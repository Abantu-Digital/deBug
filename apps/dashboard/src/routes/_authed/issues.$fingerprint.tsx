import { createFileRoute, Link, notFound, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { HourlyChart, TrendChart } from "~/components/charts";
import { RangePicker, rangeSearch, RetentionNote, type PageSearch, type RangeSearch } from "~/components/range-picker";
import { APP_CODE } from "~/lib/health";
import { Card, DataTable, IssueLabels, LevelBadge, ShareBars, Stat, timeAgo } from "~/components/ui";
import { CopyButton } from "~/components/copy-button";
import { getIssueDetail, updateIssueStatus } from "~/server/fns";

export const Route = createFileRoute("/_authed/issues/$fingerprint")({
  // `via`: the page this was opened from (a service's key, or APP_CODE), for the breadcrumb back to it.
  validateSearch: (s: Record<string, unknown>): { app: string; via?: string } & RangeSearch => ({
    app: typeof s.app === "string" ? s.app : "",
    via: typeof s.via === "string" ? s.via.slice(0, 200) : undefined,
    ...rangeSearch(s),
  }),
  loaderDeps: ({ search }) => ({ app: search.app, range: search.range, from: search.from, to: search.to }),
  loader: async ({ params, deps }) => {
    const d = await getIssueDetail({ data: { ...deps, fingerprint: params.fingerprint } });
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
  const navigate = Route.useNavigate();
  const search = Route.useSearch();
  const { range } = d;
  const keep: PageSearch = { app: d.app, range: search.range, from: search.from, to: search.to };

  return (
    <main className="mx-auto max-w-7xl space-y-5 px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Breadcrumb" className="text-sm text-muted">
          <Link to="/" search={keep} className="hover:text-ink hover:underline">Health</Link>
          {search.via && <span aria-hidden> › </span>}
          {search.via === APP_CODE ? (
            <Link to="/app-code" search={keep} className="hover:text-ink hover:underline">App code</Link>
          ) : search.via ? (
            <Link to="/services/$service" params={{ service: search.via }} search={keep} className="hover:text-ink hover:underline">
              {search.via}
            </Link>
          ) : null}
        </nav>
        <RangePicker key={`${range.preset}${range.from}${range.to}`} value={range} today={new Date().toISOString().slice(0, 10)} onChange={(r) => navigate({ search: (s) => ({ ...s, ...r }) })} />
      </div>
      <RetentionNote rangeFrom={range.from} retention={d.retention} />

      <div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <LevelBadge level={issue.severity} />
          {issue.flow && <span className="rounded bg-panel-2 px-1.5 py-0.5 font-mono">{issue.flow}</span>}
          <span>First seen {timeAgo(issue.firstSeen)} · last seen {timeAgo(issue.lastSeen)}</span>
        </div>
        <h1 className="mt-2 break-words text-xl font-semibold tracking-tight sm:text-2xl">{issue.title}</h1>
        {issue.culprit && <p className="mt-1 font-mono text-sm text-muted">{issue.culprit}</p>}
        <IssueLabels issue={issue} />
        {issue.incidentTitle && (
          <p className="mt-2 text-sm text-muted">
            Part of an incident: <span className="font-medium text-ink">{issue.incidentTitle}</span>
          </p>
        )}
      </div>

      <IssueActions app={d.app} issue={issue} canChange={d.canChangeStatus} links={d.links} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Occurrences (24h)" value={issue.count24h} tone={issue.severity} />
        <Stat label={`Occurrences (${range.label})`} value={issue.countRange.toLocaleString()} hint={`${issue.countTotal.toLocaleString()} since first seen`} />
        <Stat label="Users affected" value={d.affectedUsers.toLocaleString()} hint={`since ${range.preset === "24h" ? "yesterday" : range.from}`} />
        <Stat label="Top app version" value={d.breakdowns.appVersion[0]?.key ?? "—"} hint={d.breakdowns.appVersion[0] ? `${Math.round(d.breakdowns.appVersion[0].share * 100)}% of occurrences` : undefined} />
      </div>

      {/* Specific findings first, then the general advice (ABA-146). */}
      {d.findings.length > 0 && (
        <Card title="What the trail shows" subtitle="Patterns deBug found in what customers did before the error, and what to do about each.">
          <ol className="space-y-3">
            {d.findings.map((f) => (
              <li key={f.id} className="text-sm">
                <p className="font-medium">{f.why}</p>
                <p className="mt-0.5">{f.fix}</p>
                <details className="mt-1 text-xs text-muted">
                  <summary className="cursor-pointer hover:text-ink">
                    {f.of > 1 ? (f.seen === f.of ? `Every time: all ${f.of} recent occurrences` : `In ${f.seen} of ${f.of} recent occurrences`) : "In the latest occurrence"} · show what it read
                  </summary>
                  <ul className="mt-1 space-y-0.5 font-mono">
                    {f.evidence.map((e, i) => <li key={i} className="break-words">{e}</li>)}
                  </ul>
                </details>
              </li>
            ))}
          </ol>
        </Card>
      )}

      {issue.explanation && (
        <div className="grid gap-5 lg:grid-cols-2">
          <Card title="What happened" subtitle="In plain words, for support." right={d.ticketMarkdown ? <CopyButton text={d.ticketMarkdown} label="Copy for a ticket" /> : undefined}>
            <p className="text-sm leading-relaxed">{issue.explanation.summary}</p>
          </Card>
          <Card title="For developers" subtitle={plain(issue.explanation.technical.headline)}>
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {issue.explanation.technical.evidence.map((line, i) => (
                <li key={i} className="break-words">{plain(line)}</li>
              ))}
            </ul>
            {issue.explanation.technical.where && (
              <p className="mt-3 text-sm">
                <span className="font-medium">Where: </span>
                <span className="break-words font-mono text-xs">{plain(issue.explanation.technical.where)}</span>
              </p>
            )}
            <p className="mt-3 text-sm">
              <span className="font-medium">General advice: </span>
              {plain(issue.explanation.technical.fix)}
            </p>
          </Card>
        </div>
      )}

      {d.hints.length > 0 && (
        <Card title={issue.explanation ? "Also worth checking" : "What to look at"} subtitle="Generated from the error, its breadcrumbs and where it happens.">
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
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          {range.preset !== "24h" && (
            <div className="mb-5">
              <Card title="Occurrences per day" subtitle={`${range.label} (UTC)`}>
                <TrendChart data={d.daily.map((x) => ({ day: x.day, errors: x.count }))} />
              </Card>
            </div>
          )}
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

      <Card title="Recent occurrences" subtitle="Newest first. Open one for its timeline, request, device and stack.">
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
              {d.recent.map((r) => (
                <tr key={r.id} className="border-b border-line last:border-0 hover:bg-panel-2">
                  <td className="px-4 py-2 text-xs sm:px-2">
                    {r.type === "error" ? (
                      <Link to="/events/$eventId" params={{ eventId: r.id }} search={{ app: d.app, issue: issue.fingerprint, range: search.range, from: search.from, to: search.to }} className="font-medium text-accent hover:underline" title={r.ts}>
                        {timeAgo(r.ts)}
                      </Link>
                    ) : (
                      <span className="text-muted" title={r.ts}>{timeAgo(r.ts)}</span>
                    )}
                  </td>
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

/** Resolve (with the fixed version), ignore or reopen, and open a prefilled ticket. */
function IssueActions({
  app,
  issue,
  canChange,
  links,
}: {
  app: string;
  issue: { fingerprint: string; status: string; resolvedIn?: string; lastVersion?: string };
  canChange: boolean;
  links: { linear?: string; github?: string };
}) {
  const router = useRouter();
  const [version, setVersion] = useState(issue.resolvedIn ?? issue.lastVersion ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = async (status: "open" | "resolved" | "ignored") => {
    setBusy(true);
    setError(null);
    const out = await updateIssueStatus({ data: { app, fingerprint: issue.fingerprint, status, resolvedIn: status === "resolved" ? version : undefined } }).catch((e: Error) => ({ ok: false as const, error: e.message }));
    setBusy(false);
    if (!out.ok) return setError(out.error);
    await router.invalidate();
  };
  const btn = "rounded-md border border-line px-3 py-1.5 text-sm hover:bg-panel-2 disabled:opacity-40";
  const closed = issue.status === "resolved" || issue.status === "ignored";
  return (
    <section aria-label="Issue actions" className="flex flex-wrap items-center gap-2">
      {canChange && !closed && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void set("resolved");
          }}
        >
          <label className="text-sm text-muted" htmlFor="fixed-in">Fixed in</label>
          <input id="fixed-in" value={version} onChange={(e) => setVersion(e.target.value)} placeholder="2.4.1" className="w-28 rounded-md border border-line bg-panel px-2 py-1.5 text-sm" />
          <button type="submit" disabled={busy} className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40">Resolve</button>
          <button type="button" disabled={busy} onClick={() => void set("ignored")} className={btn}>Ignore</button>
        </form>
      )}
      {canChange && closed && (
        <button type="button" disabled={busy} onClick={() => void set("open")} className={btn}>Reopen</button>
      )}
      {links.linear && <a href={links.linear} target="_blank" rel="noopener noreferrer" className={btn}>Create Linear issue</a>}
      {links.github && <a href={links.github} target="_blank" rel="noopener noreferrer" className={btn}>Create GitHub issue</a>}
      {canChange && !closed && <p className="w-full text-xs text-muted">If it shows up again in {version || "that version"} or later, it's marked Regressed. Occurrences from older versions don't count: those users haven't updated yet.</p>}
      {error && <p role="alert" className="w-full text-sm text-sev-critical">{error}</p>}
    </section>
  );
}

/** Explanations mark code with backticks for Markdown; on the page they read as plain text. */
const plain = (s: string) => s.replaceAll("`", "");
