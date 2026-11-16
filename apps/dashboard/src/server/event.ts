import type { ReadStore } from "@debugkit/adapters";
import { nameUrl, nameUrlsIn, type Breadcrumb, type Context, type HostName, type StackFrame, type StoredEvent } from "@debugkit/schema";

/**
 * One occurrence of an issue, laid out for the event page: what led up to it, what failed, on
 * which device, and where in the code. Read from the issue's recent events (listIssueEvents),
 * so occurrences older than the newest `EVENT_LOOKBACK` aren't reachable.
 */
export interface EventDetail {
  app: string;
  issue: { fingerprint: string; title: string; status: string };
  id: string;
  ts: string;
  /** Uncaught (false) or caught and reported by the app (true). */
  handled: boolean;
  error: { name: string; message: string };
  flow?: string;
  step?: string;
  user: { id?: string; anonymousId?: string };
  sessionId: string;
  context: Context;
  /** Every event tag, sorted by name. */
  tags: { key: string; value: string }[];
  timeline: TimelineItem[];
  /** The failed request: the event's own, or the last failing API call before it. */
  request?: ApiCall;
  /** In-app frames first, each group in stack order. */
  frames: StackFrame[];
  stack?: string;
  /** The neighbouring occurrences of the same issue, for stepping through them. */
  newer?: string;
  older?: string;
}

export interface TimelineItem {
  ts: string;
  category: Breadcrumb["category"];
  message: string;
  level: Breadcrumb["level"];
  failed: boolean;
  /** Set for network breadcrumbs that describe an API call. */
  api?: ApiCall;
  /** Breadcrumb data not shown as an API call. */
  data?: Record<string, string | number | boolean | null>;
  /** Merged identical breadcrumbs (data.repeated). */
  repeated?: number;
}

export interface ApiCall {
  /** The service, as the app names it or as Settings names the host. */
  service?: string;
  method?: string;
  /** Path, or the whole URL when the breadcrumb has no separate path. */
  path?: string;
  status?: number;
  durationMs?: number;
  /** answered, unreachable, sessionExpired, ... as the app reports it. */
  outcome?: string;
  retry?: number | boolean | string;
  backendTitle?: string;
  backendCode?: string;
  traceId?: string;
  failed: boolean;
}

export const EVENT_LOOKBACK = 200;

type Data = NonNullable<Breadcrumb["data"]>;
const str = (v: unknown) => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined);
/** The first key present: the Cell C app's keys and their alternatives ("backend.title" or "backendTitle"). */
const pick = (d: Data, ...keys: string[]) => keys.map((k) => d[k]).find((v) => v !== undefined && v !== null && v !== "");

/** API keys read into the call; the rest of the data is shown as it is. */
const API_KEYS = new Set([
  "service", "method", "path", "url", "status", "durationMs", "outcome", "retry",
  "backend.title", "backendTitle", "backend.code", "backendCode", "traceId", "trace_id", "repeated",
]);

/** The SDK's own network breadcrumb: "POST api.x.com/v1/pay → 503 (120ms)". */
const SDK_NETWORK = /^([A-Z]+) (\S+) → /;

/** A network breadcrumb as an API call, or undefined when it isn't one ("Device went offline"). */
export function apiCallOf(b: Breadcrumb, hosts: readonly HostName[] = []): ApiCall | undefined {
  if (b.category !== "network") return undefined;
  const d = b.data ?? {};
  const sdk = SDK_NETWORK.exec(b.message);
  const url = str(pick(d, "path", "url")) ?? sdk?.[2];
  const method = str(pick(d, "method"))?.toUpperCase() ?? sdk?.[1];
  if (!url && !method && d.service === undefined) return undefined;
  const status = num(d.status);
  const outcome = str(d.outcome);
  // Named by Settings when the breadcrumb carries a whole URL and no service of its own.
  const named = url && !d.service ? nameUrl(url, hosts) : undefined;
  const hit = named && named !== url ? named.split(" · ") : undefined;
  const call: ApiCall = {
    service: str(d.service) ?? hit?.[0],
    method,
    path: hit ? hit[1] || "/" : url,
    status,
    durationMs: num(d.durationMs),
    outcome,
    retry: typeof d.retry === "boolean" || typeof d.retry === "number" ? d.retry : str(d.retry),
    backendTitle: str(pick(d, "backend.title", "backendTitle")),
    backendCode: str(pick(d, "backend.code", "backendCode")),
    traceId: str(pick(d, "traceId", "trace_id")),
    failed: false,
  };
  call.failed = b.level === "error" || (status !== undefined && status >= 400) || (outcome !== undefined && outcome !== "answered");
  return call;
}

