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

async function store(extra: unknown[] = []) {
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
      ...extra,
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
    // The issues behind the failures, most first: one click from the cause.
    const problems = r.endpoints[0]!.problems;
    expect(problems.reduce((n, p) => n + p.count, 0)).toBe(3);
    expect(problems.map((p) => p.count)).toEqual([...problems.map((p) => p.count)].sort((a, b) => b - a));
    expect(problems[0]).toMatchObject({ status: "402", platforms: [expect.any(String)] });
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

  it("names an endpoint's service from any call in the trails, and adds endpoints up per service", async () => {
    const seen = { ...failure("evt_000000004", 400, 503), breadcrumbs: [{ ts: at(398), category: "network", message: "GET /v1/balances → 200", data: { service: "balance", path: "/v1/balances", method: "GET", status: null, outcome: "answered" } }, ...failure("x", 400, 503).breadcrumbs] };
    const r = (await buildEndpoints(await store([seen]), "a", NOW, { range: { range: "7d" } }))!;
    expect(r.endpoints.find((e) => e.endpoint === "GET /v1/balances")).toMatchObject({ service: "balance", calls: 200, failures: 0 });
    expect(r.services.map((x) => [x.service, x.calls, x.failedCalls, x.failures])).toEqual([
      ["buy", 40, 4, 4],
      ["balance", 200, 0, 0],
    ]);
  });

  it("counts a failure the app reported itself under the SDK's endpoint with the same method and path", async () => {
    const appOnly = { ...failure("evt_000000005", 500, 401), request: undefined };
    const r = (await buildEndpoints(await store([appOnly]), "a", NOW, { range: { range: "7d" } }))!;
    expect(r.endpoints.filter((e) => e.path === "/v1/buy/airtime")).toHaveLength(1);
    expect(r.endpoints[0]).toMatchObject({ endpoint: "POST /v1/buy/airtime", failures: 4, statuses: [{ key: "402", count: 2 }, { key: "401", count: 1 }, { key: "503", count: 1 }] });
  });

  it("joins a lower-case method and a URL past the SDK's 300-character key", async () => {
    const long = `/v1/search/${"x".repeat(320)}`;
    const key = `GET ${long}`.slice(0, 300);
    const err = { ...failure("evt_000000006", 600, 500), request: { method: "get", url: long, status: 500 }, breadcrumbs: [] };
    const metric = { type: "metric", id: "evt_m00000003", ts: at(60), name: "http", key, count: 10, errors: 1, buckets: buckets(10, 0) };
    const r = (await buildEndpoints(await store([err, metric]), "a", NOW, { range: { range: "7d" } }))!;
    expect(r.endpoints.filter((e) => e.endpoint.startsWith("GET /v1/search"))).toMatchObject([{ calls: 10, failures: 1 }]);
  });

  it("says when an endpoint asked for had nothing in the period", async () => {
    const r = (await buildEndpoints(await store(), "a", NOW, { range: { range: "7d" }, endpoint: "GET /nope" }))!;
    expect(r).toMatchObject({ missing: "GET /nope", selected: undefined, truncated: false });
  });

  it("leaves out failures outside the period", async () => {
    const r = (await buildEndpoints(await store(), "a", NOW + 30 * 86_400_000, { range: { range: "7d" } }))!;
    expect(r.endpoints).toEqual([]);
  });
});

describe("calls that never left the phone (ABA-132)", () => {
  it("aren't charged to the endpoint", async () => {
    const neverSent = { type: "error", id: "evt_offline_01", ts: at(400), handled: true, tags: { source: "network" }, error: { name: "NetworkError", message: "GET /v1/balances failed" }, request: { method: "GET", url: "/v1/balances", durationMs: 20 } };
    const balances = async (extra: unknown[]) => (await buildEndpoints(await store(extra), "a", NOW, { range: { range: "7d" } }))!.endpoints.find((e) => e.endpoint === "GET /v1/balances");
    expect(await balances([neverSent])).toEqual(await balances([]));
  });
});
