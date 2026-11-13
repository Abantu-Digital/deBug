import type { Issue, IssueStatus, RollupDimension, RollupIncrement, RollupRow, StoredEvent } from "@debugkit/schema";

export interface IssueUpsert {
  app: string;
  fingerprint: string;
  title: string;
  culprit?: string;
  flow?: string;
  ts: string; // event time of the newest occurrence in this batch
  firstTs: string; // event time of the oldest occurrence in this batch
  by: number;
  lastEvent: StoredEvent;
  /** App version of the newest occurrence in this batch: drives firstVersion/lastVersion and regressions. */
  version?: string;
}

/**
 * "This member was active in this scope on this day". Members are hashes of user or install ids,
 * never the ids themselves. Scopes: "app" (everyone), "crash" (users who crashed), "issue:<fp>".
 */
export interface UserMark {
  scope: string;
  member: string;
  day: string;
}

export interface IssueStatusChange {
  status: Exclude<IssueStatus, "regressed">;
  /** For "resolved": the release with the fix. */
  resolvedIn?: string;
}

/** Per-app settings, stored in the customer's own database and changed from the dashboard. */
export interface AppSettings {
  /** How long raw events (stack traces, breadcrumbs) are kept. Counts and issues are kept forever. */
  retentionDays?: number;
  /** Flows that matter most (e.g. checkout.payment): their issues rank one severity level higher. */
  criticalFlows?: string[];
  alerts?: AlertSettings;
  updatedAt?: string;
}

export interface AlertSettings {
  /** A Slack incoming-webhook URL (https://hooks.slack.com/services/…). */
  slackWebhookUrl?: string;
  /** Alert when an issue is seen for the first time. Default true. */
  newIssues?: boolean;
  /** Alert when a resolved issue comes back. Default true. */
  regressions?: boolean;
  /** Only alert for issues in critical flows. Default false. */
  onlyCriticalFlows?: boolean;
  /** The dashboard's URL, to link alerts to the issue. */
  dashboardUrl?: string;
}

/** Which issues an upsert created or turned to regressed: what alerts are about. */
export interface UpsertOutcome {
  created: string[];
  regressed: string[];
}

export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 3650;
/** Hourly counters only feed the 24h/48h views, so they expire on their own. */
export const HOURLY_ROLLUP_DAYS = 7;

/** One page of re-stamping existing events with a new expiry. Pass `cursor` back until it's undefined. */
export interface RestampResult {
  updated: number;
  cursor?: string;
}

/** Write side, used by the ingest function. */
export interface WriteStore {
  registerApp(app: string): Promise<void>;
  /** `retentionDays` sets each event's expiry; the adapter's own default applies when it's missing. */
  writeEvents(events: StoredEvent[], opts?: { retentionDays?: number }): Promise<void>;
  upsertIssues(updates: IssueUpsert[]): Promise<UpsertOutcome | void>;
  incrementRollups(incs: RollupIncrement[]): Promise<void>;
  getSettings(app: string): Promise<AppSettings | null>;
  putSettings(app: string, settings: AppSettings): Promise<AppSettings>;
  /** Record active users per scope (one row per scope and member, holding the last day seen). */
  markUsers(app: string, marks: UserMark[]): Promise<void>;
  setIssueStatus(app: string, fingerprint: string, change: IssueStatusChange): Promise<Issue | null>;
  /** Give already-stored events an expiry based on `retentionDays`, one page at a time. */
  restampExpiry(app: string, retentionDays: number, opts?: { cursor?: string; limit?: number }): Promise<RestampResult>;
}

/** Read side, used by the dashboard. */
export interface ReadStore {
  getSettings(app: string): Promise<AppSettings | null>;
  /** Distinct members of a scope seen on or after `sinceDay` (YYYY-MM-DD). */
  countUsers(app: string, scope: string, sinceDay: string): Promise<number>;
  listApps(): Promise<string[]>;
  listIssues(app: string, opts?: { limit?: number }): Promise<Issue[]>;
  getIssue(app: string, fingerprint: string): Promise<Issue | null>;
  getRollups(app: string, dimension: RollupDimension, fromDay: string, toDay: string): Promise<RollupRow[]>;
  listIssueEvents(app: string, fingerprint: string, opts?: { limit?: number }): Promise<StoredEvent[]>;
}

export type Store = WriteStore & ReadStore;

export { coalesceRollups, rollupId } from "./rollups";
export { MemoryStore } from "./memory";
