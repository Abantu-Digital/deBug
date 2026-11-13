import { beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "@debugkit/adapters/memory";
import { DebugClient } from "@debugkit/sdk";
import { ingest } from "./index";
import { clearSettingsCache, handleAdmin } from "./admin";
import { firebaseHandler } from "./firebase";
import { lambdaHandler } from "./lambda";

const TOKEN = "admin_token_0123456789abcdef";
const DAY = 86_400_000;

function harness(retentionDays?: number) {
  const store = new MemoryStore();
  const fetch = (async (_u: string, init: { body: string; headers: Record<string, string> }) => {
    const out = await ingest(init.body, init.headers["x-debug-key"], { store, keys: { pk: "shop" }, retentionDays });
    return new Response(JSON.stringify(out.body), { status: out.status });
  }) as unknown as typeof globalThis.fetch;
  const client = new DebugClient().init({ endpoint: "x", ingestKey: "pk", app: { id: "shop" }, context: { os: { name: "web" }, runtime: { name: "node" } }, autoCapture: false, fetch, flushIntervalMs: 0 });
  return { store, client };
}
const expiryDays = (store: MemoryStore) => [...store.expiry.values()].map((t, i) => Math.round((t - Date.parse(store.events[i]!.receivedAt)) / DAY));

beforeEach(() => clearSettingsCache());

describe("retention", () => {
  it("uses the deployment default until the app has a setting", async () => {
    const { store, client } = harness(60);
    client.error(new Error("a"));
    await client.close();
    expect(expiryDays(store)).toEqual([60]);
  });

  it("falls back to 30 days with no setting and no default", async () => {
    const { store, client } = harness();
    client.error(new Error("a"));
    await client.close();
    expect(expiryDays(store)).toEqual([30]);
  });

  it("uses the app's stored setting over the default", async () => {
    const { store, client } = harness(60);
    await store.putSettings("shop", { retentionDays: 180 });
    client.error(new Error("a"));
    await client.close();
    expect(expiryDays(store)).toEqual([180]);
  });
});

describe("admin routes", () => {
  const call = (store: MemoryStore, req: Partial<Parameters<typeof handleAdmin>[0]>) =>
    handleAdmin({ method: "GET", path: "/admin/settings", body: "", authorization: `Bearer ${TOKEN}`, ...req }, { store, adminToken: TOKEN, retentionDays: 60 });

  it("are off without a token, and reject a wrong one", async () => {
    const store = new MemoryStore();
    expect((await handleAdmin({ method: "GET", path: "/admin/settings", body: "" }, { store })).status).toBe(404);
    expect((await call(store, { authorization: "Bearer nope" })).status).toBe(401);
    expect((await call(store, { authorization: undefined })).status).toBe(401);
  });

  it("read and change the retention period, validating it", async () => {
    const store = new MemoryStore();
    expect((await call(store, { query: { app: "shop" } })).body).toMatchObject({ ok: true, retentionDays: 60, settings: null });
    expect((await call(store, { method: "PUT", body: JSON.stringify({ app: "shop", retentionDays: 0 }) })).status).toBe(400);
    expect((await call(store, { method: "PUT", body: JSON.stringify({ app: "shop", retentionDays: 90.5 }) })).status).toBe(400);
    expect((await call(store, { method: "PUT", body: JSON.stringify({ app: "../x", retentionDays: 90 }) })).status).toBe(400);
    const put = await call(store, { method: "PUT", body: JSON.stringify({ app: "shop", retentionDays: 90 }) });
    expect(put.body).toMatchObject({ ok: true, retentionDays: 90 });
    expect((await call(store, { query: { app: "shop" } })).body).toMatchObject({ retentionDays: 90 });
  });

  it("re-stamp existing events page by page", async () => {
    const { store, client } = harness(30);
    for (let i = 0; i < 3; i++) client.error(new Error(`e${i}`));
    await client.close();
    await store.putSettings("shop", { retentionDays: 365 });
    clearSettingsCache(); // set straight in the store above, so drop the cached lookup
    let cursor: string | undefined;
    let total = 0;
    do {
      const out = await handleAdmin(
        { method: "POST", path: "/admin/restamp", body: JSON.stringify({ app: "shop", cursor }), authorization: `Bearer ${TOKEN}` },
        { store, adminToken: TOKEN },
      );
      total += out.body.updated as number;
      cursor = out.body.cursor as string | undefined;
    } while (cursor);
    expect(total).toBe(3);
    expect(expiryDays(store)).toEqual([365, 365, 365]);
  });

  it("are reachable through the Firebase and Lambda handlers", async () => {
    const store = new MemoryStore();
    let status = 0;
    let json: any;
    const res = { set: () => res, status: (n: number) => ((status = n), { json: (b: unknown) => (json = b), send: () => {} }) };
    await firebaseHandler({ store, keys: {}, adminToken: TOKEN, retentionDays: 45 })(
      { method: "GET", path: "/admin/settings", query: { app: "shop" }, header: (n) => (n === "authorization" ? `Bearer ${TOKEN}` : undefined) },
      res,
    );
    expect([status, json.retentionDays]).toEqual([200, 45]);
    const out = await lambdaHandler({ store, keys: {}, adminToken: TOKEN })({
      rawPath: "/admin/settings",
      requestContext: { http: { method: "PUT" } },
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ app: "shop", retentionDays: 120 }),
    });
    expect(out.statusCode).toBe(200);
    expect((await store.getSettings("shop"))?.retentionDays).toBe(120);
  });
});
