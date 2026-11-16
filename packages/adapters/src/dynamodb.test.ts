import { describe, expect, it } from "vitest";
import { DynamoStore } from "./dynamodb";

type Input = Record<string, any>;

/** A fake document client: answers queries from `rows` a page of `page` at a time, records updates. */
function fakeDoc(rows: Record<string, unknown>[], page: number) {
  const updates: Input[] = [];
  const queries: Input[] = [];
  const doc = {
    async send(cmd: { constructor: { name: string }; input: Input }) {
      const input = cmd.input;
      if (cmd.constructor.name === "UpdateCommand") {
        updates.push(input);
        return {};
      }
      queries.push(input);
      const pk = input.ExpressionAttributeValues[":pk"];
      let hits = rows.filter((r) => r.pk === pk).sort((a, b) => String(a.sk).localeCompare(String(b.sk)));
      if (input.ScanIndexForward === false) hits.reverse();
      const from = input.ExclusiveStartKey ? hits.findIndex((r) => r.sk === input.ExclusiveStartKey.sk) + 1 : 0;
      const n = Math.min(page, input.Limit ?? Infinity);
      const items = hits.slice(from, from + n);
      return { Items: items, LastEvaluatedKey: from + n < hits.length ? { pk, sk: items[items.length - 1]!.sk } : undefined };
    },
  };
  return { doc: doc as never, updates, queries };
}

const row = (pk: string, i: number) => ({ pk, sk: `2026-11-16T09:00:${String(i).padStart(2, "0")}.000Z#e${i}`, app: "a", sessionId: "s1", receivedAt: "2026-11-16T09:01:00.000Z", event: { type: "event", id: `e${i}`, ts: `2026-11-16T09:00:${String(i).padStart(2, "0")}.000Z`, name: "tick" } });

describe("DynamoStore sessions", () => {
  it("pages through a session past one query's 1 MB, keeping the newest, oldest first", async () => {
    const rows = Array.from({ length: 7 }, (_, i) => row("APP#a#SESSEV#s1", i));
    const { doc, queries } = fakeDoc(rows, 2);
    const out = await new DynamoStore(doc, { table: "t" }).listSessionEvents("a", "s1", { limit: 5 });
    expect(out.map((e) => e.event.id)).toEqual(["e2", "e3", "e4", "e5", "e6"]);
    expect(queries.length).toBe(3);
  });

  it("restamps the session copy of each event when retention changes", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const { doc, updates } = fakeDoc([{ ...row(`APP#a#EV#${day}`, 1), fingerprint: "fp" }], 10);
    await new DynamoStore(doc, { table: "t" }).restampExpiry("a", 7);
    expect(updates.map((u) => u.Key.pk).sort()).toEqual([`APP#a#EV#${day}`, "APP#a#ISSUEEV#fp", "APP#a#SESSEV#s1"]);
  });
});
