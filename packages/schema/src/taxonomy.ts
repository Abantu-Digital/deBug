/**
 * How deBug labels an error: what kind of problem it is, who most likely owns it, how badly it
 * hurts users, and the patterns that explain why it happened. The ingest classifier sets these
 * (ABA-106); the dashboard, explanations and ticket rules read them. docs/taxonomy.md lists the
 * rule behind each label.
 *
 * Ids are stable: dashboards, saved filters and ticket rules depend on them. Add new ones, never
 * rename. Labels and descriptions are for people and can change.
 */

export interface LabelInfo {
  /** Short name for the dashboard, in plain words. */
  label: string;
  /** One sentence a support person can read. */
  description: string;
}

/* ---------- Category: what kind of problem ---------- */

export const CATEGORIES = [
  "network.never_sent",
  "network.timeout",
  "network.offline",
  "server",
  "client_request",
  "auth",
  "crash",
  "unhandled_rejection",
  "screen_crash",
  "handled",
  "other",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_INFO: Record<Category, LabelInfo> = {
  "network.never_sent": {
    label: "Request never sent",
    description: "The request failed on the phone before reaching the server, usually because the connection wasn't ready.",
  },
  "network.timeout": {
    label: "Request timed out",
    description: "The request was sent but no answer came back in time: a slow network or a slow server.",
  },
  "network.offline": {
    label: "Phone offline",
    description: "The phone had no internet connection when the request was made.",
  },
  server: {
    label: "Server error",
    description: "The server received the request and failed (5xx). The problem is on the server side.",
  },
  client_request: {
    label: "Request rejected",
    description: "The server refused the request as invalid (4xx): the app sent something the server didn't accept.",
  },
  auth: {
    label: "Sign-in problem",
    description: "The server refused the request because the user wasn't signed in or not allowed (401 or 403).",
  },
  crash: {
    label: "App crash",
    description: "An error nobody caught closed the app.",
  },
  unhandled_rejection: {
    label: "Unhandled background error",
    description: "Background work failed and nothing handled it. The app kept running, but something may not have happened.",
  },
  screen_crash: {
    label: "Screen crash",
    description: "A screen failed to draw and showed the error screen instead. The rest of the app kept working.",
  },
  handled: {
    label: "Reported by the app",
    description: "The app caught this error itself and reported it.",
  },
  other: {
    label: "Other",
    description: "An error that doesn't match any category yet.",
  },
};

/* ---------- Owner: who most likely needs to fix it ---------- */

export const OWNERS = ["app", "backend", "infrastructure", "third_party", "unknown"] as const;
export type Owner = (typeof OWNERS)[number];

export const OWNER_INFO: Record<Owner, LabelInfo> = {
  app: { label: "App team", description: "The fix is in the app's code." },
  backend: { label: "Backend team", description: "The fix is in a server or API the team runs." },
  infrastructure: { label: "Infrastructure", description: "Hosting, gateways or the network between the app and the servers." },
  third_party: { label: "Third party", description: "A service or library the team doesn't own." },
  unknown: { label: "Unknown", description: "Not enough information to say yet." },
};

/* ---------- Impact: how badly it hurts users ---------- */

/** Worst first. */
export const IMPACTS = ["blocked", "degraded", "silent"] as const;
export type Impact = (typeof IMPACTS)[number];

export const IMPACT_INFO: Record<Impact, LabelInfo> = {
  blocked: { label: "Blocked", description: "The user couldn't carry on: the app closed, or a key journey failed." },
  degraded: { label: "Degraded", description: "The user saw an error or missing information, but could carry on." },
  silent: { label: "Silent", description: "The user probably didn't notice: background work failed or recovered." },
};

/** Higher is worse, for sorting. */
export const IMPACT_ORDER: Record<Impact, number> = { blocked: 2, degraded: 1, silent: 0 };

/* ---------- Cause patterns: why it happened (zero or more) ---------- */

export const CAUSES = [
  "resumed_from_background",
  "burst",
  "slow_network",
  "auth_expired",
  "new_in_release",
  "regressed",
  "single_device",
] as const;
export type Cause = (typeof CAUSES)[number];

export const CAUSE_INFO: Record<Cause, LabelInfo> = {
  resumed_from_background: {
    label: "Right after reopening the app",
    description: "It happened within seconds of the app coming back to the foreground, before the phone had reconnected.",
  },
  burst: {
    label: "Several failures at once",
    description: "Other requests failed at the same moment, which points at the connection or a shared service, not one screen.",
  },
  slow_network: {
    label: "Slow network",
    description: "Requests just before it were slow, so the connection was poor.",
  },
  auth_expired: {
    label: "Sign-in expired",
    description: "The user's sign-in had run out, so the server stopped accepting requests.",
  },
  new_in_release: {
    label: "New in this version",
    description: "It first appeared in the app's latest version, so a recent change probably caused it.",
  },
  regressed: {
    label: "Came back",
    description: "It was marked fixed, then happened again in a version that should have the fix.",
  },
  single_device: {
    label: "One device model",
    description: "Every occurrence is on the same device model, so it's probably specific to that phone.",
  },
};

/** The labels the classifier gives one error or issue. */
export interface Classification {
  category: Category;
  owner: Owner;
  impact: Impact;
  causes: Cause[];
}
