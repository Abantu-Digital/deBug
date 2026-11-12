import { describe, expect, it } from "vitest";
import { MemoryStore } from "@debugkit/adapters/memory";
import { DebugClient } from "@debugkit/sdk";
import { ingest, normaliseMessage, parseIngestKeys } from "./index";
import { lambdaHandler } from "./lambda";

const NOW = new Date("2026-11-09T12:00:00.000Z");

/** Wire a real SDK client straight into ingest + memory store. */
function harness(opts: { autoCapture?: Parameters<DebugClient["init"]>[0]["autoCapture"] } = {}) {
  const store = new MemoryStore();
  const keys = { pk_test: "megaton-native" };
  const fetch = (async (_url: string, init: { body: string; headers: Record<string, string> }) => {
    const out = await ingest(init.body, init.headers["x-debug-key"], { store, keys, now: () => NOW });
    return new Response(JSON.stringify(out.body), { status: out.status });
  }) as unknown as typeof globalThis.fetch;
  const client = new DebugClient().init({
    endpoint: "x",
    ingestKey: "pk_test",
    app: { id: "megaton-native", version: "2.3.1" },
    context: { os: { name: "Android", version: "14" }, runtime: { name: "react-native" }, device: { model: "SM-S918B" } },
    autoCapture: opts.autoCapture ?? false,
    fetch,
  });
  return { store, client };
}

function loginError(user: number) {
  const e = new TypeError(`Cannot read property 'token' of undefined for user ${user}`);
  e.stack = `TypeError: x\n    at submitOtp (/app/src/screens/Login.tsx:${40 + user}:13)\n    at /app/node_modules/rn/x.js:1:2`;
  return e;
}

