import type { HostName, Issue, IssueStatus, RollupDimension, RollupIncrement, RollupRow, StoredEvent } from "@debugkit/schema";

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
  /** Friendly names and owners for the hosts the app calls. */
  hosts?: HostName[];
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

/** Who can do what on the dashboard. Owners and admins manage the team and settings; members view. */
export type TeamRole = "owner" | "admin" | "member";
export const TEAM_ROLES: readonly TeamRole[] = ["owner", "admin", "member"];

/** A dashboard login stored in your database (the bootstrap login in the dashboard's env isn't). */
export interface TeamMember {
  /** Lowercase; the id. */
  email: string;
  name?: string;
  role: TeamRole;
  /** scrypt.<salt hex>.<hash hex>, made by the dashboard. Never returned by the admin routes. */
  passwordHash: string;
  /** Bumped on removal (and password changes), which signs out every session made before. */
  sessionVersion: number;
  createdAt: string;
  updatedAt?: string;
  invitedBy?: string;
  /** Set when access was removed; the record stays so the removal is visible. */
  removedAt?: string;
}

/** A single-use invite link. Only a SHA-256 of the token is stored. */
export interface TeamInvite {
  /** SHA-256 (hex) of the token in the link. */
  id: string;
  role: TeamRole;
  /** When set, only this email can accept it. */
  email?: string;
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
  usedBy?: string;
  revokedAt?: string;
}

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
  getMember(email: string): Promise<TeamMember | null>;
  putMember(member: TeamMember): Promise<void>;
  getInvite(id: string): Promise<TeamInvite | null>;
  putInvite(invite: TeamInvite): Promise<void>;
  /** Mark an invite used, atomically: false if it was already used or revoked. */
  claimInvite(id: string, by: string, at: string): Promise<boolean>;
}

/** Read side, used by the dashboard. */
export interface ReadStore {
  getSettings(app: string): Promise<AppSettings | null>;
  /** Distinct members of a scope seen on or after `sinceDay` (YYYY-MM-DD). */
  countUsers(app: string, scope: string, sinceDay: string): Promise<number>;
  listApps(): Promise<string[]>;
  getMember(email: string): Promise<TeamMember | null>;
  /** Everyone, removed members included (they carry removedAt). */
  listMembers(): Promise<TeamMember[]>;
  listInvites(): Promise<TeamInvite[]>;
  listIssues(app: string, opts?: { limit?: number }): Promise<Issue[]>;
  getIssue(app: string, fingerprint: string): Promise<Issue | null>;
  getRollups(app: string, dimension: RollupDimension, fromDay: string, toDay: string): Promise<RollupRow[]>;
  listIssueEvents(app: string, fingerprint: string, opts?: { limit?: number }): Promise<StoredEvent[]>;
  /**
   * One session's newest stored events (errors and custom events), up to `limit`, oldest first.
   * Firestore needs the sessionId + ts index; DynamoDB only finds events written since it started
   * keeping them by session.
   */
  listSessionEvents(app: string, sessionId: string, opts?: { limit?: number }): Promise<StoredEvent[]>;
  /**
   * The newest stored events whose `user.id` (customer number) or `user.anonymousId` (install id)
   * is one of `values` (a handful: Firestore takes at most 30), newest first. Firestore needs the user.id + ts and
   * user.anonymousId + ts indexes; DynamoDB only finds events written since it started keeping
   * them by user.
   */
  listUserEvents(app: string, field: UserField, values: readonly string[], opts?: { limit?: number }): Promise<StoredEvent[]>;
}

/** Which of an event's user ids to look up by. */
export type UserField = "id" | "anonymousId";

export type Store = WriteStore & ReadStore;

export { coalesceRollups, rollupId } from "./rollups";
export { MemoryStore } from "./memory";
