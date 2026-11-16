import type { ReadStore } from "@debugkit/adapters";
import { isRequestCategory } from "@debugkit/ingest";
import { hostNameFor, type HostName, type Issue, type StoredEvent } from "@debugkit/schema";
import { EVENT_LOOKBACK, failedRequest, timelineOf, type ApiCall } from "./event";
import { endpointTimings, retentionFor, type Retention } from "./queries";
import { resolveRange, type DateRange } from "./range";

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
  method?: string;
  path?: string;
  /** From the request summaries: null when the SDK sent none for this endpoint. */
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
  apps: string[];
  range: DateRange;
  retention: Retention;
  endpoints: EndpointHealth[];
  /** The chosen endpoint's failures in the period, newest first. */
  selected?: { endpoint: EndpointHealth; failures: EndpointFailure[] };
  /** True when there were more network issues than one report reads: the quietest are left out. */
  truncated: boolean;
}

/** Network issues read per report, busiest first, and failures listed for one endpoint. */
export const ENDPOINT_ISSUE_LIMIT = 100;
export const ENDPOINT_FAILURE_LIMIT = 50;

interface Failure {
  endpoint: string;
  call?: ApiCall;
  e: StoredEvent;
}

/** A stored error that is a failed API call: the SDK's request on it, or a request category label. */
function isNetworkIssue(i: Issue): boolean {
  const e = i.lastEvent;
  return e.event.type === "error" && (!!e.event.request || (!!e.labels?.category && isRequestCategory(e.labels.category)));
}

/** The failed call an error describes, and the endpoint key it counts under. */
export function failureOf(e: StoredEvent, hosts: readonly HostName[] = []): Failure | undefined {
  if (e.event.type !== "error") return undefined;
  const req = e.event.request;
  const call = failedRequest(req, timelineOf(e.event.breadcrumbs, hosts), hosts);
  if (req) return { endpoint: `${req.method} ${req.url}`, call, e };
  if (!call?.path) return undefined;
  // App-reported, without the SDK's request: named by the app's breadcrumb.
  return { endpoint: [call.method, call.service, call.path].filter(Boolean).join(" "), call, e };
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
    store.listIssues(app, { limit: 500 }),
    store.getSettings(app).catch(() => null),
    retentionFor(store, app, opts.retentionDays, now),
  ]);
  const hosts = settings?.hosts ?? [];

  const network = issues.filter((i) => isNetworkIssue(i) && i.lastSeen.slice(0, 10) >= range.from).sort((a, b) => b.count - a.count);
  const read = network.slice(0, ENDPOINT_ISSUE_LIMIT);
  const events = (await Promise.all(read.map((i) => store.listIssueEvents(app, i.fingerprint, { limit: EVENT_LOOKBACK })))).flat();
  const inRange = (e: StoredEvent) => e.day >= range.from && e.day <= range.to;
  const failures = events.filter(inRange).map((e) => failureOf(e, hosts)).filter((f): f is Failure => !!f);

  const byEndpoint = new Map<string, Failure[]>();
  for (const f of failures) byEndpoint.set(f.endpoint, [...(byEndpoint.get(f.endpoint) ?? []), f]);
  const timings = new Map(endpointTimings(requestRows, latencyRows, hosts).map((t) => [t.endpoint, t]));

  const rowFor = (endpoint: string): EndpointHealth => {
    const fs = byEndpoint.get(endpoint) ?? [];
    const t = timings.get(endpoint);
    const named = fs.find((f) => f.call?.service)?.call;
    const [method, ...rest] = endpoint.split(" ");
    const url = rest.join(" ");
    const host = hostNameFor(url, hosts);
    return {
      endpoint,
      service: named?.service ?? host?.host.name,
      method: named?.method ?? method,
      path: named?.path ?? (host ? host.rest || "/" : url),
      calls: t?.requests ?? null,
      failedCalls: t?.failed ?? null,
      failureRate: t ? t.errorRate : null,
      p50: t?.p50 ?? null,
      p95: t?.p95 ?? null,
      failures: fs.length,
      statuses: counts(fs.map(statusOf)),
      backendCodes: counts(fs.map((f) => f.call?.backendCode)),
      lastFailure: fs.map((f) => f.e.event.ts).sort().pop(),
    };
  };
  const endpoints = [...new Set([...timings.keys(), ...byEndpoint.keys()])]
    .map(rowFor)
    // The most failures first, then the busiest.
    .sort((a, b) => (b.failedCalls ?? b.failures) - (a.failedCalls ?? a.failures) || b.failures - a.failures || (b.calls ?? 0) - (a.calls ?? 0));

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
  return { app, apps, range, retention, endpoints, selected, truncated: network.length > read.length };
}
