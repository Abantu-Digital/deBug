import type { ReadStore } from "@debugkit/adapters";
import { nameUrlsIn, type Breadcrumb, type Context, type HostName, type StoredEvent } from "@debugkit/schema";
import { byTime, readCrumb, withoutSdkTwins, type TimelineItem } from "./event";

/**
 * One session as a single timeline: its stored errors and custom events, and the breadcrumbs
 * they carried, merged in time order with each breadcrumb once. Session markers and request
 * timings aren't stored per event, so they aren't in it.
 */
export interface SessionDetail {
  app: string;
  sessionId: string;
  user: { id?: string; anonymousId?: string };
  /** From the newest event: the device and app the session ended on. */
  context: Context;
  /**
   * The earliest thing recorded (a breadcrumb or event) and the last stored event. The SDK's
   * session-start marker isn't stored, so the real start can be earlier.
   */
  start: string;
  end: string;
  /**
   * crashed: a fatal error (labelled a crash, or uncaught and critical, as the SDK sends a fatal
   * one). errored: another uncaught error. clean: neither; errors the app caught are counted apart.
   */
  outcome: "crashed" | "errored" | "clean";
  /** Errors, of them caught by the app, and custom events shown. */
  counts: { errors: number; handled: number; events: number };
  rows: SessionRow[];
  /** True when the session had more stored events than one page reads: the oldest are left out. */
  truncated: boolean;
  /** How many stored events the timeline is built from. */
  read: number;
}

/** A stored error with a detail page. Breadcrumbs and flow events link to the first error whose trail holds them. */
export interface Source {
  eventId: string;
  fingerprint: string;
}

export type SessionRow =
  | { kind: "crumb"; ts: string; item: TimelineItem; source?: Source }
  | { kind: "error"; ts: string; eventId: string; fingerprint?: string; title: string; handled: boolean; crash: boolean }
  | { kind: "event"; ts: string; eventId: string; name: string; outcome?: string; detail?: string; failed: boolean; source?: Source };

/** A breadcrumb and the error it first came in with. */
export interface CarriedCrumb {
  crumb: Breadcrumb;
  source?: Source;
}

export const SESSION_EVENT_LIMIT = 500;

/** A fatal error: labelled a crash, or uncaught and critical, which is how the SDK sends a fatal one. */
export function isCrash(e: StoredEvent): boolean {
  return e.event.type === "error" && (e.labels?.category === "crash" || (!e.event.handled && e.event.severity === "critical"));
}

/** crashed, errored (an uncaught error) or clean, as on the session page. */
export function sessionOutcome(events: readonly StoredEvent[]): SessionDetail["outcome"] {
  if (events.some(isCrash)) return "crashed";
  return events.some((e) => e.event.type === "error" && !e.event.handled) ? "errored" : "clean";
}

/** The prop that says why a flow failed, in the order apps tend to name it. */
const REASON_KEYS = ["reason", "error", "errorKind", "code", "message"];
const OUTCOME_WORD: Record<string, string> = { success: "succeeded", failure: "failed", abandoned: "abandoned" };

/** "auth.login: failed, wrongOtp". */
export function describeEvent(name: string, outcome?: string, props?: Record<string, unknown>, step?: string): string {
  const reason = REASON_KEYS.map((k) => props?.[k]).find((v) => typeof v === "string" || typeof v === "number");
  const parts = [outcome ? (OUTCOME_WORD[outcome] ?? outcome) : undefined, reason !== undefined ? String(reason) : undefined].filter(Boolean);
  return `${name}${step ? ` · ${step}` : ""}${parts.length ? `: ${parts.join(", ")}` : ""}`;
}

/**
 * Each breadcrumb once: errors in the same session carry overlapping trails. Given the events
 * oldest first, each breadcrumb's source is the earliest error that carried it, the one it led to.
 *
 * When the SDK merges a repeat it moves the breadcrumb's time to the latest repeat, so a later
 * trail can hold the same breadcrumb with a newer time and a higher count. Nothing else was
 * recorded between it and the breadcrumb before it, so an identical one in that window is the
 * same run: keep the copy with the highest count.
 */
export function uniqueCrumbs(events: readonly StoredEvent[]): CarriedCrumb[] {
  const out: CarriedCrumb[] = [];
  const exact = new Map<string, CarriedCrumb>();
  const count = (b: Breadcrumb) => Number(b.data?.repeated ?? 1);
  for (const e of events) {
    if (e.event.type !== "error") continue;
    const source = e.fingerprint ? { eventId: e.event.id, fingerprint: e.fingerprint } : undefined;
    let after = -Infinity;
    for (const b of e.event.breadcrumbs ?? []) {
      const t = Date.parse(b.ts);
      const same = (c: CarriedCrumb) => c.crumb.category === b.category && c.crumb.message === b.message && c.crumb.level === b.level;
      const had =
        exact.get(`${b.ts}|${b.category}|${b.message}`) ??
        (count(b) > 1 ? out.find((c) => same(c) && Date.parse(c.crumb.ts) > after && Date.parse(c.crumb.ts) <= t) : undefined);
      if (!had) {
        const c = { crumb: b, source };
        out.push(c);
        exact.set(`${b.ts}|${b.category}|${b.message}`, c);
      } else if (count(b) > count(had.crumb)) {
        had.crumb = b;
        exact.set(`${b.ts}|${b.category}|${b.message}`, had);
      }
      after = t;
    }
  }
  return out;
}

