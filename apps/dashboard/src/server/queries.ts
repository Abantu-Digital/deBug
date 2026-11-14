import type { ReadStore } from "@debugkit/adapters";
import { classify, parseIncidentKey, withIssueCauses } from "@debugkit/ingest";
import {
  CATEGORY_INFO,
  CAUSE_INFO,
  compareVersions,
  percentileMs,
  SEVERITY_ORDER,
  severityFromCount,
  type Classification,
  type Issue,
  type IssueStatus,
  type RollupRow,
  type Severity,
  type SeverityThresholds,
  type StoredEvent,
} from "@debugkit/schema";
import { daysBetween, resolveRange, weekOf, type DateRange } from "./range";

/**
 * Distinct users, or 0 when the count can't be made (for example a Firestore index added in a
 * newer release isn't deployed yet). The rest of the page still loads.
 */
async function countUsersSafe(store: ReadStore, app: string, scope: string, since: string): Promise<number> {
  try {
    return await store.countUsers(app, scope, since);
  } catch (err) {
    console.warn(`deBug: couldn't count users (${scope}): ${(err as Error).message.split("\n")[0]}`);
    return 0;
  }
}

const DAY = 86_400_000;
const HOUR = 3_600_000;
const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);
const hourKey = (t: number) => new Date(t).toISOString().slice(0, 13);

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
  /** Occurrences in the selected range. */
  countRange: number;
  /** Occurrences since the issue was first seen. */
  countTotal: number;
  firstSeen: string;
  lastSeen: string;
  status: IssueStatus;
  resolvedIn?: string;
  firstVersion?: string;
  lastVersion?: string;
  /** First seen in the newest release: a likely regression from that release. */
  newInLatest: boolean;
  /** Distinct users affected since the start of the range. Filled for the top issues only. */
  users?: number;
  /** Category, likely owner, user impact and causes (docs/taxonomy.md), from the latest occurrence plus the issue. */
  labels?: Classification;
  /** The incident the latest occurrence belonged to, if any (see Summary.incidents). */
  incident?: string;
}

/** Issues that fail together for the same reason, folded into one problem. */
export interface IncidentRow {
  /** "<cause>|<category>|<os>": stable across builds. */
  key: string;
  title: string;
  cause: string;
  category: string;
  os: string;
  /** Errors in the range. */
  errors: number;
  /** Distinct users affected since the start of the range. */
  users: number;
  /** The issues in it, most errors first. */
  issues: { fingerprint: string; title: string; errors: number }[];
}

export interface FlowRow {
  flow: string;
  errors24h: number;
  errorsRange: number;
  /** Highest severity of any issue in the flow. */
  severity: Severity;
  issues: number;
  successesRange: number;
  failuresRange: number;
  /** failures / (failures + successes) in the range, from events logged with an outcome. null if no outcome events. */
  failureRate: number | null;
  /** Marked critical in Settings: its issues rank one severity level higher. */
  critical: boolean;
}

export interface StepRow {
  flow: string;
  step: string;
  successes: number;
  failures: number;
  abandoned: number;
  failureRate: number | null;
}

export interface EndpointTiming {
  endpoint: string;
  requests: number;
  failed: number;
  errorRate: number;
  /** Upper bound of the bucket holding the median / 95th percentile, in ms (Infinity: over 10 s). */
  p50: number | null;
  p95: number | null;
}

/** How long the customer keeps raw events, and where that number comes from. */
export interface Retention {
  days: number | null;
  source: "setting" | "default" | "unknown";
  /** Events received before this day have expired: counts remain, details don't. */
  detailsFrom: string | null;
}

export interface Summary {
  app: string;
  apps: string[];
  generatedAt: string;
  range: DateRange;
  retention: Retention;
  totals: {
    errors24h: number;
    /** Error events in the selected range (exact hourly sums for 24h). */
    errorsRange: number;
    /** Error events in the period of the same length just before. */
    errorsPrev: number;
    /** Percent change vs the previous period, null when it had no errors. */
    changePct: number | null;
    /** Non-error events (custom events) in the range. */
    eventsRange: number;
    activeIssues: number;
    criticalIssues: number;
    failingFlows: number;
  };
  narrative: string[];
  /** One point per hour (24h), day (up to 90 days) or week (longer), labelled by its start. */
  trend: { day: string; errors: number; events: number }[];
  flows: FlowRow[];
  issues: IssueRow[];
  incidents: IncidentRow[];
  breakdowns: Record<"os" | "appVersion" | "deviceModel" | "network" | "country" | "category" | "owner" | "impact", { key: string; errors: number }[]>;
  /** track() steps with the most failures in the range. */
  steps: StepRow[];
  /** Response times of the busiest endpoints (from the SDK's per-minute request summaries). */
  timings: EndpointTiming[];
  criticalFlows: string[];
  health: Health;
  /** Releases (version, plus OTA update) first seen inside the range, oldest first: markers on the trend. */
  releases: { release: string; firstDay: string; sessions: number }[];
  /** The newest version with sessions in the range. */
  latestVersion: string | null;
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
  /** Sessions started in the range (sent automatically by the SDK). 0 when the SDK predates sessions. */
  sessionsRange: number;
  crashFreeRate: number | null;
  errorFreeRate: number | null;
  /** Newest releases first (by version order), at most 8. */
  releases: ReleaseHealth[];
  /** Endpoints with the most failed requests (5xx, timeouts, network failures) in the range. */
  endpoints: { endpoint: string; failuresRange: number; failures24h: number }[];
  /** Distinct users (or installs) active since the start of the range, and how many of them crashed. */
  users: number;
  crashedUsers: number;
  /** 1 - crashedUsers / users. null when no users were recorded. */
  crashFreeUsersRate: number | null;
}

