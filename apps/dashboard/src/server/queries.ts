import type { ReadStore } from "@debugkit/adapters";
import {
  SEVERITY_ORDER,
  severityFromCount,
  type Issue,
  type RollupRow,
  type Severity,
  type SeverityThresholds,
  type StoredEvent,
} from "@debugkit/schema";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);
const hourKey = (t: number) => new Date(t).toISOString().slice(0, 13);

function days(now: number, n: number) {
  return Array.from({ length: n }, (_, i) => dayKey(now - (n - 1 - i) * DAY));
}
function hours(now: number, n: number) {
  return Array.from({ length: n }, (_, i) => hourKey(now - (n - 1 - i) * HOUR));
}

export interface IssueRow {
  fingerprint: string;
  title: string;
  culprit?: string;
  flow?: string;
  severity: Severity;
  /** Occurrences in the trailing 24h. Severity is derived from this. */
  count24h: number;
  /** Occurrences since the issue was first seen. */
  countTotal: number;
  firstSeen: string;
  lastSeen: string;
}

export interface FlowRow {
  flow: string;
  errors24h: number;
  errors14d: number;
  /** Highest severity of any issue in the flow. */
  severity: Severity;
  issues: number;
  successes14d: number;
  failures14d: number;
  /** failures / (failures + successes) over 14d, from events logged with an outcome. null if no outcome events. */
  failureRate: number | null;
}

export interface Summary {
  app: string;
  apps: string[];
  generatedAt: string;
  totals: {
    errors24h: number;
    errorsPrev24h: number;
    /** Percent change vs the previous 24h, null when the previous window had no errors. */
    changePct: number | null;
    /** Non-error events (custom events) over the last 14 days. */
    events14d: number;
    activeIssues: number;
    criticalIssues: number;
    failingFlows: number;
  };
  narrative: string[];
  trend: { day: string; errors: number; events: number }[];
  flows: FlowRow[];
  issues: IssueRow[];
  breakdowns: Record<"os" | "appVersion" | "deviceModel", { key: string; errors: number }[]>;
  health: Health;
}

export interface ReleaseHealth {
  version: string;
  sessions: number;
  errored: number;
  crashed: number;
  /** 1 - crashed / sessions. null when no sessions were recorded. */
  crashFreeRate: number | null;
  errorFreeRate: number | null;
}

export interface Health {
  /** Sessions started in the last 14 days (sent automatically by the SDK). 0 when the SDK predates sessions. */
  sessions14d: number;
  crashFreeRate: number | null;
  errorFreeRate: number | null;
  /** Newest releases first (by version order), at most 8. */
  releases: ReleaseHealth[];
  /** Endpoints with the most failed requests (5xx, timeouts, network failures) over 14 days. */
  endpoints: { endpoint: string; failures14d: number; failures24h: number }[];
}

/** Description of every field, shipped with the JSON API so agents can interpret it without docs. */
export const SUMMARY_FIELDS = {
  "totals.errors24h": "Error events in the trailing 24 hours (exact, from hourly rollups).",
  "totals.changePct": "Percent change of errors vs the previous 24h window.",
  "totals.activeIssues": "Distinct grouped errors (issues) seen in the last 14 days.",
  "totals.criticalIssues": "Issues whose 24h occurrence count meets the critical threshold.",
  "flows[]": "Parts of the app as tagged by the developer (e.g. auth.login). Sorted by severity, then errors24h.",
  "flows[].failureRate": "failures/(failures+successes) from events logged with an outcome. null when the app logs no outcomes for that flow.",
  "issues[]": "Grouped errors. Sorted by severity, then count24h.",
  "issues[].severity": "Derived from count24h using thresholds critical/high/medium.",
  "issues[].culprit": "Top in-app stack frame: function (file:line).",
  "trend[]": "Errors and non-error events per UTC day for the last 14 days.",
  "breakdowns": "Errors over the last 14 days split by OS, app version and device model.",
  narrative: "Plain-language summary of what is going wrong right now.",
  "health.crashFreeRate": "Share of sessions in 14 days with no fatal crash. Sessions are recorded automatically by the SDK.",
  "health.errorFreeRate": "Share of sessions in 14 days with no unhandled error.",
  "health.releases[]": "Crash-free and error-free rates per app version.",
  "health.endpoints[]": "HTTP endpoints whose requests failed most (5xx, timeouts, network errors), from automatic network capture.",
} as const;

