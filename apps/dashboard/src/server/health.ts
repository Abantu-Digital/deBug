import { isRequestCategory } from "@debugkit/ingest";
import { SEVERITY_ORDER } from "@debugkit/schema";
import { answerOf, byHealth, LIVE_MS, plural, serviceTile, type HealthLevel, type HealthTileData } from "../lib/health";
import type { EndpointsReport } from "./endpoints";
import type { IssueRow, Summary } from "./queries";

/** The health wall's data: see lib/health.ts for how each box's level is worked out. */
export interface HealthReport {
  app: string;
  apps: string[];
  generatedAt: string;
  range: Summary["range"];
  retention: Summary["retention"];
  /** Worst first. */
  tiles: HealthTileData[];
  /** How many boxes at each level. */
  counts: Record<HealthLevel, number>;
  /** One paragraph a product owner can give a client. */
  answer: string;
}

/** The app's own code: crashes and errors that aren't a failed call. Its level is its worst open issue's. */
export function appTile(issues: readonly IssueRow[], now: number): HealthTileData {
  const open = issues.filter((i) => (i.status === "open" || i.status === "regressed") && !(i.labels && isRequestCategory(i.labels.category)));
  const worst = [...open].sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] || b.countRange - a.countRange)[0];
  const lastSeen = open.map((i) => i.lastSeen).sort().pop();
  const occurrences = open.reduce((n, i) => n + i.countRange, 0);
  return {
    key: "app",
    name: "App code",
    kind: "app",
    level: worst?.severity ?? "healthy",
    headline: worst?.title,
    measure: open.length ? `${plural(open.length, "crash or code error")} open, ${plural(occurrences, "time")}` : "No crashes or code errors",
    live: !!lastSeen && now - Date.parse(lastSeen) < LIVE_MS,
    lastFailure: lastSeen,
    weight: occurrences,
    fingerprint: worst?.fingerprint,
  };
}

export function buildHealth(endpoints: EndpointsReport, summary: Summary, now = Date.now()): HealthReport {
  const tiles = [...endpoints.services.map((s) => serviceTile(s, endpoints.endpoints, now)), appTile(summary.issues, now)].sort(byHealth);
  const counts: Record<HealthLevel, number> = { critical: 0, high: 0, medium: 0, low: 0, healthy: 0 };
  for (const t of tiles) counts[t.level]++;
  return {
    app: summary.app,
    apps: summary.apps,
    generatedAt: new Date(now).toISOString(),
    range: summary.range,
    retention: summary.retention,
    tiles,
    counts,
    answer: answerOf(tiles, summary.range.label),
  };
}
