import { isRegression, type Issue, type RollupDimension, type RollupIncrement, type RollupRow, type StoredEvent } from "@debugkit/schema";
import { coalesceRollups, rollupId } from "./rollups";
import type { TeamInvite, TeamMember, AppSettings, IssueStatusChange, IssueUpsert, RestampResult, Store, UpsertOutcome, UserMark } from "./index";

/** In-process store for tests and the dashboard's demo mode. */
export class MemoryStore implements Store {
  apps = new Set<string>();
  events: StoredEvent[] = [];
  issues = new Map<string, Issue>();
  rollups = new Map<string, RollupRow>();
  settings = new Map<string, AppSettings>();
  /** `${app}/${scope}/${member}` → last day seen */
  users = new Map<string, string>();
  /** Expiry per event id (ms), mirroring what a real store would stamp. */
  expiry = new Map<string, number>();
  retentionDays = 30;
  members = new Map<string, TeamMember>();
  invites = new Map<string, TeamInvite>();

  async getMember(email: string) {
    return this.members.get(email) ?? null;
  }
  async putMember(m: TeamMember) {
    this.members.set(m.email, { ...m });
  }
  async listMembers() {
    return [...this.members.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async getInvite(id: string) {
    return this.invites.get(id) ?? null;
  }
  async putInvite(i: TeamInvite) {
    this.invites.set(i.id, { ...i });
  }
  async claimInvite(id: string, by: string, at: string) {
    const cur = this.invites.get(id);
    if (!cur || cur.usedAt || cur.revokedAt) return false;
    this.invites.set(id, { ...cur, usedAt: at, usedBy: by });
    return true;
  }
  async listInvites() {
    return [...this.invites.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async registerApp(app: string) {
    this.apps.add(app);
  }
  async writeEvents(events: StoredEvent[], opts: { retentionDays?: number } = {}) {
    const days = opts.retentionDays ?? this.retentionDays;
    for (const e of events) this.expiry.set(e.event.id, Date.parse(e.receivedAt) + days * 86_400_000);
    this.events.push(...events);
  }
  async markUsers(app: string, marks: UserMark[]) {
    for (const m of marks) {
      const k = `${app}/${m.scope}/${m.member}`;
      const cur = this.users.get(k);
      if (!cur || m.day > cur) this.users.set(k, m.day);
    }
  }
  async countUsers(app: string, scope: string, sinceDay: string) {
    const prefix = `${app}/${scope}/`;
    let n = 0;
    for (const [k, day] of this.users) if (k.startsWith(prefix) && day >= sinceDay) n++;
    return n;
  }
  async setIssueStatus(app: string, fp: string, change: IssueStatusChange) {
    const cur = this.issues.get(`${app}/${fp}`);
    if (!cur) return null;
    const next = { ...cur, status: change.status, resolvedIn: change.status === "resolved" ? change.resolvedIn : undefined, resolvedAt: change.status === "resolved" ? new Date().toISOString() : undefined, regressedAt: undefined };
    this.issues.set(`${app}/${fp}`, next);
    return next;
  }
  async getSettings(app: string) {
    return this.settings.get(app) ?? null;
  }
  async putSettings(app: string, s: AppSettings) {
    const next = { ...this.settings.get(app), ...s, updatedAt: new Date().toISOString() };
    this.settings.set(app, next);
    return next;
  }
  async restampExpiry(app: string, retentionDays: number, { cursor, limit = 500 }: { cursor?: string; limit?: number } = {}): Promise<RestampResult> {
    const mine = this.events.filter((e) => e.app === app);
    const start = cursor ? Number(cursor) : 0;
    const page = mine.slice(start, start + limit);
    for (const e of page) this.expiry.set(e.event.id, Date.parse(e.receivedAt) + retentionDays * 86_400_000);
    const next = start + page.length;
    return { updated: page.length, cursor: next < mine.length ? String(next) : undefined };
  }
  async upsertIssues(updates: IssueUpsert[]): Promise<UpsertOutcome> {
    const outcome: UpsertOutcome = { created: [], regressed: [] };
    for (const u of updates) {
      const k = `${u.app}/${u.fingerprint}`;
      const cur = this.issues.get(k);
      const regressed = cur?.status === "resolved" && isRegression(cur.resolvedIn, u.version, cur.resolvedAt, u.ts);
      const newer = !cur || u.ts >= cur.lastSeen;
      if (!cur) outcome.created.push(u.fingerprint);
      if (regressed) outcome.regressed.push(u.fingerprint);
      this.issues.set(k, {
        ...cur,
        ...(regressed ? { status: "regressed" as const, regressedAt: u.ts } : {}),
        firstVersion: cur?.firstVersion ?? u.version,
        lastVersion: newer ? (u.version ?? cur?.lastVersion) : cur?.lastVersion,
        app: u.app,
        fingerprint: u.fingerprint,
        title: u.title,
        culprit: u.culprit,
        flow: u.flow,
        firstSeen: cur && cur.firstSeen < u.firstTs ? cur.firstSeen : u.firstTs,
        lastSeen: cur && cur.lastSeen > u.ts ? cur.lastSeen : u.ts,
        count: (cur?.count ?? 0) + u.by,
        lastEvent: cur && cur.lastSeen > u.ts ? cur.lastEvent : u.lastEvent,
      });
    }
    return outcome;
  }
  async incrementRollups(incs: RollupIncrement[]) {
    for (const r of coalesceRollups(incs)) {
      const k = `${r.app}/${rollupId(r)}`;
      const cur = this.rollups.get(k);
      this.rollups.set(k, cur ? { ...cur, errors: cur.errors + r.errors, events: cur.events + r.events } : r);
    }
  }

  async listApps() {
    return [...this.apps].sort();
  }
  async listIssues(app: string, { limit = 200 } = {}) {
    return [...this.issues.values()]
      .filter((i) => i.app === app)
      .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
      .slice(0, limit);
  }
  async getIssue(app: string, fp: string) {
    return this.issues.get(`${app}/${fp}`) ?? null;
  }
  async getRollups(app: string, dimension: RollupDimension, fromDay: string, toDay: string) {
    return [...this.rollups.values()].filter(
      (r) => r.app === app && r.dimension === dimension && r.day >= fromDay && r.day <= toDay,
    );
  }
  async listIssueEvents(app: string, fp: string, { limit = 50 } = {}) {
    return this.events
      .filter((e) => e.app === app && e.fingerprint === fp)
      .sort((a, b) => b.event.ts.localeCompare(a.event.ts))
      .slice(0, limit);
  }
}
