import { describe, expect, it } from "vitest";
import { MemoryStore } from "@debugkit/adapters/memory";
import { ingest } from "@debugkit/ingest";
import { DEFAULT_SEVERITY_THRESHOLDS, type Breadcrumb } from "@debugkit/schema";
import { apiCallOf, buildEventDetail, failedRequest, framesInAppFirst, timelineOf } from "./event";
import { buildIssueDetail } from "./queries";

const crumb = (b: Partial<Breadcrumb> & Pick<Breadcrumb, "category" | "message">): Breadcrumb => ({ ts: "2026-11-16T09:00:00.000Z", level: "info", ...b });

describe("API calls in breadcrumbs", () => {
  it("reads the Cell C app's keys, both spellings of the backend fields, and the failure", () => {
    const call = apiCallOf(
      crumb({
        category: "network",
        message: "POST /payments/charge",
        level: "error",
        data: { service: "payments", method: "post", path: "/payments/charge", status: 402, durationMs: 380, outcome: "answered", retry: 0, "backend.title": "Insufficient funds", backendCode: "PAY-402", traceId: "4f2c9a" },
      }),
    );
    expect(call).toEqual({ service: "payments", method: "POST", path: "/payments/charge", status: 402, durationMs: 380, outcome: "answered", retry: 0, backendTitle: "Insufficient funds", backendCode: "PAY-402", traceId: "4f2c9a", failed: true });
  });

  it("reads CCA-1542's final keys: numeric backend code, error kind, backend errors, null status", () => {
    const failed = apiCallOf(
      crumb({
        category: "network",
        message: "POST /buy/with-airtime → 422 (98 ms)",
        level: "error",
        data: { service: "buy", path: "/buy/with-airtime", method: "POST", durationMs: 98, outcome: "answered", retry: 0, errorKind: null, status: 422, backendTitle: "Not enough airtime", backendCode: 4102, traceId: null, backendErrors: "balance too low; try a smaller bundle" },
      }),
    );
    expect(failed).toEqual({ service: "buy", method: "POST", path: "/buy/with-airtime", status: 422, durationMs: 98, outcome: "answered", retry: 0, backendTitle: "Not enough airtime", backendCode: "4102", backendErrors: "balance too low; try a smaller bundle", errorKind: undefined, traceId: undefined, failed: true });
    const ok = apiCallOf(crumb({ category: "network", message: "GET /catalog/bundles → OK (40 ms)", data: { service: "catalog", path: "/catalog/bundles", method: "GET", durationMs: 40, outcome: "answered", retry: 0, errorKind: null, status: null } }));
    expect(ok).toMatchObject({ service: "catalog", failed: false });
    expect(ok?.status).toBeUndefined();
    const unreachable = apiCallOf(crumb({ category: "network", message: "GET /profile/me → unreachable", level: "error", data: { service: "profile", path: "/profile/me", method: "GET", outcome: "unreachable", errorKind: "connectionError", status: null } }));
    expect(unreachable).toMatchObject({ errorKind: "connectionError", failed: true });
  });

  it("counts an unanswered call as failed even without an error level", () => {
    expect(apiCallOf(crumb({ category: "network", message: "x", data: { service: "balance", path: "/b", outcome: "unreachable" } }))?.failed).toBe(true);
    expect(apiCallOf(crumb({ category: "network", message: "x", data: { service: "balance", path: "/b", status: 200, outcome: "answered" } }))?.failed).toBe(false);
    expect(apiCallOf(crumb({ category: "network", message: "x", data: { service: "balance", path: "/b", outcome: "cached" } }))?.failed).toBe(false);
    // The app cancelled it: the SDK says "aborted" at level info.
    expect(apiCallOf(crumb({ category: "network", message: "GET /b → aborted (12ms)", data: { service: "balance", path: "/b", method: "GET", status: null, outcome: "aborted" } }))?.failed).toBe(false);
  });

  it("reads the SDK's own network breadcrumb and names its host from Settings", () => {
    const call = apiCallOf(
      crumb({ category: "network", message: "POST api-b.example.com/api/balance/getBalances → failed (16ms)", level: "error", data: { status: null, durationMs: 16 } }),
      [{ match: "api-b.example.com/api/balance", name: "Balance service" }],
    );
    expect(call).toMatchObject({ service: "Balance service", method: "POST", path: "/getBalances", durationMs: 16, failed: true });
    expect(call?.status).toBeUndefined();
  });

  it("reads the status from the SDK's message, and keeps a host name that contains a dot", () => {
    const call = apiCallOf(crumb({ category: "network", message: "GET api.x.com/v1/me → 503 (90ms)", level: "error", data: { durationMs: 90 } }), [{ match: "api.x.com", name: "Accounts · EU" }]);
    expect(call).toMatchObject({ service: "Accounts · EU", path: "/v1/me", status: 503 });
  });

  it("isn't an API call when a network breadcrumb only reports connectivity", () => {
    expect(apiCallOf(crumb({ category: "network", message: "Device went offline", level: "warning" }))).toBeUndefined();
    expect(apiCallOf(crumb({ category: "ui", message: "Tapped Pay" }))).toBeUndefined();
  });
});