async function counts24hByIssue(store: ReadStore, app: string, now: number) {
  const hs = hours(now, 24);
  const rows = await store.getRollups(app, "issueHour", hs[0]!, hs[hs.length - 1]!);
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.key, (map.get(r.key) ?? 0) + r.errors);
  return map;
}

export async function buildSummary(
  store: ReadStore,
  appParam: string | undefined,
  thresholds: SeverityThresholds,
  now = Date.now(),
): Promise<Summary | null> {
  const apps = await store.listApps();
  const app = appParam && apps.includes(appParam) ? appParam : apps[0];
  if (!app) return null;

  const d14 = days(now, 14);
  const from = d14[0]!;
  const to = d14[d14.length - 1]!;
  const [sessionRows, endpointRows, total, flowRows, outcomeRows, os, appVersion, deviceModel, issues, issue24h, hourly] = await Promise.all([
    store.getRollups(app, "session", from, to),
    store.getRollups(app, "endpoint", from, to),
    store.getRollups(app, "total", from, to),
    store.getRollups(app, "flow", from, to),
    store.getRollups(app, "flowOutcome", from, to),
    store.getRollups(app, "os", from, to),
    store.getRollups(app, "appVersion", from, to),
    store.getRollups(app, "deviceModel", from, to),
    store.listIssues(app, { limit: 500 }),
    counts24hByIssue(store, app, now),
    // 48 hours of issueHour rollups gives exact 24h vs previous-24h error totals.
    store.getRollups(app, "issueHour", hours(now, 48)[0]!, hourKey(now)),
  ]);

  const trend = d14.map((day) => {
    const r = total.find((x) => x.day === day);
    return { day, errors: r?.errors ?? 0, events: r?.events ?? 0 };
  });

  const h24 = new Set(hours(now, 24));
  let errors24h = 0;
  let errorsPrev24h = 0;
  for (const r of hourly) (h24.has(r.day) ? (errors24h += r.errors) : (errorsPrev24h += r.errors));

  const since14 = new Date(now - 14 * DAY).toISOString();
  const issueRows: IssueRow[] = issues
    .filter((i) => i.lastSeen >= since14)
    .map((i) => toIssueRow(i, issue24h.get(i.fingerprint) ?? 0, thresholds))
    .sort(bySeverityThenCount);

  const flowMap = new Map<string, FlowRow>();
  const flowOf = (flow: string) => {
    let f = flowMap.get(flow);
    if (!f) flowMap.set(flow, (f = { flow, errors24h: 0, errors14d: 0, severity: "low", issues: 0, successes14d: 0, failures14d: 0, failureRate: null }));
    return f;
  };
  for (const r of flowRows) if (r.errors > 0) flowOf(r.key).errors14d += r.errors;
  for (const i of issueRows) {
    const f = flowOf(i.flow ?? "untagged");
    f.issues++;
    f.errors24h += i.count24h;
    if (SEVERITY_ORDER[i.severity] > SEVERITY_ORDER[f.severity]) f.severity = i.severity;
  }
  for (const r of outcomeRows) {
    const [flow, outcome] = r.key.split("|");
    const f = flowOf(flow!);
    if (outcome === "success") f.successes14d += r.events;
    else if (outcome === "failure") f.failures14d += r.events;
  }
  const flows = [...flowMap.values()]
    .map((f) => ({ ...f, failureRate: f.successes14d + f.failures14d > 0 ? f.failures14d / (f.successes14d + f.failures14d) : null }))
    .filter((f) => f.errors14d > 0 || f.failures14d > 0)
    .sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] || b.errors24h - a.errors24h || b.errors14d - a.errors14d);

  const top = (rows: { key: string; errors: number }[]) => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.key, (m.get(r.key) ?? 0) + r.errors);
    return [...m.entries()].map(([key, errors]) => ({ key, errors })).filter((r) => r.errors > 0).sort((a, b) => b.errors - a.errors).slice(0, 8);
  };

  const summary: Summary = {
    app,
    apps,
    generatedAt: new Date(now).toISOString(),
    totals: {
      errors24h,
      errorsPrev24h,
      changePct: errorsPrev24h > 0 ? Math.round(((errors24h - errorsPrev24h) / errorsPrev24h) * 100) : null,
      events14d: trend.reduce((a, d) => a + d.events, 0),
      activeIssues: issueRows.length,
      criticalIssues: issueRows.filter((i) => i.severity === "critical").length,
      failingFlows: flows.filter((f) => f.errors24h > 0).length,
    },
    narrative: [],
    trend,
    flows,
    issues: issueRows,
    breakdowns: { os: top(os), appVersion: top(appVersion), deviceModel: top(deviceModel) },
    health: buildHealth(sessionRows, endpointRows, dayKey(now)),
  };
  summary.narrative = narrate(summary);
  return summary;
}

