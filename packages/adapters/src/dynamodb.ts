import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { BatchWriteCommand, type BatchWriteCommandOutput, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { isRegression, type Issue, type RollupDimension, type RollupIncrement, type RollupRow, type StoredEvent } from "@debugkit/schema";
import { coalesceRollups } from "./rollups";
import { HOURLY_ROLLUP_DAYS, type TeamInvite, type TeamMember, type AppSettings, type IssueStatusChange, type IssueUpsert, type RestampResult, type Store, type UpsertOutcome, type UserField, type UserMark } from "./index";

/**
 * Single-table layout. Table needs: partition key `pk` (S), sort key `sk` (S),
 * and TTL enabled on attribute `ttl`.
 *
 *   APPS                         | {app}            app marker
 *   APP#{app}#ISSUE              | {fingerprint}    Issue
 *   APP#{app}#ROLLUP#{dimension} | {day}#{key}      RollupRow (ADD counters)
 *   APP#{app}#ISSUEEV#{fp}       | {ts}#{id}        StoredEvent (error events by issue)
 *   APP#{app}#EV#{day}           | {ts}#{id}        StoredEvent (all events by day)
 *   APP#{app}#SESSEV#{sessionId} | {ts}#{id}        StoredEvent (all events by session)
 *   APP#{app}#USEREV#id#{userId} | {ts}#{id}        StoredEvent (by customer number, user.id)
 *   APP#{app}#USEREV#anonymousId#{anonymousId} | {ts}#{id}   StoredEvent (by install id)
 *   APP#{app}#SETTINGS           | app              AppSettings
 *   APP#{app}#USERS#{scope}      | {member}         { lastDay } (hashed ids; for "users affected")
 *
 *   TEAM                         | M#{email}        TeamMember (dashboard logins)
 *   TEAM                         | I#{sha256}       TeamInvite
 *
 * Hourly rollups (dimension issueHour) also carry `ttl`, so they expire after 7 days.
 */
export class DynamoStore implements Store {
  constructor(
    private doc: DynamoDBDocumentClient,
    private opts: { table: string; retentionDays?: number },
  ) {}

  private get table() {
    return this.opts.table;
  }

  async getMember(email: string) {
    const out = await this.doc.send(new GetCommand({ TableName: this.table, Key: { pk: "TEAM", sk: `M#${email}` } }));
    return out.Item ? (clean(out.Item) as TeamMember) : null;
  }
  async putMember(m: TeamMember) {
    await this.doc.send(new PutCommand({ TableName: this.table, Item: { ...dropUndefined(m), pk: "TEAM", sk: `M#${m.email}` } }));
  }
  async listMembers() {
    return (await this.teamItems("M#")) as TeamMember[];
  }
  async getInvite(id: string) {
    const out = await this.doc.send(new GetCommand({ TableName: this.table, Key: { pk: "TEAM", sk: `I#${id}` } }));
    return out.Item ? (clean(out.Item) as TeamInvite) : null;
  }
  async putInvite(i: TeamInvite) {
    await this.doc.send(new PutCommand({ TableName: this.table, Item: { ...dropUndefined(i), pk: "TEAM", sk: `I#${i.id}` } }));
  }
  async claimInvite(id: string, by: string, at: string) {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk: "TEAM", sk: `I#${id}` },
          UpdateExpression: "SET usedAt = :at, usedBy = :by",
          ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(usedAt) AND attribute_not_exists(revokedAt)",
          ExpressionAttributeValues: { ":at": at, ":by": by },
        }),
      );
      return true;
    } catch (e) {
      if ((e as { name?: string }).name === "ConditionalCheckFailedException") return false;
      throw e;
    }
  }
  async listInvites() {
    return ((await this.teamItems("I#")) as TeamInvite[]).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  private async teamItems(prefix: string) {
    const items: unknown[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const out = await this.doc.send(
        new QueryCommand({ TableName: this.table, KeyConditionExpression: "pk = :pk AND begins_with(sk, :p)", ExpressionAttributeValues: { ":pk": "TEAM", ":p": prefix }, ExclusiveStartKey }),
      );
      items.push(...(out.Items ?? []).map(clean));
      ExclusiveStartKey = out.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  }

  async registerApp(app: string) {
    await this.doc.send(new PutCommand({ TableName: this.table, Item: { pk: "APPS", sk: app } }));
  }

  async writeEvents(events: StoredEvent[], opts: { retentionDays?: number } = {}) {
    const days = opts.retentionDays ?? this.opts.retentionDays ?? 30;
    const ttl = (e: StoredEvent) => Math.floor(Date.parse(e.receivedAt) / 1000) + days * 86_400;
    const items = events.flatMap((e) => {
      const sk = `${e.event.ts}#${e.event.id}`;
      const base = { ...e, ttl: ttl(e) };
      return [`APP#${e.app}#EV#${e.day}`, ...copyKeys(e)].map((pk) => ({ pk, sk, ...base }));
    });
    for (let i = 0; i < items.length; i += 25) {
      let req: Record<string, any> | undefined = {
        [this.table]: items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } })),
      };
      for (let attempt = 0; req && Object.keys(req).length && attempt < 5; attempt++) {
        const out: BatchWriteCommandOutput = await this.doc.send(new BatchWriteCommand({ RequestItems: req }));
        req = out.UnprocessedItems;
        if (req && Object.keys(req).length) await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
      }
    }
  }

  async upsertIssues(updates: IssueUpsert[]): Promise<UpsertOutcome> {
    const outcome: UpsertOutcome = { created: [], regressed: [] };
    await Promise.all(
      updates.map(async (u) => {
        // Counters + firstSeen in one atomic update. The old count tells us whether it's new.
        const first = await this.doc.send(
          new UpdateCommand({
            TableName: this.table,
            Key: { pk: `APP#${u.app}#ISSUE`, sk: u.fingerprint },
            UpdateExpression:
              "ADD #count :by SET app = :app, fingerprint = :fp, title = :title, flow = :flow, culprit = :culprit, firstSeen = if_not_exists(firstSeen, :first)",
            ExpressionAttributeNames: { "#count": "count" },
            ExpressionAttributeValues: {
              ":by": u.by,
              ":app": u.app,
              ":fp": u.fingerprint,
              ":title": u.title,
              ":flow": u.flow ?? null,
              ":culprit": u.culprit ?? null,
              ":first": u.firstTs,
            },
            ReturnValues: "UPDATED_OLD",
          }),
        );
        if (first.Attributes?.count === undefined) outcome.created.push(u.fingerprint);
        // lastSeen / lastEvent / lastVersion only move forward.
        await this.doc
          .send(
            new UpdateCommand({
              TableName: this.table,
              Key: { pk: `APP#${u.app}#ISSUE`, sk: u.fingerprint },
              UpdateExpression: "SET lastSeen = :ts, lastEvent = :ev, lastVersion = :v, firstVersion = if_not_exists(firstVersion, :v)",
              ConditionExpression: "attribute_not_exists(lastSeen) OR lastSeen < :ts",
              ExpressionAttributeValues: { ":ts": u.ts, ":ev": u.lastEvent, ":v": u.version ?? null },
            }),
          )
          .catch((e: { name?: string }) => {
            if (e.name !== "ConditionalCheckFailedException") throw e;
          });
        // A resolved issue seen again in the fixed release (or later) has regressed.
        const cur = (await this.doc.send(new GetCommand({ TableName: this.table, Key: { pk: `APP#${u.app}#ISSUE`, sk: u.fingerprint }, ProjectionExpression: "#s, resolvedIn, resolvedAt", ExpressionAttributeNames: { "#s": "status" } }))).Item as Partial<Issue> | undefined;
        if (cur?.status === "resolved" && isRegression(cur.resolvedIn, u.version, cur.resolvedAt, u.ts)) {
          await this.doc.send(
            new UpdateCommand({
              TableName: this.table,
              Key: { pk: `APP#${u.app}#ISSUE`, sk: u.fingerprint },
              UpdateExpression: "SET #s = :r, regressedAt = :ts",
              ConditionExpression: "#s = :resolved",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: { ":r": "regressed", ":ts": u.ts, ":resolved": "resolved" },
            }),
          )
            .then(() => outcome.regressed.push(u.fingerprint))
            .catch((e: { name?: string }) => {
              if (e.name !== "ConditionalCheckFailedException") throw e;
            });
        }
        // firstSeen can also move backwards if an older event arrives late.
        await this.doc
          .send(
            new UpdateCommand({
              TableName: this.table,
              Key: { pk: `APP#${u.app}#ISSUE`, sk: u.fingerprint },
              UpdateExpression: "SET firstSeen = :first",
              ConditionExpression: "firstSeen > :first",
              ExpressionAttributeValues: { ":first": u.firstTs },
            }),
          )
          .catch((e: { name?: string }) => {
            if (e.name !== "ConditionalCheckFailedException") throw e;
          });
      }),
    );
    return outcome;
  }

  async incrementRollups(incs: RollupIncrement[]) {
    await Promise.all(
      coalesceRollups(incs).map((r) =>
        this.doc.send(
          new UpdateCommand({
            TableName: this.table,
            Key: { pk: `APP#${r.app}#ROLLUP#${r.dimension}`, sk: `${r.day}#${r.key}` },
            UpdateExpression: `ADD errors :e, events :v SET app = :app, #day = :day, dimension = :dim, #key = :key${r.dimension === "issueHour" ? ", #ttl = :ttl" : ""}`,
            ExpressionAttributeNames: { "#day": "day", "#key": "key", ...(r.dimension === "issueHour" ? { "#ttl": "ttl" } : {}) },
            ExpressionAttributeValues: {
              ":e": r.errors,
              ":v": r.events,
              ":app": r.app,
              ":day": r.day,
              ":dim": r.dimension,
              ":key": r.key,
              // Hourly buckets look like "YYYY-MM-DDTHH"; expire them a week after the hour.
              ...(r.dimension === "issueHour" ? { ":ttl": Math.floor(Date.parse(`${r.day}:00:00Z`) / 1000) + HOURLY_ROLLUP_DAYS * 86_400 } : {}),
            },
          }),
        ),
      ),
    );
  }

  async markUsers(app: string, marks: UserMark[]) {
    await Promise.all(
      marks.map((m) =>
        this.doc
          .send(
            new UpdateCommand({
              TableName: this.table,
              Key: { pk: `APP#${app}#USERS#${m.scope}`, sk: m.member },
              UpdateExpression: "SET lastDay = :d",
              ConditionExpression: "attribute_not_exists(lastDay) OR lastDay < :d",
              ExpressionAttributeValues: { ":d": m.day },
            }),
          )
          .catch((e: { name?: string }) => {
            if (e.name !== "ConditionalCheckFailedException") throw e;
          }),
      ),
    );
  }
  async countUsers(app: string, scope: string, sinceDay: string) {
    let n = 0;
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const out = await this.doc.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: "pk = :pk",
          FilterExpression: "lastDay >= :d",
          ExpressionAttributeValues: { ":pk": `APP#${app}#USERS#${scope}`, ":d": sinceDay },
          Select: "COUNT",
          ExclusiveStartKey,
        }),
      );
      n += out.Count ?? 0;
      ExclusiveStartKey = out.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return n;
  }
  async setIssueStatus(app: string, fp: string, change: IssueStatusChange) {
    const resolved = change.status === "resolved";
    const out = await this.doc
      .send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk: `APP#${app}#ISSUE`, sk: fp },
          UpdateExpression: resolved ? "SET #s = :s, resolvedAt = :at, resolvedIn = :in REMOVE regressedAt" : "SET #s = :s REMOVE resolvedIn, resolvedAt, regressedAt",
          ConditionExpression: "attribute_exists(pk)",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: resolved ? { ":s": change.status, ":at": new Date().toISOString(), ":in": change.resolvedIn ?? null } : { ":s": change.status },
          ReturnValues: "ALL_NEW",
        }),
      )
      .catch((e: { name?: string }) => {
        if (e.name === "ConditionalCheckFailedException") return null;
        throw e;
      });
    return out?.Attributes ? clean(out.Attributes as Issue) : null;
  }
  async getSettings(app: string) {
    const out = await this.doc.send(new GetCommand({ TableName: this.table, Key: { pk: `APP#${app}#SETTINGS`, sk: "app" } }));
    return out.Item ? (clean(out.Item) as AppSettings) : null;
  }
  async putSettings(app: string, s: AppSettings) {
    const next = Object.fromEntries(Object.entries({ ...s, updatedAt: new Date().toISOString() }).filter(([, v]) => v !== undefined));
    const names = Object.keys(next);
    const out = await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk: `APP#${app}#SETTINGS`, sk: "app" },
        UpdateExpression: `SET ${names.map((n, i) => `#n${i} = :v${i}`).join(", ")}`,
        ExpressionAttributeNames: Object.fromEntries(names.map((n, i) => [`#n${i}`, n])),
        ExpressionAttributeValues: Object.fromEntries(names.map((n, i) => [`:v${i}`, (next as Record<string, unknown>)[n]])),
        ReturnValues: "ALL_NEW",
      }),
    );
    return clean(out.Attributes ?? next) as AppSettings;
  }
  /**
   * Events live in one partition per day (and a copy per issue). Walk the day partitions newest
   * first, one per call; the cursor is how many days back we've got. Stops after 10 years.
   */
  async restampExpiry(app: string, retentionDays: number, { cursor }: { cursor?: string; limit?: number } = {}): Promise<RestampResult> {
    let back = cursor ? Number(cursor) : 0;
    let updated = 0;
    // Skip empty days quickly, but do at most 30 partitions per call.
    for (let n = 0; n < 30 && back <= 3650; n++, back++) {
      const day = new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);
      const items = await this.queryAll({ pk: `APP#${app}#EV#${day}` });
      for (const item of items) {
        const ttl = Math.floor(Date.parse(item.receivedAt as string) / 1000) + retentionDays * 86_400;
        const keys = [item.pk, ...copyKeys(item as unknown as StoredEvent)].map((pk) => ({ pk, sk: item.sk }));
        await Promise.all(
          keys.map((Key) =>
            this.doc
              .send(new UpdateCommand({ TableName: this.table, Key, UpdateExpression: "SET #t = :t", ConditionExpression: "attribute_exists(pk)", ExpressionAttributeNames: { "#t": "ttl" }, ExpressionAttributeValues: { ":t": ttl } }))
              .catch((e: { name?: string }) => {
                if (e.name !== "ConditionalCheckFailedException") throw e;
              }),
          ),
        );
        updated++;
      }
      if (items.length) {
        back++;
        break;
      }
    }
    return { updated, cursor: back <= 3650 ? String(back) : undefined };
  }

  async listApps() {
    return (await this.queryAll({ pk: "APPS" })).map((i) => i.sk as string).sort();
  }
  async listIssues(app: string, { limit = 200 } = {}) {
    const items = (await this.queryAll({ pk: `APP#${app}#ISSUE` })) as unknown as Issue[];
    return items.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)).slice(0, limit).map(clean);
  }
  async getIssue(app: string, fp: string) {
    const out = await this.doc.send(new GetCommand({ TableName: this.table, Key: { pk: `APP#${app}#ISSUE`, sk: fp } }));
    return out.Item ? clean(out.Item as Issue) : null;
  }
  async getRollups(app: string, dimension: RollupDimension, fromDay: string, toDay: string) {
    const items = await this.queryAll({ pk: `APP#${app}#ROLLUP#${dimension}`, between: [`${fromDay}#`, `${toDay}#￿`] });
    return items.map((i) => clean(i as unknown as RollupRow));
  }
  async listSessionEvents(app: string, sessionId: string, { limit = 500 } = {}) {
    const items = await this.newest(`APP#${app}#SESSEV#${sessionId}`, limit);
    return items.map((i) => clean(i as unknown as StoredEvent)).reverse();
  }

  /** A partition's newest `limit` items, a page at a time: a query stops at 1 MB, well short of 500 events with trails. */
  private async newest(pk: string, limit: number) {
    const items: Record<string, unknown>[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const out = await this.doc.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: { ":pk": pk },
          ScanIndexForward: false,
          Limit: limit - items.length,
          ExclusiveStartKey,
        }),
      );
      items.push(...(out.Items ?? []));
      ExclusiveStartKey = out.LastEvaluatedKey;
    } while (ExclusiveStartKey && items.length < limit);
    return items;
  }

  async listUserEvents(app: string, field: UserField, values: readonly string[], { limit = 500 } = {}) {
    const each = await Promise.all(values.map((v) => this.newest(userKey(app, field, v), limit)));
    return each
      .flat()
      .sort((a, b) => String(b.sk).localeCompare(String(a.sk)))
      .slice(0, limit)
      .map((i) => clean(i as unknown as StoredEvent));
  }

  async listIssueEvents(app: string, fp: string, { limit = 50 } = {}) {
    const out = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": `APP#${app}#ISSUEEV#${fp}` },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    return (out.Items ?? []).map((i) => clean(i as StoredEvent));
  }

  private async queryAll({ pk, between }: { pk: string; between?: [string, string] }) {
    const items: Record<string, unknown>[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const out = await this.doc.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: between ? "pk = :pk AND sk BETWEEN :a AND :b" : "pk = :pk",
          ExpressionAttributeValues: between ? { ":pk": pk, ":a": between[0], ":b": between[1] } : { ":pk": pk },
          ExclusiveStartKey,
        }),
      );
      items.push(...(out.Items ?? []));
      ExclusiveStartKey = out.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  }
}

const userKey = (app: string, field: UserField, value: string) => `APP#${app}#USEREV#${field}#${value}`;

/** The partitions an event is copied into besides its day: by issue, session and user. */
function copyKeys(e: StoredEvent): string[] {
  return [
    ...(e.fingerprint ? [`APP#${e.app}#ISSUEEV#${e.fingerprint}`] : []),
    ...(e.sessionId ? [`APP#${e.app}#SESSEV#${e.sessionId}`] : []),
    ...(e.user?.id ? [userKey(e.app, "id", e.user.id)] : []),
    ...(e.user?.anonymousId ? [userKey(e.app, "anonymousId", e.user.anonymousId)] : []),
  ];
}

function clean<T>(item: T): T {
  const { pk: _p, sk: _s, ttl: _t, ...rest } = item as Record<string, unknown>;
  return rest as T;
}

function dropUndefined<T extends object>(v: T): T {
  return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)) as T;
}