/** Description of every field, shipped with the JSON API so agents can interpret it without docs. */
export const SUMMARY_FIELDS = {
  range: "The period the numbers cover. Query with ?range=24h|7d|14d|30d|90d, or ?range=custom&from=YYYY-MM-DD&to=YYYY-MM-DD. Default 14d.",
  retention: "How long raw events are kept. Counts, issues and release health are kept forever; event details older than detailsFrom have expired.",
  "totals.errors24h": "Error events in the trailing 24 hours (exact, from hourly rollups).",
  "totals.errorsRange": "Error events in the selected range.",
  "totals.changePct": "Percent change of errors vs the previous period of the same length. null when that period had fewer than 10 errors.",
  "totals.activeIssues": "Distinct grouped errors (issues) seen in the range.",
  "totals.criticalIssues": "Issues whose 24h occurrence count meets the critical threshold.",
  "flows[]": "Parts of the app as tagged by the developer (e.g. auth.login). Sorted by severity, then errors24h, then errorsRange.",
  "flows[].failureRate": "failures/(failures+successes) in the range from events logged with an outcome. null when the app logs no outcomes for that flow.",
  "issues[]": "Grouped errors seen in the range. Sorted by severity, then count24h, then countRange.",
  "issues[].severity": "Derived from count24h using thresholds critical/high/medium.",
  "issues[].culprit": "Top in-app stack frame: function (file:line).",
  "incidents[]": "Issues that failed together for the same reason (a cause such as resumed_from_background or burst, a category and an OS), folded into one problem. Most errors first. Key is stable across builds.",
  "incidents[].issues": "The issues in the incident with their errors in the range.",
  "issues[].incident": "Key of the incident the latest occurrence belonged to, if any.",
  "issues[].labels": "What kind of problem (category), who likely fixes it (owner), how badly it hurts users (impact: blocked, degraded, silent) and why (causes). Ids and rules: docs/taxonomy.md in the deBug repo.",
  "breakdowns.category": "Errors in the range by category (e.g. network.never_sent, server, crash).",
  "breakdowns.owner": "Errors in the range by likely owner: app, backend, infrastructure, third_party, unknown.",
  "breakdowns.impact": "Errors in the range by user impact: blocked, degraded, silent.",
  "trend[]": "Errors and non-error events per hour (24h), UTC day (up to 90 days) or week (longer).",
  breakdowns: "Errors in the range split by OS, app version, device model, network, country, and the labels category, owner and impact.",
  narrative: "Plain-language summary of what is going wrong in the range.",
  "health.crashFreeRate": "Share of sessions in the range with no fatal crash. Sessions are recorded automatically by the SDK.",
  "health.errorFreeRate": "Share of sessions in the range with no unhandled error.",
  "health.releases[]": "Crash-free and error-free rates per app version.",
  "health.endpoints[]": "HTTP endpoints whose requests failed most (5xx, timeouts, network errors), from automatic network capture.",
  "health.users": "Distinct users active since the start of the range (user id when set, else the install's anonymous id; stored hashed).",
  "health.crashFreeUsersRate": "Share of those users who didn't crash.",
  "issues[].status": "open, resolved, ignored, or regressed (seen again in the fixed release or later).",
  "issues[].newInLatest": "First seen in latestVersion: likely introduced by the newest release.",
  "issues[].users": "Distinct users affected since the start of the range (top issues only).",
  "releases[]": "Releases first seen inside the range, with the day they appeared: markers on the trend.",
  "steps[]": "track(flow, step) outcomes per step in the range, most failures first.",
  "timings[]": "Busiest endpoints with p50/p95 response time (bucket upper bounds, ms) and error rate, from automatic request timing.",
  "breakdowns.network": "Errors by network type (wifi, cellular...).",
  "breakdowns.country": "Errors by country, from the device's timezone or locale (never IP).",
  criticalFlows: "Flows marked critical in Settings; their issues rank one severity level higher.",
} as const;

