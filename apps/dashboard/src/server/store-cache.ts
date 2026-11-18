import type { ReadStore } from "@debugkit/adapters";

/** A read this new is served as it is. */
export const FRESH_MS = 30_000;
/** A read up to this old is served at once while a fresh one runs in the background. */
export const STALE_MS = 2 * 60_000;
/** Entries kept at most; the oldest go first. */
export const MAX_ENTRIES = 2_000;

/** The reads that are cached. */
export const CACHED_READS = new Set<string>(["getSettings", "getVersions", "countUsers", "listApps", "listIssues", "getIssue", "getRollups", "listIssueEvents", "listSessionEvents"]);
/** Calls that change data (demo and memory mode write through the store): they clear the cache. */
const WRITE = /^(write|upsert|increment|put|set|register|note|mark|delete|remove|restamp|create|accept|revoke|change)/;

interface Entry {
  at: number;
  value: Promise<unknown>;
  refreshing?: boolean;
}

/** The cached store, and a way to forget everything it kept. */
export interface StoreCache {
  store: ReadStore;
  clear(): void;
}

/**
 * A short-lived cache in front of the store, so moving between pages doesn't read the same data
 * from Firestore or DynamoDB again and again.
 *
 * - The same read made twice at once (the health wall's summary and endpoints both read the issue
 *   list) is made once.
 * - A read newer than FRESH_MS is served as it is; one up to STALE_MS old is served at once and
 *   read again in the background, so the next page has it fresh.
 * - A write through the store (demo and memory mode), or clearStoreCache() after a change made
 *   through the ingest function's admin routes, clears it. A background read that started
 *   before the clear is dropped.
 * - Only CACHED_READS are cached: team and sign-in reads always go to the store.
 *
 * Per server instance, like the sign-in limits in auth.ts: on hosting with several instances,
 * another one can show data up to STALE_MS old after a change. The Refresh button clears this
 * instance's cache.
 */
export function cacheStore(store: ReadStore, now: () => number = Date.now): StoreCache {
  const entries = new Map<string, Entry>();
  // Bumped by every clear, so a background read that started before a write can't put old data back.
  let generation = 0;
  const read = (key: string, call: () => Promise<unknown>): Promise<unknown> => {
    const t = now();
    const hit = entries.get(key);
    if (hit) {
      // Most recently used last, so the oldest unused go first when the cache is full.
      entries.delete(key);
      entries.set(key, hit);
    }
    if (hit && t - hit.at < FRESH_MS) return hit.value;
    if (hit && t - hit.at < STALE_MS) {
      if (!hit.refreshing) {
        hit.refreshing = true;
        const started = generation;
        const next = call();
        // Swap in the new value only once it has arrived; keep the old one if the read fails.
        next.then(
          () => generation === started && entries.set(key, { at: now(), value: next }),
          () => (hit.refreshing = false),
        );
      }
      return hit.value;
    }
    const value = call();
    entries.set(key, { at: t, value });
    // A failed read isn't kept: the next page tries again.
    value.catch(() => entries.get(key)?.value === value && entries.delete(key));
    while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
    return value;
  };
  const clear = () => {
    generation++;
    entries.clear();
  };
  const cached = new Proxy(store, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function" || typeof prop !== "string") return v;
      if (CACHED_READS.has(prop)) return (...args: unknown[]) => read(`${prop}:${JSON.stringify(args)}`, () => v.apply(target, args));
      if (!WRITE.test(prop)) return v.bind(target);
      // A write: clear before (nothing old is served meanwhile) and after it lands (nothing read
      // during it is kept).
      return async (...args: unknown[]) => {
        clear();
        try {
          return await v.apply(target, args);
        } finally {
          clear();
        }
      };
    },
  });
  return { store: cached, clear };
}
