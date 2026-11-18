import { SEVERITY_ORDER, type Severity } from "@debugkit/schema";
// Types only: erased at build, so nothing from the server reaches the browser.
import type { EndpointHealth, ServiceHealth } from "../server/endpoints";

/**
 * The health wall: one box per backend service, plus one for the app's own code, coloured by how
 * bad it is and ranked worst first. It answers "what's wrong, and how bad" at a glance; each box
 * opens the next level down (where, how often, what's causing it). Pure functions, used by both
 * the server (to build the wall) and the pages (to group and colour).
 */

/** A box's level: an issue level, or healthy (green, nothing failing). */
export type HealthLevel = Severity | "healthy";

/** Worst first when sorted descending; healthy comes last. */
export const HEALTH_ORDER: Record<HealthLevel, number> = { ...SEVERITY_ORDER, healthy: -1 };

/**
 * What sets a service's level. Two ways to be bad: a large share of calls failing (with enough
 * failures that it isn't one unlucky call), or a large number failing even when the share is
 * small, because that's still many customers.
 */
export const SERVICE_LEVELS = {
  critical: { rate: 0.25, failed: 5, volume: 500 },
  high: { rate: 0.1, failed: 3, volume: 100 },
  medium: { rate: 0.05, failed: 1 },
  /** With no request summaries from the SDK: stored failures alone. */
  stored: { critical: 50, high: 20, medium: 5 },
} as const;

/** Failing within this long ago counts as still happening. */
export const LIVE_MS = 60 * 60 * 1000;

/** The address part for endpoints nobody named a service for. */
export const UNNAMED = "-";

/** How badly an endpoint fails: the larger of the SDK's failed calls and the stored failures. */
export const failing = (r: { failedCalls: number | null; failures: number }) => Math.max(r.failedCalls ?? 0, r.failures);

/** "27%", or "<1%" for a small share that isn't none. */
export const pct = (r: number) => (r > 0 && r < 0.01 ? "<1%" : `${Math.round(r * 100)}%`);

