import type { Issue, RollupDimension, RollupIncrement, RollupRow, StoredEvent } from "@debug/schema";

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

/** Write side, used by the ingest function. */
export interface WriteStore {
  registerApp(app: string): Promise<void>;
  writeEvents(events: StoredEvent[]): Promise<void>;
  upsertIssues(updates: IssueUpsert[]): Promise<void>;
  incrementRollups(incs: RollupIncrement[]): Promise<void>;
}

/** Read side, used by the dashboard. */
export interface ReadStore {
  listApps(): Promise<string[]>;
  listIssues(app: string, opts?: { limit?: number }): Promise<Issue[]>;
  getIssue(app: string, fingerprint: string): Promise<Issue | null>;
  getRollups(app: string, dimension: RollupDimension, fromDay: string, toDay: string): Promise<RollupRow[]>;
  listIssueEvents(app: string, fingerprint: string, opts?: { limit?: number }): Promise<StoredEvent[]>;
}

export type Store = WriteStore & ReadStore;

export { coalesceRollups, rollupId } from "./rollups";
export { MemoryStore } from "./memory";