const sumRows = (rows: RollupRow[], field: "errors" | "events" = "errors") => rows.reduce((a, r) => a + r[field], 0);

/** Retention as the dashboard knows it: the app's setting, else the deployment default it was told about. */
export async function retentionFor(store: ReadStore, app: string, fallbackDays: number | undefined, now = Date.now()): Promise<Retention> {
  let days: number | null = null;
  let source: Retention["source"] = "unknown";
  try {
    const s = await store.getSettings(app);
    if (s?.retentionDays) [days, source] = [s.retentionDays, "setting"];
  } catch {
    /* read-only credentials may not reach settings: fall through */
  }
  if (days === null && fallbackDays) [days, source] = [fallbackDays, "default"];
  return { days, source, detailsFrom: days ? dayKey(now - days * DAY) : null };
}

export async function buildSummary(
  store: ReadStore,
  appParam: string | undefined,
  thresholds: SeverityThresholds,
  now = Date.now(),
  opts: { range?: { range?: string; from?: string; to?: string }; retentionDays?: number } = {},
): Promise<Summary | null> {
  const apps = await store.listApps();
  const app = appParam && apps.includes(appParam) ? appParam : apps[0];
  if (!app) return null;

  const range = resolveRange(opts.range ?? {}, now);
  const { from, to } = range;
  const hourly = range.preset === "24h";
  const h24 = hours(now, 24);
  const [sessionRows, endpointRows, total, prevTotal, flowRows, outcomeRows, os, appVersion, deviceModel, issueDays, issues, hourRows, retention] = await Promise.all([
    store.getRollups(app, "session", from, to),
    store.getRollups(app, "endpoint", from, to),
    store.getRollups(app, "total", from, to),
    store.getRollups(app, "total", range.prevFrom, range.prevTo),
    store.getRollups(app, "flow", from, to),
    store.getRollups(app, "flowOutcome", from, to),
    store.getRollups(app, "os", from, to),
    store.getRollups(app, "appVersion", from, to),
    store.getRollups(app, "deviceModel", from, to),
    store.getRollups(app, "issue", from, to),
    store.listIssues(app, { limit: 500 }),
    // 48 hours of hourly rollups: exact 24h totals, the previous 24h, and per-issue 24h counts.
    store.getRollups(app, "issueHour", hours(now, 48)[0]!, hourKey(now)),
    retentionFor(store, app, opts.retentionDays, now),
  ]);
  // A year of release rows, to know which releases first appeared inside the range.
  const [releaseRows, stepRows, requestRows, latencyRows, networkRows, countryRows, appSettings, categoryRows, ownerRows, impactRows, incidentRows, incidentIssueRows] = await Promise.all([
    store.getRollups(app, "release", dayKey(Date.parse(`${from}T00:00:00Z`) - 365 * DAY), to),
    store.getRollups(app, "flowStep", from, to),
    store.getRollups(app, "requests", from, to),
    store.getRollups(app, "latency", from, to),
    store.getRollups(app, "network", from, to),
    store.getRollups(app, "country", from, to),
    store.getSettings(app).catch(() => null),
    store.getRollups(app, "category", from, to),
    store.getRollups(app, "owner", from, to),
    store.getRollups(app, "impact", from, to),
    store.getRollups(app, "incident", from, to),
    store.getRollups(app, "incidentIssue", from, to),
  ]);
  const criticalFlows = appSettings?.criticalFlows ?? [];
  const critical = new Set(criticalFlows);
  const usersSince = hourly ? dayKey(now - DAY) : from;
  const [users, crashedUsers] = await Promise.all([countUsersSafe(store, app, "app", usersSince), countUsersSafe(store, app, "crash", usersSince)]);

  const last24 = new Set(h24);
  let errors24h = 0;
  let errorsPrev24h = 0;
  const issue24h = new Map<string, number>();
  for (const r of hourRows) {
    if (last24.has(r.day)) {
      errors24h += r.errors;
      issue24h.set(r.key, (issue24h.get(r.key) ?? 0) + r.errors);
    } else errorsPrev24h += r.errors;
  }

  // Trend: hourly for 24h, daily up to 90 days, weekly beyond.
  let trend: Summary["trend"];
  if (hourly) {
    trend = h24.map((h) => ({ day: h, errors: hourRows.filter((r) => r.day === h).reduce((a, r) => a + r.errors, 0), events: 0 }));
  } else {
    const byDay = new Map(total.map((r) => [r.day, r]));
    const daily = daysBetween(from, to).map((day) => ({ day, errors: byDay.get(day)?.errors ?? 0, events: byDay.get(day)?.events ?? 0 }));
    if (range.granularity === "week") {
      const weeks = new Map<string, { day: string; errors: number; events: number }>();
      for (const d of daily) {
        const w = weekOf(d.day);
        const cur = weeks.get(w) ?? { day: w, errors: 0, events: 0 };
        cur.errors += d.errors;
        cur.events += d.events;
        weeks.set(w, cur);
      }
      trend = [...weeks.values()];
    } else trend = daily;
  }

  const errorsRange = hourly ? errors24h : sumRows(total);
  const errorsPrev = hourly ? errorsPrev24h : sumRows(prevTotal);

  const issueRange = new Map<string, number>();
  for (const r of issueDays) issueRange.set(r.key, (issueRange.get(r.key) ?? 0) + r.errors);
  const rangeStart = hourly ? new Date(now - DAY).toISOString() : `${from}T00:00:00.000Z`;
  const versionsInRange = [...new Set(sessionRows.map((r) => r.key.split("|")[0]!).filter((v) => v && v !== "unknown"))].sort(compareVersions);
  const latestVersion = versionsInRange[versionsInRange.length - 1] ?? null;
  const issueRows: IssueRow[] = issues
    .filter((i) => i.lastSeen >= rangeStart && i.firstSeen <= `${to}T23:59:59.999Z`)
    .map((i) => toIssueRow(i, issue24h.get(i.fingerprint) ?? 0, hourly ? (issue24h.get(i.fingerprint) ?? 0) : (issueRange.get(i.fingerprint) ?? 0), thresholds, latestVersion, criticalFlows))
    .sort(bySeverityThenCount);
  // Users affected: one count per issue, so only for the issues people look at first.
  const active = issueRows.filter((i) => i.status !== "ignored" && i.status !== "resolved");
  await Promise.all(active.slice(0, 10).map(async (i) => (i.users = await countUsersSafe(store, app, `issue:${i.fingerprint}`, usersSince))));

  const incidents = await buildIncidents(incidentRows, incidentIssueRows, issueRows, (key) => countUsersSafe(store, app, `incident:${key}`, usersSince));

  const firstDay = new Map<string, { day: string; sessions: number }>();
  for (const r of releaseRows) {
    const cur = firstDay.get(r.key);
    if (!cur) firstDay.set(r.key, { day: r.day, sessions: r.events });
    else {
      if (r.day < cur.day) cur.day = r.day;
      cur.sessions += r.events;
    }
  }
  const releases = [...firstDay.entries()]
    .filter(([, v]) => v.day >= from && v.day <= to)
    .map(([release, v]) => ({ release, firstDay: v.day, sessions: v.sessions }))
    .sort((a, b) => a.firstDay.localeCompare(b.firstDay));

  const flowMap = new Map<string, FlowRow>();
  const flowOf = (flow: string) => {
    let f = flowMap.get(flow);
    if (!f) flowMap.set(flow, (f = { flow, errors24h: 0, errorsRange: 0, severity: "low", issues: 0, successesRange: 0, failuresRange: 0, failureRate: null, critical: critical.has(flow) }));
    return f;
  };
  for (const r of flowRows) if (r.errors > 0) flowOf(r.key).errorsRange += r.errors;
  for (const i of active) {
    const f = flowOf(i.flow ?? "untagged");
    f.issues++;
    f.errors24h += i.count24h;
    if (SEVERITY_ORDER[i.severity] > SEVERITY_ORDER[f.severity]) f.severity = i.severity;
  }
  for (const r of outcomeRows) {
    const [flow, outcome] = r.key.split("|");
    const f = flowOf(flow!);
    if (outcome === "success") f.successesRange += r.events;
    else if (outcome === "failure") f.failuresRange += r.events;
  }
  const flows = [...flowMap.values()]
    .map((f) => ({ ...f, failureRate: f.successesRange + f.failuresRange > 0 ? f.failuresRange / (f.successesRange + f.failuresRange) : null }))
    .filter((f) => f.errorsRange > 0 || f.failuresRange > 0 || f.errors24h > 0)
    .sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] || b.errors24h - a.errors24h || b.errorsRange - a.errorsRange);

  const top = (rows: { key: string; errors: number }[]) => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.key, (m.get(r.key) ?? 0) + r.errors);
    return [...m.entries()].map(([key, errors]) => ({ key, errors })).filter((r) => r.errors > 0).sort((a, b) => b.errors - a.errors).slice(0, 8);
  };

  const summary: Summary = {
    app,
    apps,
    generatedAt: new Date(now).toISOString(),
    range,
    retention,
    totals: {
      errors24h,
      errorsRange,
      errorsPrev,
      // A percentage against a near-empty previous period (new app, short history) only misleads.
      changePct: errorsPrev >= 10 ? Math.round(((errorsRange - errorsPrev) / errorsPrev) * 100) : null,
      eventsRange: sumRows(total, "events"),
      activeIssues: active.length,
      criticalIssues: active.filter((i) => i.severity === "critical").length,
      failingFlows: flows.filter((f) => (hourly ? f.errors24h : f.errorsRange) > 0).length,
    },
    narrative: [],
    trend,
    flows,
    issues: issueRows,
    incidents,
    breakdowns: {
      os: top(os),
      appVersion: top(appVersion),
      deviceModel: top(deviceModel),
      network: top(networkRows),
      country: top(countryRows),
      category: top(categoryRows),
      owner: top(ownerRows),
      impact: top(impactRows),
    },
    steps: buildSteps(stepRows),
    timings: buildTimings(requestRows, latencyRows),
    criticalFlows,
    health: { ...buildHealth(sessionRows, endpointRows, dayKey(now)), users, crashedUsers, crashFreeUsersRate: users > 0 ? Math.max(0, 1 - crashedUsers / users) : null },
    releases,
    latestVersion,
  };
  summary.narrative = narrate(summary);
  return summary;
}

