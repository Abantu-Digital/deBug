import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ClosedIssues, type ClosedIssue } from "~/components/closed-issues";
import { EmptyState } from "~/components/empty-state";
import { RangePicker, rangeSearch, RetentionNote, type PageSearch } from "~/components/range-picker";
import { LevelRow, levelName, timeAgo, toneClass } from "~/components/ui";
import { endpointsOf, failing, HEALTH_ORDER, isOpen, pct, plural, serviceLevel, servicesOf, serviceTile } from "~/lib/health";
import { bodyView } from "~/lib/exchange-view";
import type { EndpointHealth } from "~/server/endpoints";
import { getEndpoints } from "~/server/fns";

type Search = PageSearch;

export const Route = createFileRoute("/_authed/services/$service")({
  validateSearch: (s: Record<string, unknown>): Search => ({ app: typeof s.app === "string" ? s.app : undefined, ...rangeSearch(s) }),
  loaderDeps: ({ search }) => ({ app: search.app, range: search.range, from: search.from, to: search.to }),
  loader: ({ deps }) => getEndpoints({ data: deps }),
  component: ServicePage,
});

/**
 * One service, one level down from the health wall: its endpoints worst first, each with what
 * the server said, how often, and the issues behind it (one click from the cause and the fix).
 */
function ServicePage() {
  const report = Route.useLoaderData();
  const { service } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  if (!report) return <EmptyState />;

  const { range } = report;
  const keep: PageSearch = { app: report.app, range: search.range, from: search.from, to: search.to };
  const endpoints = endpointsOf(service, report.endpoints);
  const grouped = servicesOf(endpoints)[0];
  const summary = grouped && { ...grouped, key: service };
  const now = Date.parse(report.generatedAt);
  const tile = summary && serviceTile(summary, endpoints, now);
  const rows = endpoints
    .map((e) => ({ e, level: serviceLevel({ calls: e.calls ?? 0, failedCalls: e.failedCalls ?? 0, failures: e.failures }) }))
    .sort((a, b) => HEALTH_ORDER[b.level] - HEALTH_ORDER[a.level] || failing(b.e) - failing(a.e));
  const broken = rows.filter((r) => r.level !== "healthy");
  const healthy = rows.filter((r) => r.level === "healthy");
  // Resolved and ignored issues behind any endpoint, once each, folded away at the bottom.
  const closed = new Map<string, ClosedIssue>();
  for (const e of endpoints) for (const p of e.problems) if (!isOpen(p.issueStatus)) closed.set(p.fingerprint, { ...p, status: p.issueStatus });

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
              <span className={toneClass(tile.level, "text")}>{levelName(tile.level)}</span>
              {tile.live && <span className={`ml-2 normal-case ${toneClass(tile.level, "text")}`}>· Still happening</span>}
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">{tile.name}</h1>
            <p className="mt-1 text-sm text-muted">
              {tile.measure} in {range.label}
              {tile.lastFailure ? `, the last ${timeAgo(tile.lastFailure, now)}` : ""}. {plural(endpoints.length, "endpoint")}, worst first.
            </p>
          </header>

          {broken.length > 0 ? (
            <ol className="space-y-3" aria-label="Failing endpoints, worst first">
              {broken.map(({ e, level }) => (
                <li key={e.endpoint}>
                  <LevelRow level={level} aside={e.failureRate !== null ? `${pct(e.failureRate)} failed` : plural(e.failures, "failure")}>
                    <EndpointProblems row={e} keep={keep} now={now} service={service} />
                  </LevelRow>
                </li>
              ))}
            </ol>
          ) : (
            <p className="rounded-lg border border-level-healthy-edge bg-level-healthy-bg px-3 py-2 text-sm text-level-healthy-fg">Every call to {tile.name} worked in {range.label}.</p>
          )}

          <ClosedIssues issues={[...closed.values()]} keep={keep} now={now} />

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

/** One failing endpoint: what the server said, how often, and the issues behind it. */
function EndpointProblems({ row, keep, now, service }: { row: EndpointHealth; keep: PageSearch; now: number; service: string }) {
  const said = [...row.statuses.slice(0, 3).map((s) => `${s.key} ×${s.count}`)];
  const code = row.backendCodes[0];
  const open = row.problems.filter((p) => isOpen(p.issueStatus));
  const message = row.backendMessages[0];
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="break-all font-mono text-sm font-semibold">
          {row.method} {row.path}
        </h2>
        <span className="tabular text-xs text-muted">
          {row.calls !== null ? `${(row.failedCalls ?? 0).toLocaleString()} of ${plural(row.calls, "call")} failed` : plural(row.failures, "stored failure")}
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
      {row.lastAnswer?.body && (
        <details open className="rounded-lg border border-line bg-panel-2 p-2">
          <summary className="cursor-pointer text-xs font-medium text-muted hover:text-ink">
            What the server answered last, {row.lastAnswer.status}, {timeAgo(row.lastAnswer.ts, now)}
          </summary>
          <pre className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed">{bodyView({ body: row.lastAnswer.body })?.text ?? row.lastAnswer.body}</pre>
          <Link to="/issues/$fingerprint" params={{ fingerprint: row.lastAnswer.fingerprint }} search={{ ...keep, app: keep.app ?? "" }} className="text-xs text-accent hover:underline">
            The request and the whole response →
          </Link>
        </details>
      )}
      {open.length > 0 && (
        <ul className="space-y-1.5" aria-label={`What's causing it on ${row.method ?? ""} ${row.path ?? row.endpoint}`}>
          {open.map((p) => (
            <li key={p.fingerprint}>
              <Link
                to="/issues/$fingerprint"
                params={{ fingerprint: p.fingerprint }}
                search={{ ...keep, app: keep.app ?? "" }}
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
      {row.problems.length > 0 && !open.length && (
        <p className="text-sm text-muted">Its issues are all resolved or ignored (listed at the bottom): these failures came before that, or are still being looked at.</p>
      )}
      <Link to="/endpoints" search={{ ...keep, endpoint: row.endpoint }} className="inline-block text-xs text-accent hover:underline">
        Every failure on this endpoint, with traces →
      </Link>
    </div>
  );
}
