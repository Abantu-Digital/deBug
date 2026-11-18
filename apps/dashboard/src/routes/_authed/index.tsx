import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { CopyButton } from "~/components/copy-button";
import { RangePicker, rangeSearch, RetentionNote, type RangeSearch } from "~/components/range-picker";
import { HealthBox, levelName } from "~/components/ui";
import { getHealth } from "~/server/fns";
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
  if (!report) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
        <h1 className="text-xl font-semibold">No apps have sent events yet</h1>
        <p className="mt-2 text-sm text-muted">Once the SDK sends its first event, every service the app calls shows up here, coloured by how it's doing.</p>
      </main>
    );
  }
  const { range, tiles, counts } = report;
  const keep = { app: report.app, range: search.range, from: search.from, to: search.to };
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
              <Box tile={t} keep={keep} />
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
                <Box tile={t} keep={keep} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {!shown.length && <p className="text-sm text-muted">Nothing at this level in {range.label}.</p>}

      <p className="flex flex-wrap gap-4 text-sm">
        <Link to="/issues" search={keep} className="text-accent hover:underline">Every issue, worst first →</Link>
        <Link to="/endpoints" search={keep} className="text-accent hover:underline">Every endpoint, with timings →</Link>
      </p>
    </main>
  );
}

type Keep = { app: string; range?: string; from?: string; to?: string };

function Box({ tile, keep }: { tile: HealthTileData; keep: Keep }) {
  // The app's own code opens its worst crash or code error; a service opens its page.
  const link =
    tile.kind === "app"
      ? tile.fingerprint
        ? { to: "/issues/$fingerprint" as const, params: { fingerprint: tile.fingerprint }, search: keep }
        : { to: "/issues" as const, search: keep }
      : { to: "/services/$service" as const, params: { service: tile.key || "unnamed" }, search: keep };
  return <HealthBox level={tile.level} name={tile.name} headline={tile.headline} measure={tile.measure} live={tile.live} lastFailure={tile.lastFailure} link={link} big={tile.level === "critical"} />;
}

const CHIP_TONE: Record<HealthLevel, string> = {
  critical: "border-level-critical-edge bg-level-critical-bg text-level-critical-fg",
  high: "border-level-high-edge bg-level-high-bg text-level-high-fg",
  medium: "border-level-medium-edge bg-level-medium-bg text-level-medium-fg",
  low: "border-level-low-edge bg-level-low-bg text-level-low-fg",
  healthy: "border-level-healthy-edge bg-level-healthy-bg text-level-healthy-fg",
};

function LevelChip({ level, count, on }: { level: HealthLevel; count: number; on: boolean }) {
  return (
    <Link
      to="/"
      search={(s) => ({ ...s, level: on ? undefined : level })}
      aria-pressed={on}
      className={`tabular rounded-full border px-3 py-1 text-sm font-semibold hover:brightness-110 ${count ? CHIP_TONE[level] : "border-line text-muted"} ${on ? "ring-2 ring-accent ring-offset-2 ring-offset-bg" : ""}`}
    >
      {count} {levelName(level)}
    </Link>
  );
}