describe("ingest", () => {
  it("rolls session markers up per release without storing them as events", async () => {
    const { store, client } = harness({ autoCapture: { sessions: true } });
    client.error(new Error("crash"), { handled: false, fatal: true });
    await client.close();
    while ((client as any).queue.length) await client.flush();
    const rows = await store.getRollups("megaton-native", "session", "2026-11-09", "2026-11-09");
    expect(Object.fromEntries(rows.map((r) => [r.key, r.events]))).toEqual({ "2.3.1|started": 1, "2.3.1|errored": 1, "2.3.1|crashed": 1 });
    expect(store.events.map((e) => e.event.type)).toEqual(["error"]);
  });

  it("groups failed requests by endpoint and status class, wherever they were made", async () => {
    const { store, client } = harness();
    const sendFailure = (status: number, where: string) =>
      client.captureError(
        { name: "HttpError", message: `GET /v1/feed responded ${status}`, stack: `Error\n    at ${where} (/app/src/${where}.ts:1:1)` },
        { tags: { source: "network" } },
        { method: "GET", url: "/v1/feed", status },
      );
    sendFailure(502, "FeedScreen");
    sendFailure(503, "HomeScreen");
    sendFailure(404, "FeedScreen");
    await client.close();
    while ((client as any).queue.length) await client.flush();
    const issues = await store.listIssues("megaton-native");
    expect(issues.map((i) => i.count).sort()).toEqual([1, 2]);
    const rows = await store.getRollups("megaton-native", "endpoint", "2026-11-09", "2026-11-09");
    expect(rows.map((r) => [r.key, r.errors])).toEqual([["GET /v1/feed", 3]]);
  });

  it("groups repeated errors into one issue and rolls up by flow / os / version", async () => {
    const { store, client } = harness();
    for (let u = 0; u < 3; u++) client.error(loginError(u), { flow: "auth.login" });
    client.error(new Error("boom"), { flow: "checkout.payment" });
    client.event("login", { flow: "auth.login", outcome: "failure" });
    client.event("login", { flow: "auth.login", outcome: "success" });
    await client.close();
    while ((client as any).queue.length) await client.flush();

    const issues = await store.listIssues("megaton-native");
    expect(issues).toHaveLength(2);
    const login = issues.find((i) => i.flow === "auth.login")!;
    expect(login.count).toBe(3); // line numbers differ, still one issue
    expect(login.culprit).toMatch(/^submitOtp \(src\/screens\/Login\.tsx:\d+\)$/);

    const day = "2026-11-09";
    const byFlow = await store.getRollups("megaton-native", "flow", day, day);
    expect(byFlow.find((r) => r.key === "auth.login")).toMatchObject({ errors: 3, events: 2 });
    const os = await store.getRollups("megaton-native", "os", day, day);
    expect(os[0]?.key).toBe("android 14");
    const outcomes = await store.getRollups("megaton-native", "flowOutcome", day, day);
    expect(outcomes.map((r) => r.key).sort()).toEqual(["auth.login|failure", "auth.login|success"]);
    expect(await store.listIssueEvents("megaton-native", login.fingerprint)).toHaveLength(3);
  });

  it("rejects bad keys, cross-app writes and malformed payloads", async () => {
    const store = new MemoryStore();
    const keys = { pk_a: "app-a" };
    const env = (app: string) =>
      JSON.stringify({
        sdk: { name: "t", version: "1" },
        context: { app: { id: app }, os: { name: "ios" }, runtime: { name: "rn" } },
        session: { id: "s", startedAt: NOW.toISOString() },
        events: [{ type: "event", id: "evt_12345678", ts: NOW.toISOString(), name: "x" }],
      });
    expect((await ingest(env("app-a"), "nope", { store, keys })).status).toBe(401);
    expect((await ingest(env("app-b"), "pk_a", { store, keys })).status).toBe(403);
    expect((await ingest("{", "pk_a", { store, keys })).status).toBe(400);
    expect((await ingest(JSON.stringify({ events: [] }), "pk_a", { store, keys })).status).toBe(400);
    expect((await ingest(env("app-a"), "pk_a", { store, keys })).status).toBe(202);
  });

  it("lambda handler handles CORS preflight and base64 bodies", async () => {
    const h = lambdaHandler({ store: new MemoryStore(), keys: {} });
    expect((await h({ requestContext: { http: { method: "OPTIONS" } } })).statusCode).toBe(204);
    const r = await h({ body: Buffer.from("{}").toString("base64"), isBase64Encoded: true, headers: { "X-Debug-Key": "k" } });
    expect(r.statusCode).toBe(401);
  });

  it("helpers", () => {
    expect(parseIngestKeys("pk_a:app-a, pk_b:app-b")).toEqual({ pk_a: "app-a", pk_b: "app-b" });
    expect(normaliseMessage("User 123 not found at https://x.io/a")).toBe(normaliseMessage("User 9 not found at https://y.io/b"));
  });
});

describe("react native stacks", () => {
  it("treats Hermes bundle frames as in-app and shortens the bundle path", async () => {
    const { parseStack } = await import("@debugkit/schema/core");
    const { culpritOf } = await import("./fingerprint");
    const dev = parseStack(
      "Error: boom\n    at Bomb (http://127.0.0.1:8081/node_modules/expo-router/entry.bundle//&platform=ios&dev=true:191207:20)\n    at anonymous (http://127.0.0.1:8081/node_modules/expo-router/entry.bundle//&platform=ios&dev=true:1:1)",
    );
    expect(dev[0]?.inApp).toBe(true);
    expect(dev[1]?.inApp).toBe(false);
    const release = parseStack("TypeError: x\n    at handleOtp (address at index.android.bundle:1:48211)");
    expect(release[0]).toMatchObject({ fn: "handleOtp", file: "index.android.bundle", inApp: true });
    const ev = { type: "error", id: "evt_00000001", ts: new Date().toISOString(), handled: true, error: { name: "Error", message: "boom", frames: dev } } as const;
    expect(culpritOf(ev as never)).toBe("Bomb (entry.bundle:191207)");
  });
});
