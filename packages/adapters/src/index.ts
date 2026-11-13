import type { Issue, RollupDimension, RollupIncrement, RollupRow, StoredEvent } from "@debugkit/schema";

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
}

/** Per-app settings, stored in the customer's own database and changed from the dashboard. */
export interface AppSettings {
  /** How long raw events (stack traces, breadcrumbs) are kept. Counts and issues are kept forever. */
  retentionDays?: number;
  updatedAt?: string;
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
  upsertIssues(updates: IssueUpsert[]): Promise<void>;
  incrementRollups(incs: RollupIncrement[]): Promise<void>;
  getSettings(app: string): Promise<AppSettings | null>;
  putSettings(app: string, settings: AppSettings): Promise<AppSettings>;
  /** Give already-stored events an expiry based on `retentionDays`, one page at a time. */
  restampExpiry(app: string, retentionDays: number, opts?: { cursor?: string; limit?: number }): Promise<RestampResult>;
}

/** Read side, used by the dashboard. */
export interface ReadStore {
  getSettings(app: string): Promise<AppSettings | null>;
  listApps(): Promise<string[]>;
  listIssues(app: string, opts?: { limit?: number }): Promise<Issue[]>;
  getIssue(app: string, fingerprint: string): Promise<Issue | null>;
  getRollups(app: string, dimension: RollupDimension, fromDay: string, toDay: string): Promise<RollupRow[]>;
  listIssueEvents(app: string, fingerprint: string, opts?: { limit?: number }): Promise<StoredEvent[]>;
}

export type Store = WriteStore & ReadStore;

export { coalesceRollups, rollupId } from "./rollups";
export { MemoryStore } from "./memory";
