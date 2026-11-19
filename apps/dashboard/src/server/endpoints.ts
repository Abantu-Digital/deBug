import type { ReadStore } from "@debugkit/adapters";
import { isRequestCategory } from "@debugkit/ingest";
import { hostKindOf, hostNameFor, isOfflineIssue, isTestIssue, nameUrlsIn, type HostKind, type HostName, type Issue, type IssueStatus, type StoredEvent } from "@debugkit/schema";
import { apiCallOf, EVENT_LOOKBACK, failedRequest, timelineOf, type ApiCall } from "./event";
import { endpointTimings, retentionFor, type EndpointTiming, type Retention } from "./queries";
import { resolveRange, type DateRange } from "./range";
import { failing, OUTAGE, servicesOf } from "../lib/health";

/**
 * Endpoint health: how each API endpoint did over a period. Calls, failure rate and timings come
 * from the SDK's per-minute request summaries, which count every call. What went wrong (statuses,
 * backend codes, the failures themselves) comes from the stored network errors and the API
 * breadcrumb each carries for the call.
 */
export interface EndpointHealth {
  /** "<METHOD> <url>", as the SDK's request summaries name it; the link between the two sources. */
  endpoint: string;
  /** The backend service, as the app's breadcrumb or Settings names it. */
  service?: string;
  /** Whose service answers here, from Settings: our backend, or an upstream such as Cell C. */
  kind?: HostKind;
  /** The upstream's name, from Settings ("Cell C"). */
  provider?: string;
  /**
   * Calls that got no answer or a 5xx in the last OUTAGE.windowMs (before the report's time): who
   * they happened to (user ids, else install ids, else session ids; each once), how many, and the
   * statuses. Unset when none.
   */
  down?: { who: string[]; failures: number; statuses: Count[]; last: string };
  method?: string;
  path?: string;
  /**
   * From the request summaries: null when the SDK sent none for this endpoint. Failed calls are
   * those the SDK's network.isFailure counted (status 400 and above on mobile, else 500).
   */
  calls: number | null;
  failedCalls: number | null;
  failureRate: number | null;
  /** Upper bound of the bucket holding the median / 95th percentile, in ms (Infinity: over 10 s). */
  p50: number | null;
  p95: number | null;
  /** Stored failures (network errors) in the period. */
  failures: number;
  /** The failures' statuses ("503", or the outcome when there was no answer: "unreachable"), most first. */
  statuses: Count[];
  /** The backend's own error codes on the failures, most first. */
  backendCodes: Count[];
  /** The backend's own error messages on the failures ("Balance lookup unsuccessful"), most first. */
  backendMessages: Count[];
  /**
   * What the server said the last time it answered a failed call here: its status and body as
   * the SDK captured them (redacted on the phone), and the occurrence. Unset when it never did.
   */
  lastAnswer?: { status: number; body?: string; ts: string; eventId: string; fingerprint: string };
  /** The issues the failures belong to, most failures first: where to click for the cause and fix. */
  problems: EndpointProblem[];
  lastFailure?: string;
}

/** One issue's failures on one endpoint. */
export interface EndpointProblem {
  fingerprint: string;
  title: string;
  /** Its failures on this endpoint in the period. */
  count: number;
  /** The status most of them had: "404", or "no answer". */
  status: string;
  lastSeen: string;
  /** Platforms and app versions they were on, most first. */
  platforms: string[];
  versions: string[];
  /** The issue's status: resolved and ignored ones are listed apart. */
  issueStatus: IssueStatus;
  resolvedIn?: string;
}

/** Endpoints added up per backend service. */
export interface ServiceHealth {
  /** What groups it ("balance" for "balance" and "Balances"), and its address: /services/<key>. */
  key: string;
  /** undefined: endpoints whose service nobody named (in Settings or the app's breadcrumbs). */
  service?: string;
  /** Whose service it is, as its busiest endpoint with one set is. */
  kind?: HostKind;
  provider?: string;
  /** Its endpoints' recent no-answer and 5xx calls, together: see EndpointHealth.down. */
  down?: { users: number; failures: number; statuses: Count[]; last: string };
  endpoints: number;
  calls: number;
  failedCalls: number;
  failureRate: number | null;
  /** The slowest endpoint's p95. */
  worstP95: number | null;
  failures: number;
  lastFailure?: string;
}

export interface Count {
  key: string;
  count: number;
}

