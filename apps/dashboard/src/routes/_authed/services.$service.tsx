import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { RangePicker, rangeSearch, RetentionNote, type RangeSearch } from "~/components/range-picker";
import { LevelRow, levelName, timeAgo } from "~/components/ui";
import type { EndpointHealth } from "~/server/endpoints";
import { getEndpoints } from "~/server/fns";
import { HEALTH_ORDER, serviceKey, serviceLevel, servicesOf, serviceTile, shortPath } from "~/lib/health";

type Search = { app?: string } & RangeSearch;

export const Route = createFileRoute("/_authed/services/$service")({
  validateSearch: (s: Record<string, unknown>): Search => ({ app: typeof s.app === "string" ? s.app : undefined, ...rangeSearch(s) }),
  loaderDeps: ({ search }) => ({ app: search.app, range: search.range, from: search.from, to: search.to }),
  loader: ({ deps }) => getEndpoints({ data: deps }),
  component: ServicePage,
});

/** "unnamed" in the address is the endpoints nobody named a service for. */
const keyOf = (param: string) => serviceKey(param === "unnamed" ? undefined : param);

/**
 * One service, one level down from the health wall: its endpoints worst first, each with what
 * the server said, how often, and the issues behind it (one click from the cause and the fix).
 */
function ServicePage() {
  const report = Route.useLoaderData();
  const { service } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  if (!report) return <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6"><h1 className="text-xl font-semibold">No apps have sent events yet</h1></main>;

  const { range } = report;
  const keep = { app: report.app, range: search.range, from: search.from, to: search.to };
  const endpoints = report.endpoints.filter((e) => serviceKey(e.service) === keyOf(service));
  const summary = servicesOf(endpoints)[0];
  const now = Date.parse(report.generatedAt);
  const tile = summary && serviceTile(summary, endpoints, now);
  const rows = endpoints
    .map((e) => ({ e, level: serviceLevel({ calls: e.calls ?? 0, failedCalls: e.failedCalls ?? 0, failures: e.failures }) }))
    .sort((a, b) => HEALTH_ORDER[b.level] - HEALTH_ORDER[a.level] || Math.max(b.e.failedCalls ?? 0, b.e.failures) - Math.max(a.e.failedCalls ?? 0, a.e.failures));
  const failing = rows.filter((r) => r.level !== "healthy");
  const healthy = rows.filter((r) => r.level === "healthy");

  return (
    <main className="mx-auto max-w-7xl space-y-5 px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Breadcrumb" className="text-sm text-muted">
          <Link to="/" search={keep} className="hover:text-ink hover:underline">Health</Link>
          <span aria-hidden> › </span>
          <span className="text-ink" aria-current="page">{tile?.name ?? service}</span>
        </nav>
        <RangePicker key={`${range.preset}${range.from}${range.to}`} value={range} today={report.generatedAt.slice(0, 10)} onChange={(r) => navigate({ search: (s) => ({ ...s, ...r }) })} />
      </div>
      <RetentionNote rangeFrom={range.from} retention={report.retention} />

      {!tile ? (
        <p className="text-sm text-muted">{service} had no calls or failures in {range.label}.</p>
      ) : (
        <>
          <header>
            <p className="text-xs font-bold uppercase tracking-wide">
              <span className={TEXT[tile.level]}>{levelName(tile.level)}</span>
              {tile.live && <span className={`ml-2 normal-case ${TEXT[tile.level]}`}>· Still happening</span>}
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">{tile.name}</h1>
            <p className="mt-1 text-sm text-muted">
              {tile.measure} in {range.label}
              {tile.lastFailure ? `, the last ${timeAgo(tile.lastFailure, now)}` : ""}. {endpoints.length} endpoint{endpoints.length === 1 ? "" : "s"}, worst first.
            </p>
          </header>

          {failing.length > 0 ? (
            <ol className="space-y-3" aria-label="Failing endpoints, worst first">
              {failing.map(({ e, level }) => (
                <li key={e.endpoint}>
                  <LevelRow level={level} aside={e.failureRate !== null ? `${pct(e.failureRate)} failed` : `${e.failures} failures`}>
                    <EndpointProblems row={e} keep={keep} now={now} />
                  </LevelRow>
                </li>
              ))}
            </ol>
          ) : (
            <p className="rounded-lg border border-level-healthy-edge bg-level-healthy-bg px-3 py-2 text-sm text-level-healthy-fg">Every call to {tile.name} worked in {range.label}.</p>
          )}

          {healthy.length > 0 && (
            <section aria-label="Healthy endpoints">
              <h2 className="mb-2 text-sm font-semibold text-muted">Healthy</h2>
              <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {healthy.map(({ e }) => (
                  <li key={e.endpoint} className="rounded-lg border border-level-healthy-edge bg-level-healthy-bg px-3 py-2 text-sm text-level-healthy-fg">
                    <span className="font-mono text-xs">{e.method} {e.path}</span>
                    <span className="block text-xs">{e.calls?.toLocaleString() ?? "—"} calls, none failed</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </main>
  );
}

const TEXT: Record<string, string> = {
  critical: "text-level-critical-fg",
  high: "text-level-high-fg",
  medium: "text-level-medium-fg",
  low: "text-level-low-fg",
  healthy: "text-level-healthy-fg",
};

/** One failing endpoint: what the server said, how often, and the issues behind it. */
function EndpointProblems({ row, keep, now }: { row: EndpointHealth; keep: { app: string; range?: string; from?: string; to?: string }; now: number }) {
  const said = [...row.statuses.slice(0, 3).map((s) => `${s.key} ×${s.count}`)];
  const code = row.backendCodes[0];
  const message = row.backendMessages[0];
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="break-all font-mono text-sm font-semibold">
          {row.method} {row.path}
        </h2>
        <span className="tabular text-xs text-muted">
          {row.calls !== null ? `${(row.failedCalls ?? 0).toLocaleString()} of ${row.calls.toLocaleString()} calls failed` : `${row.failures} stored failures`}
          {row.lastFailure ? ` · last ${timeAgo(row.lastFailure, now)}` : ""}
        </span>
      </div>
      {(said.length > 0 || code || message) && (
        <p className="text-sm">
          <span className="text-muted">The server said: </span>
          {said.join(", ")}
          {(code || message) && (
            <>
              {said.length ? " · " : ""}
              <span className="font-semibold">{[code?.key, message?.key && `"${message.key}"`].filter(Boolean).join(" ")}</span>
            </>
          )}
        </p>
      )}
      {row.problems.length > 0 && (
        <ul className="space-y-1.5" aria-label={`What's causing it on ${shortPath(row.path)}`}>
          {row.problems.map((p) => (
            <li key={p.fingerprint}>
              <Link
                to="/issues/$fingerprint"
                params={{ fingerprint: p.fingerprint }}
                search={keep}
                className="group flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm hover:border-accent focus-visible:outline-2 focus-visible:outline-accent"
              >
                <span className="min-w-0 break-words">
                  <span className="font-medium">{p.title}</span>
                  <span className="tabular block text-xs text-muted">
                    {p.count}× · {p.status} · {[p.platforms.join(", "), p.versions.slice(0, 2).map((v) => `app ${v}`).join(", ")].filter(Boolean).join(" · ")} · last {timeAgo(p.lastSeen, now)}
                  </span>
                </span>
                <span className="shrink-0 text-xs font-semibold text-accent group-hover:underline">Cause and fix →</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Link to="/endpoints" search={{ ...keep, endpoint: row.endpoint }} className="inline-block text-xs text-accent hover:underline">
        Every failure on this endpoint, with traces →
      </Link>
    </div>
  );
}

const pct = (r: number) => (r > 0 && r < 0.01 ? "<1%" : `${Math.round(r * 100)}%`);
