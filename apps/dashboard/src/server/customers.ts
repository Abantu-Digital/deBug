import type { ReadStore, UserField } from "@debugkit/adapters";
import type { Context, StoredEvent } from "@debugkit/schema";
import { sessionOutcome, type SessionDetail } from "./session";

/** One of a customer's sessions, as the lookup lists it. */
export interface CustomerSession {
  sessionId: string;
  /** The first and last stored event of the session that the lookup read. */
  start: string;
  end: string;
  outcome: SessionDetail["outcome"];
  errors: number;
  /** Of them, caught and reported by the app. */
  handled: number;
  /** From the session's newest event. */
  context: Context;
  user: { id?: string; anonymousId?: string };
}

export interface CustomerLookup {
  query: string;
  /** What the query matched: the customer number (user.id), the install id (user.anonymousId), or both. */
  matched: UserField[];
  sessions: CustomerSession[];
  /** True when the customer had more stored events than the lookup reads: older sessions are left out. */
  truncated: boolean;
}

export const CUSTOMER_EVENT_LIMIT = 500;

/**
 * The ways a South African customer number can be stored: 0841234567, 27841234567 and
 * +27841234567 are the same number. Anything else is looked up as typed.
 */
export function customerNumberVariants(raw: string): string[] {
  const q = raw.trim();
  const compact = q.replace(/[\s\-().]/g, "");
  if (!/^\+?\d+$/.test(compact)) return q ? [q] : [];
  const digits = compact.replace(/^\+/, "");
  const national = /^0\d{9}$/.test(digits) ? digits.slice(1) : /^27\d{9}$/.test(digits) ? digits.slice(2) : undefined;
  const out = national ? [`0${national}`, `27${national}`, `+27${national}`] : [digits, `+${digits}`];
  return [...new Set([q, ...out])];
}

/** A customer's sessions, newest first, by customer number in any format or by install id. */
export async function lookupCustomer(store: ReadStore, app: string, raw: string): Promise<CustomerLookup> {
  const query = raw.trim();
  if (!query) return { query, matched: [], sessions: [], truncated: false };
  const [byId, byInstall] = await Promise.all([
    store.listUserEvents(app, "id", customerNumberVariants(query), { limit: CUSTOMER_EVENT_LIMIT + 1 }),
    store.listUserEvents(app, "anonymousId", [query], { limit: CUSTOMER_EVENT_LIMIT + 1 }),
  ]);
  const matched: UserField[] = [...(byId.length ? (["id"] as const) : []), ...(byInstall.length ? (["anonymousId"] as const) : [])];
  const truncated = byId.length > CUSTOMER_EVENT_LIMIT || byInstall.length > CUSTOMER_EVENT_LIMIT;
  const events = new Map<string, StoredEvent>();
  for (const e of [...byId.slice(0, CUSTOMER_EVENT_LIMIT), ...byInstall.slice(0, CUSTOMER_EVENT_LIMIT)]) events.set(e.event.id, e);
  return { query, matched, sessions: sessionsOf([...events.values()]), truncated };
}

/** Events grouped by session, newest session first. */
export function sessionsOf(events: readonly StoredEvent[]): CustomerSession[] {
  const by = new Map<string, StoredEvent[]>();
  for (const e of events) by.set(e.sessionId, [...(by.get(e.sessionId) ?? []), e]);
  return [...by.entries()]
    .map(([sessionId, list]) => {
      const sorted = [...list].sort((a, b) => Date.parse(a.event.ts) - Date.parse(b.event.ts));
      const last = sorted[sorted.length - 1]!;
      return {
        sessionId,
        start: sorted[0]!.event.ts,
        end: last.event.ts,
        outcome: sessionOutcome(sorted),
        errors: sorted.filter((e) => e.event.type === "error").length,
        handled: sorted.filter((e) => e.event.type === "error" && e.event.handled).length,
        context: last.context,
        user: { id: last.user?.id, anonymousId: last.user?.anonymousId },
      };
    })
    .sort((a, b) => Date.parse(b.end) - Date.parse(a.end));
}