export interface EndpointFailure {
  eventId: string;
  fingerprint: string;
  ts: string;
  /** "503", or the outcome when there was no answer. */
  status: string;
  durationMs?: number;
  errorKind?: string;
  backendCode?: string;
  backendTitle?: string;
  traceId?: string;
  sessionId: string;
  userId?: string;
}

export interface EndpointsReport {
  app: string;
  generatedAt: string;
  apps: string[];
  range: DateRange;
  retention: Retention;
  /** Most failures first. */
  services: ServiceHealth[];
  /** Most failures first, then the busiest. */
  endpoints: EndpointHealth[];
  /** The chosen endpoint's failures in the period, newest first. */
  selected?: { endpoint: EndpointHealth; failures: EndpointFailure[] };
  /** The endpoint asked for, when it had no calls or failures in the period. */
  missing?: string;
  /**
   * True when the stored failures are undercounted: more network issues than one report reads,
   * or an issue with more failures than are read per issue.
   */
  truncated: boolean;
}

/** Network issues read per report, busiest first, and failures listed for one endpoint. */
export const ENDPOINT_ISSUE_LIMIT = 100;
export const ENDPOINT_FAILURE_LIMIT = 50;
const ISSUE_READ_LIMIT = 500;

/**
 * The key an endpoint counts under: "<METHOD> <url>" as the SDK's request summaries name it, with
 * the method in capitals and cut where the SDK cuts the summary's key.
 */
export function endpointKey(method: string, url: string): string {
  return `${method.toUpperCase()} ${url}`.slice(0, 300);
}

interface Failure {
  endpoint: string;
  /** Set when the key isn't "<METHOD> <url>": a failure the app reported, with no matching summary. */
  own?: { method?: string; path: string };
  call?: ApiCall;
  e: StoredEvent;
}

/**
 * A stored error that is a failed API call: the SDK's request on it, a request category label, or
 * (a failure the app reported itself) a failed call as its last breadcrumb, just before it.
 */
function isNetworkIssue(i: Issue): boolean {
  const e = i.lastEvent.event;
  if (e.type !== "error") return false;
  if (e.request || (i.lastEvent.labels?.category && isRequestCategory(i.lastEvent.labels.category))) return true;
  const last = e.breadcrumbs?.[e.breadcrumbs.length - 1];
  return !!last && !!apiCallOf(last)?.failed && Math.abs(Date.parse(e.ts) - Date.parse(last.ts)) <= 2000;
}

/**
 * The failed call an error describes, and the endpoint key it counts under: the SDK's request, or
 * for a failure the app reported itself, the request-summary key with the same method and path.
 */
function failureOf(e: StoredEvent, hosts: readonly HostName[] = [], keys: readonly string[] = []): Failure | undefined {
  if (e.event.type !== "error") return undefined;
  const req = e.event.request;
  const call = failedRequest(req, timelineOf(e.event.breadcrumbs, hosts), hosts);
  if (req) return { endpoint: endpointKey(req.method, req.url), call, e };
  if (!call?.path) return undefined;
  const known = keys.find((k) => sameCall(k, call.method, call.path!));
  if (known) return { endpoint: known, call, e };
  return { endpoint: [call.method, call.service, call.path].filter(Boolean).join(" "), own: { method: call.method, path: call.path }, call, e };
}

