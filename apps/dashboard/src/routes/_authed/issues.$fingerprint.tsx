import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { HourlyChart } from "~/components/charts";
import { Card, DataTable, SeverityBadge, ShareBars, Stat, timeAgo } from "~/components/ui";
import { getIssueDetail } from "~/server/fns";

export const Route = createFileRoute("/_authed/issues/$fingerprint")({
  validateSearch: (s: Record<string, unknown>): { app: string } => ({ app: typeof s.app === "string" ? s.app : "" }),
  loaderDeps: ({ search }) => ({ app: search.app }),
  loader: async ({ params, deps }) => {
    const d = await getIssueDetail({ data: { app: deps.app, fingerprint: params.fingerprint } });
    if (!d) throw notFound();
    return d;
  },
  component: IssuePage,
});

function IssuePage() {
  const d = Route.useLoaderData();
  const { issue, sample } = d;
  const ev = sample?.event.type === "error" ? sample.event : null;
  const frames = ev?.error.frames ?? [];

  return (
    <main className="mx-auto max-w-7xl space-y-5 px-4 py-6 sm:px-6">
      <Link to="/" search={{ app: d.app }} className="text-sm text-muted hover:text-ink">← Overview</Link>

      <div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <SeverityBadge severity={issue.severity} />
          {issue.flow && <span className="rounded bg-panel-2 px-1.5 py-0.5 font-mono">{issue.flow}</span>}
          <span>First seen {timeAgo(issue.firstSeen)} · last seen {timeAgo(issue.lastSeen)}</span>
        </div>
        <h1 className="mt-2 break-words text-xl font-semibold tracking-tight sm:text-2xl">{issue.title}</h1>
        {issue.culprit && <p className="mt-1 font-mono text-sm text-muted">{issue.culprit}</p>}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Occurrences (24h)" value={issue.count24h} tone={issue.severity} />
        <Stat label="Total occurrences" value={issue.countTotal.toLocaleString()} />
        <Stat label="Users affected" value={d.affectedUsers} hint="in the last 200 events" />
        <Stat label="Top app version" value={d.breakdowns.appVersion[0]?.key ?? "—"} hint={d.breakdowns.appVersion[0] ? `${Math.round(d.breakdowns.appVersion[0].share * 100)}% of occurrences` : undefined} />
      </div>

      <Card title="What to look at" subtitle="Generated from the error, its breadcrumbs and where it happens.">
        <ol className="space-y-3">
          {d.hints.map((h, i) => (
            <li key={i} className="flex gap-3">
              <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent">{i + 1}</span>
              <div>
                <div className="text-sm font-medium">{h.title}</div>
                <div className="text-sm text-muted">{h.detail}</div>
              </div>
            </li>
          ))}
        </ol>
      </Card>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card title="Occurrences per hour" subtitle="Last 48 hours">
            <HourlyChart data={d.hourly} />
            <DataTable columns={["Hour (UTC)", "Count"]} rows={d.hourly.map((h) => [h.hour, h.count])} />
          </Card>
        </div>
        <Card title="Where it happens" subtitle="Share of recent occurrences">
          <div className="space-y-4">
            {(["os", "appVersion", "deviceModel", "network"] as const).map((k) => (
              <div key={k}>
                <div className="mb-1.5 text-xs font-medium text-muted">{({ os: "OS", appVersion: "App version", deviceModel: "Device", network: "Network" })[k]}</div>
                <ShareBars rows={d.breakdowns[k].map((r) => ({ key: r.key, value: r.count }))} />
              </div>
            ))}
          </div>
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Stack trace" subtitle="Most recent occurrence. In-app frames highlighted.">
          {frames.length ? (
            <ol className="space-y-1 font-mono text-xs">
              {frames.map((f, i) => (
                <li key={i} className={`rounded px-2 py-1 ${f.inApp ? "bg-accent-soft text-ink" : "text-muted"}`}>
                  <span className="font-semibold">{f.fn ?? "<anonymous>"}</span>{" "}
                  <span className="break-all">{f.file}:{f.line}:{f.col}</span>
                </li>
              ))}
            </ol>
          ) : (
            <pre className="overflow-auto whitespace-pre-wrap text-xs text-muted">{ev?.error.stack ?? "No stack trace captured."}</pre>
          )}
        </Card>
        <Card title="Breadcrumbs" subtitle="What the user did right before the error">
          {ev?.breadcrumbs?.length ? (
            <ol className="relative space-y-3 border-l border-line pl-4">
              {ev.breadcrumbs.map((b, i) => (
                <li key={i} className="text-sm">
                  <span className={`absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full ${b.level === "error" ? "bg-sev-critical" : "bg-line"}`} />
                  <span className="mr-2 rounded bg-panel-2 px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-muted">{b.category}</span>
                  <span className="break-words">{b.message}</span>
                </li>
              ))}
              <li className="text-sm font-medium text-sev-critical">
                <span className="absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full bg-sev-critical" />
                {issue.title}
              </li>
            </ol>
          ) : (
            <p className="text-sm text-muted">No breadcrumbs. Call <code>deBug.breadcrumb()</code> on navigation and network calls to see the path to the error.</p>
          )}
        </Card>
      </div>

      <Card title="Recent occurrences">
        <div className="-mx-4 overflow-x-auto sm:mx-0">
          <table className="tabular w-full min-w-[600px] text-left text-sm">
            <thead className="text-xs text-muted">
              <tr className="border-b border-line">
                <th className="px-4 py-2 font-medium sm:px-2">When</th>
                <th className="px-2 py-2 font-medium">OS</th>
                <th className="px-2 py-2 font-medium">Version</th>
                <th className="px-2 py-2 font-medium">Device</th>
                <th className="px-2 py-2 font-medium">User</th>
              </tr>
            </thead>
            <tbody>
              {d.recent.map((r, i) => (
                <tr key={i} className="border-b border-line last:border-0">
                  <td className="px-4 py-2 text-xs text-muted sm:px-2">{timeAgo(r.ts)}</td>
                  <td className="px-2 py-2">{r.os}</td>
                  <td className="px-2 py-2">{r.appVersion ?? "—"}</td>
                  <td className="px-2 py-2">{r.device ?? "—"}</td>
                  <td className="px-2 py-2 font-mono text-xs text-muted">{r.userId ?? "anonymous"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </main>
  );
}
