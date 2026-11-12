import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { BatchWriteCommand, type BatchWriteCommandOutput, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { Issue, RollupDimension, RollupIncrement, RollupRow, StoredEvent } from "@debugkit/schema";
import { coalesceRollups } from "./rollups";
import type { IssueUpsert, Store } from "./index";

/**
 * Single-table layout. Table needs: partition key `pk` (S), sort key `sk` (S),
 * and TTL enabled on attribute `ttl`.
 *
 *   APPS                         | {app}            app marker
 *   APP#{app}#ISSUE              | {fingerprint}    Issue
 *   APP#{app}#ROLLUP#{dimension} | {day}#{key}      RollupRow (ADD counters)
 *   APP#{app}#ISSUEEV#{fp}       | {ts}#{id}        StoredEvent (error events by issue)
 *   APP#{app}#EV#{day}           | {ts}#{id}        StoredEvent (all events by day)
 */
export class DynamoStore implements Store {
  constructor(
    private doc: DynamoDBDocumentClient,
    private opts: { table: string; retentionDays?: number },
  ) {}

  private get table() {
    return this.opts.table;
  }

  async registerApp(app: string) {
    await this.doc.send(new PutCommand({ TableName: this.table, Item: { pk: "APPS", sk: app } }));
  }

  async writeEvents(events: StoredEvent[]) {
    const ttl = (e: StoredEvent) => Math.floor(Date.parse(e.receivedAt) / 1000) + (this.opts.retentionDays ?? 30) * 86_400;
    const items = events.flatMap((e) => {
      const sk = `${e.event.ts}#${e.event.id}`;
      const base = { ...e, ttl: ttl(e) };
      const rows = [{ pk: `APP#${e.app}#EV#${e.day}`, sk, ...base }];
      if (e.fingerprint) rows.push({ pk: `APP#${e.app}#ISSUEEV#${e.fingerprint}`, sk, ...base });
      return rows;
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

  async upsertIssues(updates: IssueUpsert[]) {
    await Promise.all(
      updates.map(async (u) => {
        // Counters + firstSeen in one atomic update.
        await this.doc.send(
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
          }),
        );
        // lastSeen / lastEvent only move forward.
        await this.doc
          .send(
            new UpdateCommand({
              TableName: this.table,
              Key: { pk: `APP#${u.app}#ISSUE`, sk: u.fingerprint },
              UpdateExpression: "SET lastSeen = :ts, lastEvent = :ev",
              ConditionExpression: "attribute_not_exists(lastSeen) OR lastSeen < :ts",
              ExpressionAttributeValues: { ":ts": u.ts, ":ev": u.lastEvent },
            }),
          )
          .catch((e: { name?: string }) => {
            if (e.name !== "ConditionalCheckFailedException") throw e;
          });
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
  }

  async incrementRollups(incs: RollupIncrement[]) {
    await Promise.all(
      coalesceRollups(incs).map((r) =>
        this.doc.send(
          new UpdateCommand({
            TableName: this.table,
            Key: { pk: `APP#${r.app}#ROLLUP#${r.dimension}`, sk: `${r.day}#${r.key}` },
            UpdateExpression: "ADD errors :e, events :v SET app = :app, #day = :day, dimension = :dim, #key = :key",
            ExpressionAttributeNames: { "#day": "day", "#key": "key" },
            ExpressionAttributeValues: { ":e": r.errors, ":v": r.events, ":app": r.app, ":day": r.day, ":dim": r.dimension, ":key": r.key },
          }),
        ),
      ),
    );
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

function clean<T>(item: T): T {
  const { pk: _p, sk: _s, ttl: _t, ...rest } = item as Record<string, unknown>;
  return rest as T;
}
