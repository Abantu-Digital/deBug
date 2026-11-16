import type { ReadStore } from "@debugkit/adapters";
// session.ts imports from here too; both only call each other inside functions.
import { stepsAfter } from "./session";
import { hostNameFor, nameUrlsIn, type Breadcrumb, type Context, type HostName, type StackFrame, type StoredEvent } from "@debugkit/schema";

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
  /** What the customer did next, within five minutes, from the session's later errors. */
  after: TimelineItem[];
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
  /** The app's retry count or flag, as it sends it. */
  retry?: number | boolean | string;
  backendTitle?: string;
  backendCode?: string;
  /** The backend's own list of errors, joined ("; "). */
  backendErrors?: string;
  /** The app's kind of failure: connectionError, schemaError, ... */
  errorKind?: string;
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
  "backend.title", "backendTitle", "backend.code", "backendCode", "backendErrors", "traceId", "trace_id", "errorKind",
]);

/** Outcomes that mean the call did what it should. Anything else the app reports (unreachable, sessionExpired) is a failure. */
const OK_OUTCOMES = new Set(["answered", "cached", "cancelled", "canceled", "aborted", "success", "ok"]);

/** The SDK's own network breadcrumb: "POST api.x.com/v1/pay → 503 (120ms)", or "→ failed". */
const SDK_NETWORK = /^([A-Z]+) (\S+) → (\d{3})?/;

/** A network breadcrumb as an API call, or undefined when it isn't one ("Device went offline"). */
export function apiCallOf(b: Breadcrumb, hosts: readonly HostName[] = []): ApiCall | undefined {
  if (b.category !== "network") return undefined;
  const d = b.data ?? {};
  const sdk = SDK_NETWORK.exec(b.message);
  const url = str(pick(d, "path", "url")) ?? sdk?.[2];
  const method = str(pick(d, "method"))?.toUpperCase() ?? sdk?.[1];
  const appService = str(d.service);
  if (!url && !method && !appService) return undefined;
  const status = num(d.status) ?? num(sdk?.[3]);
  const outcome = str(d.outcome);
  // Named by Settings when the breadcrumb carries a whole URL and no service of its own.
  const named = url && !appService ? hostNameFor(url, hosts) : undefined;
  const call: ApiCall = {
    service: appService ?? named?.host.name,
    method,
    path: named ? named.rest || "/" : url,
    status,
    durationMs: num(d.durationMs),
    outcome,
    retry: typeof d.retry === "boolean" || typeof d.retry === "number" ? d.retry : str(d.retry),
    backendTitle: str(pick(d, "backend.title", "backendTitle")),
    backendCode: str(pick(d, "backend.code", "backendCode")),
    backendErrors: str(d.backendErrors),
    errorKind: str(d.errorKind),
    traceId: str(pick(d, "traceId", "trace_id")),
    failed: false,
  };
  call.failed = b.level === "error" || (status !== undefined && status >= 400) || (outcome !== undefined && !OK_OUTCOMES.has(outcome));
  return call;
}

/** How close in time the SDK's breadcrumb and the app's own for the same call are. */
const TWIN_MS = 2000;

/**
 * The SDK's own network breadcrumbs that repeat an app breadcrumb for the same call (same method,
 * the SDK's URL ending in the app's path, within TWIN_MS): the app's says more, so the SDK's is
 * left out of the timeline.
 */
