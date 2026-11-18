import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { FlowChart, TrendChart } from "~/components/charts";
import { Card, DataTable, IssueLabels, LabelBadges, LevelBadge, ShareBars, Stat, timeAgo } from "~/components/ui";
import {
  filterIssues,
  isStatusFilter,
  labelCounts,
  labelFilterOf,
  LABEL_FILTER_KEYS,
  LABEL_FILTERS,
  NO_LABEL_FILTERS,
  STATUS_FILTERS,
  type IssueFilter,
  type LabelFilterKey,
  type StatusFilter,
} from "~/lib/issue-filter";
import { RangePicker, rangeSearch, RetentionNote, type RangeSearch } from "~/components/range-picker";
import { getOverview } from "~/server/fns";
import { EmptyState } from "~/components/empty-state";

type Search = { app?: string; flow?: string; status?: StatusFilter } & Pick<IssueFilter, LabelFilterKey> & RangeSearch;

const labelName = (k: LabelFilterKey, id: string) => LABEL_FILTERS[k].info[id]?.name ?? id;

export const Route = createFileRoute("/_authed/issues/")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    app: typeof s.app === "string" ? s.app : undefined,
    flow: typeof s.flow === "string" ? s.flow : undefined,
    status: isStatusFilter(s.status) ? s.status : undefined,
    ...labelFilterOf((k) => s[k]),
    ...rangeSearch(s),
  }),
  loaderDeps: ({ search }) => ({ app: search.app, range: search.range, from: search.from, to: search.to }),
  loader: ({ deps }) => getOverview({ data: deps }),
  component: Overview,
});