describe("timeline", () => {
  it("puts breadcrumbs in time order, keeps the rest of the data, and marks failures and repeats", () => {
    const t = timelineOf([
      crumb({ ts: "2026-11-16T09:00:03.000Z", category: "network", message: "GET /b", data: { service: "balance", path: "/b", status: 503, repeated: 3 } }),
      crumb({ ts: "2026-11-16T09:00:01.000Z", category: "navigation", message: "Dashboard → Buy" }),
      crumb({ ts: "2026-11-16T09:00:02.000Z", category: "ui", message: "Tapped Pay", data: { button: "pay", screen: "Buy" } }),
    ]);
    expect(t.map((x) => x.category)).toEqual(["navigation", "ui", "network"]);
    expect(t[1]).toMatchObject({ failed: false, data: { button: "pay", screen: "Buy" } });
    expect(t[2]).toMatchObject({ failed: true, repeated: 3, api: { service: "balance", status: 503 } });
    expect(t[2]!.data).toBeUndefined();
  });

  it("leaves out the SDK's own breadcrumb for a call the app also recorded", () => {
    const t = timelineOf([
      crumb({ ts: "2026-11-16T09:00:01.000Z", category: "network", message: "POST gw.example.com/prod/buy/with-airtime → 422 (97ms)", level: "error", data: { status: 422, durationMs: 97 } }),
      crumb({ ts: "2026-11-16T09:00:01.010Z", category: "network", message: "POST /buy/with-airtime → 422 (98 ms)", level: "error", data: { service: "buy", path: "/buy/with-airtime", method: "POST", status: 422, outcome: "answered" } }),
      crumb({ ts: "2026-11-16T09:00:05.000Z", category: "network", message: "GET gw.example.com/prod/catalog/bundles → 200 (40ms)", data: { status: 200, durationMs: 40 } }),
    ]);
    expect(t.map((x) => x.message)).toEqual(["POST /buy/with-airtime → 422 (98 ms)", "GET gw.example.com/prod/catalog/bundles → 200 (40ms)"]);
  });

  it("sorts by time even when timestamps have different precision", () => {
    const t = timelineOf([
      crumb({ ts: "2026-11-16T09:00:00.500Z", category: "ui", message: "second" }),
      crumb({ ts: "2026-11-16T09:00:00Z", category: "ui", message: "first" }),
    ]);
    expect(t.map((x) => x.message)).toEqual(["first", "second"]);
  });

  it("only fills the error's request from a breadcrumb for the same call", () => {
    const timeline = timelineOf([
      crumb({ category: "network", message: "GET /balance", level: "error", data: { service: "balance", method: "GET", path: "/balance", status: 503, traceId: "wrong" } }),
    ]);
    const own = failedRequest({ method: "GET", url: "api.x.com/profile", status: 500 }, timeline);
    expect(own).toEqual({ service: undefined, method: "GET", path: "api.x.com/profile", status: 500, durationMs: undefined, failed: true });
    const same = failedRequest({ method: "GET", url: "api.x.com/balance", status: 503, durationMs: 40 }, timeline);
    expect(same).toMatchObject({ service: "balance", path: "/balance", traceId: "wrong", durationMs: 40 });
    expect(failedRequest(undefined, timeline)).toMatchObject({ path: "/balance" });
  });

  it("lists the app's own frames first, in stack order", () => {
    const f = framesInAppFirst([{ fn: "a" }, { fn: "b", inApp: true }, { fn: "c" }, { fn: "d", inApp: true }]);
    expect(f.map((x) => x.fn)).toEqual(["b", "d", "a", "c"]);
  });
});