function sdkTwins(crumbs: readonly Breadcrumb[]): Set<Breadcrumb> {
  const app = crumbs.filter((b) => b.category === "network" && str(b.data?.service) && str(b.data?.path));
  const out = new Set<Breadcrumb>();
  if (!app.length) return out;
  for (const b of crumbs) {
    const sdk = b.category === "network" && !b.data?.service ? SDK_NETWORK.exec(b.message) : null;
    if (!sdk) continue;
    const url = sdk[2]!.split(/[?#]/)[0]!;
    const t = Date.parse(b.ts);
    if (app.some((a) => str(a.data?.method)?.toUpperCase() === sdk[1] && url.endsWith(String(a.data!.path)) && Math.abs(Date.parse(a.ts) - t) <= TWIN_MS)) out.add(b);
  }
  return out;
}

/** The breadcrumbs in time order (stable for equal times), each read for what it says. */
export function timelineOf(crumbs: readonly Breadcrumb[] = [], hosts: readonly HostName[] = []): TimelineItem[] {
  return byTime(withoutSdkTwins(crumbs)).map((b) => readCrumb(b, hosts));
}

/** Oldest first, stable for equal times. By time, not by string: "09:00:00Z" and "09:00:00.500Z" don't sort as text. */
export function byTime<T extends { ts: string }>(items: readonly T[]): T[] {
  return items
    .map((x, i) => ({ x, i }))
    .sort((p, q) => Date.parse(p.x.ts) - Date.parse(q.x.ts) || p.i - q.i)
    .map(({ x }) => x);
}

/** The breadcrumbs without the SDK's own copy of a call the app also described. */
export function withoutSdkTwins<B extends Breadcrumb>(crumbs: readonly B[]): B[] {
  const twins = sdkTwins(crumbs);
  return crumbs.filter((b) => !twins.has(b));
}

/** One breadcrumb read for what it says: the API call it describes, or its message. */
export function readCrumb(b: Breadcrumb, hosts: readonly HostName[] = []): TimelineItem {
  const api = apiCallOf(b, hosts);
  const rest = Object.entries(b.data ?? {}).filter(([k]) => k !== "repeated" && !(api && API_KEYS.has(k)));
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
  // Only errors have a page: stepping newer and older skips anything else.
  const errors = (events.length ? events : [issue.lastEvent]).filter((e) => e.event.type === "error");
  const index = errors.findIndex((e) => e.event.id === eventId);
  const stored = index >= 0 ? errors[index] : issue.lastEvent.event.id === eventId ? issue.lastEvent : undefined;
  if (!stored || stored.event.type !== "error") return null;
  const ev = stored.event;
  const hosts = settings?.hosts ?? [];
  const timeline = timelineOf(ev.breadcrumbs, hosts);
  return {
    app,
    issue: { fingerprint, title: nameUrlsIn(issue.title, hosts), status: issue.status ?? "open" },
    id: ev.id,
    ts: ev.ts,
    handled: ev.handled,
    error: { name: ev.error.name, message: nameUrlsIn(ev.error.message, hosts) },
    flow: ev.flow,
    step: ev.step,
    user: { id: stored.user?.id, anonymousId: stored.user?.anonymousId },
    sessionId: stored.sessionId,
    context: stored.context,
    tags: Object.entries(ev.tags ?? {})
      .map(([key, value]) => ({ key, value: String(value) }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    timeline,
    request: failedRequest(ev.request, timeline, hosts),
    frames: framesInAppFirst(ev.error.frames),
    stack: ev.error.stack,
    after: await stepsAfter(store, app, stored.sessionId, ev.ts, hosts),
    newer: index > 0 ? errors[index - 1]!.event.id : undefined,
    older: index >= 0 && index < errors.length - 1 ? errors[index + 1]!.event.id : undefined,
  };
}

type ErrorRequest = { method: string; url: string; status?: number; durationMs?: number };

/**
 * The call that failed: the error's own request, filled in from the app's breadcrumb for the same
 * call (service, backend code, traceId), or the last failing call when the error has no request.
 * A breadcrumb counts as the same call only when its method and path match.
 */
export function failedRequest(request: ErrorRequest | undefined, timeline: readonly TimelineItem[], hosts: readonly HostName[] = []): ApiCall | undefined {
  const lastFailing = [...timeline].reverse().find((t) => t.api?.failed)?.api;
  if (!request) return lastFailing;
  const named = hostNameFor(request.url, hosts);
  const own: ApiCall = {
    service: named?.host.name,
    method: request.method.toUpperCase(),
    path: named ? named.rest || "/" : request.url,
    status: request.status,
    durationMs: request.durationMs,
    failed: true,
  };
  const bare = request.url.split(/[?#]/)[0]!;
  const sameCall = (c: ApiCall) => c.method === own.method && !!c.path && (bare.endsWith(c.path) || c.path === own.path);
  const match = [...timeline].reverse().find((t) => t.api?.failed && sameCall(t.api))?.api;
  // The path as the app names it, unless Settings names the host.
  return match ? { ...match, ...defined(own), service: match.service ?? own.service, path: named ? own.path : match.path } : own;
}

/** Drop undefined fields, so spreading doesn't erase a value from the breadcrumb. */
function defined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
