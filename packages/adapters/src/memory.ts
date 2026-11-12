import type { Issue, RollupDimension, RollupIncrement, RollupRow, StoredEvent } from "@debugkit/schema";
import { coalesceRollups, rollupId } from "./rollups";
import type { IssueUpsert, Store } from "./index";

/** In-process store for tests and the dashboard's demo mode. */
export class MemoryStore implements Store {
  apps = new Set<string>();
  events: StoredEvent[] = [];
  issues = new Map<string, Issue>();
  rollups = new Map<string, RollupRow>();

  async registerApp(app: string) {
    this.apps.add(app);
  }
  async writeEvents(events: StoredEvent[]) {
    this.events.push(...events);
  }
  async upsertIssues(updates: IssueUpsert[]) {
    for (const u of updates) {
      const k = `${u.app}/${u.fingerprint}`;
      const cur = this.issues.get(k);
      this.issues.set(k, {
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
