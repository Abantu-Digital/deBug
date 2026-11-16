import { describe, expect, it } from "vitest";
import { MemoryStore } from "@debugkit/adapters/memory";
import { ingest } from "@debugkit/ingest";
import { buildSessionDetail, describeEvent, uniqueCrumbs } from "./session";

const at = (s: number) => new Date(Date.parse("2026-11-16T09:00:00.000Z") + s * 1000).toISOString();
const crumbs = {
  open: { ts: at(0), category: "navigation", message: "Dashboard" },
  buy: { ts: at(5), category: "navigation", message: "Dashboard → Buy" },
  tap: { ts: at(8), category: "ui", message: "Tapped \"Pay\"" },
  pay: { ts: at(9), category: "network", message: "POST /buy/with-airtime → 422 (98 ms)", level: "error", data: { service: "buy", path: "/buy/with-airtime", method: "POST", status: 422, outcome: "answered", backendCode: 4102 } },
  back: { ts: at(20), category: "navigation", message: "Buy → Dashboard" },
};

async function session(events: unknown[], sessionId = "sess-1") {
  const store = new MemoryStore();
  const env = {
    sdk: { name: "t", version: "1" },
    context: { app: { id: "a", version: "10.1.28", build: "1028" }, os: { name: "android", version: "15" }, runtime: { name: "react-native" }, device: { model: "Pixel 8a", brand: "google" } },
    user: { id: "0841234567", anonymousId: "anon-1" },
    session: { id: sessionId, startedAt: at(0) },
    events,
  };
  expect((await ingest(JSON.stringify(env), "k", { store, keys: { k: "a" }, now: () => new Date(at(60)) })).status).toBe(202);
  return store;
}

describe("session timeline", () => {
  it("merges errors, flow events and their trails into one timeline, each breadcrumb once", async () => {
    const store = await session([
      { type: "event", id: "evt_000000001", ts: at(3), name: "auth.login", flow: "auth.login", outcome: "failure", props: { reason: "wrongOtp" } },
      { type: "error", id: "evt_000000002", ts: at(10), error: { name: "HttpError", message: "POST /buy/with-airtime → 422" }, breadcrumbs: [crumbs.open, crumbs.buy, crumbs.tap, crumbs.pay] },
      { type: "event", id: "evt_000000003", ts: at(9.5), name: "api.failed", props: { service: "buy", path: "/buy/with-airtime", status: 422 } },
      { type: "error", id: "evt_000000004", ts: at(25), handled: false, error: { name: "TypeError", message: "x is undefined" }, breadcrumbs: [crumbs.buy, crumbs.tap, crumbs.pay, crumbs.back] },
    ]);
    const s = (await buildSessionDetail(store, "a", "sess-1"))!;
    expect(s.rows.map((r) => (r.kind === "crumb" ? r.item.message : r.kind === "event" ? r.detail : r.title))).toEqual([
      "Dashboard",
      "auth.login: failed, wrongOtp",
      "Dashboard → Buy",
      "Tapped \"Pay\"",
      "POST /buy/with-airtime → 422 (98 ms)",
      "HttpError: POST /buy/with-airtime → 422",
      "Buy → Dashboard",
      "TypeError: x is undefined",
    ]);
    expect(s).toMatchObject({ outcome: "errored", counts: { errors: 2, handled: 1, events: 1 }, user: { id: "0841234567" }, start: at(0), end: at(25), truncated: false });
    const err = s.rows.find((r) => r.kind === "error")!;
    expect(err).toMatchObject({ eventId: "evt_000000002", fingerprint: expect.any(String) });
  });

  it("calls a session with a fatal crash crashed, and one with only caught errors clean", async () => {
    const crash = await session([{ type: "error", id: "evt_000000011", ts: at(1), handled: false, severity: "critical", tags: { source: "global-handler" }, error: { name: "Error", message: "boom" } }], "s-crash");
    expect((await buildSessionDetail(crash, "a", "s-crash"))!.outcome).toBe("crashed");
    const caught = await session([{ type: "error", id: "evt_000000012", ts: at(1), error: { name: "Error", message: "declined" } }], "s-ok");
    expect((await buildSessionDetail(caught, "a", "s-ok"))!).toMatchObject({ outcome: "clean", counts: { errors: 1, handled: 1 } });
    expect(await buildSessionDetail(caught, "a", "nope")).toBeNull();
  });

  it("keeps the copy of a merged repeat with the highest count", () => {
    const b = { ts: at(1), category: "network" as const, message: "GET /x → failed", level: "error" as const };
    const ev = (n: number) => ({ event: { type: "error", breadcrumbs: [{ ...b, data: { repeated: n } }] } }) as never;
    expect(uniqueCrumbs([ev(2), ev(5), ev(3)]).map((c) => c.data?.repeated)).toEqual([5]);
  });

  it("describes flow events in plain words", () => {
    expect(describeEvent("checkout.pay", "success")).toBe("checkout.pay: succeeded");
    expect(describeEvent("auth.login", "abandoned", {}, "otp")).toBe("auth.login · otp: abandoned");
    expect(describeEvent("app.opened")).toBe("app.opened");
  });
});
