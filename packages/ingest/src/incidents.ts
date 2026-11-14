import type { Category, Cause, Classification } from "@debugkit/schema";

/**
 * Incidents fold issues that fail together for the same reason into one problem: the six
 * requests that failed when the app reopened are one incident, not four issues.
 *
 * The key is the cause, the category and the OS, never a fingerprint, so it stays the same across
 * builds and releases: "resumed_from_background|network.never_sent|ios". Issues stay the unit for
 * resolving and regressions; incidents sit above them.
 */

/** Causes that tie several errors together, most telling first. */
const GROUPING_CAUSES: readonly Cause[] = ["resumed_from_background", "burst"];
/** A burst only means something for requests. */
const REQUEST_CATEGORIES = new Set<Category>(["network.timeout", "network.never_sent", "network.failed", "network.offline", "server", "auth", "client_request"]);
/** Errors in one batch this close together, of the same category, belong to the same incident. */
export const INCIDENT_WINDOW_MS = 5_000;

export interface IncidentKey {
  cause: Cause;
  category: Category;
  os: string;
}

export function incidentKey(labels: Classification, os: string): string | undefined {
  const cause = GROUPING_CAUSES.find((c) => labels.causes.includes(c) && (c !== "burst" || REQUEST_CATEGORIES.has(labels.category)));
  return cause ? [cause, labels.category, os.toLowerCase() || "unknown"].join("|") : undefined;
}

export function parseIncidentKey(key: string): IncidentKey | undefined {
  const [cause, category, os] = key.split("|");
  return cause && category && os ? { cause: cause as Cause, category: category as Category, os } : undefined;
}

export interface BatchError {
  ts: string;
  labels: Classification;
  incident?: string;
}

/**
 * Give each error in one batch its incident. An error's own labels decide first. Then an error
 * with none joins an incident of the same category that starts within INCIDENT_WINDOW_MS after
 * it: the first failure of a burst can't know the others are coming, but the batch does.
 */
export function assignIncidents(errors: BatchError[], os: string): void {
  for (const e of errors) e.incident = incidentKey(e.labels, os);
  for (const e of errors) {
    if (e.incident) continue;
    const at = Date.parse(e.ts);
    const next = errors.find((o) => {
      if (!o.incident || o.labels.category !== e.labels.category) return false;
      const d = Date.parse(o.ts) - at;
      return d >= 0 && d <= INCIDENT_WINDOW_MS;
    });
    if (next) e.incident = next.incident;
  }
}