const rate = (bad: number, total: number) => (total > 0 ? Math.max(0, 1 - bad / total) : null);

/** "2.10.0" sorts after "2.9.1". */
function compareVersions(a: string, b: string) {
  const pa = a.split(/[.-]/);
  const pb = b.split(/[.-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "";
    const y = pb[i] ?? "";
    const d = /^\d+$/.test(x) && /^\d+$/.test(y) ? Number(x) - Number(y) : x.localeCompare(y);
    if (d) return d;
  }
  return 0;
}

function buildHealth(sessionRows: RollupRow[], endpointRows: RollupRow[], today: string): Health {
  const byVersion = new Map<string, ReleaseHealth>();
  for (const r of sessionRows) {
    const [version = "unknown", status] = r.key.split("|");
    let v = byVersion.get(version);
    if (!v) byVersion.set(version, (v = { version, sessions: 0, errored: 0, crashed: 0, crashFreeRate: null, errorFreeRate: null }));
    if (status === "started") v.sessions += r.events;
    else if (status === "errored") v.errored += r.events;
    else if (status === "crashed") v.crashed += r.events;
  }
  const releases = [...byVersion.values()]
    .map((v) => ({ ...v, crashFreeRate: rate(v.crashed, v.sessions), errorFreeRate: rate(v.errored, v.sessions) }))
    .filter((v) => v.sessions > 0)
    .sort((a, b) => compareVersions(b.version, a.version))
    .slice(0, 8);
  const sum = (k: "sessions" | "errored" | "crashed") => [...byVersion.values()].reduce((a, v) => a + v[k], 0);

  const eps = new Map<string, { endpoint: string; failures14d: number; failures24h: number }>();
  for (const r of endpointRows) {
    let e = eps.get(r.key);
    if (!e) eps.set(r.key, (e = { endpoint: r.key, failures14d: 0, failures24h: 0 }));
    e.failures14d += r.errors;
    if (r.day === today) e.failures24h += r.errors;
  }
  return {
    sessions14d: sum("sessions"),
    crashFreeRate: rate(sum("crashed"), sum("sessions")),
    errorFreeRate: rate(sum("errored"), sum("sessions")),
    releases,
    endpoints: [...eps.values()].sort((a, b) => b.failures14d - a.failures14d).slice(0, 8),
  };
}

function toIssueRow(i: Issue, count24h: number, t: SeverityThresholds): IssueRow {
  return {
    fingerprint: i.fingerprint,
    title: i.title,
    culprit: i.culprit,
    flow: i.flow,
    severity: severityFromCount(count24h, t),
    count24h,
    countTotal: i.count,
    firstSeen: i.firstSeen,
    lastSeen: i.lastSeen,
  };
}

const bySeverityThenCount = (a: IssueRow, b: IssueRow) =>
  SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] || b.count24h - a.count24h || b.lastSeen.localeCompare(a.lastSeen);

const pct = (n: number) => `${Math.round(n * 100)}%`;
const pctOne = (n: number) => `${(Math.floor(n * 1000) / 10).toFixed(1)}%`;