/** "Requests failed on app resume (iOS)", from an incident key. */
export function incidentTitle(key: string): string {
  const k = parseIncidentKey(key);
  if (!k) return key;
  const os = k.os === "ios" ? "iOS" : k.os === "android" ? "Android" : k.os;
  const requests = k.category.startsWith("network.") || ["server", "auth", "client_request"].includes(k.category);
  const what = CATEGORY_INFO[k.category]?.name ?? k.category;
  if (k.cause === "resumed_from_background") return `${requests ? "Requests failed" : what} on app resume (${os})`;
  if (k.cause === "burst") return `${what}: several requests at once (${os})`;
  return `${what}: ${CAUSE_INFO[k.cause]?.name.toLowerCase() ?? k.cause} (${os})`;
}

async function buildIncidents(rows: RollupRow[], issueRows: RollupRow[], issues: IssueRow[], users: (key: string) => Promise<number>): Promise<IncidentRow[]> {
  const errors = new Map<string, number>();
  for (const r of rows) errors.set(r.key, (errors.get(r.key) ?? 0) + r.errors);
  const members = new Map<string, Map<string, number>>();
  for (const r of issueRows) {
    const cut = r.key.lastIndexOf("|");
    const key = r.key.slice(0, cut);
    const fp = r.key.slice(cut + 1);
    const m = members.get(key) ?? new Map<string, number>();
    m.set(fp, (m.get(fp) ?? 0) + r.errors);
    members.set(key, m);
  }
  const titles = new Map(issues.map((i) => [i.fingerprint, i.title]));
  const out = [...errors.entries()]
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([key, n]) => {
      const k = parseIncidentKey(key);
      return {
        key,
        title: incidentTitle(key),
        cause: k?.cause ?? "",
        category: k?.category ?? "",
        os: k?.os ?? "",
        errors: n,
        users: 0,
        issues: [...(members.get(key) ?? new Map<string, number>()).entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([fingerprint, e]) => ({ fingerprint, title: titles.get(fingerprint) ?? fingerprint, errors: e })),
      };
    });
  await Promise.all(out.map(async (i) => (i.users = await users(i.key))));
  return out;
}