/** The breadcrumbs in time order (stable for equal times), each read for what it says. */
export function timelineOf(crumbs: readonly Breadcrumb[] = [], hosts: readonly HostName[] = []): TimelineItem[] {
  return crumbs
    .map((b, i) => ({ b, i }))
    .sort((x, y) => x.b.ts.localeCompare(y.b.ts) || x.i - y.i)
    .map(({ b }) => {
      const api = apiCallOf(b, hosts);
      const rest = Object.entries(b.data ?? {}).filter(([k]) => !(api && API_KEYS.has(k)) && k !== "repeated");
      const repeated = num(b.data?.repeated);
      return {
        ts: b.ts,
        category: b.category,
        message: nameUrlsIn(b.message, hosts),
        level: b.level,
        failed: api ? api.failed : b.level === "error",
        ...(api ? { api } : {}),
        ...(rest.length ? { data: Object.fromEntries(rest) } : {}),
        ...(repeated && repeated > 1 ? { repeated } : {}),
      };
    });
}

/** In-app frames first, keeping stack order within each group. */
export function framesInAppFirst(frames: readonly StackFrame[] = []): StackFrame[] {
  return [...frames.filter((f) => f.inApp), ...frames.filter((f) => !f.inApp)];
}

export async function buildEventDetail(store: ReadStore, app: string, fingerprint: string, eventId: string): Promise<EventDetail | null> {
  const [issue, events, settings] = await Promise.all([
    store.getIssue(app, fingerprint),
    store.listIssueEvents(app, fingerprint, { limit: EVENT_LOOKBACK }),
    store.getSettings(app).catch(() => null),
  ]);
  if (!issue) return null;
  const all: StoredEvent[] = events.length ? events : [issue.lastEvent];
  const at = all.findIndex((e) => e.event.id === eventId);
  const se = at >= 0 ? all[at]! : issue.lastEvent.event.id === eventId ? issue.lastEvent : undefined;
  if (!se || se.event.type !== "error") return null;
  const ev = se.event;
  const hosts = settings?.hosts ?? [];
  const timeline = timelineOf(ev.breadcrumbs, hosts);
  const own: ApiCall | undefined = ev.request
    ? {
        ...apiCallOf({ ts: ev.ts, category: "network", level: "error", message: "", data: { method: ev.request.method, url: ev.request.url } }, hosts),
        status: ev.request.status,
        durationMs: ev.request.durationMs,
        failed: true,
      }
    : undefined;
  // The app's breadcrumb for the same call usually carries more: service, backend code, traceId.
  const lastFailing = [...timeline].reverse().find((t) => t.api?.failed)?.api;
  const request = own && lastFailing && lastFailing.method === own.method ? { ...lastFailing, ...defined(own), service: lastFailing.service ?? own.service } : own ?? lastFailing;
  return {
    app,
    issue: { fingerprint, title: nameUrlsIn(issue.title, hosts), status: issue.status ?? "open" },
    id: ev.id,
    ts: ev.ts,
    handled: ev.handled,
    error: { name: ev.error.name, message: nameUrlsIn(ev.error.message, hosts) },
    flow: ev.flow,
    step: ev.step,
    user: { id: se.user?.id, anonymousId: se.user?.anonymousId },
    sessionId: se.sessionId,
    context: se.context,
    tags: Object.entries(ev.tags ?? {})
      .map(([key, value]) => ({ key, value: String(value) }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    timeline,
    request,
    frames: framesInAppFirst(ev.error.frames),
    stack: ev.error.stack,
    newer: at > 0 ? all[at - 1]!.event.id : undefined,
    older: at >= 0 && at < all.length - 1 ? all[at + 1]!.event.id : undefined,
  };
}

/** Drop undefined fields, so spreading doesn't erase a value from the breadcrumb. */
function defined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
