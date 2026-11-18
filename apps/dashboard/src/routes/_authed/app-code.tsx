import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { EmptyState } from "~/components/empty-state";
import { RangePicker, rangeSearch, RetentionNote, type PageSearch } from "~/components/range-picker";
import { ClosedIssues } from "~/components/closed-issues";
import { IssueLabels, LevelRow, levelName, timeAgo, toneClass } from "~/components/ui";
import { plural } from "~/lib/health";
import { testsFlag } from "~/lib/issue-filter";
import { getAppCode } from "~/server/fns";
import type { IssueRow } from "~/server/queries";

type Search = PageSearch & { tests?: boolean };

export const Route = createFileRoute("/_authed/app-code")({
  // tests: show the errors made on purpose to test deBug (the Folded away line links here).
  validateSearch: (s: Record<string, unknown>): Search => ({ app: typeof s.app === "string" ? s.app : undefined, tests: testsFlag(s.tests) || undefined, ...rangeSearch(s) }),
  loaderDeps: ({ search }) => ({ app: search.app, range: search.range, from: search.from, to: search.to }),
  loader: ({ deps }) => getAppCode({ data: deps }),
  component: AppCodePage,
});

/**
 * The App code box, one level down: the app's own crashes and code errors (not failed calls,
 * which belong to their service), worst first, each one click from its cause and fix. Resolved
 * and ignored ones sit apart at the bottom.
 */
function AppCodePage() {
  const report = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  if (!report) return <EmptyState />;
  const { range, tile, open, closed } = report;
  const keep: PageSearch = { app: report.app, range: search.range, from: search.from, to: search.to };
  const now = Date.parse(report.generatedAt);

  return (
    <main className="mx-auto max-w-7xl space-y-5 px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Breadcrumb" className="text-sm text-muted">
          <Link to="/" search={keep} className="hover:text-ink hover:underline">Health</Link>
          <span aria-hidden> › </span>
          <span className="text-ink" aria-current="page">App code</span>
        </nav>
        <RangePicker key={`${range.preset}${range.from}${range.to}`} value={range} today={report.generatedAt.slice(0, 10)} onChange={(r) => navigate({ search: (s) => ({ ...s, ...r }) })} />
      </div>
      <RetentionNote rangeFrom={range.from} retention={report.retention} />

      <header>
        <p className="text-xs font-bold uppercase tracking-wide">
          <span className={toneClass(tile.level, "text")}>{levelName(tile.level)}</span>
          {tile.live && <span className={`ml-2 normal-case ${toneClass(tile.level, "text")}`}>· Still happening</span>}
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">App code</h1>
        <p className="mt-1 text-sm text-muted">Crashes and code errors in the app itself, in {range.label}, worst first. Failed calls are on their service's page.</p>
      </header>

      {search.tests && <TestErrors issues={report.tests} keep={keep} now={now} />}

      {open.length ? (
        <ol className="space-y-3" aria-label="Open crashes and code errors, worst first">
          {open.map((i) => (
            <li key={i.fingerprint}>
              <LevelRow level={i.severity} aside={plural(i.countRange, "time")}>
                <Problem issue={i} keep={keep} now={now} />
              </LevelRow>
            </li>
          ))}
        </ol>
      ) : (
        <p className="rounded-lg border border-level-healthy-edge bg-level-healthy-bg px-3 py-2 text-sm text-level-healthy-fg">No open crashes or code errors in {range.label}.</p>
      )}

      <ClosedIssues issues={closed} keep={keep} now={now} />
    </main>
  );
}

/** One crash or code error: what, where in the code, how often, and the way to its cause and fix. */
function Problem({ issue: i, keep, now }: { issue: IssueRow; keep: PageSearch; now: number }) {
  const versions = [i.firstVersion, i.lastVersion].filter((v, n, all) => v && all.indexOf(v) === n);
  return (
    <Link
      to="/issues/$fingerprint"
      params={{ fingerprint: i.fingerprint }}
      search={{ ...keep, app: keep.app ?? "" }}
      className="group -m-1 flex flex-wrap items-center justify-between gap-2 rounded-lg p-1 hover:bg-panel-2 focus-visible:outline-2 focus-visible:outline-accent"
    >
      <span className="min-w-0 break-words">
        <span className="font-medium">{i.title}</span>
        {i.culprit && <span className="block font-mono text-xs text-muted">{i.culprit}</span>}
        <span className="tabular block text-xs text-muted">
          {plural(i.countRange, "time")}
          {i.users ? ` · ${plural(i.users, "customer")}` : ""}
          {versions.length ? ` · app ${versions.join("–")}` : ""} · last {timeAgo(i.lastSeen, now)}
        </span>
        <IssueLabels issue={i} />
      </span>
      <span className="shrink-0 text-xs font-semibold text-accent group-hover:underline">Cause and fix →</span>
    </Link>
  );
}

/** Errors the app made on purpose to test deBug: shown only when asked for, never counted. */
function TestErrors({ issues, keep, now }: { issues: readonly IssueRow[]; keep: PageSearch; now: number }) {
  return (
    <section id="test-errors" aria-labelledby="tests-h" className="rounded-xl border border-line bg-panel p-4">
      <h2 id="tests-h" className="text-sm font-semibold">Test errors ({issues.length})</h2>
      <p className="mt-0.5 text-sm text-muted">Why they're folded away: the app made them on purpose to check deBug works (tagged test=true), so they never count toward any box, total, rate or alert.</p>
      {issues.length ? (
        <ul className="mt-3 space-y-1.5 text-sm">
          {issues.map((i) => (
            <li key={i.fingerprint}>
              <Link to="/issues/$fingerprint" params={{ fingerprint: i.fingerprint }} search={{ ...keep, app: keep.app ?? "" }} className="flex flex-wrap justify-between gap-2 rounded px-1 py-0.5 hover:bg-panel-2">
                <span className="min-w-0 break-words">{i.title}</span>
                <span className="shrink-0 text-xs text-muted">{plural(i.countRange, "time")} · last {timeAgo(i.lastSeen, now)}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-muted">None in this period.</p>
      )}
    </section>
  );
}
