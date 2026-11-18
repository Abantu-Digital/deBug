import { isRequestCategory } from "@debugkit/ingest";
import { answerOf, byHealth, isOpen, LIVE_MS, plural, serviceTile, type HealthLevel, type HealthTileData } from "../lib/health";
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
  /** What's kept off the wall on purpose: test errors (ABA-133) and phones going offline (ABA-132). */
  folded: { tests: number; offline: Summary["connectivity"] };
}

/**
 * An issue in the app's own code: a crash or code error, not a failed call (those belong to a
 * service), and not one made on purpose to test deBug (ABA-133: those are folded away).
 */
export const isAppCodeIssue = (i: IssueRow): boolean => !i.test && !(i.labels && isRequestCategory(i.labels.category));

/** The App code page: its open issues worst first, and the resolved or ignored ones apart. */
export interface AppCodeReport {
  app: string;
  apps: string[];
  generatedAt: string;
  range: Summary["range"];
  retention: Summary["retention"];
  tile: HealthTileData;
  open: IssueRow[];
  closed: IssueRow[];
  /** Errors made on purpose to test deBug: listed apart, never counted. */
  tests: IssueRow[];
}

/** The App code page's data, from the summary the health wall also reads. */
export function buildAppCode(summary: Summary, now = Date.now()): AppCodeReport {
  const mine = summary.issues.filter(isAppCodeIssue);
  return {
    app: summary.app,
    apps: summary.apps,
    generatedAt: new Date(now).toISOString(),
    range: summary.range,
    retention: summary.retention,
    tile: appTile(summary.issues, now),
    // The summary already ranks by level, then count.
    open: mine.filter((i) => isOpen(i.status)),
    closed: mine.filter((i) => !isOpen(i.status)),
    tests: summary.issues.filter((i) => i.test),
  };
}

/** The app's own code: crashes and errors that aren't a failed call. Its level is its worst open issue's. */
export function appTile(issues: readonly IssueRow[], now: number): HealthTileData {
  const open = issues.filter((i) => isOpen(i.status) && isAppCodeIssue(i));
  // The summary already ranks worst first; the App code page lists them in the same order.
  const worst = open[0];
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
  };
}

/** The health wall: every service's box and the app code's box, worst first, with the counts and the client answer. */
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
    folded: { tests: summary.totals.testIssues, offline: summary.connectivity },
  };
}