/** How far apart a custom event and its own breadcrumb, or an api.failed event and its call, can be. */
const SAME_MS = 2000;

/** The SDK writes each custom event as an "event" breadcrumb too: the breadcrumb that is this event, if any. */
function ownCrumb(name: string, ts: string, crumbs: readonly CarriedCrumb[], taken: Set<CarriedCrumb>): CarriedCrumb | undefined {
  const t = Date.parse(ts);
  return crumbs.find((c) => !taken.has(c) && c.crumb.category === "event" && c.crumb.message === name && Math.abs(Date.parse(c.crumb.ts) - t) <= SAME_MS);
}

/** The app's api.failed event says the same as the failed call's breadcrumb next to it. */
function repeatsCrumb(e: StoredEvent, crumbs: readonly TimelineItem[]): boolean {
  if (e.event.type !== "event" || e.event.name !== "api.failed") return false;
  const path = e.event.props?.path;
  const t = Date.parse(e.event.ts);
  return crumbs.some((c) => c.api?.failed && c.api.path === path && Math.abs(Date.parse(c.ts) - t) <= SAME_MS);
}

export async function buildSessionDetail(store: ReadStore, app: string, sessionId: string): Promise<SessionDetail | null> {
  const [events, settings] = await Promise.all([
    store.listSessionEvents(app, sessionId, { limit: SESSION_EVENT_LIMIT + 1 }),
    store.getSettings(app).catch(() => null),
  ]);
  if (!events.length) return null;
  const truncated = events.length > SESSION_EVENT_LIMIT;
  // The store gives the newest, oldest first: drop the oldest, keep the end (often the crash).
  const page = events.slice(-SESSION_EVENT_LIMIT);
  const hosts = settings?.hosts ?? [];

  const carried = withoutSdkTwinsCarried(uniqueCrumbs(page));
  // A custom event replaces its own breadcrumb, and takes over its link.
  const taken = new Set<CarriedCrumb>();
  const own = new Map<StoredEvent, CarriedCrumb>();
  for (const e of page) {
    if (e.event.type !== "event") continue;
    const c = ownCrumb(e.event.name, e.event.ts, carried, taken);
    if (c) {
      taken.add(c);
      own.set(e, c);
    }
  }
  const kept = carried.filter((c) => !taken.has(c)).map((c) => ({ ts: c.crumb.ts, item: readCrumb(c.crumb, hosts), source: c.source }));
  const crumbs = kept.map((c) => c.item);
  const rows: SessionRow[] = kept.map((c) => ({ kind: "crumb", ...c }));
  let errors = 0;
  let handled = 0;
  for (const e of page) {
    const ev = e.event;
    if (ev.type === "error") {
      const crash = isCrash(e);
      errors++;
      if (ev.handled) handled++;
      rows.push({ kind: "error", ts: ev.ts, eventId: ev.id, fingerprint: e.fingerprint, title: nameUrlsIn(`${ev.error.name}: ${ev.error.message}`, hosts), handled: ev.handled, crash });
    } else if (ev.type === "event" && !repeatsCrumb(e, crumbs)) {
      rows.push({ kind: "event", ts: ev.ts, eventId: ev.id, name: ev.name, outcome: ev.outcome, detail: describeEvent(ev.name, ev.outcome, ev.props, ev.step), failed: ev.outcome === "failure", source: own.get(e)?.source });
    }
  }
  // Time order; at the same moment, the trail before the error it led to.
  const order = { crumb: 0, event: 1, error: 2 } as const;
  const sorted = byTime(rows.sort((a, b) => order[a.kind] - order[b.kind]));

  const last = page[page.length - 1]!;
  return {
    app,
    sessionId,
    user: { id: last.user?.id, anonymousId: last.user?.anonymousId },
    context: last.context,
    start: sorted[0]?.ts ?? page[0]!.event.ts,
    end: last.event.ts,
    outcome: sessionOutcome(page),
    counts: { errors, handled, events: sorted.filter((r) => r.kind === "event").length },
    rows: sorted,
    truncated,
    read: page.length,
  };
}

/** How far after an error its "what they did next" reaches. */
const AFTER_MS = 5 * 60_000;

/**
 * What the customer did after an error, from the trails of the session's later errors: the steps
 * within five minutes of it, at most `limit`. Empty when nothing later was stored or the session
 * can't be read (Firestore without its index).
 */
export async function stepsAfter(store: ReadStore, app: string, sessionId: string, ts: string, hosts: readonly HostName[] = [], limit = 10): Promise<TimelineItem[]> {
  const events = await store.listSessionEvents(app, sessionId, { limit: SESSION_EVENT_LIMIT }).catch(() => []);
  const t = Date.parse(ts);
  const later = withoutSdkTwinsCarried(uniqueCrumbs(events)).filter((c) => {
    const d = Date.parse(c.crumb.ts) - t;
    return d > 0 && d <= AFTER_MS;
  });
  return byTime(later.map((c) => c.crumb)).slice(0, limit).map((b) => readCrumb(b, hosts));
}

/** withoutSdkTwins over carried breadcrumbs, keeping each one's source. */
function withoutSdkTwinsCarried(carried: readonly CarriedCrumb[]): CarriedCrumb[] {
  const keep = new Set(withoutSdkTwins(carried.map((c) => c.crumb)));
  return carried.filter((c) => keep.has(c.crumb));
}
