import type { Category, Cause, Classification } from "@debugkit/schema";
import { BURST_WINDOW_MS } from "./classify";

/**
 * Incidents fold issues that fail together for the same reason into one problem: the six
 * requests that failed when the app reopened are one incident, not four issues.
 *
 * An incident is a recurring problem across users and days, not one episode: the key is the
 * cause, the category and the OS, never a fingerprint or a session, so it stays the same across
 * builds and releases ("resumed_from_background|network.never_sent|ios"). Issues stay the unit for
 * resolving and regressions; incidents sit above them.
 */

/** Causes that tie several errors together, most telling first. */
const GROUPING_CAUSES: readonly Cause[] = ["resumed_from_background", "burst"];
const REQUEST_CATEGORIES = new Set<Category>(["network.offline", "network.timeout", "network.never_sent", "network.failed", "auth", "server", "client_request"]);

/** Categories for a failed request: the only ones a burst makes an incident of. */
export const isRequestCategory = (c: string) => REQUEST_CATEGORIES.has(c as Category);

export interface IncidentKey {
  cause: Cause;
  category: Category;
  os: string;
}

const SEP = "|";

export function incidentKey(labels: Classification, os: string): string | undefined {
  const cause = GROUPING_CAUSES.find((c) => labels.causes.includes(c) && (c !== "burst" || isRequestCategory(labels.category)));
  if (!cause) return undefined;
  // The OS is the only free text in the key: keep the separator out of it.
  const osPart = os.toLowerCase().replaceAll(SEP, " ").trim() || "unknown";
  return [cause, labels.category, osPart].join(SEP);
}

export function parseIncidentKey(key: string): IncidentKey | undefined {
  const [cause, category, os, ...rest] = key.split(SEP);
  return cause && category && os && !rest.length ? { cause: cause as Cause, category: category as Category, os } : undefined;
}

/** "<incident key>|<fingerprint>", the key of the incidentIssue rollup. */
export const incidentIssueKey = (incident: string, fingerprint: string) => `${incident}${SEP}${fingerprint}`;

export function parseIncidentIssueKey(key: string): { incident: string; fingerprint: string } | undefined {
  const cut = key.lastIndexOf(SEP);
  if (cut <= 0 || !parseIncidentKey(key.slice(0, cut))) return undefined;
  return { incident: key.slice(0, cut), fingerprint: key.slice(cut + 1) };
}

export interface BatchError {
  /** Device time, as sent. */
  ts: string;
  labels: Classification;
  incident?: string;
}

/**
 * Give each error in one batch its incident. An error's own labels decide first. Then the first
 * failure of a burst, which can't know the others are coming, joins a burst incident of the same
 * category that starts within BURST_WINDOW_MS after it. Only errors whose own incident is a burst
 * pull others in (never a resume incident: an earlier error didn't fail on resume), so the result
 * doesn't depend on the batch's order and never chains.
 */
export function assignIncidents(errors: BatchError[], os: string): void {
  for (const e of errors) e.incident = incidentKey(e.labels, os);
  const anchors = errors.filter((e) => parseIncidentKey(e.incident ?? "")?.cause === "burst").map((e) => ({ at: Date.parse(e.ts), e }));
  for (const e of errors) {
    if (e.incident || !isRequestCategory(e.labels.category)) continue;
    const at = Date.parse(e.ts);
    const anchor = anchors.find((a) => a.e.labels.category === e.labels.category && a.at - at >= 0 && a.at - at <= BURST_WINDOW_MS);
    if (anchor) e.incident = anchor.e.incident;
  }
}