function narrate(s: Summary): string[] {
  const out: string[] = [];
  const t = s.totals;
  if (t.errors24h === 0) {
    out.push("No errors in the last 24 hours.");
    return out;
  }
  const change =
    t.changePct === null ? "" : t.changePct === 0 ? ", flat versus the day before" : `, ${t.changePct > 0 ? "up" : "down"} ${Math.abs(t.changePct)}% on the previous 24h`;
  out.push(`${t.errors24h.toLocaleString()} errors in the last 24 hours${change}, across ${t.failingFlows} part${t.failingFlows === 1 ? "" : "s"} of the app.`);
  const f = s.flows[0];
  if (f && f.errors24h > 0) {
    const rate = f.failureRate !== null ? ` ${pct(f.failureRate)} of attempts fail.` : "";
    out.push(`${f.flow} is the most affected flow (${f.severity}): ${f.errors24h} errors in 24h from ${f.issues} issue${f.issues === 1 ? "" : "s"}.${rate}`);
  }
  const i = s.issues[0];
  if (i && i.count24h > 0) {
    const isNew = Date.parse(s.generatedAt) - Date.parse(i.firstSeen) < 3 * DAY;
    out.push(`Top issue: "${i.title}"${i.culprit ? ` in ${i.culprit}` : ""} — ${i.count24h} time${i.count24h === 1 ? "" : "s"} in 24h${isNew ? `, first seen ${relDays(s.generatedAt, i.firstSeen)}` : ""}.`);
  }
  const h = s.health;
  const latest = h.releases[0];
  const prev = h.releases[1];
  if (latest?.crashFreeRate != null && latest.sessions >= 20 && latest.crashFreeRate < 0.995) {
    const vs = prev?.crashFreeRate != null && prev.sessions >= 20 ? ` (${prev.version}: ${pctOne(prev.crashFreeRate)})` : "";
    out.push(`${latest.version} is ${pctOne(latest.crashFreeRate)} crash-free across ${latest.sessions.toLocaleString()} sessions${vs}.`);
  }
  const ep = h.endpoints[0];
  if (ep && ep.failures24h > 0) out.push(`${ep.endpoint} is the most failing endpoint: ${ep.failures24h} failed request${ep.failures24h === 1 ? "" : "s"} today.`);
  const os = s.breakdowns.os;
  const osTotal = os.reduce((a, b) => a + b.errors, 0);
  if (os[0] && osTotal > 20 && os[0].errors / osTotal > 0.6) out.push(`${pct(os[0].errors / osTotal)} of errors in the last 14 days come from ${os[0].key}.`);
  return out;
}

function relDays(now: string, then: string) {
  const d = Math.floor((Date.parse(now) - Date.parse(then)) / DAY);
  return d === 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
}

/* ------------------------------ issue detail ------------------------------ */

export interface IssueDetail {
  app: string;
  issue: IssueRow;
  hourly: { hour: string; count: number }[];
  daily: { day: string; count: number }[];
  breakdowns: Record<"os" | "appVersion" | "deviceModel" | "network" | "runtime", { key: string; count: number; share: number }[]>;
  affectedUsers: number;
  sample: StoredEvent | null;
  recent: { ts: string; os: string; appVersion?: string; device?: string; message: string; userId?: string }[];
  hints: { title: string; detail: string }[];
}