/** "1 call", "126 calls". */
export const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? "" : "s"}`;

/** How bad a service is, by share and by number of failed calls. See SERVICE_LEVELS. */
export function serviceLevel(s: Pick<ServiceHealth, "calls" | "failedCalls" | "failures">): HealthLevel {
  const L = SERVICE_LEVELS;
  if (s.calls > 0) {
    if (!s.failedCalls && !s.failures) return "healthy";
    const rate = s.failedCalls / s.calls;
    if (s.failedCalls >= L.critical.volume || (rate >= L.critical.rate && s.failedCalls >= L.critical.failed)) return "critical";
    if (s.failedCalls >= L.high.volume || (rate >= L.high.rate && s.failedCalls >= L.high.failed)) return "high";
    if (rate >= L.medium.rate && s.failedCalls >= L.medium.failed) return "medium";
    return "low";
  }
  const n = s.failures;
  return !n ? "healthy" : n >= L.stored.critical ? "critical" : n >= L.stored.high ? "high" : n >= L.stored.medium ? "medium" : "low";
}

/**
 * How to group service names: case doesn't matter, and a plural joins its singular when both are
 * there ("Balances" with "balance"). "status" stays "status" when there's no "statu".
 */
export function serviceKeys(names: readonly (string | undefined)[]): (name: string | undefined) => string {
  const lower = (n: string | undefined) => (n ?? "").trim().toLowerCase();
  const known = new Set(names.map(lower));
  return (name) => {
    const l = lower(name);
    return l.endsWith("s") && known.has(l.slice(0, -1)) ? l.slice(0, -1) : l;
  };
}

/** Endpoints added up per service, most failures first. */
export function servicesOf(endpoints: readonly EndpointHealth[]): ServiceHealth[] {
  const keyOf = serviceKeys(endpoints.map((e) => e.service));
  const by = new Map<string, EndpointHealth[]>();
  for (const e of endpoints) by.set(keyOf(e.service), [...(by.get(keyOf(e.service)) ?? []), e]);
  return [...by.entries()]
    .map(([key, list]) => {
      const calls = list.reduce((n, e) => n + (e.calls ?? 0), 0);
      const failedCalls = list.reduce((n, e) => n + (e.failedCalls ?? 0), 0);
      const p95s = list.map((e) => e.p95).filter((v): v is number => v !== null);
      return {
        key: key || UNNAMED,
        // The name the busiest of its endpoints goes by.
        service: [...list].sort((a, b) => (b.calls ?? 0) - (a.calls ?? 0))[0]!.service,
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

/** A service's endpoints, by its key (as in the address). */
export function endpointsOf(key: string, endpoints: readonly EndpointHealth[]): EndpointHealth[] {
  const keyOf = serviceKeys(endpoints.map((e) => e.service));
  return endpoints.filter((e) => (keyOf(e.service) || UNNAMED) === key);
}

/**
 * What's wrong with a service, in one line, from its worst endpoint: the status, the backend's own
 * code and message, and which call. "404 · 30007 Balance lookup unsuccessful · POST /ppd/api/balance/getBalances".
 */
export function headlineOf(endpoints: readonly EndpointHealth[]): string | undefined {
  const worst = [...endpoints].filter((e) => failing(e) > 0).sort((a, b) => failing(b) - failing(a))[0];
  if (!worst) return undefined;
  const status = worst.statuses[0]?.key;
  const code = worst.backendCodes[0]?.key;
  const message = worst.backendMessages[0]?.key;
  const what = [status, [code, message].filter(Boolean).join(" ")].filter(Boolean).join(" · ") || "Failing";
  return `${what} · ${worst.method ? `${worst.method} ` : ""}${worst.path ?? worst.endpoint}`;
}

/** One box on the health wall. */
export interface HealthTileData {
  /** Where the box leads: a service's key, or "app" for the app's own code. */
  key: string;
  name: string;
  kind: "service" | "app";
  level: HealthLevel;
  /** What's wrong, in one line; undefined when healthy. */
  headline?: string;
  /** "27% of 126 calls failed", "3 crashes or code errors open". */
  measure: string;
  /** Failed within the last hour. */
  live: boolean;
  lastFailure?: string;
  /** For ranking within a level: failed calls, or open occurrences for the app box. */
  weight: number;
  /** The app box opens its worst open issue until the issue list can filter to app code (ABA-142). */
  fingerprint?: string;
}

/** A service's box: its level, what's wrong, and how much. */
export function serviceTile(s: ServiceHealth, endpoints: readonly EndpointHealth[], now: number): HealthTileData {
  const level = serviceLevel(s);
  const measure =
    s.calls > 0
      ? s.failedCalls
        ? `${pct(s.failedCalls / s.calls)} of ${plural(s.calls, "call")} failed`
        : `${plural(s.calls, "call")}, none failed`
      : s.failures
        ? plural(s.failures, "failure")
        : "No calls";
  return {
    key: s.key,
    name: s.service ?? "Unnamed service",
    kind: "service",
    level,
    headline: level === "healthy" ? undefined : headlineOf(endpointsOf(s.key, endpoints)),
    measure,
    live: level !== "healthy" && !!s.lastFailure && now - Date.parse(s.lastFailure) < LIVE_MS,
    lastFailure: s.lastFailure,
    weight: failing(s),
  };
}

/** Worst level first, then still happening, then most failures, then by name. */
export const byHealth = (a: HealthTileData, b: HealthTileData) =>
  HEALTH_ORDER[b.level] - HEALTH_ORDER[a.level] || Number(b.live) - Number(a.live) || b.weight - a.weight || a.name.localeCompare(b.name);

/**
 * The answer to "why is it breaking?", for a client: what's failing badly, the worst of it with
 * what the server said, whether it's still happening, and how much is healthy.
 */
export function answerOf(tiles: readonly HealthTileData[], rangeLabel: string): string {
  const healthy = tiles.filter((t) => t.level === "healthy").length;
  const healthyLine = `${healthy} of ${tiles.length} ${tiles.length === 1 ? "part is" : "parts are"} healthy.`;
  const failingBadly = tiles.filter((t) => t.level !== "healthy" && t.level !== "low");
  if (!failingBadly.length) return `Nothing is failing badly in ${rangeLabel}. ${healthyLine}`;
  const names = (ts: readonly HealthTileData[]) => (ts.length === 1 ? ts[0]!.name : `${ts.slice(0, -1).map((t) => t.name).join(", ")} and ${ts[ts.length - 1]!.name}`);
  const critical = failingBadly.filter((t) => t.level === "critical");
  const lead = critical.length
    ? `${critical.length === 1 ? "1 part is" : `${critical.length} parts are`} failing badly in ${rangeLabel}: ${names(critical)}.`
    : `${failingBadly.length === 1 ? "1 part has" : `${failingBadly.length} parts have`} problems in ${rangeLabel}: ${names(failingBadly)}.`;
  const top = failingBadly[0]!;
  const live = failingBadly.filter((t) => t.live).length;
  return [
    lead,
    `Worst: ${top.name}, ${top.measure}${top.headline ? ` (${top.headline})` : ""}.`,
    live ? `${live === 1 ? "1 is" : `${live} are`} still happening (failed in the last hour).` : "",
    healthyLine,
  ]
    .filter(Boolean)
    .join(" ");
}