describe("event detail", () => {
  it("is two clicks from an issue: its occurrences link to an event that reads in order up to the failure", async () => {
    const store = new MemoryStore();
    const ts = (s: number) => new Date(Date.parse("2026-11-16T09:00:00.000Z") + s * 1000).toISOString();
    const err = (id: string, at: number) => ({
      type: "error",
      id,
      ts: ts(at),
      tags: { "device.details": "full", "network.carrier": "Cell C" },
      error: { name: "HttpError", message: "POST api.x.com/payments/charge → 402", stack: "HttpError\n    at request (node_modules/axios/lib/core.js:1:1)\n    at pay (/app/src/Buy.tsx:42:7)" },
      request: { method: "POST", url: "api.x.com/payments/charge", status: 402, durationMs: 380 },
      breadcrumbs: [
        { ts: ts(at - 3), category: "navigation", message: "Dashboard → Buy" },
        { ts: ts(at - 1), category: "network", message: "POST /payments/charge", level: "error", data: { service: "payments", method: "POST", path: "/payments/charge", status: 402, backendCode: "PAY-402", traceId: "4f2c9a" } },
        { ts: ts(at - 2), category: "ui", message: "Tapped Pay" },
      ],
    });
    const env = {
      sdk: { name: "t", version: "1" },
      context: { app: { id: "a", version: "10.1.28", build: "1028" }, os: { name: "android", version: "15" }, runtime: { name: "react-native" }, device: { model: "Pixel 8a", brand: "google" } },
      user: { id: "0841234567", anonymousId: "anon-1" },
      session: { id: "sess-1", startedAt: ts(-60) },
      events: [err("evt_000000001", 0), err("evt_000000002", 10), err("evt_000000003", 20)],
    };
    expect((await ingest(JSON.stringify(env), "k", { store, keys: { k: "a" }, now: () => new Date(ts(30)) })).status).toBe(202);

    const fp = (await store.listIssues("a"))[0]!.fingerprint;
    const issue = (await buildIssueDetail(store, "a", fp, DEFAULT_SEVERITY_THRESHOLDS, Date.parse(ts(30))))!;
    expect(issue.recent.map((r) => r.id)).toEqual(["evt_000000003", "evt_000000002", "evt_000000001"]);

    const d = (await buildEventDetail(store, "a", fp, "evt_000000001"))!;
    expect(d.timeline.map((t) => t.message)).toEqual(["Dashboard → Buy", "Tapped Pay", "POST /payments/charge"]);
    expect(d.request).toMatchObject({ service: "payments", method: "POST", status: 402, durationMs: 380, backendCode: "PAY-402", traceId: "4f2c9a", failed: true });
    expect(d.user).toEqual({ id: "0841234567", anonymousId: "anon-1" });
    expect(d.sessionId).toBe("sess-1");
    expect(d.tags).toEqual([{ key: "device.details", value: "full" }, { key: "network.carrier", value: "Cell C" }]);
    expect(d.frames[0]).toMatchObject({ fn: "pay", inApp: true });
    expect(d).toMatchObject({ newer: "evt_000000002", older: undefined });
    expect(await buildEventDetail(store, "a", fp, "evt_000000002")).toMatchObject({ newer: "evt_000000003", older: "evt_000000001" });

    expect(await buildEventDetail(store, "a", fp, "evt_unknown00")).toBeNull();
    expect(await buildEventDetail(store, "a", "nope", "evt_000000001")).toBeNull();
  });
});
