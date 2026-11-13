import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { FlowChart, TrendChart } from "~/components/charts";
import { Card, DataTable, IssueLabels, SeverityBadge, ShareBars, Stat, timeAgo } from "~/components/ui";
import { RangePicker, rangeSearch, RetentionNote, type RangeSearch } from "~/components/range-picker";
import { getOverview } from "~/server/fns";

type Search = { app?: string; flow?: string; status?: string } & RangeSearch;

export const Route = createFileRoute("/_authed/")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    app: typeof s.app === "string" ? s.app : undefined,
    flow: typeof s.flow === "string" ? s.flow : undefined,
    status: typeof s.status === "string" ? s.status : undefined,
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
  const statusFilter = search.status ?? "open";
  const byStatus = summary.issues.filter((i) =>
    statusFilter === "all" ? true : statusFilter === "open" ? i.status === "open" || i.status === "regressed" : i.status === statusFilter,
  );
  const issues = flow ? byStatus.filter((i) => (i.flow ?? "untagged") === flow) : byStatus;
  const countFor = (st: string) => summary.issues.filter((i) => (st === "open" ? i.status === "open" || i.status === "regressed" : i.status === st)).length;
  const change = totals.changePct;

  return (
    <main className="mx-auto max-w-7xl space-y-5 px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted">Overview · {range.label}</p>
          <h1 className="text-2xl font-semibold tracking-tight">What's going wrong in {summary.app}</h1>
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
            <FlowChart data={summary.flows} onSelect={(f) => navigate({ search: (s) => ({ ...s, flow: s.flow === f ? undefined : f }) })} />
            <DataTable
              columns={["Flow", "Severity", "Errors 24h", `Errors (${span})`, "Issues", `Failure rate (${span})`]}
              rows={summary.flows.map((f) => [
                f.flow,
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
            <ShareBars rows={summary.health.endpoints.map((e) => ({ key: e.endpoint, value: e.failuresRange }))} />
          ) : (
            <p className="text-sm text-muted">No failed requests.</p>
          )}
        </Card>
      </div>

      <Card
        title={flow ? `Issues in ${flow}` : "Issues by severity"}
        subtitle={`Grouped errors seen in ${range.label}. Severity is set by occurrences in the last 24 hours.`}
        right={
          <div className="flex flex-wrap items-center justify-end gap-1 text-xs">
            {flow && <button className="mr-2 text-accent" onClick={() => navigate({ search: (s) => ({ ...s, flow: undefined }) })}>Clear flow ×</button>}
            {(["open", "resolved", "ignored", "all"] as const).map((st) => (
              <button
                key={st}
                onClick={() => navigate({ search: (s) => ({ ...s, status: st === "open" ? undefined : st }) })}
                className={`rounded-md border px-2 py-1 capitalize ${statusFilter === st ? "border-accent bg-accent-soft text-accent" : "border-line text-muted hover:bg-panel-2"}`}
              >
                {st}
                {st !== "all" && <span className="ml-1 opacity-70">{countFor(st)}</span>}
              </button>
            ))}
          </div>
        }
      >
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
                  <td className="px-4 py-2.5 sm:px-2"><SeverityBadge severity={i.severity} /></td>
                  <td className="max-w-[420px] px-2 py-2.5">
                    <Link to="/issues/$fingerprint" params={{ fingerprint: i.fingerprint }} search={{ app: summary.app, range: range.preset === "14d" ? undefined : range.preset, ...(range.preset === "custom" ? { from: range.from, to: range.to } : {}) }} className="block truncate font-medium hover:text-accent">
                      {i.title}
                    </Link>
                    {i.culprit && <div className="truncate font-mono text-xs text-muted">{i.culprit}</div>}
                    <IssueLabels issue={i} />
                  </td>
                  <td className="px-2 py-2.5 text-xs">{i.flow ?? <span className="text-muted">untagged</span>}</td>
                  <td className="px-2 py-2.5 text-right text-muted">{i.users ?? "—"}</td>
                  <td className="px-2 py-2.5 text-right font-semibold">{i.count24h}</td>
                  <td className="px-2 py-2.5 text-right text-muted">{span === "24h" ? i.countTotal : i.countRange}</td>
                  <td className="px-2 py-2.5 text-right text-xs text-muted">{timeAgo(i.lastSeen)}</td>
                </tr>
              ))}
              {!issues.length && (
                <tr><td colSpan={7} className="px-2 py-6 text-center text-muted">No issues.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid gap-5 md:grid-cols-3">
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

const WHAT_YOU_WILL_SEE: { title: string; when: string; detail: string }[] = [
  { title: "A written summary", when: "after the first error", detail: "How many errors in the last 24 hours, the worst part of the app, the top issue and the release that's struggling, in plain sentences." },
  { title: "Issues by severity", when: "after the first error", detail: "Errors grouped by cause. Severity comes from how often each happened in the last 24 hours. Open one for the stack trace and the steps that led to it." },
  { title: "Release health", when: "as soon as the app starts", detail: "Every app launch is a session. You'll see the share of sessions per version that ran without a crash or an unhandled error." },
  { title: "Failing endpoints", when: "after the first failed request", detail: "Requests that timed out, failed or returned 5xx, captured from fetch and XHR without any code from you." },
  { title: "Where the app is failing", when: "once you tag flows", detail: "Errors by flow, like auth.login or checkout.payment. Wrap a step in deBug.track() and each flow also gets a failure rate." },
  { title: "Breakdowns", when: "after the first error", detail: "Errors split by OS, app version and device model, so you can see who is affected." },
];

function EmptyState() {
  // Re-run the loader every few seconds, so the first event shows up without a refresh.
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => void router.invalidate(), 5000);
    return () => clearInterval(t);
  }, [router]);
  return (
    <main className="mx-auto max-w-4xl space-y-6 px-4 py-10 sm:px-6">
      <div>
        <p className="text-xs uppercase tracking-wide text-muted">Connected · waiting for the first event</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Your dashboard is ready, and empty for now.</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted">
          Nothing has arrived yet. Run your app with the SDK initialised, or send a test event with <code>npx debugkit test</code> (or <code>npx @debugkit/cli test</code>). This page fills in on its own.
        </p>
      </div>

      <section aria-labelledby="see-h" className="rounded-xl border border-line bg-panel p-4 sm:p-5">
        <h2 id="see-h" className="text-sm font-semibold">What you'll see here</h2>
        <ul className="mt-3 grid gap-3 sm:grid-cols-2">
          {WHAT_YOU_WILL_SEE.map((w) => (
            <li key={w.title} className="rounded-lg border border-line p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">{w.title}</span>
                <span className="text-[11px] uppercase tracking-wide text-muted">{w.when}</span>
              </div>
              <p className="mt-1 text-sm text-ink/80">{w.detail}</p>
            </li>
          ))}
        </ul>
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <section aria-labelledby="auto-h" className="rounded-xl border border-line bg-panel p-4 sm:p-5">
          <h2 id="auto-h" className="text-sm font-semibold">Recorded automatically</h2>
          <p className="mt-1 text-xs text-muted">Once <code>init()</code> runs, with no other code.</p>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm">
            <li>Crashes and unhandled promise rejections</li>
            <li>Failed, timed-out and 5xx requests, with the code that made them</li>
            <li>Sessions, for crash-free rates per release</li>
            <li>Screens visited, buttons clicked, console warnings, app backgrounded or offline</li>
            <li>Device, OS, app version and network on every event</li>
          </ul>
        </section>
        <section aria-labelledby="manual-h" className="rounded-xl border border-line bg-panel p-4 sm:p-5">
          <h2 id="manual-h" className="text-sm font-semibold">What you add</h2>
          <p className="mt-1 text-xs text-muted">Only what the app can't know on its own.</p>
          <pre className="mt-3 overflow-x-auto rounded-md bg-panel-2 p-3 text-xs leading-relaxed">{`// in a try/catch you already have
catch (err) {
  deBug.error(err, { flow: "checkout.payment", step: "charge" });
}

// success or failure of a step, plus the error
await deBug.track("auth.login", "submit_otp", () => verifyOtp(code));`}</pre>
        </section>
      </div>
    </main>
  );
}
