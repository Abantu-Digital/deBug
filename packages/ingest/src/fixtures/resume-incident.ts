import type { Breadcrumb, ErrorEvent } from "@debugkit/schema";

/**
 * Cell C staging, 14 Nov 2026, iPhone 16 Pro Max, app 10.1.29: the app came back to the
 * foreground and every request failed within 3–49 ms for the next 6 s. Real timings and
 * breadcrumbs; hosts and paths anonymised, device tags dropped.
 */
const T = "2026-11-14T";
type Row = [ts: string, method: string, url: string, status: number | null, ms: number];

const A = "api-a.example.com";
const B = "api-b.example.com";

const requests: Row[] = [
  ["12:59:51.752", "GET", `${A}/api/app-force-update`, 200, 33],
  ["12:59:51.752", "GET", `${A}/api/app-maintenance`, 200, 33],
  ["12:59:51.799", "POST", `${B}/api/balance/getDetailedSummary`, 200, 307],
  ["12:59:52.051", "POST", `${B}/api/balance/getBalances`, 200, 560],
  ["12:59:52.094", "GET", "api-c.example.com/api/linked-numbers", 200, 41],
  ["12:59:52.123", "GET", `${A}/api/banners`, 200, 69],
  ["12:59:52.540", "GET", "api-d.example.com/api/airtime/balance", 200, 485],
  ["12:59:55.467", "GET", `${A}/api/app-force-update`, null, 17],
  ["12:59:55.500", "GET", `${A}/api/app-maintenance`, null, 49],
  ["12:59:58.762", "GET", `${A}/api/app-force-update`, null, 3],
  ["12:59:58.783", "GET", `${A}/api/app-maintenance`, null, 24],
  ["13:00:01.303", "POST", `${B}/api/balance/getBalances`, null, 16],
  ["13:00:01.330", "POST", `${B}/api/balance/getDetailedSummary`, null, 42],
];

const timeline: Breadcrumb[] = [
  ...requests.map(([ts, method, url, status, ms]): Breadcrumb => ({
    ts: `${T}${ts}Z`,
    category: "network",
    message: `${method} ${url} → ${status ?? "failed"} (${ms}ms)`,
    level: status === null ? "error" : "info",
    data: { status, durationMs: ms },
  })),
  { ts: `${T}12:59:52.891Z`, category: "ui", message: "App went to the background", level: "info" } satisfies Breadcrumb,
  { ts: `${T}12:59:55.450Z`, category: "ui", message: "App came to the foreground", level: "info" } satisfies Breadcrumb,
].sort((a, b) => a.ts.localeCompare(b.ts));

/** The six failures, as the SDK reported them: each carries the breadcrumbs up to and including its own request. */
export const resumeIncident: ErrorEvent[] = requests
  .filter(([, , , status]) => status === null)
  .map(([ts, method, url, , ms], i) => ({
    id: `resume-incident-${i}`,
    ts: `${T}${ts}Z`,
    type: "error",
    handled: true,
    tags: { source: "network" },
    error: { name: "NetworkError", message: `${method} ${url} failed` },
    request: { method, url, durationMs: ms },
    breadcrumbs: timeline.filter((b) => b.ts <= `${T}${ts}Z`),
  }));
