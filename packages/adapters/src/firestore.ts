import type { Firestore } from "firebase-admin/firestore";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import type { Issue, RollupDimension, RollupIncrement, RollupRow, StoredEvent } from "@debug/schema";
import { coalesceRollups, rollupId } from "./rollups";
import type { IssueUpsert, Store } from "./index";

/**
 * Firestore layout (all under one root collection so it's easy to find / secure / delete):
 *
 *   {root}/{app}                      app marker
 *   {root}/{app}/issues/{fingerprint} Issue
 *   {root}/{app}/rollups/{day__dim__key}  RollupRow (counters via FieldValue.increment)
 *   {root}/{app}/events/{eventId}     StoredEvent + expireAt (enable a TTL policy on `expireAt`)
 *
 * Composite index needed: rollups (dimension ASC, day ASC). See firestore.indexes.json.
 */
export class FirestoreStore implements Store {
  constructor(
    private db: Firestore,
    private opts: { root?: string; retentionDays?: number } = {},
  ) {}

  private get root() {
    return this.db.collection(this.opts.root ?? "debug_apps");
  }
  private app(app: string) {
    return this.root.doc(app);
  }

  async registerApp(app: string) {
    await this.app(app).set({ id: app, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  }

  async writeEvents(events: StoredEvent[]) {
    const days = this.opts.retentionDays ?? 30;
    for (const chunk of chunks(events, 400)) {
      const batch = this.db.batch();
      for (const e of chunk) {
        const expireAt = Timestamp.fromMillis(Date.parse(e.receivedAt) + days * 86_400_000);
        batch.set(this.app(e.app).collection("events").doc(e.event.id), { ...strip(e), ts: e.event.ts, expireAt });
      }
      await batch.commit();
    }
  }

  async upsertIssues(updates: IssueUpsert[]) {
    // A transaction per issue keeps firstSeen/lastSeen correct under concurrent ingest.
    await Promise.all(
      updates.map((u) =>
        this.db.runTransaction(async (tx) => {
          const ref = this.app(u.app).collection("issues").doc(u.fingerprint);
          const snap = await tx.get(ref);
          const cur = snap.data() as Issue | undefined;
          const newer = !cur || u.ts >= cur.lastSeen;
          tx.set(
            ref,
            strip({
              app: u.app,
              fingerprint: u.fingerprint,
              title: u.title,
              culprit: u.culprit,
              flow: u.flow,
              firstSeen: cur && cur.firstSeen < u.firstTs ? cur.firstSeen : u.firstTs,
              lastSeen: newer ? u.ts : cur!.lastSeen,
              count: FieldValue.increment(u.by),
              ...(newer ? { lastEvent: strip(u.lastEvent) } : {}),
            }),
            { merge: true },
          );
        }),
      ),
    );
  }

  async incrementRollups(incs: RollupIncrement[]) {
    const rows = coalesceRollups(incs);
    for (const chunk of chunks(rows, 400)) {
      const batch = this.db.batch();
      for (const r of chunk) {
        batch.set(
          this.app(r.app).collection("rollups").doc(rollupId(r)),
          {
            app: r.app,
            day: r.day,
            dimension: r.dimension,
            key: r.key,
            errors: FieldValue.increment(r.errors),
            events: FieldValue.increment(r.events),
          },
          { merge: true },
        );
      }
      await batch.commit();
    }
  }

  async listApps() {
    const snap = await this.root.select().get();
    return snap.docs.map((d) => d.id).sort();
  }
  async listIssues(app: string, { limit = 200 } = {}) {
    const snap = await this.app(app).collection("issues").orderBy("lastSeen", "desc").limit(limit).get();
    return snap.docs.map((d) => d.data() as Issue);
  }
  async getIssue(app: string, fp: string) {
    const snap = await this.app(app).collection("issues").doc(fp).get();
    return snap.exists ? (snap.data() as Issue) : null;
  }
  async getRollups(app: string, dimension: RollupDimension, fromDay: string, toDay: string) {
    const snap = await this.app(app)
      .collection("rollups")
      .where("dimension", "==", dimension)
      .where("day", ">=", fromDay)
      .where("day", "<=", toDay)
      .get();
    return snap.docs.map((d) => d.data() as RollupRow);
  }
  async listIssueEvents(app: string, fp: string, { limit = 50 } = {}) {
    const snap = await this.app(app)
      .collection("events")
      .where("fingerprint", "==", fp)
      .orderBy("ts", "desc")
      .limit(limit)
      .get();
    return snap.docs.map((d) => {
      const { expireAt: _e, ts: _t, ...rest } = d.data();
      return rest as StoredEvent;
    });
  }
}

/** Firestore rejects `undefined` values; drop them recursively. */
function strip<T>(v: T): T {
  if (Array.isArray(v)) return v.map(strip) as T;
  if (v && typeof v === "object" && v.constructor === Object) {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).map(([k, x]) => [k, strip(x)]),
    ) as T;
  }
  return v;
}

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}