function Overview() {
  const summary = Route.useLoaderData();
  const search = Route.useSearch();
  const { flow } = search;
  const navigate = useNavigate({ from: Route.fullPath });

  if (!summary) return <EmptyState />;

  const { totals, range } = summary;
  const span = range.preset === "custom" ? "range" : range.preset;
  /** Keep the app and range when opening an issue. */
  const issueSearch = { app: summary.app, range: range.preset === "14d" ? undefined : range.preset, ...(range.preset === "custom" ? { from: range.from, to: range.to } : {}) };
  const statusFilter = search.status ?? "open";
  const filter: IssueFilter = { status: statusFilter, flow, category: search.category, owner: search.owner, impact: search.impact };
  const issues = filterIssues(summary.issues, filter);
  const countFor = (st: StatusFilter) => filterIssues(summary.issues, { ...filter, status: st }).length;
  const labelFiltered = LABEL_FILTER_KEYS.filter((k) => filter[k]);
  const toggleLabel = (k: LabelFilterKey, v: string) => navigate({ search: (s) => ({ ...s, [k]: s[k] === v ? undefined : v }), resetScroll: false });
  /** "Whose is it" for a label-filtered list: its issues by owner, worst first. */
  const owners = labelFiltered.length && !filter.owner ? [...labelCounts(summary.issues, filter, "owner")].sort((a, b) => b[1] - a[1]) : [];
  /** Issues hidden only by the status filter: a bar's errors can all belong to resolved issues. */
  const otherStatuses = issues.length === 0 && statusFilter !== "all" ? countFor("all") : 0;
  const issuesTitle = labelFiltered.length
    ? `Issues: ${labelFiltered.map((k) => labelName(k, filter[k]!)).join(" · ")}${flow ? ` in ${flow}` : ""}`
    : flow ? `Issues in ${flow}` : "Issues by severity";
  const change = totals.changePct;

  return (
    <main className="mx-auto max-w-7xl space-y-5 px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted">Issues · {range.label}</p>
          <h1 className="text-2xl font-semibold tracking-tight">Every issue in {summary.app}, worst first</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <RangePicker
            key={`${range.preset}${range.from}${range.to}`}
            value={range}
            today={summary.generatedAt.slice(0, 10)}
            onChange={(r) => navigate({ search: (s) => ({ ...s, ...r }) })}
          />
          {summary.apps.length > 1 && (
            <select
              aria-label="App"
              value={summary.app}
              onChange={(e) => navigate({ search: (s) => ({ ...s, app: e.target.value, flow: undefined }) })}
              className="rounded-md border border-line bg-panel px-2 py-1.5 text-sm"
            >
              {summary.apps.map((a) => <option key={a}>{a}</option>)}
            </select>
          )}
        </div>
      </div>
      <RetentionNote rangeFrom={range.from} retention={summary.retention} />

      {/* The story, in words first. */}
      <section aria-label="Summary" className="rounded-xl border border-line bg-panel p-4 sm:p-5">
        <ul className="space-y-1.5 text-[15px] leading-relaxed">
          {summary.narrative.map((line, i) => (
            <li key={i} className={i === 0 ? "font-medium" : "text-ink/90"}>{line}</li>
          ))}
        </ul>
      </section>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label={`Errors (${span})`}
          value={totals.errorsRange.toLocaleString()}
          tone={totals.criticalIssues ? "critical" : undefined}
          hint={change === null ? "not enough earlier data to compare" : change > 500 ? `▲ from ${totals.errorsPrev.toLocaleString()} in the previous ${range.span}` : `${change > 0 ? "▲" : change < 0 ? "▼" : "•"} ${Math.abs(change)}% vs previous ${range.span}`}
        />
        <Stat label="Critical issues" value={totals.criticalIssues} tone={totals.criticalIssues ? "critical" : undefined} hint="≥ threshold occurrences in 24h" />
        <Stat
          label={`Crash-free users (${span})`}
          value={asPct(summary.health.crashFreeUsersRate)}
          tone={summary.health.crashFreeUsersRate !== null && summary.health.crashFreeUsersRate < 0.99 ? "high" : undefined}
          hint={`${summary.health.users.toLocaleString()} users · ${summary.health.crashedUsers.toLocaleString()} crashed`}
        />
        <Stat
          label={`Crash-free sessions (${span})`}
          value={asPct(summary.health.crashFreeRate)}
          tone={summary.health.crashFreeRate !== null && summary.health.crashFreeRate < 0.99 ? "high" : undefined}
          hint={`${summary.health.sessionsRange.toLocaleString()} sessions · ${totals.activeIssues} active issues`}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-5">
        <div className="min-w-0 lg:col-span-3">
          <Card title="Where the app is failing" subtitle={`Errors in ${range.label} by flow, coloured by worst severity. Click a bar to filter issues.`}>
            <FlowChart data={summary.flows} onSelect={(f) => navigate({ search: (s) => ({ ...s, flow: s.flow === f ? undefined : f }), resetScroll: false })} />
            <DataTable
              columns={["Flow", "Severity", "Errors 24h", `Errors (${span})`, "Issues", `Failure rate (${span})`]}
              rows={summary.flows.map((f) => [
                f.critical ? `${f.flow} (critical)` : f.flow,
                f.severity,
                f.errors24h,
                f.errorsRange,
                f.issues,
                f.failureRate === null ? "—" : `${Math.round(f.failureRate * 100)}%`,
              ])}
            />
          </Card>
        </div>
        <div className="min-w-0 lg:col-span-2">
          <Card title="Error trend" subtitle={`Errors per ${range.granularity}, ${range.label} (UTC)`}>
            <TrendChart data={summary.trend} markers={summary.releases.map((r) => ({ day: r.firstDay, label: r.release }))} />
            {summary.releases.length > 0 && (
              <p className="mt-2 text-xs text-muted">Dashed lines: a release's first sessions ({summary.releases.map((r) => r.release).join(", ")}).</p>
            )}
            <DataTable columns={["Day", "Errors", "Events"]} rows={summary.trend.map((d) => [d.day, d.errors, d.events])} />
          </Card>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card
          title="Release health"
          subtitle={`Share of sessions without a crash or unhandled error, per app version, in ${range.label}. Recorded automatically by the SDK.`}
        >
          {summary.health.releases.length ? (
            <div className="-mx-4 overflow-x-auto sm:mx-0">
              <table className="tabular w-full min-w-[420px] text-left text-sm">
                <thead className="text-xs text-muted">
                  <tr className="border-b border-line">
                    <th className="px-4 py-2 font-medium sm:px-2">Version</th>
                    <th className="px-2 py-2 text-right font-medium">Sessions</th>
                    <th className="px-2 py-2 text-right font-medium">Crash-free</th>
                    <th className="px-2 py-2 text-right font-medium">Error-free</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.health.releases.map((r) => (
                    <tr key={r.version} className="border-b border-line last:border-0">
                      <td className="px-4 py-2 font-medium sm:px-2">{r.version}</td>
                      <td className="px-2 py-2 text-right text-muted">{r.sessions.toLocaleString()}</td>
                      <td className={`px-2 py-2 text-right font-semibold ${healthTone(r.crashFreeRate)}`}>{asPct(r.crashFreeRate)}</td>
                      <td className="px-2 py-2 text-right">{asPct(r.errorFreeRate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-muted">No sessions yet. They're recorded automatically from SDK 0.2.</p>
          )}
        </Card>
        <Card title="Failing endpoints" subtitle={`Requests that returned 5xx, timed out or failed in ${range.label}. Captured automatically from fetch and XHR.`}>
          {summary.health.endpoints.length ? (
            <ShareBars rows={summary.health.endpoints.map((e) => ({ key: e.endpoint, label: e.label, value: e.failuresRange }))} />
          ) : (
            <p className="text-sm text-muted">No failed requests.</p>
          )}
        </Card>
      </div>

      {(summary.steps.length > 0 || summary.timings.length > 0) && (
        <div className="grid gap-5 lg:grid-cols-2">
          {summary.steps.length > 0 && (
            <Card title="Steps that fail" subtitle={`track() outcomes per step in ${range.label}, most failures first.${flow ? ` Filtered to ${flow}.` : ""}`}>
              <div className="-mx-4 overflow-x-auto sm:mx-0">
                <table className="tabular w-full min-w-[420px] text-left text-sm">
                  <thead className="text-xs text-muted">
                    <tr className="border-b border-line">
                      <th className="px-4 py-2 font-medium sm:px-2">Flow · step</th>
                      <th className="px-2 py-2 text-right font-medium">Tries</th>
                      <th className="px-2 py-2 text-right font-medium">Failed</th>
                      <th className="px-2 py-2 text-right font-medium">Failure rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.steps.filter((st) => !flow || st.flow === flow).slice(0, 8).map((st) => (
                      <tr key={`${st.flow}|${st.step}`} className="border-b border-line last:border-0">
                        <td className="px-4 py-2 font-mono text-xs sm:px-2">{st.flow} · {st.step}</td>
                        <td className="px-2 py-2 text-right text-muted">{(st.successes + st.failures).toLocaleString()}</td>
                        <td className="px-2 py-2 text-right">{st.failures.toLocaleString()}</td>
                        <td className={`px-2 py-2 text-right font-semibold ${st.failureRate !== null && st.failureRate >= 0.1 ? "text-sev-critical" : ""}`}>{st.failureRate === null ? "—" : `${Math.round(st.failureRate * 100)}%`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
          {summary.timings.length > 0 && (
            <Card title="Response times" subtitle={`Busiest endpoints in ${range.label}. Measured by the SDK on real devices.`}>
              <div className="-mx-4 overflow-x-auto sm:mx-0">
                <table className="tabular w-full min-w-[420px] text-left text-sm">
                  <thead className="text-xs text-muted">
                    <tr className="border-b border-line">
                      <th className="px-4 py-2 font-medium sm:px-2">Endpoint</th>
                      <th className="px-2 py-2 text-right font-medium">Requests</th>
                      <th className="px-2 py-2 text-right font-medium">p50</th>
                      <th className="px-2 py-2 text-right font-medium">p95</th>
                      <th className="px-2 py-2 text-right font-medium">Failed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.timings.map((t) => (
                      <tr key={t.endpoint} className="border-b border-line last:border-0">
                        <td className={`max-w-[220px] truncate px-4 py-2 text-xs sm:px-2 ${t.label ? "" : "font-mono"}`} title={t.endpoint}>{t.label ?? t.endpoint}</td>
                        <td className="px-2 py-2 text-right text-muted">{t.requests.toLocaleString()}</td>
                        <td className="px-2 py-2 text-right">{ms(t.p50)}</td>
                        <td className={`px-2 py-2 text-right font-semibold ${t.p95 !== null && t.p95 >= 3000 ? "text-sev-high" : ""}`}>{ms(t.p95)}</td>
                        <td className={`px-2 py-2 text-right ${t.errorRate >= 0.05 ? "font-semibold text-sev-critical" : "text-muted"}`}>{`${(t.errorRate * 100).toFixed(t.errorRate < 0.1 ? 1 : 0)}%`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-xs text-muted">p50/p95: half / 95% of requests finished within this time.</p>
            </Card>
          )}
        </div>
      )}

      {!flow && summary.incidents.some((inc) => inc.active) && (
        <Card title="Incidents" subtitle={`Issues that failed together for the same reason in ${range.label}, folded into one problem.`}>
          <ul className="space-y-3">
            {summary.incidents.filter((inc) => inc.active).map((inc) => (
              <li key={inc.key} className="rounded-lg border border-line p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">{inc.title}</span>
                  <span className="text-xs text-muted">
                    {plural(inc.errors, "error")} · {plural(inc.issues.length, "issue")} · {inc.users ? plural(inc.users, "user") : "users —"} · happened {plural(inc.episodes, "time")}
                  </span>
                </div>
                <ul className="mt-2 space-y-1 text-sm">
                  {inc.issues.map((i) => (
                    <li key={i.fingerprint} className="flex items-baseline justify-between gap-3">
                      <Link to="/issues/$fingerprint" params={{ fingerprint: i.fingerprint }} search={issueSearch} className="block min-w-0 truncate text-muted hover:text-accent">
                        {i.title}
                      </Link>
                      <span className="shrink-0 text-xs text-muted">{i.errors.toLocaleString()}</span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {summary.breakdowns.impact.length > 0 && (
        <Card title="Who it hurts and whose it is" subtitle={`Errors in ${range.label}, by how badly they hurt users, who likely fixes them, and what kind of problem. Click one to filter issues.`}>
          <div className="grid gap-5 md:grid-cols-3">
            {LABEL_FILTER_KEYS.map((k) => (
              <div key={k} className="min-w-0">
                <h3 className="mb-2 text-xs font-medium text-muted">{LABEL_FILTERS[k].title}</h3>
                <ShareBars
                  rows={summary.breakdowns[k].map((r) => ({ key: r.key, label: labelName(k, r.key), value: r.errors }))}
                  selected={filter[k]}
                  onSelect={(v) => toggleLabel(k, v)}
                />
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted">
            Bars count every error in the range, as labelled when it arrived, whatever its issue's status. The list below shows each issue's labels now, including host owners set in Settings since.
          </p>
        </Card>
      )}

      <Card
        title={issuesTitle}
        subtitle={`Grouped errors seen in ${range.label}. Severity is set by occurrences in the last 24 hours.`}
        right={
          <div className="flex flex-wrap items-center justify-end gap-1 text-xs">
            {flow && <button type="button" className="mr-2 text-accent" onClick={() => navigate({ search: (s) => ({ ...s, flow: undefined }), resetScroll: false })}>Clear flow ×</button>}
            {labelFiltered.length > 0 && (
              <button type="button" className="mr-2 text-accent" onClick={() => navigate({ search: (s) => ({ ...s, ...NO_LABEL_FILTERS }), resetScroll: false })}>Clear labels ×</button>
            )}
            {STATUS_FILTERS.map((st) => (
              <button
                key={st}
                type="button"
                aria-pressed={statusFilter === st}
                onClick={() => navigate({ search: (s) => ({ ...s, status: st === "open" ? undefined : st }), resetScroll: false })}
                className={`rounded-md border px-2 py-1 capitalize ${statusFilter === st ? "border-accent bg-accent-soft text-accent" : "border-line text-muted hover:bg-panel-2"}`}
              >
                {st}
                {st !== "all" && <span className="ml-1 opacity-70">{countFor(st)}</span>}
              </button>
            ))}
          </div>
        }
      >
        <div className="mb-3 flex flex-wrap gap-2">
          {LABEL_FILTER_KEYS.map((k) => {
            const counts = labelCounts(summary.issues, filter, k);
            return (
              <select
                key={k}
                aria-label={`Filter by ${LABEL_FILTERS[k].title.toLowerCase()}`}
                value={filter[k] ?? ""}
                onChange={(e) => navigate({ search: (s) => ({ ...s, [k]: e.target.value || undefined }), resetScroll: false })}
                className={`rounded-md border bg-panel px-2 py-1 text-xs ${filter[k] ? "border-accent text-accent" : "border-line"}`}
              >
                <option value="">Any {LABEL_FILTERS[k].title.toLowerCase()}</option>
                {Object.entries(LABEL_FILTERS[k].info)
                  .filter(([id]) => counts.has(id) || filter[k] === id)
                  .map(([id, info]) => (
                    <option key={id} value={id}>{info.name} ({counts.get(id) ?? 0})</option>
                  ))}
              </select>
            );
          })}
        </div>
        {owners.length > 0 && (
          <p className="mb-3 text-sm">
            <span className="text-muted">Whose: </span>
            {owners.map(([o, n], idx) => (
              <span key={o}>
                {idx > 0 && ", "}
                <button type="button" className="text-accent hover:underline" onClick={() => toggleLabel("owner", o)}>{labelName("owner", o)}</button> {n}
              </span>
            ))}
          </p>
        )}
        <div className="-mx-4 overflow-x-auto sm:mx-0">
          <table className="tabular w-full min-w-[640px] text-left text-sm">
            <thead className="text-xs text-muted">
              <tr className="border-b border-line">
                <th className="px-4 py-2 font-medium sm:px-2">Severity</th>
                <th className="px-2 py-2 font-medium">Issue</th>
                <th className="px-2 py-2 font-medium">Flow</th>
                <th className="px-2 py-2 text-right font-medium">Users</th>
                <th className="px-2 py-2 text-right font-medium">24h</th>
                <th className="px-2 py-2 text-right font-medium">{span === "24h" ? "Total" : span === "range" ? "Range" : span}</th>
                <th className="px-2 py-2 text-right font-medium">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {issues.map((i) => (
                <tr key={i.fingerprint} className="border-b border-line last:border-0 hover:bg-panel-2">
                  <td className="px-4 py-2.5 sm:px-2"><LevelBadge level={i.severity} /></td>
                  <td className="max-w-[420px] px-2 py-2.5">
                    <Link to="/issues/$fingerprint" params={{ fingerprint: i.fingerprint }} search={issueSearch} className="block truncate font-medium hover:text-accent">
                      {i.title}
                    </Link>
                    {i.culprit && <div className="truncate font-mono text-xs text-muted">{i.culprit}</div>}
                    <div><LabelBadges labels={i.labels} /><IssueLabels issue={i} /></div>
                  </td>
                  <td className="px-2 py-2.5 text-xs">{i.flow ?? <span className="text-muted">untagged</span>}</td>
                  <td className="px-2 py-2.5 text-right text-muted">{i.users ?? "—"}</td>
                  <td className="px-2 py-2.5 text-right font-semibold">{i.count24h}</td>
                  <td className="px-2 py-2.5 text-right text-muted">{span === "24h" ? i.countTotal : i.countRange}</td>
                  <td className="px-2 py-2.5 text-right text-xs text-muted">{timeAgo(i.lastSeen)}</td>
                </tr>
              ))}
              {!issues.length && (
                <tr><td colSpan={7} className="px-2 py-6 text-center text-muted">{otherStatuses > 0 ? (
                  <>
                    No {statusFilter} issues match.{" "}
                    <button type="button" className="text-accent hover:underline" onClick={() => navigate({ search: (s) => ({ ...s, status: "all" }), resetScroll: false })}>
                      Show {otherStatuses} in other statuses
                    </button>
                  </>
                ) : labelFiltered.length || flow ? "No issues match these filters." : "No issues."}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid gap-5 md:grid-cols-3">
        <Card title="By network" subtitle={`Errors, ${range.label}`}><ShareBars rows={summary.breakdowns.network.map((r) => ({ key: r.key, value: r.errors }))} /></Card>
        <Card title="By country" subtitle={`Errors, ${range.label}. From the device's timezone, not its IP.`}><ShareBars rows={summary.breakdowns.country.map((r) => ({ key: r.key, value: r.errors }))} /></Card>
        <Card title="By OS" subtitle={`Errors, ${range.label}`}><ShareBars rows={summary.breakdowns.os.map((r) => ({ key: r.key, value: r.errors }))} /></Card>
        <Card title="By app version" subtitle={`Errors, ${range.label}`}><ShareBars rows={summary.breakdowns.appVersion.map((r) => ({ key: r.key, value: r.errors }))} /></Card>
        <Card title="By device" subtitle={`Errors, ${range.label}`}><ShareBars rows={summary.breakdowns.deviceModel.map((r) => ({ key: r.key, value: r.errors }))} /></Card>
      </div>

      <p className="pb-6 text-xs text-muted">
        Machine-readable: <code>GET /api/summary?app={summary.app}</code> returns this page as JSON with field descriptions.
      </p>
    </main>
  );
}

function asPct(rate: number | null) {
  return rate === null ? "—" : `${(Math.floor(rate * 1000) / 10).toFixed(1)}%`;
}

function healthTone(rate: number | null) {
  if (rate === null) return "";
  return rate < 0.98 ? "text-sev-critical" : rate < 0.995 ? "text-sev-high" : "";
}

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

function ms(v: number | null) {
  if (v === null) return "—";
  if (!Number.isFinite(v)) return "> 10 s";
  return v >= 1000 ? `≤ ${(v / 1000).toFixed(v % 1000 ? 1 : 0)} s` : `≤ ${v} ms`;
}