/** Whether a request-summary key ("<METHOD> <url>") is the call the app names by method and path. */
function sameCall(key: string, method: string | undefined, path: string): boolean {
  const [m, ...rest] = key.split(" ");
  const url = rest.join(" ").split(/[?#]/)[0]!;
  return (!method || m === method.toUpperCase()) && (url === path || url.endsWith(path.startsWith("/") ? path : `/${path}`));
}

/** "503", or the outcome or kind of failure when there was no answer. */
function statusOf(f: Failure): string {
  const c = f.call;
  const status = (f.e.event.type === "error" ? f.e.event.request?.status : undefined) ?? c?.status;
  if (status !== undefined) return String(status);
  const timedOut = f.e.event.type === "error" && /timed out|timeout/i.test(f.e.event.error.message);
  return c?.outcome ?? c?.errorKind ?? (timedOut ? "timed out" : "no answer");
}

function counts(values: readonly (string | undefined)[]): Count[] {
  const m = new Map<string, number>();
  for (const v of values) if (v) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

export async function buildEndpoints(
  store: ReadStore,
  appParam: string | undefined,
  now = Date.now(),
  opts: { range?: { range?: string; from?: string; to?: string }; endpoint?: string; retentionDays?: number } = {},
): Promise<EndpointsReport | null> {
  const apps = await store.listApps();
  const app = appParam && apps.includes(appParam) ? appParam : apps[0];
  if (!app) return null;
  const range = resolveRange(opts.range ?? {}, now);
  const [requestRows, latencyRows, issues, settings, retention] = await Promise.all([
    store.getRollups(app, "requests", range.from, range.to),
    store.getRollups(app, "latency", range.from, range.to),
    store.listIssues(app, { limit: ISSUE_READ_LIMIT }),
    store.getSettings(app).catch(() => null),
    retentionFor(store, app, opts.retentionDays, now),
  ]);
  const hosts = settings?.hosts ?? [];

  // The most recently failing first: they're the ones with failures in the period.
  // Test errors (ABA-133) and calls that never left the phone (ABA-132) are never an endpoint's failures.
  const network = issues.filter((i) => isNetworkIssue(i) && !isTestIssue(i) && !isOfflineIssue(i) && i.lastSeen.slice(0, 10) >= range.from).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  const read = network.slice(0, ENDPOINT_ISSUE_LIMIT);
  const perIssue = await Promise.all(read.map((i) => store.listIssueEvents(app, i.fingerprint, { limit: EVENT_LOOKBACK })));
  const events = perIssue.flat();
  const inRange = (e: StoredEvent) => e.day >= range.from && e.day <= range.to;
  // An issue whose oldest event read is still in the period may have more there.
  const capped = perIssue.some((list) => list.length >= EVENT_LOOKBACK && inRange(list[list.length - 1]!));
  const timings = new Map<string, EndpointTiming>();
  for (const t of endpointTimings(requestRows, latencyRows, hosts)) {
    const [m, ...rest] = t.endpoint.split(" ");
    timings.set(endpointKey(m!, rest.join(" ")), t);
  }
  const failures = events.filter(inRange).map((e) => failureOf(e, hosts, [...timings.keys()])).filter((f): f is Failure => !!f);

  const byEndpoint = new Map<string, Failure[]>();
  for (const f of failures) byEndpoint.set(f.endpoint, [...(byEndpoint.get(f.endpoint) ?? []), f]);

  // Every API call in the trails read, failed or not, names its service: learn them for the rest.
  const named = events.flatMap((e) => (e.event.type === "error" ? (e.event.breadcrumbs ?? []) : [])).map((b) => apiCallOf(b, hosts)).filter((c): c is ApiCall => !!c?.service && !!c.path);
  const serviceFor = (endpoint: string) => named.find((c) => sameCall(endpoint, c.method, c.path!));

  const byFingerprint = new Map(issues.map((i) => [i.fingerprint, { ...i, title: nameUrlsIn(i.title, hosts) }]));
  const rowFor = (endpoint: string): EndpointHealth => {
    const fs = byEndpoint.get(endpoint) ?? [];
    const t = timings.get(endpoint);
    const own = fs.find((f) => f.call?.service)?.call ?? serviceFor(endpoint);
    const fallback = fs.find((f) => f.own)?.own;
    const [first, ...rest] = endpoint.split(" ");
    const method = fallback ? fallback.method : first;
    const url = fallback ? fallback.path : rest.join(" ");
    const host = hostNameFor(url, hosts);
    const kind = hostKindOf(host?.host);
    return {
      endpoint,
      service: own?.service ?? host?.host.name,
      ...(kind ? { kind } : {}),
      ...(kind === "upstream" && host?.host.provider ? { provider: host.host.provider } : {}),
      down: downOf(fs, now),
      method: own?.method ?? method,
      path: host ? host.rest || "/" : (own?.path ?? url),
      calls: t?.requests ?? null,
      failedCalls: t?.failed ?? null,
      failureRate: t ? t.errorRate : null,
      p50: t?.p50 ?? null,
      p95: t?.p95 ?? null,
      failures: fs.length,
      statuses: counts(fs.map(statusOf)),
      backendCodes: counts(fs.map((f) => f.call?.backendCode)),
      backendMessages: counts(fs.map((f) => f.call?.backendTitle)),
      problems: problemsOf(fs, byFingerprint),
      lastAnswer: lastAnswerOf(fs),
      lastFailure: fs.map((f) => f.e.event.ts).sort().pop(),
    };
  };
  const endpoints = [...new Set([...timings.keys(), ...byEndpoint.keys()])]
    .map(rowFor)
    // The most failures first (by either count: the SDK's and the app's own differ), then the busiest.
    .sort((a, b) => failing(b) - failing(a) || (b.calls ?? 0) - (a.calls ?? 0));

  const chosen = opts.endpoint ? endpoints.find((r) => r.endpoint === opts.endpoint) : undefined;
  const selected = chosen && {
    endpoint: chosen,
    failures: (byEndpoint.get(chosen.endpoint) ?? [])
      .sort((a, b) => Date.parse(b.e.event.ts) - Date.parse(a.e.event.ts))
      .slice(0, ENDPOINT_FAILURE_LIMIT)
      .map(
        (f): EndpointFailure => ({
          eventId: f.e.event.id,
          fingerprint: f.e.fingerprint!,
          ts: f.e.event.ts,
          status: statusOf(f),
          durationMs: f.call?.durationMs,
          errorKind: f.call?.errorKind,
          backendCode: f.call?.backendCode,
          backendTitle: f.call?.backendTitle,
          traceId: f.call?.traceId,
          sessionId: f.e.sessionId,
          userId: f.e.user?.id,
        }),
      ),
  };
  return {
    app,
    generatedAt: new Date(now).toISOString(),
    apps,
    range,
    retention,
    services: servicesOf(endpoints),
    endpoints,
    selected,
    missing: opts.endpoint && !chosen ? opts.endpoint : undefined,
    truncated: issues.length >= ISSUE_READ_LIMIT || network.length > read.length || capped,
  };
}

/** The statuses that mean the server never answered. Anything else the app reports (sessionExpired, schemaError, …) isn't the server being down. */
const NO_ANSWER = new Set(["no answer", "timed out", "timeout", "unreachable"]);

/** No answer at all (unreachable, timed out) or a server error: the server, not the request, failed. */
export function isServerDown(status: string): boolean {
  const n = Number(status);
  return Number.isInteger(n) ? n >= 500 : NO_ANSWER.has(status);
}

/** Recent no-answer and 5xx failures on an endpoint: see EndpointHealth.down. */
function downOf(fs: readonly Failure[], now: number): EndpointHealth["down"] {
  const recent = fs.filter((f) => {
    const age = now - Date.parse(f.e.event.ts);
    return age >= 0 && age <= OUTAGE.windowMs && isServerDown(statusOf(f));
  });
  if (!recent.length) return undefined;
  return {
    // A person: their user id, else the install, else (with neither) the session.
    who: [...new Set(recent.map((f) => f.e.user?.id ?? f.e.user?.anonymousId ?? f.e.sessionId))],
    failures: recent.length,
    statuses: counts(recent.map(statusOf)),
    last: recent.map((f) => f.e.event.ts).sort().pop()!,
  };
}

/** How much of a server's answer an endpoint row carries. */
export const ANSWER_CHARS = 1_500;

/** The newest failure the server answered, with what it said. */
function lastAnswerOf(fs: readonly Failure[]): EndpointHealth["lastAnswer"] {
  const answered = fs
    .filter((f) => f.e.event.type === "error" && f.e.event.response)
    .sort((a, b) => b.e.event.ts.localeCompare(a.e.event.ts))[0];
  if (!answered || answered.e.event.type !== "error") return undefined;
  const r = answered.e.event.response!;
  // A page lists every endpoint: keep it light. The full body is on the occurrence's page.
  const body = r.body && r.body.length > ANSWER_CHARS ? `${r.body.slice(0, ANSWER_CHARS)}…` : r.body;
  return { status: r.status, body, ts: answered.e.event.ts, eventId: answered.e.event.id, fingerprint: answered.e.fingerprint! };
}

/** An endpoint's failures grouped by issue, most first. */
function problemsOf(fs: readonly Failure[], issues: ReadonlyMap<string, Pick<Issue, "title" | "status" | "resolvedIn">>): EndpointProblem[] {
  const by = new Map<string, Failure[]>();
  for (const f of fs) if (f.e.fingerprint) by.set(f.e.fingerprint, [...(by.get(f.e.fingerprint) ?? []), f]);
  return [...by.entries()]
    .map(([fingerprint, list]) => ({
      fingerprint,
      title: issues.get(fingerprint)?.title ?? fingerprint,
      issueStatus: issues.get(fingerprint)?.status ?? "open",
      resolvedIn: issues.get(fingerprint)?.resolvedIn,
      count: list.length,
      status: counts(list.map(statusOf))[0]?.key ?? "no answer",
      lastSeen: list.map((f) => f.e.event.ts).sort().pop()!,
      platforms: counts(list.map((f) => f.e.context.os.name)).map((c) => c.key),
      versions: counts(list.map((f) => f.e.context.app.version)).map((c) => c.key),
    }))
    .sort((a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen));
}


