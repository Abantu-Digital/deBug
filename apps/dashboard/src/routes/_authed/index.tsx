import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { FlowChart, TrendChart } from "~/components/charts";
import { Card, DataTable, SeverityBadge, ShareBars, Stat, timeAgo } from "~/components/ui";
import { getOverview } from "~/server/fns";

type Search = { app?: string; flow?: string };

export const Route = createFileRoute("/_authed/")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    app: typeof s.app === "string" ? s.app : undefined,
    flow: typeof s.flow === "string" ? s.flow : undefined,
  }),
  loaderDeps: ({ search }) => ({ app: search.app }),
  loader: ({ deps }) => getOverview({ data: { app: deps.app } }),
  component: Overview,
});

function Overview() {
  const summary = Route.useLoaderData();
  const { flow } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  if (!summary) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16 text-center">
        <h1 className="text-xl font-semibold">No data yet</h1>
        <p className="mt-2 text-sm text-muted">Once your app sends its first event through the ingest function, it will appear here.</p>
      </main>
    );
  }

  const { totals } = summary;
  const issues = flow ? summary.issues.filter((i) => (i.flow ?? "untagged") === flow) : summary.issues;
  const change = totals.changePct;

  return (
    <main className="mx-auto max-w-7xl space-y-5 px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted">Overview · last 24h</p>
          <h1 className="text-2xl font-semibold tracking-tight">What's going wrong in {summary.app}</h1>
        </div>
        {summary.apps.length > 1 && (
          <select
            aria-label="App"
            value={summary.app}
            onChange={(e) => navigate({ search: { app: e.target.value } })}
            className="rounded-md border border-line bg-panel px-2 py-1.5 text-sm"
          >
            {summary.apps.map((a) => <option key={a}>{a}</option>)}
          </select>
        )}
      </div>

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
          label="Errors (24h)"
          value={totals.errors24h.toLocaleString()}
          tone={totals.criticalIssues ? "critical" : undefined}
          hint={change === null ? "no prior data" : `${change > 0 ? "▲" : change < 0 ? "▼" : "•"} ${Math.abs(change)}% vs previous 24h`}
        />
        <Stat label="Critical issues" value={totals.criticalIssues} tone={totals.criticalIssues ? "critical" : undefined} hint="≥ threshold occurrences in 24h" />
        <Stat label="Failing flows" value={totals.failingFlows} hint="parts of the app with errors in 24h" />
        <Stat
          label="Crash-free sessions (14d)"
          value={asPct(summary.health.crashFreeRate)}
          tone={summary.health.crashFreeRate !== null && summary.health.crashFreeRate < 0.99 ? "high" : undefined}
          hint={`${summary.health.sessions14d.toLocaleString()} sessions · ${totals.activeIssues} active issues`}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <Card title="Where the app is failing" subtitle="Errors in the last 24h by flow, coloured by worst severity. Click a bar to filter issues.">
            <FlowChart data={summary.flows} onSelect={(f) => navigate({ search: (s) => ({ ...s, flow: s.flow === f ? undefined : f }) })} />
            <DataTable
              columns={["Flow", "Severity", "Errors 24h", "Errors 14d", "Issues", "Failure rate 14d"]}
              rows={summary.flows.map((f) => [
                f.flow,
                f.severity,
                f.errors24h,
                f.errors14d,
                f.issues,
                f.failureRate === null ? "—" : `${Math.round(f.failureRate * 100)}%`,
              ])}
            />
          </Card>
        </div>
        <div className="lg:col-span-2">
          <Card title="Error trend" subtitle="Errors per day, last 14 days (UTC)">
            <TrendChart data={summary.trend} />
            <DataTable columns={["Day", "Errors", "Events"]} rows={summary.trend.map((d) => [d.day, d.errors, d.events])} />
          </Card>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card
          title="Release health"
          subtitle="Share of sessions without a crash or unhandled error, per app version (14d). Recorded automatically by the SDK."
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
        <Card title="Failing endpoints" subtitle="Requests that returned 5xx, timed out or failed, 14d. Captured automatically from fetch and XHR.">
          {summary.health.endpoints.length ? (
            <ShareBars rows={summary.health.endpoints.map((e) => ({ key: e.endpoint, value: e.failures14d }))} />
          ) : (
            <p className="text-sm text-muted">No failed requests.</p>
          )}
        </Card>
      </div>

      <Card
        title={flow ? `Issues in ${flow}` : "Issues by severity"}
        subtitle="Grouped errors. Severity is set by occurrences in the last 24 hours."
        right={flow ? <button className="text-xs text-accent" onClick={() => navigate({ search: (s) => ({ ...s, flow: undefined }) })}>Clear filter ×</button> : null}
      >
        <div className="-mx-4 overflow-x-auto sm:mx-0">
          <table className="tabular w-full min-w-[640px] text-left text-sm">
            <thead className="text-xs text-muted">
              <tr className="border-b border-line">
                <th className="px-4 py-2 font-medium sm:px-2">Severity</th>
                <th className="px-2 py-2 font-medium">Issue</th>
                <th className="px-2 py-2 font-medium">Flow</th>
                <th className="px-2 py-2 text-right font-medium">24h</th>
                <th className="px-2 py-2 text-right font-medium">Total</th>
                <th className="px-2 py-2 text-right font-medium">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {issues.map((i) => (
                <tr key={i.fingerprint} className="border-b border-line last:border-0 hover:bg-panel-2">
                  <td className="px-4 py-2.5 sm:px-2"><SeverityBadge severity={i.severity} /></td>
                  <td className="max-w-[420px] px-2 py-2.5">
                    <Link to="/issues/$fingerprint" params={{ fingerprint: i.fingerprint }} search={{ app: summary.app }} className="block truncate font-medium hover:text-accent">
                      {i.title}
                    </Link>
                    {i.culprit && <div className="truncate font-mono text-xs text-muted">{i.culprit}</div>}
                  </td>
                  <td className="px-2 py-2.5 text-xs">{i.flow ?? <span className="text-muted">untagged</span>}</td>
                  <td className="px-2 py-2.5 text-right font-semibold">{i.count24h}</td>
                  <td className="px-2 py-2.5 text-right text-muted">{i.countTotal}</td>
                  <td className="px-2 py-2.5 text-right text-xs text-muted">{timeAgo(i.lastSeen)}</td>
                </tr>
              ))}
              {!issues.length && (
                <tr><td colSpan={6} className="px-2 py-6 text-center text-muted">No issues.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid gap-5 md:grid-cols-3">
        <Card title="By OS" subtitle="Errors, 14d"><ShareBars rows={summary.breakdowns.os.map((r) => ({ key: r.key, value: r.errors }))} /></Card>
        <Card title="By app version" subtitle="Errors, 14d"><ShareBars rows={summary.breakdowns.appVersion.map((r) => ({ key: r.key, value: r.errors }))} /></Card>
        <Card title="By device" subtitle="Errors, 14d"><ShareBars rows={summary.breakdowns.deviceModel.map((r) => ({ key: r.key, value: r.errors }))} /></Card>
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
