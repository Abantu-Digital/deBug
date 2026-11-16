import { describe, expect, it } from "vitest";
import { MemoryStore } from "@debugkit/adapters/memory";
import { ingest } from "@debugkit/ingest";
import { buildEndpoints } from "./endpoints";

const NOW = Date.parse("2026-11-16T12:00:00.000Z");
const at = (s: number) => new Date(NOW - 3600_000 + s * 1000).toISOString();
const buckets = (fast: number, slow: number) => [0, 0, fast, 0, 0, 0, 0, slow, 0, 0, 0, 0, 0];

/** A failed call as the SDK reports it: the error with its request, and the app's breadcrumb for it. */
function failure(id: string, s: number, status: number, backendCode?: number, traceId?: string) {
  return {
    type: "error",
    id,
    ts: at(s),
    handled: true,
    tags: { source: "network" },
    error: { name: "HttpError", message: `POST /v1/buy/airtime responded ${status}` },
    request: { method: "POST", url: "/v1/buy/airtime", status, durationMs: 420 },
    breadcrumbs: [
      { ts: at(s - 5), category: "navigation", message: "Dashboard → Buy" },
      {
        ts: at(s),
        category: "network",
        level: "error",
        message: `POST /v1/buy/airtime → ${status}`,
        data: { service: "buy", path: "/v1/buy/airtime", method: "POST", status, durationMs: 420, outcome: "answered", backendCode: backendCode ?? null, backendTitle: backendCode ? "Insufficient funds" : null, traceId: traceId ?? null },
      },
    ],
  };
}

async function store() {
  const s = new MemoryStore();
  const env = {
    sdk: { name: "t", version: "1" },
    context: { app: { id: "a", version: "10.1.28" }, os: { name: "android", version: "15" }, runtime: { name: "react-native" }, device: { model: "Pixel 8a" } },
    user: { id: "0841234567", anonymousId: "inst-1" },
    session: { id: "s1", startedAt: at(0) },
    events: [
      { type: "metric", id: "evt_m00000001", ts: at(60), name: "http", key: "POST /v1/buy/airtime", count: 40, errors: 4, buckets: buckets(30, 10) },
      { type: "metric", id: "evt_m00000002", ts: at(60), name: "http", key: "GET /v1/balances", count: 200, errors: 0, buckets: buckets(200, 0) },
      failure("evt_000000001", 100, 402, 4102, "4f2c9a1b77"),
      failure("evt_000000002", 200, 402, 4102),
      failure("evt_000000003", 300, 503),
    ],
  };
  expect((await ingest(JSON.stringify(env), "k", { store: s, keys: { k: "a" }, now: () => new Date(NOW) })).status).toBe(202);
  return s;
}

describe("endpoint health", () => {
  it("puts the failing endpoint first, with its rate and timings from the SDK and its statuses and codes from the failures", async () => {
    const r = (await buildEndpoints(await store(), "a", NOW, { range: { range: "7d" } }))!;
    expect(r.endpoints.map((e) => e.endpoint)).toEqual(["POST /v1/buy/airtime", "GET /v1/balances"]);
    expect(r.endpoints[0]).toMatchObject({
      service: "buy",
      method: "POST",
      path: "/v1/buy/airtime",
      calls: 40,
      failedCalls: 4,
      failureRate: 0.1,
      failures: 3,
      statuses: [{ key: "402", count: 2 }, { key: "503", count: 1 }],
      backendCodes: [{ key: "4102", count: 2 }],
      lastFailure: at(300),
    });
    expect(r.endpoints[0]!.p95).toBeGreaterThan(r.endpoints[0]!.p50!);
    expect(r.endpoints[1]).toMatchObject({ calls: 200, failureRate: 0, failures: 0, statuses: [] });
    expect(r.selected).toBeUndefined();
  });

  it("lists an endpoint's recent failures, newest first, each pointing at its event", async () => {
    const r = (await buildEndpoints(await store(), "a", NOW, { range: { range: "7d" }, endpoint: "POST /v1/buy/airtime" }))!;
    expect(r.selected!.failures.map((f) => [f.eventId, f.status, f.backendCode, f.traceId])).toEqual([
      ["evt_000000003", "503", undefined, undefined],
      ["evt_000000002", "402", "4102", undefined],
      ["evt_000000001", "402", "4102", "4f2c9a1b77"],
    ]);
    expect(r.selected!.failures[0]).toMatchObject({ fingerprint: expect.any(String), sessionId: "s1", userId: "0841234567", durationMs: 420 });
  });

  it("leaves out failures outside the period", async () => {
    const r = (await buildEndpoints(await store(), "a", NOW + 30 * 86_400_000, { range: { range: "7d" } }))!;
    expect(r.endpoints).toEqual([]);
  });
});