const rate = (bad: number, total: number) => (total > 0 ? Math.max(0, 1 - bad / total) : null);

export { compareVersions };

function buildHealth(sessionRows: RollupRow[], endpointRows: RollupRow[], today: string): Omit<Health, "users" | "crashedUsers" | "crashFreeUsersRate"> {
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

  const eps = new Map<string, { endpoint: string; failuresRange: number; failures24h: number }>();
  for (const r of endpointRows) {
    let e = eps.get(r.key);
    if (!e) eps.set(r.key, (e = { endpoint: r.key, failuresRange: 0, failures24h: 0 }));
    e.failuresRange += r.errors;
    if (r.day === today) e.failures24h += r.errors;
  }
  return {
    sessionsRange: sum("sessions"),
    crashFreeRate: rate(sum("crashed"), sum("sessions")),
    errorFreeRate: rate(sum("errored"), sum("sessions")),
    releases,
    endpoints: [...eps.values()].sort((a, b) => b.failuresRange - a.failuresRange).slice(0, 8),
  };
}

const BUMP: Record<Severity, Severity> = { low: "medium", medium: "high", high: "critical", critical: "critical" };

function buildSteps(rows: RollupRow[]): StepRow[] {
  const m = new Map<string, StepRow>();
  for (const r of rows) {
    const [flow = "", step = "", outcome] = r.key.split("|");
    const k = `${flow}|${step}`;
    let s = m.get(k);
    if (!s) m.set(k, (s = { flow, step, successes: 0, failures: 0, abandoned: 0, failureRate: null }));
    if (outcome === "success") s.successes += r.events;
    else if (outcome === "failure") s.failures += r.events;
    else if (outcome === "abandoned") s.abandoned += r.events;
  }
  return [...m.values()]
    .map((s) => ({ ...s, failureRate: s.successes + s.failures > 0 ? s.failures / (s.successes + s.failures) : null }))
    .sort((a, b) => b.failures - a.failures || (b.failureRate ?? 0) - (a.failureRate ?? 0))
    .slice(0, 30);
}

