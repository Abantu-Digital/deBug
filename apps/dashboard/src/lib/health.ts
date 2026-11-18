import { SEVERITY_ORDER, type Severity } from "@debugkit/schema";
import type { EndpointHealth, ServiceHealth } from "../server/endpoints";

/**
 * The health wall: one box per backend service, plus one for the app's own code, coloured by how
 * bad it is and ranked worst first. It answers "what's wrong, and how bad" at a glance; each box
 * opens the next level down (where, how often, what's causing it).
 */

/** A box's level: an issue level, or healthy (green, nothing failing). */
export type HealthLevel = Severity | "healthy";

export const HEALTH_ORDER: Record<HealthLevel, number> = { ...SEVERITY_ORDER, healthy: -1 };

/** Failure rates and counts that set a service's level. */
export const SERVICE_LEVELS = {
  critical: { rate: 0.25, failed: 5 },
  high: { rate: 0.1, failed: 3 },
  medium: { rate: 0.05, failed: 1 },
  /** With no request summaries from the SDK, stored failures alone. */
  storedHigh: 20,
  storedMedium: 5,
} as const;

/** Failing within this long ago counts as still happening. */
export const LIVE_MS = 60 * 60 * 1000;

/**
 * How bad a service is: by the share of its calls that failed, with enough failures that it isn't
 * one unlucky call. Without the SDK's request summaries, by stored failures alone.
 */
export function serviceLevel(s: Pick<ServiceHealth, "calls" | "failedCalls" | "failures">): HealthLevel {
  const L = SERVICE_LEVELS;
  if (s.calls > 0) {
    if (!s.failedCalls && !s.failures) return "healthy";
    const rate = s.failedCalls / s.calls;
    if (rate >= L.critical.rate && s.failedCalls >= L.critical.failed) return "critical";
    if (rate >= L.high.rate && s.failedCalls >= L.high.failed) return "high";
    if (rate >= L.medium.rate && s.failedCalls >= L.medium.failed) return "medium";
    return "low";
  }
  if (!s.failures) return "healthy";
  return s.failures >= L.storedHigh ? "high" : s.failures >= L.storedMedium ? "medium" : "low";
}

