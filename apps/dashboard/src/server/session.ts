import type { ReadStore } from "@debugkit/adapters";
import { nameUrlsIn, type Breadcrumb, type Context, type StoredEvent } from "@debugkit/schema";
import { timelineOf, type TimelineItem } from "./event";

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
  /** The first breadcrumb or event, and the last event. */
  start: string;
  end: string;
  /**
   * crashed: an error the classifier labelled an app crash. errored: an uncaught error. clean:
   * neither (errors the app caught and reported are counted separately).
   */
  outcome: "crashed" | "errored" | "clean";
  /** Errors, of them caught by the app, and custom events shown. */
  counts: { errors: number; handled: number; events: number };
  rows: SessionRow[];
  /** True when the session had more stored events than one page reads. */
  truncated: boolean;
}

export type SessionRow =
  | { kind: "crumb"; ts: string; item: TimelineItem }
  | { kind: "error"; ts: string; eventId: string; fingerprint?: string; title: string; handled: boolean; crash: boolean }
  | { kind: "event"; ts: string; eventId: string; name: string; outcome?: string; detail?: string; failed: boolean };

export const SESSION_EVENT_LIMIT = 500;

/** The prop that says why a flow failed, in the order apps tend to name it. */
const REASON_KEYS = ["reason", "error", "errorKind", "code", "message"];
const OUTCOME_WORD: Record<string, string> = { success: "succeeded", failure: "failed", abandoned: "abandoned" };

/** "auth.login: failed, wrongOtp". */
export function describeEvent(name: string, outcome?: string, props?: Record<string, unknown>, step?: string): string {
  const reason = REASON_KEYS.map((k) => props?.[k]).find((v) => typeof v === "string" || typeof v === "number");
  const parts = [outcome ? (OUTCOME_WORD[outcome] ?? outcome) : undefined, reason !== undefined ? String(reason) : undefined].filter(Boolean);
  return `${name}${step ? ` · ${step}` : ""}${parts.length ? `: ${parts.join(", ")}` : ""}`;
}

/** Each breadcrumb once: errors in the same session carry overlapping trails. */
export function uniqueCrumbs(events: readonly StoredEvent[]): Breadcrumb[] {
  const seen = new Map<string, Breadcrumb>();
  for (const e of events) {
    if (e.event.type !== "error") continue;
    for (const b of e.event.breadcrumbs ?? []) {
      const key = `${b.ts}|${b.category}|${b.message}`;
      // Merged repeats grow between errors: keep the copy with the highest count.
      const had = seen.get(key);
      if (!had || Number(b.data?.repeated ?? 1) > Number(had.data?.repeated ?? 1)) seen.set(key, b);
    }
  }
  return [...seen.values()];
}

/** The app's api.failed event says the same as the failed call's breadcrumb next to it. */
function repeatsCrumb(e: StoredEvent, crumbs: readonly TimelineItem[]): boolean {
  if (e.event.type !== "event" || e.event.name !== "api.failed") return false;
  const path = e.event.props?.path;
  const t = Date.parse(e.event.ts);
  return crumbs.some((c) => c.api?.failed && c.api.path === path && Math.abs(Date.parse(c.ts) - t) <= 2000);
}

export async function buildSessionDetail(store: ReadStore, app: string, sessionId: string): Promise<SessionDetail | null> {
  const [events, settings] = await Promise.all([
    store.listSessionEvents(app, sessionId, { limit: SESSION_EVENT_LIMIT + 1 }),
    store.getSettings(app).catch(() => null),
  ]);
  if (!events.length) return null;
  const truncated = events.length > SESSION_EVENT_LIMIT;
  const page = events.slice(0, SESSION_EVENT_LIMIT);
  const hosts = settings?.hosts ?? [];

  const crumbs = timelineOf(uniqueCrumbs(page), hosts);
  const rows: SessionRow[] = crumbs.map((item) => ({ kind: "crumb", ts: item.ts, item }));
  let errors = 0;
  let handled = 0;
  let crashed = false;
  let uncaught = false;
  for (const e of page) {
    const ev = e.event;
    if (ev.type === "error") {
      const crash = e.labels?.category === "crash";
      errors++;
      if (ev.handled) handled++;
      else uncaught = true;
      crashed ||= crash;
      rows.push({ kind: "error", ts: ev.ts, eventId: ev.id, fingerprint: e.fingerprint, title: nameUrlsIn(`${ev.error.name}: ${ev.error.message}`, hosts), handled: ev.handled, crash });
    } else if (ev.type === "event" && !repeatsCrumb(e, crumbs)) {
      rows.push({ kind: "event", ts: ev.ts, eventId: ev.id, name: ev.name, outcome: ev.outcome, detail: describeEvent(ev.name, ev.outcome, ev.props, ev.step), failed: ev.outcome === "failure" });
    }
  }
  // Time order; at the same moment, the trail before the error it led to.
  const order = { crumb: 0, event: 1, error: 2 } as const;
  rows.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts) || order[a.kind] - order[b.kind]);

  const last = page[page.length - 1]!;
  return {
    app,
    sessionId,
    user: { id: last.user?.id, anonymousId: last.user?.anonymousId },
    context: last.context,
    start: rows[0]?.ts ?? page[0]!.event.ts,
    end: last.event.ts,
    outcome: crashed ? "crashed" : uncaught ? "errored" : "clean",
    counts: { errors, handled, events: rows.filter((r) => r.kind === "event").length },
    rows,
    truncated,
  };
}