function buildTimings(requestRows: RollupRow[], latencyRows: RollupRow[]): EndpointTiming[] {
  const totals = new Map<string, { requests: number; failed: number }>();
  for (const r of requestRows) {
    const t = totals.get(r.key) ?? { requests: 0, failed: 0 };
    t.requests += r.events;
    t.failed += r.errors;
    totals.set(r.key, t);
  }
  const hist = new Map<string, number[]>();
  for (const r of latencyRows) {
    const cut = r.key.lastIndexOf("|");
    const key = r.key.slice(0, cut);
    const i = Number(r.key.slice(cut + 1));
    const b = hist.get(key) ?? new Array(13).fill(0);
    if (i >= 0 && i < 13) b[i] += r.events;
    hist.set(key, b);
  }
  return [...totals.entries()]
    .map(([endpoint, t]) => {
      const b = hist.get(endpoint) ?? [];
      return { endpoint, requests: t.requests, failed: t.failed, errorRate: t.requests ? t.failed / t.requests : 0, p50: percentileMs(b, 0.5), p95: percentileMs(b, 0.95) };
    })
    .sort((a, b) => b.requests - a.requests)
    .slice(0, 10);
}

/**
 * An issue's labels: those ingest stored with its latest occurrence, or worked out now for
 * occurrences stored before the classifier existed, plus the causes that come from the issue.
 */
export function issueLabels(i: Issue, latestVersion: string | null, criticalFlows: readonly string[] = []): Classification | undefined {
  const ev = i.lastEvent?.event;
  const own = i.lastEvent?.labels ?? (ev?.type === "error" ? classify(ev, { criticalFlows }) : undefined);
  return own && withIssueCauses(own, { status: i.status, firstVersion: i.firstVersion, latestVersion });
}

function toIssueRow(
  i: Issue,
  count24h: number,
  countRange: number,
  t: SeverityThresholds,
  latestVersion: string | null = null,
  criticalFlows: readonly string[] = [],
): IssueRow {
  const base = severityFromCount(count24h, t);
  const critical = new Set(criticalFlows);
  return {
    labels: issueLabels(i, latestVersion, criticalFlows),
    incident: i.lastEvent?.incident,
    status: i.status ?? "open",
    resolvedIn: i.resolvedIn,
    firstVersion: i.firstVersion,
    lastVersion: i.lastVersion,
    newInLatest: !!latestVersion && i.firstVersion === latestVersion,
    fingerprint: i.fingerprint,
    title: i.title,
    culprit: i.culprit,
    flow: i.flow,
    // Issues in a critical flow rank one level higher (only once they've happened in the last 24h).
    severity: i.flow && critical.has(i.flow) && count24h > 0 ? BUMP[base] : base,
    count24h,
    countRange,
    countTotal: i.count,
    firstSeen: i.firstSeen,
    lastSeen: i.lastSeen,
  };
}

const bySeverityThenCount = (a: IssueRow, b: IssueRow) =>
  SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] || b.count24h - a.count24h || b.countRange - a.countRange || b.lastSeen.localeCompare(a.lastSeen);

const pct = (n: number) => `${Math.round(n * 100)}%`;
const pctOne = (n: number) => `${(Math.floor(n * 1000) / 10).toFixed(1)}%`;
const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

