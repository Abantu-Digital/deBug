import type { ReadStore, UserField } from "@debugkit/adapters";
import { isTestEvent, type Context, type StoredEvent } from "@debugkit/schema";
import { sessionOutcome, type SessionDetail } from "./session";

/** One of a customer's sessions, as the lookup lists it. */
export interface CustomerSession {
  app: string;
  sessionId: string;
  /** The first and last stored event of the session that the lookup read. */
  start: string;
  end: string;
  outcome: SessionDetail["outcome"];
  errors: number;
  /** Of them, caught and reported by the app. */
  handled: number;
  /** Flow events with outcome failure, e.g. a recharge that didn't go through. */
  failedFlows: number;
  /** From the session's newest event. */
  context: Context;
  user: { id?: string; anonymousId?: string };
}

export interface CustomerLookup {
  query: string;
  /** What the query matched: the customer number (user.id), the install id (user.anonymousId), or both. */
  matched: UserField[];
  sessions: CustomerSession[];
  /**
   * True when the customer had more stored events than the lookup reads in an app: older sessions
   * are left out, and the oldest one listed may be only partly read.
   */
  truncated: boolean;
}

export const CUSTOMER_EVENT_LIMIT = 500;

/**
 * The ways a South African customer number can be stored: 0841234567, 27841234567 and
 * +27841234567 are the same number, typed as any of those, as 0027…, +27 0…, or without the
 * leading 0. Anything else is looked up as typed. Numbers are looked up without spaces.
 */
export function zaNumberVariants(raw: string): string[] {
  const q = raw.trim();
  const compact = q.replace(/[\s\-().]/g, "");
  if (!/^\+?\d+$/.test(compact)) return q ? [q] : [];
  const digits = compact.replace(/^\+/, "").replace(/^00(?=27)/, "");
  const national = /^0\d{9}$/.test(digits)
    ? digits.slice(1)
    : /^27\d{9}$/.test(digits)
      ? digits.slice(2)
      : /^270\d{9}$/.test(digits)
        ? digits.slice(3)
        : /^[1-9]\d{8}$/.test(digits)
          ? digits
          : undefined;
  const out = national ? [`0${national}`, `27${national}`, `+27${national}`] : [digits, `+${digits}`];
  return [...new Set([q, ...out])];
}

/**
 * A customer's sessions in the given apps, newest first, by customer number in any format or by
 * install id. Android and iOS are often separate apps, so support searches them all at once.
 */
export async function lookupCustomer(store: ReadStore, apps: readonly string[], raw: string): Promise<CustomerLookup> {
  const query = raw.trim();
  if (!query) return { query, matched: [], sessions: [], truncated: false };
  const variants = zaNumberVariants(query);
  const reads = await Promise.all(
    apps.flatMap((app) => (["id", "anonymousId"] as const).map(async (field) => ({ field, events: await store.listUserEvents(app, field, field === "id" ? variants : [query], { limit: CUSTOMER_EVENT_LIMIT + 1 }) }))),
  );
  const matched = (["id", "anonymousId"] as const).filter((f) => reads.some((r) => r.field === f && r.events.length));
  const truncated = reads.some((r) => r.events.length > CUSTOMER_EVENT_LIMIT);
  const events = new Map<string, StoredEvent>();
  for (const r of reads) for (const e of r.events.slice(0, CUSTOMER_EVENT_LIMIT)) events.set(`${e.app}|${e.event.id}`, e);
  return { query, matched, sessions: sessionsOf([...events.values()]), truncated };
}

/** Events grouped by session, newest session first. */
export function sessionsOf(events: readonly StoredEvent[]): CustomerSession[] {
  const by = new Map<string, StoredEvent[]>();
  for (const e of events) {
    const k = `${e.app}|${e.sessionId}`;
    by.set(k, [...(by.get(k) ?? []), e]);
  }
  return [...by.values()]
    .map((list) => {
      const sorted = [...list].sort((a, b) => Date.parse(a.event.ts) - Date.parse(b.event.ts));
      const last = sorted[sorted.length - 1]!;
      return {
        app: last.app,
        sessionId: last.sessionId,
        start: sorted[0]!.event.ts,
        end: last.event.ts,
        outcome: sessionOutcome(sorted),
        // Test errors (ABA-133) aren't the customer's errors.
        errors: sorted.filter((e) => e.event.type === "error" && !isTestEvent(e.event)).length,
        handled: sorted.filter((e) => e.event.type === "error" && e.event.handled && !isTestEvent(e.event)).length,
        failedFlows: sorted.filter((e) => e.event.type === "event" && e.event.outcome === "failure").length,
        context: last.context,
        user: { id: last.user?.id, anonymousId: last.user?.anonymousId },
      };
    })
    .sort((a, b) => Date.parse(b.end) - Date.parse(a.end));
}
