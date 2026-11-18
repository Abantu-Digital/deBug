import { describe, expect, it } from "vitest";
import { MemoryStore } from "@debugkit/adapters/memory";
import { DebugClient } from "@debugkit/sdk";
import { isTestEvent } from "@debugkit/schema";
import { ingest } from "./index";

/** ABA-133: errors made on purpose to test deBug get their own issues and count nowhere else. */

const NOW = new Date("2026-11-18T12:00:00.000Z");
const DAY = "2026-11-18";

function harness() {
  const store = new MemoryStore();
  const fetch = (async (_url: string, init: { body: string; headers: Record<string, string> }) => {
    const out = await ingest(init.body, init.headers["x-debug-key"], { store, keys: { pk_test: "cell-c" }, now: () => NOW });
    return new Response(JSON.stringify(out.body), { status: out.status });
  }) as unknown as typeof globalThis.fetch;
  const client = new DebugClient().init({
    endpoint: "x",
    ingestKey: "pk_test",
    app: { id: "cell-c", version: "10.1.30" },
    context: { os: { name: "ios", version: "27.3" }, runtime: { name: "react-native" }, device: { model: "iPhone 16 Pro Max" } },
    autoCapture: { sessions: true },
    fetch,
  });
  const drain = async () => {
    await client.close();
    while ((client as any).queue.length) await client.flush();
  };
  return { store, client, drain };
}

/** The Error testing screen's screenCrash: same code location for the test and a real one. */
function amountOfNull() {
  const e = new TypeError("Cannot read property 'amount' of null");
  e.stack = "TypeError: x\n    at readMissingBalance (/app/src/features/devTools/screens/errorTesting/index.tsx:42:13)";
  return e;
}

const rollup = async (store: MemoryStore, dimension: Parameters<MemoryStore["getRollups"]>[1]) =>
  Object.fromEntries((await store.getRollups("cell-c", dimension, DAY, DAY)).map((r) => [r.key, r.errors]));

describe("test errors (ABA-133)", () => {
  it("deBug.error(err, { test: true }) tags the event, and it gets its own issue apart from a real one at the same place", async () => {
    const { store, client, drain } = harness();
    client.error(amountOfNull(), { test: true });
    client.error(amountOfNull());
    await drain();
    const issues = await store.listIssues("cell-c");
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => isTestEvent(i.lastEvent.event)).sort()).toEqual([false, true]);
  });

  it("counts a test error only on its own issue: not in totals, flows, devices, labels or endpoints", async () => {
    const { store, client, drain } = harness();
    client.error(amountOfNull(), { test: true, flow: "devtools.errorTesting" });
    client.captureError({ name: "HttpError", message: "GET /x responded 500" }, { tags: { test: "true" } }, { method: "GET", url: "/x", status: 500 });
    await drain();
    const fps = (await store.listIssues("cell-c")).map((i) => i.fingerprint);
    expect(Object.keys(await rollup(store, "issue")).sort()).toEqual(fps.sort());
    for (const d of ["total", "flow", "deviceModel", "category", "owner", "endpoint", "incident"] as const) expect(await rollup(store, d)).toEqual({});
  });

  it("a test crash marked with setTags never marks the session errored or crashed", async () => {
    const { store, client, drain } = harness();
    client.setTags({ test: "true" });
    client.error(amountOfNull(), { handled: false, fatal: true });
    client.setTags({ test: undefined });
    await drain();
    const sessions = Object.fromEntries((await store.getRollups("cell-c", "session", DAY, DAY)).map((r) => [r.key, r.events]));
    expect(sessions).toEqual({ "10.1.30|started": 1 });
    expect(isTestEvent(store.events.find((e) => e.event.type === "error")?.event)).toBe(true);
  });

  it("a real crash still marks the session", async () => {
    const { store, client, drain } = harness();
    client.error(amountOfNull(), { handled: false, fatal: true });
    await drain();
    const sessions = Object.fromEntries((await store.getRollups("cell-c", "session", DAY, DAY)).map((r) => [r.key, r.events]));
    expect(sessions).toEqual({ "10.1.30|started": 1, "10.1.30|errored": 1, "10.1.30|crashed": 1 });
  });

  it("a rejection with deBug.testError() is a test however it's reported, and never marks the session", async () => {
    const { store, client, drain } = harness();
    // What the React Native rejection tracker does with an unhandled rejection's reason, later.
    client.error(client.testError("deBug crash test: unhandled promise rejection"), { handled: false, tags: { source: "unhandled-rejection" } });
    await drain();
    expect(isTestEvent(store.events.find((e) => e.event.type === "error")?.event)).toBe(true);
    const sessions = Object.fromEntries((await store.getRollups("cell-c", "session", DAY, DAY)).map((r) => [r.key, r.events]));
    expect(sessions).toEqual({ "10.1.30|started": 1 });
  });

  it("ingest ignores an errored or crashed marker that only test errors caused (an older SDK sends one)", async () => {
    const store = new MemoryStore();
    const ts = "2026-11-18T11:00:00.000Z";
    const env = {
      sdk: { name: "old", version: "0.8.0" },
      context: { app: { id: "cell-c", version: "10.1.30" }, os: { name: "ios" }, runtime: { name: "rn" } },
      session: { id: "s1", startedAt: ts },
      events: [
        { type: "session", id: "evt_sess_err", ts, status: "errored" },
        { type: "session", id: "evt_sess_crash", ts, status: "crashed" },
        { type: "error", id: "evt_test_crash", ts, handled: false, tags: { test: "true" }, error: { name: "Error", message: "Test crash" } },
      ],
    };
    expect((await ingest(JSON.stringify(env), "pk_test", { store, keys: { pk_test: "cell-c" }, now: () => NOW })).status).toBe(202);
    expect(await store.getRollups("cell-c", "session", DAY, DAY)).toEqual([]);
  });

  it("test events that aren't errors (track() outcomes from a test run) count nowhere", async () => {
    const { store, client, drain } = harness();
    client.setTags({ test: "true" });
    await client.track("onboarding.test", "submit", async () => true);
    client.setTags({ test: undefined });
    await drain();
    expect(await rollup(store, "flowOutcome")).toEqual({});
    expect(Object.keys(await rollup(store, "total"))).toEqual([]);
  });

  it("only test=\"true\" counts: other values of the tag are ordinary errors", async () => {
    const { store, client, drain } = harness();
    client.error(amountOfNull(), { tags: { test: "false" } });
    await drain();
    expect(await rollup(store, "total")).toEqual({ all: 1 });
  });
});
