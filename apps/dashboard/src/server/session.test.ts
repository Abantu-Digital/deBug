import { describe, expect, it } from "vitest";
import { MemoryStore } from "@debugkit/adapters/memory";
import { ingest } from "@debugkit/ingest";
import { buildSessionDetail, describeEvent, SESSION_EVENT_LIMIT, stepsAfter, uniqueCrumbs } from "./session";

const at = (s: number) => new Date(Date.parse("2026-11-16T09:00:00.000Z") + s * 1000).toISOString();
const crumbs = {
  open: { ts: at(0), category: "navigation", message: "Dashboard" },
  // The SDK's own breadcrumb for the auth.login event below.
  login: { ts: at(3), category: "event", message: "auth.login", data: { reason: "wrongOtp" } },
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
      { type: "error", id: "evt_000000002", ts: at(10), error: { name: "HttpError", message: "POST /buy/with-airtime → 422" }, breadcrumbs: [crumbs.open, crumbs.login, crumbs.buy, crumbs.tap, crumbs.pay] },
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
    // Every step links to the first error whose trail holds it; the last screen came only with the second.
    const sourceOf = (text: string) => {
      const r = s.rows.find((x) => (x.kind === "crumb" ? x.item.message : x.kind === "event" ? x.detail : undefined) === text);
      return r && r.kind !== "error" ? r.source?.eventId : undefined;
    };
    expect(sourceOf("Dashboard")).toBe("evt_000000002");
    expect(sourceOf("auth.login: failed, wrongOtp")).toBe("evt_000000002");
    expect(sourceOf("Buy → Dashboard")).toBe("evt_000000004");
  });

  it("calls a session with a fatal crash crashed, and one with only caught errors clean", async () => {
    const crash = await session([{ type: "error", id: "evt_000000011", ts: at(1), handled: false, severity: "critical", tags: { source: "global-handler" }, error: { name: "Error", message: "boom" } }], "s-crash");
    expect((await buildSessionDetail(crash, "a", "s-crash"))!.outcome).toBe("crashed");
    // A fatal error the classifier didn't call a crash (here, a failed call) still crashed the session.
    const fatal = await session([{ type: "error", id: "evt_000000013", ts: at(1), handled: false, severity: "critical", error: { name: "HttpError", message: "GET /x → 500" }, request: { method: "GET", url: "/x", status: 500 } }], "s-fatal");
    expect((await buildSessionDetail(fatal, "a", "s-fatal"))!.outcome).toBe("crashed");
    const caught = await session([{ type: "error", id: "evt_000000012", ts: at(1), error: { name: "Error", message: "declined" } }], "s-ok");
    expect((await buildSessionDetail(caught, "a", "s-ok"))!).toMatchObject({ outcome: "clean", counts: { errors: 1, handled: 1 } });
    expect(await buildSessionDetail(caught, "a", "nope")).toBeNull();
  });

  it("keeps the copy of a merged repeat with the highest count", () => {
    const b = { ts: at(1), category: "network" as const, message: "GET /x → failed", level: "error" as const };
    const ev = (n: number) => ({ event: { type: "error", breadcrumbs: [{ ...b, data: { repeated: n } }] } }) as never;
    expect(uniqueCrumbs([ev(2), ev(5), ev(3)]).map((c) => c.crumb.data?.repeated)).toEqual([5]);
  });

  it("treats a merged repeat whose time moved on as the same breadcrumb", () => {
    const before = { ts: at(1), category: "navigation" as const, message: "Dashboard" };
    const rep = (ts: string, n?: number) => ({ ts, category: "network" as const, message: "GET /x → failed", level: "error" as const, ...(n ? { data: { repeated: n } } : {}) });
    const err = (id: string, crumbs: unknown[]) => ({ fingerprint: "fp", event: { type: "error", id, breadcrumbs: crumbs } }) as never;
    // The first error saw it once; by the second the SDK had merged two more repeats into it.
    const out = uniqueCrumbs([err("e1", [before, rep(at(2))]), err("e2", [before, rep(at(7), 3)])]);
    expect(out.map((c) => [c.crumb.message, c.crumb.data?.repeated, c.source?.eventId])).toEqual([
      ["Dashboard", undefined, "e1"],
      ["GET /x → failed", 3, "e1"],
    ]);
    // A separate run after another breadcrumb is a different one.
    const later = uniqueCrumbs([err("e1", [before, rep(at(2))]), err("e2", [before, rep(at(2)), { ...before, ts: at(4) }, rep(at(6), 2)])]);
    expect(later.map((c) => c.crumb.ts)).toEqual([at(1), at(2), at(4), at(6)]);
  });

  it("keeps the newest events of a long session", async () => {
    const store = new MemoryStore();
    const context = { app: { id: "a", version: "1" }, os: { name: "android" }, runtime: { name: "react-native" }, device: {} };
    await store.writeEvents(
      Array.from({ length: SESSION_EVENT_LIMIT + 2 }, (_, i) => ({ app: "a", day: "2026-11-16", sessionId: "s-long", receivedAt: at(999), context, event: { type: "event", id: `evt_${String(i).padStart(9, "0")}`, ts: at(i), name: "tick" } })) as never,
    );
    const s = (await buildSessionDetail(store, "a", "s-long"))!;
    expect(s).toMatchObject({ truncated: true, read: SESSION_EVENT_LIMIT, end: at(SESSION_EVENT_LIMIT + 1), start: at(2) });
  });

  it("finds what the customer did after an error in the trails of later errors", async () => {
    const store = await session([
      { type: "error", id: "evt_000000031", ts: at(10), error: { name: "HttpError", message: "POST /buy/with-airtime → 422" }, breadcrumbs: [crumbs.open, crumbs.buy, crumbs.pay] },
      { type: "error", id: "evt_000000032", ts: at(25), handled: false, error: { name: "TypeError", message: "x" }, breadcrumbs: [crumbs.buy, crumbs.pay, crumbs.back] },
    ], "s-after");
    expect((await stepsAfter(store, "a", "s-after", at(10))).map((t) => t.message)).toEqual(["Buy → Dashboard"]);
    expect(await stepsAfter(store, "a", "s-after", at(25))).toEqual([]);
  });

  it("describes flow events in plain words", () => {
    expect(describeEvent("checkout.pay", "success")).toBe("checkout.pay: succeeded");
    expect(describeEvent("auth.login", "abandoned", {}, "otp")).toBe("auth.login · otp: abandoned");
    expect(describeEvent("app.opened")).toBe("app.opened");
  });
});