export async function buildIssueDetail(
  store: ReadStore,
  app: string,
  fingerprint: string,
  thresholds: SeverityThresholds,
  now = Date.now(),
): Promise<IssueDetail | null> {
  const issue = await store.getIssue(app, fingerprint);
  if (!issue) return null;
  const hs = hours(now, 48);
  const d14 = days(now, 14);
  const [hourRows, dayRows, events] = await Promise.all([
    store.getRollups(app, "issueHour", hs[0]!, hs[hs.length - 1]!),
    store.getRollups(app, "issue", d14[0]!, d14[d14.length - 1]!),
    store.listIssueEvents(app, fingerprint, { limit: 200 }),
  ]);
  const hourly = hs.map((hour) => ({ hour, count: hourRows.filter((r) => r.key === fingerprint && r.day === hour).reduce((a, r) => a + r.errors, 0) }));
  const daily = d14.map((day) => ({ day, count: dayRows.filter((r) => r.key === fingerprint && r.day === day).reduce((a, r) => a + r.errors, 0) }));
  const count24h = hourly.slice(-24).reduce((a, h) => a + h.count, 0);

  const split = (pick: (e: StoredEvent) => string | undefined) => {
    const m = new Map<string, number>();
    for (const e of events) {
      const k = pick(e) || "unknown";
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()]
      .map(([key, count]) => ({ key, count, share: events.length ? count / events.length : 0 }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);
  };
  const breakdowns = {
    os: split((e) => `${e.context.os.name} ${e.context.os.version ?? ""}`.trim()),
    appVersion: split((e) => e.context.app.version),
    deviceModel: split((e) => e.context.device.model),
    network: split((e) => e.context.network?.type),
    runtime: split((e) => [e.context.runtime.name, e.context.runtime.engine].filter(Boolean).join(" / ")),
  };
  const users = new Set(events.map((e) => e.user?.id ?? e.user?.anonymousId ?? e.sessionId));

  const row = toIssueRow(issue, count24h, thresholds);
  return {
    app,
    issue: row,
    hourly,
    daily,
    breakdowns,
    affectedUsers: users.size,
    sample: events[0] ?? issue.lastEvent ?? null,
    recent: events.slice(0, 25).map((e) => ({
      ts: e.event.ts,
      os: `${e.context.os.name} ${e.context.os.version ?? ""}`.trim(),
      appVersion: e.context.app.version,
      device: e.context.device.model,
      message: e.event.type === "error" ? e.event.error.message : e.event.type === "event" ? e.event.name : `session ${e.event.status}`,
      userId: e.user?.id,
    })),
    hints: hintsFor(issue, breakdowns, events),
  };
}

/** Rule-based "what to look at" hints. Phase 2 replaces/augments these with an LLM over the same data. */
function hintsFor(issue: Issue, b: IssueDetail["breakdowns"], events: StoredEvent[]): IssueDetail["hints"] {
  const hints: IssueDetail["hints"] = [];
  const text = `${issue.title} ${events[0]?.event.type === "error" ? (events[0].event.error.stack ?? "") : ""}`.toLowerCase();
  const crumbs = events.flatMap((e) => (e.event.type === "error" ? (e.event.breadcrumbs ?? []) : []));

  const concentrated = (label: string, rows: { key: string; share: number }[]) => {
    const r = rows[0];
    if (r && r.key !== "unknown" && r.share >= 0.8 && events.length >= 5 && rows.length >= 1)
      hints.push({ title: `Concentrated on ${label} ${r.key}`, detail: `${Math.round(r.share * 100)}% of recent occurrences. Reproduce on ${r.key} first, and check what changed for it.` });
  };
  concentrated("app version", b.appVersion);
  concentrated("OS", b.os);
  concentrated("device", b.deviceModel);

  if (/cannot read propert|undefined is not an object|of undefined|of null|is not a function/.test(text))
    hints.push({
      title: "A value is missing when the code expects it",
      detail: `Something is null/undefined at ${issue.culprit ?? "the top frame"}. Check the data the previous step returns (API response shape, async state not yet loaded) and add a guard or loading state.`,
    });
  if (/network request failed|failed to fetch|networkerror|timeout|timed out|econn|socket/.test(text))
    hints.push({ title: "Network failure", detail: "Check if errors line up with poor connectivity (see the network breakdown), add retries with backoff, and show an offline/timeout state instead of failing." });
  if (/\b401\b|\b403\b|unauthori[sz]ed|forbidden|token expired|jwt/.test(text))
    hints.push({ title: "Auth/session problem", detail: "Look for expired or missing tokens. Confirm the token refresh runs before this call, and that the clock/expiry handling is right." });
  if (/json|unexpected token|syntaxerror/.test(text))
    hints.push({ title: "Bad response body", detail: "The app tried to parse something that isn't the JSON it expected — often an HTML error page or an empty 204/5xx. Log the status and content-type before parsing." });
  if (/\b5\d\d\b|internal server error|bad gateway|service unavailable/.test(text))
    hints.push({ title: "Server-side failure", detail: "The backend returned a 5xx. Correlate the timestamps with your API logs." });

  const failingRequests = crumbs.filter((c) => c.category === "network" && (c.level === "error" || /\b[45]\d\d\b/.test(c.message)));
  if (failingRequests.length) {
    const m = new Map<string, number>();
    for (const c of failingRequests) m.set(c.message, (m.get(c.message) ?? 0) + 1);
    const [msg] = [...m.entries()].sort((a, b) => b[1] - a[1])[0]!;
    hints.push({ title: "A request fails right before the error", detail: `Most common: ${msg}` });
  }
  if (hints.length === 0) hints.push({ title: "Start at the culprit frame", detail: `Open ${issue.culprit ?? "the top stack frame"} and use the breadcrumbs below to replay what the user did.` });
  return hints;
}