function narrate(s: Summary): string[] {
  const out: string[] = [];
  const t = s.totals;
  const r = s.range;
  if (t.errorsRange === 0) {
    out.push(`No errors in ${r.label}.`);
    return out;
  }
  // Past +500% a percentage stops meaning much; the previous count says more.
  const change =
    t.changePct === null
      ? ""
      : t.changePct === 0
        ? `, flat versus the previous ${r.span}`
        : t.changePct > 500
          ? `, up from ${t.errorsPrev.toLocaleString()} in the previous ${r.span}`
          : `, ${t.changePct > 0 ? "up" : "down"} ${Math.abs(t.changePct)}% on the previous ${r.span}`;
  out.push(`${plural(t.errorsRange, "error")} in ${r.label}${change}, across ${t.failingFlows} part${t.failingFlows === 1 ? "" : "s"} of the app.`);
  const f = s.flows[0];
  if (f && (f.errors24h > 0 || f.errorsRange > 0)) {
    const failRate = f.failureRate !== null ? ` ${pct(f.failureRate)} of attempts fail.` : "";
    const n = r.preset === "24h" ? f.errors24h : f.errorsRange;
    out.push(`${f.flow}${f.critical ? " (a critical flow)" : ""} is the most affected flow (${f.severity}): ${plural(n, "error")} in ${r.label} from ${plural(f.issues, "issue")}.${failRate}`);
  }
  const i = s.issues.find((x) => x.status !== "ignored" && x.status !== "resolved");
  if (i && i.countRange > 0) {
    const isNew = Date.parse(s.generatedAt) - Date.parse(i.firstSeen) < 3 * DAY;
    out.push(`Top issue: "${i.title}"${i.culprit ? ` in ${i.culprit}` : ""}, ${plural(i.countRange, "time")} in ${r.label}${isNew ? `, first seen ${relDays(s.generatedAt, i.firstSeen)}` : ""}.`);
  }
  const h = s.health;
  const latest = h.releases[0];
  const prev = h.releases[1];
  if (latest?.crashFreeRate != null && latest.sessions >= 20 && latest.crashFreeRate < 0.995) {
    const vs = prev?.crashFreeRate != null && prev.sessions >= 20 ? ` (${prev.version}: ${pctOne(prev.crashFreeRate)})` : "";
    out.push(`${latest.version} is ${pctOne(latest.crashFreeRate)} crash-free across ${plural(latest.sessions, "session")}${vs}.`);
  }
  const ep = h.endpoints[0];
  if (ep && ep.failuresRange > 0) out.push(`${ep.endpoint} is the most failing endpoint: ${plural(ep.failuresRange, "failed request")} in ${r.label}.`);
  const net = s.breakdowns.network.filter((r) => r.key !== "unknown");
  const netTotal = net.reduce((a, b) => a + b.errors, 0);
  if (net[0] && netTotal >= 20 && net[0].errors / netTotal > 0.6 && net[0].key !== "wifi")
    out.push(`${pct(net[0].errors / netTotal)} of errors happen on ${net[0].key}: check timeouts and retries on slow connections.`);
  const os = s.breakdowns.os;
  const osTotal = os.reduce((a, b) => a + b.errors, 0);
  if (os[0] && osTotal > 20 && os[0].errors / osTotal > 0.6) out.push(`${pct(os[0].errors / osTotal)} of errors in ${r.label} come from ${os[0].key}.`);
  return out;
}

function relDays(now: string, then: string) {
  const d = Math.floor((Date.parse(now) - Date.parse(then)) / DAY);
  return d === 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
}

/* ------------------------------ issue detail ------------------------------ */

export interface IssueDetail {
  app: string;
  range: DateRange;
  retention: Retention;
  issue: IssueRow;
  hourly: { hour: string; count: number }[];
  daily: { day: string; count: number }[];
  breakdowns: Record<"os" | "appVersion" | "deviceModel" | "network" | "runtime", { key: string; count: number; share: number }[]>;
  /** Distinct users affected since the start of the range (all of them, not just recent events). */
  affectedUsers: number;
  /** Prefilled "new issue" links for trackers configured on the dashboard. */
  links: { linear?: string; github?: string };
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
  opts: { range?: { range?: string; from?: string; to?: string }; retentionDays?: number; trackers?: Trackers } = {},
): Promise<IssueDetail | null> {
  const issue = await store.getIssue(app, fingerprint);
  if (!issue) return null;
  const range = resolveRange(opts.range ?? {}, now);
  const hs = hours(now, 48);
  const [hourRows, dayRows, events, retention, settings] = await Promise.all([
    store.getRollups(app, "issueHour", hs[0]!, hs[hs.length - 1]!),
    store.getRollups(app, "issue", range.from, range.to),
    store.listIssueEvents(app, fingerprint, { limit: 200 }),
    retentionFor(store, app, opts.retentionDays, now),
    store.getSettings(app).catch(() => null),
  ]);
  const hourly = hs.map((hour) => ({ hour, count: hourRows.filter((r) => r.key === fingerprint && r.day === hour).reduce((a, r) => a + r.errors, 0) }));
  const daily = daysBetween(range.from, range.to).map((day) => ({ day, count: dayRows.filter((r) => r.key === fingerprint && r.day === day).reduce((a, r) => a + r.errors, 0) }));
  const count24h = hourly.slice(-24).reduce((a, h) => a + h.count, 0);
  const countRange = range.preset === "24h" ? count24h : daily.reduce((a, d) => a + d.count, 0);

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
  const usersSince = range.preset === "24h" ? dayKey(now - DAY) : range.from;
  const counted = await countUsersSafe(store, app, `issue:${fingerprint}`, usersSince);
  // Data from before 0.6 has no user marks: fall back to the users in recent events.
  const affectedUsers = counted || new Set(events.map((e) => e.user?.id ?? e.user?.anonymousId ?? e.sessionId)).size;

  const criticalFlows = settings?.criticalFlows ?? [];
  const row = toIssueRow(issue, count24h, countRange, thresholds, null, criticalFlows);
  // Recent occurrences say whether it's one device model.
  if (row.labels) row.labels = withIssueCauses(row.labels, { deviceModels: events.map((e) => e.context.device.model) });
  const hints = hintsFor(issue, breakdowns, events);
  const detail = {
    app,
    range,
    retention,
    issue: row,
    hourly,
    daily,
    breakdowns,
    affectedUsers,
    links: {},
    sample: events[0] ?? issue.lastEvent ?? null,
    recent: events.slice(0, 25).map((e) => ({
      ts: e.event.ts,
      os: `${e.context.os.name} ${e.context.os.version ?? ""}`.trim(),
      appVersion: e.context.app.version,
      device: e.context.device.model,
      message: e.event.type === "error" ? e.event.error.message : e.event.type === "event" ? e.event.name : e.event.type === "session" ? `session ${e.event.status}` : `requests to ${e.event.key}`,
      userId: e.user?.id,
    })),
    hints,
  } satisfies IssueDetail;
  detail.links = trackerLinks(detail, opts.trackers ?? {});
  return detail;
}

