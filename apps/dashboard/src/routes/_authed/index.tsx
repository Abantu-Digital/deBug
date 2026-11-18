import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { CopyButton } from "~/components/copy-button";
import { EmptyState } from "~/components/empty-state";
import { RangePicker, rangeSearch, RetentionNote, type PageSearch, type RangeSearch } from "~/components/range-picker";
import { HealthBox, levelName, toneClass } from "~/components/ui";
import { getHealth } from "~/server/fns";
import type { HealthReport } from "~/server/health";
import { HEALTH_ORDER, type HealthLevel, type HealthTileData } from "~/lib/health";

const LEVELS = (Object.keys(HEALTH_ORDER) as HealthLevel[]).sort((a, b) => HEALTH_ORDER[b] - HEALTH_ORDER[a]);
const isLevel = (v: unknown): v is HealthLevel => typeof v === "string" && v in HEALTH_ORDER;

type Search = { app?: string; level?: HealthLevel } & RangeSearch;

export const Route = createFileRoute("/_authed/")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    app: typeof s.app === "string" ? s.app : undefined,
    level: isLevel(s.level) ? s.level : undefined,
    ...rangeSearch(s),
  }),
  loaderDeps: ({ search }) => ({ app: search.app, range: search.range, from: search.from, to: search.to }),
  loader: ({ deps }) => getHealth({ data: deps }),
  component: HealthWall,
});

/**
 * The home page: every backend service and the app's own code as a box, in its level's colour,
 * worst first. Red means a big problem, orange a smaller one, yellow minor, grey one-offs, green
 * healthy. Each box opens where the problem is, how often, and what's causing it.
 */
function HealthWall() {
  const report = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  if (!report) return <EmptyState />;
  const { range, tiles, counts } = report;
  const keep: PageSearch = { app: report.app, range: search.range, from: search.from, to: search.to };
  const now = Date.parse(report.generatedAt);
  const shown = search.level ? tiles.filter((t) => t.level === search.level) : tiles;
  const problems = shown.filter((t) => t.level !== "healthy");
  const healthy = shown.filter((t) => t.level === "healthy");

  return (
    <main className="mx-auto max-w-7xl space-y-5 px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted">Health · {range.label}</p>
          <h1 className="text-2xl font-semibold tracking-tight">How {report.app} is doing</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <RangePicker key={`${range.preset}${range.from}${range.to}`} value={range} today={report.generatedAt.slice(0, 10)} onChange={(r) => navigate({ search: (s) => ({ ...s, ...r }) })} />
          {report.apps.length > 1 && (
            <select aria-label="App" value={report.app} onChange={(e) => navigate({ search: (s) => ({ ...s, app: e.target.value }) })} className="rounded-md border border-line bg-panel px-2 py-1.5 text-sm">
              {report.apps.map((a) => <option key={a}>{a}</option>)}
            </select>
          )}
        </div>
      </div>
      <RetentionNote rangeFrom={range.from} retention={report.retention} />

      {/* The answer to "why is it breaking?", ready to give a client. */}
      <section aria-label="In short" className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-4 sm:flex-row sm:items-start sm:justify-between">
        <p className="text-base leading-relaxed">{report.answer}</p>
        <span className="shrink-0 whitespace-nowrap">
          <CopyButton text={report.answer} label="Copy for the client" ariaLabel="Copy this summary for the client" />
        </span>
      </section>

      {/* One chip per level: click to show only that level, again to show all. */}
      <div role="group" aria-label="Show one level" className="flex flex-wrap gap-2">
        {LEVELS.map((l) => (
          <LevelChip key={l} level={l} count={counts[l]} on={search.level === l} />
        ))}
        {search.level && (
          <Link to="/" search={(s) => ({ ...s, level: undefined })} className="rounded-full px-3 py-1 text-sm text-accent hover:underline">
            Show all
          </Link>
        )}
      </div>

      {problems.length > 0 && (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Problems, worst first">
          {problems.map((t) => (
            <li key={`${t.kind}${t.key}`} className={t.level === "critical" ? "sm:col-span-2" : ""}>
              <Box tile={t} keep={keep} now={now} />
            </li>
          ))}
        </ul>
      )}

      {healthy.length > 0 && (
        <section aria-label="Healthy">
          <h2 className="mb-2 text-sm font-semibold text-muted">Healthy</h2>
          <ul className="grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
            {healthy.map((t) => (
              <li key={`${t.kind}${t.key}`}>
                <Box tile={t} keep={keep} now={now} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {!shown.length && <p className="text-sm text-muted">Nothing at this level in {range.label}.</p>}

      <Folded folded={report.folded} keep={keep} />

      <p className="text-sm">
        <Link to="/endpoints" search={keep} className="text-accent hover:underline">Every endpoint, with timings →</Link>
      </p>
    </main>
  );
}

/** A box on the wall, linked one level down. */
function Box({ tile, keep, now }: { tile: HealthTileData; keep: PageSearch; now: number }) {
  const link = tile.kind === "app" ? { to: "/app-code" as const, search: keep } : { to: "/services/$service" as const, params: { service: tile.key }, search: keep };
  return <HealthBox level={tile.level} name={tile.name} headline={tile.headline} measure={tile.measure} live={tile.live} lastFailure={tile.lastFailure} link={link} big={tile.level === "critical"} now={now} />;
}

/** A level and how many boxes are at it. Click to show only that level, again to show all. None at that level: not clickable. */
function LevelChip({ level, count, on }: { level: HealthLevel; count: number; on: boolean }) {
  if (!count) return <span className="tabular rounded-full border border-line px-3 py-1 text-sm text-muted">0 {levelName(level)}</span>;
  return (
    <Link
      to="/"
      search={(s) => ({ ...s, level: on ? undefined : level })}
      aria-current={on ? "true" : undefined}
      className={`tabular rounded-full border px-3 py-1 text-sm font-semibold hover:brightness-110 ${toneClass(level, "surface")} ${on ? "ring-2 ring-accent ring-offset-2 ring-offset-bg" : ""}`}
    >
      {count} {levelName(level)}
    </Link>
  );
}

/** What's kept off the wall on purpose, each linking to where it's listed and why. Nothing when there's nothing. */
function Folded({ folded, keep }: { folded: HealthReport["folded"]; keep: PageSearch }) {
  if (!folded.tests) return null;
  return (
    <p className="text-sm text-muted">
      <span className="font-semibold">Folded away: </span>
      <Link to="/app-code" search={{ ...keep, tests: true }} hash="test-errors" className="text-accent hover:underline">
        Test errors: {folded.tests} →
      </Link>
    </p>
  );
}
