import type { Firestore } from "firebase-admin/firestore";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import type { Issue, RollupDimension, RollupIncrement, RollupRow, StoredEvent } from "@debugkit/schema";
import { coalesceRollups, rollupId } from "./rollups";
import { HOURLY_ROLLUP_DAYS, type AppSettings, type IssueUpsert, type RestampResult, type Store } from "./index";

/**
 * Firestore layout (all under one root collection so it's easy to find / secure / delete):
 *
 *   {root}/{app}                      app marker
 *   {root}/{app}/issues/{fingerprint} Issue
 *   {root}/{app}/rollups/{day__dim__key}  RollupRow (counters via FieldValue.increment)
 *   {root}/{app}/events/{eventId}     StoredEvent + expireAt (enable a TTL policy on `expireAt`)
 *   {root}/{app}/settings/app         AppSettings (retention, set from the dashboard)
 *
 * Hourly rollups (dimension issueHour) also carry expireAt, so they expire after 7 days.
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

  async writeEvents(events: StoredEvent[], opts: { retentionDays?: number } = {}) {
    const days = opts.retentionDays ?? this.opts.retentionDays ?? 30;
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
            // Hourly buckets look like "YYYY-MM-DDTHH"; expire them a week after the hour.
            ...(r.dimension === "issueHour" ? { expireAt: Timestamp.fromMillis(Date.parse(`${r.day}:00:00Z`) + HOURLY_ROLLUP_DAYS * 86_400_000) } : {}),
          },
          { merge: true },
        );
      }
      await batch.commit();
    }
  }

  private settingsRef(app: string) {
    return this.app(app).collection("settings").doc("app");
  }
  async getSettings(app: string) {
    const snap = await this.settingsRef(app).get();
    return snap.exists ? (snap.data() as AppSettings) : null;
  }
  async putSettings(app: string, s: AppSettings) {
    const next = strip({ ...s, updatedAt: new Date().toISOString() });
    await this.settingsRef(app).set(next, { merge: true });
    return { ...(await this.getSettings(app)), ...next };
  }
  async restampExpiry(app: string, retentionDays: number, { cursor, limit = 400 }: { cursor?: string; limit?: number } = {}): Promise<RestampResult> {
    let q = this.app(app).collection("events").orderBy("__name__").limit(Math.min(limit, 400));
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) return { updated: 0 };
    const batch = this.db.batch();
    for (const d of snap.docs) {
      const receivedAt = Date.parse((d.get("receivedAt") as string | undefined) ?? (d.get("ts") as string));
      batch.update(d.ref, { expireAt: Timestamp.fromMillis(receivedAt + retentionDays * 86_400_000) });
    }
    await batch.commit();
    const last = snap.docs[snap.docs.length - 1]!.id;
    return { updated: snap.size, cursor: snap.size === Math.min(limit, 400) ? last : undefined };
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
