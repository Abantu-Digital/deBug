import { describe, expect, it } from "vitest";
import { MemoryStore } from "@debugkit/adapters/memory";
import { ingest } from "@debugkit/ingest";
import { zaNumberVariants, lookupCustomer } from "./customers";

const at = (s: number) => new Date(Date.parse("2026-11-16T09:00:00.000Z") + s * 1000).toISOString();

async function send(store: MemoryStore, user: { id?: string; anonymousId: string }, sessionId: string, events: unknown[], version = "10.1.28", app = "a") {
  const env = {
    sdk: { name: "t", version: "1" },
    context: { app: { id: app, version, build: "1028" }, os: { name: "android", version: "15" }, runtime: { name: "react-native" }, device: { model: "Pixel 8a", brand: "google" } },
    user,
    session: { id: sessionId, startedAt: at(0) },
    events,
  };
  expect((await ingest(JSON.stringify(env), "k", { store, keys: { k: app }, now: () => new Date(at(3600)) })).status).toBe(202);
}

describe("customer number variants", () => {
  it("treats 0…, 27… and +27… as the same number", () => {
    const all = ["0841234567", "27841234567", "+27841234567"];
    for (const q of [...all, "+27 84 123 4567", "084-123-4567", " (084) 123 4567 ", "0027841234567", "+27 084 123 4567", "841234567"]) expect(zaNumberVariants(q)).toEqual(expect.arrayContaining(all));
  });
  it("looks up anything else as typed", () => {
    expect(zaNumberVariants("anon-7f3c")).toEqual(["anon-7f3c"]);
    expect(zaNumberVariants("12345")).toEqual(["12345", "+12345"]);
    expect(zaNumberVariants("  ")).toEqual([]);
  });
});

describe("customer lookup", () => {
  it("lists a customer's sessions newest first, whatever format the number is typed in", async () => {
    const store = new MemoryStore();
    await send(store, { id: "27841234567", anonymousId: "inst-1" }, "s-old", [{ type: "event", id: "evt_000000001", ts: at(10), name: "airtime.buy", outcome: "failure", props: { reason: "insufficientFunds" } }], "10.1.27");
    await send(store, { id: "27841234567", anonymousId: "inst-1" }, "s-new", [
      { type: "error", id: "evt_000000002", ts: at(100), handled: true, error: { name: "HttpError", message: "POST /buy → 402" } },
      { type: "error", id: "evt_000000003", ts: at(120), handled: false, severity: "critical", error: { name: "TypeError", message: "x is undefined" } },
    ]);
    await send(store, { id: "27829999999", anonymousId: "inst-2" }, "s-other", [{ type: "event", id: "evt_000000004", ts: at(200), name: "app.opened" }]);

    for (const q of ["0841234567", "+27 84 123 4567", "27841234567"]) {
      const out = await lookupCustomer(store, ["a"], q);
      expect(out.matched).toEqual(["id"]);
      expect(out.sessions.map((s) => [s.sessionId, s.outcome, s.errors, s.failedFlows, s.context.app.version])).toEqual([
        ["s-new", "crashed", 2, 0, "10.1.28"],
        ["s-old", "clean", 0, 1, "10.1.27"],
      ]);
      expect(out.sessions[0]).toMatchObject({ start: at(100), end: at(120), user: { id: "27841234567", anonymousId: "inst-1" } });
    }
  });

  it("searches every app given, as Android and iOS are often separate", async () => {
    const store = new MemoryStore();
    await send(store, { id: "0841234567", anonymousId: "i-a" }, "s-android", [{ type: "event", id: "evt_000000021", ts: at(10), name: "x" }], "1", "android");
    await send(store, { id: "+27841234567", anonymousId: "i-b" }, "s-ios", [{ type: "event", id: "evt_000000021", ts: at(20), name: "x" }], "1", "ios");
    const out = await lookupCustomer(store, ["android", "ios"], "084 123 4567");
    expect(out.sessions.map((s) => [s.app, s.sessionId])).toEqual([["ios", "s-ios"], ["android", "s-android"]]);
  });

  it("finds a signed-out customer by install id", async () => {
    const store = new MemoryStore();
    await send(store, { anonymousId: "inst-9" }, "s-1", [{ type: "error", id: "evt_000000011", ts: at(5), handled: false, error: { name: "Error", message: "boom" } }]);
    const out = await lookupCustomer(store, ["a"], "inst-9");
    expect(out).toMatchObject({ matched: ["anonymousId"], sessions: [{ sessionId: "s-1", outcome: "errored" }] });
    expect((await lookupCustomer(store, ["a"], "nobody")).sessions).toEqual([]);
  });
});