/** The last part of a path, for a short name: "/ppd/api/balance/getBalances" → "getBalances". */
export function shortPath(path: string | undefined): string {
  const parts = (path ?? "").split(/[?#]/)[0]!.split("/").filter((p) => p && !p.startsWith(":"));
  return parts[parts.length - 1] ?? path ?? "";
}

/**
 * What's wrong with a service, in one line, from its worst endpoint: the status, the backend's own
 * code and message, and which call. "404 · 30007 Balance lookup unsuccessful · POST /ppd/api/balance/getBalances".
 */
export function headlineOf(endpoints: readonly EndpointHealth[]): string | undefined {
  const worst = [...endpoints].filter((e) => e.failures > 0 || (e.failedCalls ?? 0) > 0).sort((a, b) => Math.max(b.failedCalls ?? 0, b.failures) - Math.max(a.failedCalls ?? 0, a.failures))[0];
  if (!worst) return undefined;
  const status = worst.statuses[0]?.key;
  const code = worst.backendCodes[0]?.key;
  const message = worst.backendMessages[0]?.key;
  const what = [status, [code, message].filter(Boolean).join(" ")].filter(Boolean).join(" · ") || "Failing";
  return `${what} · ${worst.method ? `${worst.method} ` : ""}${worst.path ?? worst.endpoint}`;
}

export interface HealthTileData {
  /** The service's name; "app" for the app's own code. */
  key: string;
  name: string;
  kind: "service" | "app";
  level: HealthLevel;
  /** What's wrong, in one line; undefined when healthy. */
  headline?: string;
  /** "27% of 126 calls failed", "2 crashes and code errors open". */
  measure: string;
  /** Failed within the last hour. */
  live: boolean;
  lastFailure?: string;
  /** For ranking: failed calls, or open occurrences for the app box. */
  weight: number;
  /** The app box: its worst open issue, which the box opens. */
  fingerprint?: string;
}


const pct = (r: number) => (r > 0 && r < 0.01 ? "<1%" : `${Math.round(r * 100)}%`);
export const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? "" : "s"}`;

export function serviceTile(s: ServiceHealth, endpoints: readonly EndpointHealth[], now: number): HealthTileData {
  const level = serviceLevel(s);
  const own = endpoints.filter((e) => serviceKey(e.service) === serviceKey(s.service));
  const measure =
    s.calls > 0
      ? s.failedCalls
        ? `${pct(s.failedCalls / s.calls)} of ${plural(s.calls, "call")} failed`
        : `${plural(s.calls, "call")}, none failed`
      : s.failures
        ? plural(s.failures, "failure")
        : "No calls";
  return {
    key: s.service ?? "",
    name: s.service ?? "Unnamed service",
    kind: "service",
    level,
    headline: level === "healthy" ? undefined : headlineOf(own),
    measure,
    live: level !== "healthy" && !!s.lastFailure && now - Date.parse(s.lastFailure) < LIVE_MS,
    lastFailure: s.lastFailure,
    weight: Math.max(s.failedCalls, s.failures),
  };
}

export const byHealth = (a: HealthTileData, b: HealthTileData) =>
  HEALTH_ORDER[b.level] - HEALTH_ORDER[a.level] || Number(b.live) - Number(a.live) || b.weight - a.weight || a.name.localeCompare(b.name);

/** "3 services are failing badly: balance, billing and hot-updater. Worst: balance, 404 · …" */
export function answerOf(tiles: readonly HealthTileData[], rangeLabel: string): string {
  const failing = tiles.filter((t) => t.level !== "healthy" && t.level !== "low");
  if (!failing.length) return `Nothing is failing badly in ${rangeLabel}.${tiles.some((t) => t.level === "low") ? " A few one-off failures, listed in grey." : ""}`;
  const names = (ts: readonly HealthTileData[]) => (ts.length === 1 ? ts[0]!.name : `${ts.slice(0, -1).map((t) => t.name).join(", ")} and ${ts[ts.length - 1]!.name}`);
  const critical = failing.filter((t) => t.level === "critical");
  const lead = critical.length
    ? `${critical.length === 1 ? "1 part is" : `${critical.length} parts are`} failing badly in ${rangeLabel}: ${names(critical)}.`
    : `${failing.length === 1 ? "1 part has" : `${failing.length} parts have`} problems in ${rangeLabel}: ${names(failing)}.`;
  const top = failing[0]!;
  const live = failing.filter((t) => t.live).length;
  return [lead, `Worst: ${top.name}, ${top.measure}${top.headline ? ` (${top.headline})` : ""}.`, live ? `${live === 1 ? "1 is" : `${live} are`} still happening (failed in the last hour).` : ""].filter(Boolean).join(" ");
}


/**
 * The name a service is grouped under: case and a trailing "s" don't make a different service
 * ("Surveys" and "surveys", "balance" and "Balances").
 */
export const serviceKey = (service: string | undefined): string => (service ?? "").trim().toLowerCase().replace(/s$/, "");

/** How badly an endpoint fails: the larger of the SDK's failed calls and the stored failures. */
export const failing = (r: { failedCalls: number | null; failures: number }) => Math.max(r.failedCalls ?? 0, r.failures);

/** Endpoints added up per service, most failures first. */
export function servicesOf(endpoints: readonly EndpointHealth[]): ServiceHealth[] {
  const by = new Map<string, EndpointHealth[]>();
  for (const e of endpoints) by.set(serviceKey(e.service), [...(by.get(serviceKey(e.service)) ?? []), e]);
  return [...by.values()]
    .map((list) => {
      // The name the busiest of its endpoints goes by.
      const service = [...list].sort((a, b) => (b.calls ?? 0) - (a.calls ?? 0))[0]!.service;
      const calls = list.reduce((n, e) => n + (e.calls ?? 0), 0);
      const failedCalls = list.reduce((n, e) => n + (e.failedCalls ?? 0), 0);
      const p95s = list.map((e) => e.p95).filter((v): v is number => v !== null);
      return {
        service,
        endpoints: list.length,
        calls,
        failedCalls,
        failureRate: calls ? failedCalls / calls : null,
        worstP95: p95s.length ? Math.max(...p95s) : null,
        failures: list.reduce((n, e) => n + e.failures, 0),
        lastFailure: list.map((e) => e.lastFailure).filter((t): t is string => !!t).sort().pop(),
      };
    })
    .sort((a, b) => failing(b) - failing(a) || b.calls - a.calls);
}