/** Where "Create issue" buttons point. */
export interface Trackers {
  /** Linear team key (e.g. ABA). Without one, links go to linear.new and your default team. */
  linearTeam?: string;
  linear?: boolean;
  /** owner/name of a GitHub repository. */
  githubRepo?: string;
  /** The dashboard's public URL, to link back from the ticket. */
  dashboardUrl?: string;
}

/** The issue as a ticket: what, where, how often, what to look at. Kept short enough for a URL. */
export function issueStory(d: Omit<IssueDetail, "links">, dashboardUrl?: string): { title: string; body: string } {
  const i = d.issue;
  const top = (rows: { key: string; share: number }[]) => rows.filter((r) => r.key !== "unknown").slice(0, 3).map((r) => `${r.key} (${Math.round(r.share * 100)}%)`).join(", ") || "n/a";
  const frames = d.sample?.event.type === "error" ? (d.sample.event.error.frames ?? []).filter((f) => f.inApp).slice(0, 3) : [];
  const body = [
    `**${i.title}**`,
    i.culprit ? `At \`${i.culprit}\`${i.flow ? ` in flow \`${i.flow}\`` : ""}.` : i.flow ? `In flow \`${i.flow}\`.` : "",
    "",
    `- ${i.countRange.toLocaleString()} occurrences in ${d.range.label}, ${i.count24h} in the last 24h (severity: ${i.severity})`,
    `- ${d.affectedUsers.toLocaleString()} users affected`,
    `- First seen ${i.firstSeen.slice(0, 10)}${i.firstVersion ? ` in ${i.firstVersion}` : ""}; last seen ${i.lastSeen.slice(0, 10)}${i.lastVersion ? ` in ${i.lastVersion}` : ""}`,
    `- Versions: ${top(d.breakdowns.appVersion)}`,
    `- OS: ${top(d.breakdowns.os)}; devices: ${top(d.breakdowns.deviceModel)}`,
    ...(frames.length ? ["", "Stack (in-app frames):", ...frames.map((f) => `- \`${f.fn ?? "?"}\` ${f.file ?? ""}:${f.line ?? ""}`)] : []),
    ...(d.hints.length ? ["", "What to look at:", ...d.hints.slice(0, 3).map((h) => `- ${h.title}: ${h.detail}`)] : []),
    ...(dashboardUrl ? ["", `deBug: ${dashboardUrl.replace(/\/+$/, "")}/issues/${i.fingerprint}?app=${encodeURIComponent(d.app)}`] : []),
  ]
    .filter((l, n, all) => !(l === "" && all[n - 1] === ""))
    .join("\n");
  return { title: `[deBug] ${i.title}`.slice(0, 200), body: body.slice(0, 3000) };
}

function trackerLinks(d: Omit<IssueDetail, "links">, t: Trackers): IssueDetail["links"] {
  const { title, body } = issueStory(d, t.dashboardUrl);
  const q = (p: Record<string, string>) => new URLSearchParams(p).toString();
  return {
    ...(t.linear || t.linearTeam ? { linear: `${t.linearTeam ? `https://linear.app/team/${encodeURIComponent(t.linearTeam)}/new` : "https://linear.new"}?${q({ title, description: body })}` } : {}),
    ...(t.githubRepo && /^[\w.-]+\/[\w.-]+$/.test(t.githubRepo) ? { github: `https://github.com/${t.githubRepo}/issues/new?${q({ title, body })}` } : {}),
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
