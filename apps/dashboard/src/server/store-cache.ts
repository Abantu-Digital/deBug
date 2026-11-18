import type { ReadStore } from "@debugkit/adapters";

/**
 * A short-lived cache in front of the store, so moving between pages doesn't read the same data
 * from Firestore or DynamoDB again and again.
 *
 * - The same read made twice at once (the health wall's summary and endpoints both read the issue
 *   list) is made once.
 * - A read newer than FRESH_MS is served as it is.
 * - One older than that, up to STALE_MS, is served at once and read again in the background, so
 *   the next page has it fresh. Only the very first read waits on the store.
 * - Anything that isn't a cached read (a status change, demo ingest) clears the cache; so does
 *   clearStoreCache(), which the dashboard's own writes call.
 *
 * Team and sign-in reads are never cached: removing someone takes effect at once.
 */
export const FRESH_MS = 30_000;
export const STALE_MS = 10 * 60_000;
/** Entries kept at most; the oldest go first. */
export const MAX_ENTRIES = 2_000;

/** The reads that are cached. */
export const CACHED_READS = new Set<string>(["getSettings", "getVersions", "countUsers", "listApps", "listIssues", "getIssue", "getRollups", "listIssueEvents", "listSessionEvents"]);
/** Reads that always go to the store. */
const UNCACHED_READS = new Set<string>(["getMember", "listMembers", "listInvites", "listUserEvents"]);

interface Entry {
  at: number;
  value: Promise<unknown>;
  refreshing?: boolean;
}

export interface StoreCache {
  store: ReadStore;
  clear(): void;
}

export function cacheStore(store: ReadStore, now: () => number = Date.now): StoreCache {
  const entries = new Map<string, Entry>();
  const read = (key: string, call: () => Promise<unknown>): Promise<unknown> => {
    const t = now();
    const hit = entries.get(key);
    if (hit && t - hit.at < FRESH_MS) return hit.value;
    if (hit && t - hit.at < STALE_MS) {
      if (!hit.refreshing) {
        hit.refreshing = true;
        const next = call();
        // Swap in the new value only once it has arrived; keep the old one if the read fails.
        next.then(
          () => entries.set(key, { at: now(), value: next }),
          () => (hit.refreshing = false),
        );
      }
      return hit.value;
    }
    const value = call();
    entries.set(key, { at: t, value });
    // A failed read isn't kept: the next page tries again.
    value.catch(() => entries.get(key)?.value === value && entries.delete(key));
    if (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
    return value;
  };
  const cached = new Proxy(store, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function" || typeof prop !== "string") return v;
      if (CACHED_READS.has(prop)) return (...args: unknown[]) => read(`${prop}:${JSON.stringify(args)}`, () => v.apply(target, args));
      if (UNCACHED_READS.has(prop)) return v.bind(target);
      // A write: what's cached may no longer be true.
      return (...args: unknown[]) => {
        entries.clear();
        return v.apply(target, args);
      };
    },
  });
  return { store: cached, clear: () => entries.clear() };
}
