import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { RangePicker, rangeSearch, RetentionNote, type RangeSearch } from "~/components/range-picker";
import { clock, joined } from "~/components/timeline";
import { Card, HealthBox, timeAgo } from "~/components/ui";
import { byHealth, serviceTile } from "~/lib/health";
import type { Count, EndpointFailure, EndpointHealth, ServiceHealth } from "~/server/endpoints";
import { getEndpoints } from "~/server/fns";

const SORTS = { failing: "Most failures", slow: "Slowest", busy: "Busiest" } as const;
type Sort = keyof typeof SORTS;
type Search = { app?: string; endpoint?: string; sort?: Sort } & RangeSearch;

export const Route = createFileRoute("/_authed/endpoints")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    app: typeof s.app === "string" ? s.app : undefined,
    endpoint: typeof s.endpoint === "string" ? s.endpoint : undefined,
    sort: s.sort === "slow" || s.sort === "busy" ? s.sort : undefined,
    ...rangeSearch(s),
  }),
  loaderDeps: ({ search }) => ({ app: search.app, endpoint: search.endpoint, range: search.range, from: search.from, to: search.to }),
  loader: ({ deps }) => getEndpoints({ data: deps }),
  component: EndpointsPage,
});

function EndpointsPage() {
  const report = Route.useLoaderData();
  const search = Route.useSearch();
  const { sort = "failing" } = search;
  const navigate = useNavigate({ from: Route.fullPath });
  if (!report) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
        <h1 className="text-xl font-semibold">No apps have sent events yet</h1>
      </main>
    );
  }
  const { range, services, selected } = report;
  const endpoints = sorted(report.endpoints, sort);
  return (
    <main className="mx-auto max-w-7xl space-y-5 px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Endpoints</h1>
          <p className="mt-1 text-sm text-muted">Which backend services and calls fail or are slow in {range.label}.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <RangePicker key={`${range.preset}${range.from}${range.to}`} value={range} today={report.generatedAt.slice(0, 10)} onChange={(r) => navigate({ search: (s) => ({ ...s, ...r }) })} />
          {report.apps.length > 1 && (
            <select aria-label="App" value={report.app} onChange={(e) => navigate({ search: (s) => ({ ...s, app: e.target.value, endpoint: undefined }) })} className="rounded-md border border-line bg-panel px-2 py-1.5 text-sm">
              {report.apps.map((a) => <option key={a}>{a}</option>)}
            </select>
          )}
        </div>
      </div>
      <RetentionNote rangeFrom={range.from} retention={report.retention} />

      {selected && <EndpointDetail app={report.app} row={selected.endpoint} failures={selected.failures} />}
      {report.missing && (
        <p className="rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm text-muted">
          <span className="font-mono text-ink">{report.missing}</span> had no calls or failures in {range.label}.
        </p>
      )}

      {endpoints.length === 0 ? (
        <p className="text-sm text-muted">No API calls recorded in {range.label}. Calls are counted when the SDK's network capture is on, and failures when they're stored as errors.</p>
      ) : (
        <>
        {services.length > 1 && <Services rows={services} endpoints={report.endpoints} keep={{ app: report.app, range: search.range, from: search.from, to: search.to }} now={Date.parse(report.generatedAt)} />}
        <Card
          title={`${endpoints.length} endpoint${endpoints.length === 1 ? "" : "s"}`}
          subtitle="Calls, failure rate and timings count every call the SDK saw. Statuses and backend codes count the stored failures, which the SDK samples."
          right={
            <span className="flex gap-1 text-xs" role="group" aria-label="Sort endpoints">
              {(Object.keys(SORTS) as Sort[]).map((k) => (
                <Link key={k} to="/endpoints" search={(s) => ({ ...s, sort: k === "failing" ? undefined : k })} aria-pressed={sort === k} className={`whitespace-nowrap rounded-md border px-2 py-1 ${sort === k ? "border-ink text-ink" : "border-line text-muted hover:text-ink"}`}>
                  {SORTS[k]}
                </Link>
              ))}
            </span>
          }
        >
          <div className="-mx-4 overflow-x-auto sm:mx-0">
            <table className="tabular w-full min-w-[720px] text-left text-sm">
              <thead className="text-xs text-muted">
                <tr className="border-b border-line">
                  <th className="px-4 py-2 font-medium sm:px-2">Endpoint</th>
                  <th className="px-2 py-2 text-right font-medium">Calls</th>
                  <th className="px-2 py-2 text-right font-medium">Failed</th>
                  <th className="px-2 py-2 text-right font-medium">p50</th>
                  <th className="px-2 py-2 text-right font-medium">p95</th>
                  <th className="px-2 py-2 font-medium">Statuses</th>
                  <th className="px-2 py-2 font-medium">Backend codes</th>
                </tr>
              </thead>
              <tbody>
                {endpoints.map((r) => (
                  <tr key={r.endpoint} className={`border-b border-line last:border-0 ${selected?.endpoint.endpoint === r.endpoint ? "bg-panel-2" : ""}`}>
                    <td className="max-w-[320px] px-4 py-2 sm:px-2">
                      <Link to="/endpoints" search={(s) => ({ ...s, endpoint: r.endpoint })} className="block hover:underline" title={r.endpoint}>
                        <EndpointName row={r} />
                      </Link>
                    </td>
                    <td className="px-2 py-2 text-right text-muted">{count(r.calls)}</td>
                    <td className={`px-2 py-2 text-right ${r.failureRate !== null && r.failureRate >= 0.05 ? "font-semibold text-sev-critical" : "text-muted"}`}>
                      {r.failureRate !== null ? pct(r.failureRate) : r.failures ? `${r.failures} stored` : "—"}
                    </td>
                    <td className="px-2 py-2 text-right">{ms(r.p50)}</td>
                    <td className={`px-2 py-2 text-right font-semibold ${r.p95 !== null && r.p95 >= 3000 ? "text-sev-high" : ""}`}>{ms(r.p95)}</td>
                    <td className="px-2 py-2"><Counts items={r.statuses} /></td>
                    <td className="px-2 py-2"><Counts items={r.backendCodes} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-muted">
            Failed: calls the SDK counted as failed (status 400 and above on mobile). p50/p95: half / 95% of calls finished within this time. "—": the SDK sent no request timings for that endpoint.
          </p>
          {report.truncated && <p className="mt-1 text-xs text-muted">There were more stored failures than one page reads: statuses, backend codes and failure lists may be undercounted. Pick a shorter period for exact ones.</p>}
        </Card>
        </>
      )}
    </main>
  );
}

function EndpointDetail({ app, row, failures }: { app: string; row: EndpointHealth; failures: EndpointFailure[] }) {
  return (
    <Card title={joined([row.service, row.method, row.path]) ?? row.endpoint} subtitle={`${row.failures} stored failure${row.failures === 1 ? "" : "s"} in this period${row.lastFailure ? `, the last ${timeAgo(row.lastFailure)}` : ""}. Newest first.`}>
      <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <span><span className="text-muted">Calls </span>{count(row.calls)}</span>
        <span><span className="text-muted">Failure rate </span>{rate(row.failureRate)}</span>
        <span><span className="text-muted">p50 </span>{ms(row.p50)}</span>
        <span><span className="text-muted">p95 </span>{ms(row.p95)}</span>
        <Link to="/endpoints" search={(s) => ({ ...s, endpoint: undefined })} className="ml-auto text-xs text-muted hover:text-ink hover:underline">Close</Link>
      </div>
      {failures.length === 0 ? (
        <p className="text-sm text-muted">No stored failures for this endpoint in this period.</p>
      ) : (
        <ul className="divide-y divide-line">
          {failures.map((f) => (
            <li key={f.eventId}>
              <Link to="/events/$eventId" params={{ eventId: f.eventId }} search={{ app, issue: f.fingerprint }} className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 px-1 py-2 text-sm hover:bg-panel-2 sm:grid-cols-[11rem_5rem_1fr_auto]">
                <span title={f.ts}>{clock(f.ts)}</span>
                <span className="justify-self-end font-semibold text-sev-critical sm:justify-self-start">{f.status}</span>
                <span className="min-w-0 break-words text-muted">
                  {joined([f.backendCode && `code ${f.backendCode}`, f.backendTitle && `"${f.backendTitle}"`, f.errorKind, f.traceId && `trace ${f.traceId.slice(0, 8)}…`], " · ") ?? "No backend detail"}
                </span>
                <span className="font-mono text-xs text-muted sm:text-right">{f.userId ?? ""}{f.durationMs !== undefined ? ` · ${f.durationMs} ms` : ""}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Each backend service as a box in its level's colour, worst first; a box opens that service. */
function Services({ rows, endpoints, keep, now }: { rows: ServiceHealth[]; endpoints: EndpointHealth[]; keep: { app: string; range?: string; from?: string; to?: string }; now: number }) {
  const tiles = rows.map((r) => serviceTile(r, endpoints, now)).sort(byHealth);
  return (
    <Card title="By service" subtitle="Coloured by how each is doing, worst first. Click one for what's failing, how often, and why.">
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {tiles.map((t) => (
          <li key={t.key}>
            <HealthBox level={t.level} name={t.name} headline={t.headline} measure={t.measure} live={t.live} lastFailure={t.lastFailure} link={{ to: "/services/$service", params: { service: t.key || "unnamed" }, search: keep }} />
          </li>
        ))}
      </ul>
      {rows.some((r) => !r.service) && <p className="mt-2 text-xs text-muted">Name hosts in Settings, or set the SDK's network.baseUrls, to group unnamed ones.</p>}
    </Card>
  );
}

/** The endpoints in the order picked: most failures (as the server sends them), slowest p95, or most calls. */
function sorted(rows: EndpointHealth[], sort: Sort): EndpointHealth[] {
  if (sort === "failing") return rows;
  const by = sort === "slow" ? (r: EndpointHealth) => (r.p95 === null ? -1 : Number.isFinite(r.p95) ? r.p95 : 1e9) : (r: EndpointHealth) => r.calls ?? -1;
  return [...rows].sort((a, b) => by(b) - by(a));
}

const count = (n: number | null) => (n === null ? "—" : n.toLocaleString());
const rate = (r: number | null) => (r === null ? "—" : pct(r));

function EndpointName({ row }: { row: EndpointHealth }) {
  return (
    <span className="break-words">
      {row.service && <span className="font-medium">{row.service} </span>}
      <span className="font-mono text-xs">{joined([row.method, row.path])}</span>
    </span>
  );
}

function Counts({ items }: { items: Count[] }) {
  if (!items.length) return <span className="text-muted">—</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {items.slice(0, 3).map((c) => (
        <span key={c.key} className="rounded bg-panel-2 px-1.5 py-0.5 font-mono text-[11px]">
          {c.key}
          <span className="text-muted"> ×{c.count}</span>
        </span>
      ))}
      {items.length > 3 && <span className="text-[11px] text-muted">+{items.length - 3}</span>}
    </span>
  );
}

function pct(r: number) {
  return `${(r * 100).toFixed(r < 0.1 ? 1 : 0)}%`;
}

function ms(v: number | null) {
  if (v === null) return "—";
  if (!Number.isFinite(v)) return "> 10 s";
  return v >= 1000 ? `≤ ${(v / 1000).toFixed(v % 1000 ? 1 : 0)} s` : `≤ ${v} ms`;
}
