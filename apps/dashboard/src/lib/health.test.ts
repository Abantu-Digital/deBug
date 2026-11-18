import { describe, expect, it } from "vitest";
import type { EndpointHealth } from "../server/endpoints";
import { answerOf, byHealth, endpointsOf, headlineOf, serviceKeys, serviceLevel, servicesOf, serviceTile, UNNAMED, type HealthTileData } from "./health";

const NOW = Date.parse("2026-11-18T12:00:00Z");

const ep = (o: Partial<EndpointHealth>): EndpointHealth => ({
  endpoint: `${o.method ?? "GET"} ${o.path ?? "/x"}`,
  calls: 100,
  failedCalls: 0,
  failureRate: 0,
  p50: 200,
  p95: 800,
  failures: 0,
  statuses: [],
  backendCodes: [],
  backendMessages: [],
  problems: [],
  ...o,
});

describe("serviceLevel", () => {
  it("is green with nothing failing, and by failure rate with enough failures otherwise", () => {
    expect(serviceLevel({ calls: 100, failedCalls: 0, failures: 0 })).toBe("healthy");
    expect(serviceLevel({ calls: 164, failedCalls: 48, failures: 34 })).toBe("critical");
    expect(serviceLevel({ calls: 66, failedCalls: 15, failures: 15 })).toBe("high");
    expect(serviceLevel({ calls: 70, failedCalls: 5, failures: 5 })).toBe("medium");
    expect(serviceLevel({ calls: 158, failedCalls: 4, failures: 4 })).toBe("low");
  });

  it("doesn't call one unlucky call critical", () => {
    expect(serviceLevel({ calls: 2, failedCalls: 1, failures: 1 })).toBe("medium");
  });

  it("counts many failures as bad even when they're a small share", () => {
    expect(serviceLevel({ calls: 100_000, failedCalls: 4_000, failures: 300 })).toBe("critical");
    expect(serviceLevel({ calls: 10_000, failedCalls: 150, failures: 40 })).toBe("high");
  });

  it("goes by stored failures when the SDK sent no request summaries", () => {
    expect(serviceLevel({ calls: 0, failedCalls: 0, failures: 60 })).toBe("critical");
    expect(serviceLevel({ calls: 0, failedCalls: 0, failures: 25 })).toBe("high");
    expect(serviceLevel({ calls: 0, failedCalls: 0, failures: 2 })).toBe("low");
    expect(serviceLevel({ calls: 0, failedCalls: 0, failures: 0 })).toBe("healthy");
  });
});

describe("services", () => {
  it("groups names that differ by case, or a plural with its singular, and nothing else", () => {
    const key = serviceKeys(["Surveys", "surveys", "balance", "Balances", "status", "news"]);
    expect(key("Surveys")).toBe(key("surveys"));
    expect(key("Balances")).toBe("balance");
    expect(key("status")).toBe("status");
    expect(key("news")).toBe("news");
    const rows = [ep({ service: "balance", calls: 126, failedCalls: 34 }), ep({ service: "Balances", path: "/y", calls: 38, failedCalls: 14 }), ep({ path: "/z" })];
    const s = servicesOf(rows);
    expect(s.map((x) => [x.key, x.service, x.calls, x.failedCalls, x.endpoints])).toEqual([
      ["balance", "balance", 164, 48, 2],
      [UNNAMED, undefined, 100, 0, 1],
    ]);
    expect(endpointsOf("balance", rows)).toHaveLength(2);
    expect(endpointsOf(UNNAMED, rows)).toHaveLength(1);
  });

  it("says what's wrong from the worst endpoint: status, the backend's code and message, and the call", () => {
    const rows = [
      ep({ method: "POST", path: "/ppd/api/balance/getBalances", failedCalls: 17, failures: 17, statuses: [{ key: "404", count: 14 }], backendCodes: [{ key: "30007", count: 14 }], backendMessages: [{ key: "Balance lookup unsuccessful", count: 14 }] }),
      ep({ path: "/ok" }),
    ];
    expect(headlineOf(rows)).toBe("404 · 30007 Balance lookup unsuccessful · POST /ppd/api/balance/getBalances");
    expect(headlineOf([ep({})])).toBeUndefined();
  });

  it("marks a box still happening only when it failed in the last hour", () => {
    const rows = [ep({ service: "billing", failedCalls: 8, failures: 8, lastFailure: new Date(NOW - 10 * 60_000).toISOString(), statuses: [{ key: "403", count: 8 }] })];
    const [s] = servicesOf(rows);
    expect(serviceTile(s!, rows, NOW)).toMatchObject({ name: "billing", level: "medium", live: true, measure: "8% of 100 calls failed" });
    expect(serviceTile(s!, rows, NOW + 2 * 3_600_000).live).toBe(false);
  });
});

const tile = (o: Partial<HealthTileData>): HealthTileData => ({ key: o.name ?? "x", name: "x", kind: "service", level: "healthy", measure: "", live: false, weight: 0, ...o });

describe("the wall", () => {
  it("ranks worst first, then still happening, then most failures", () => {
    const tiles = [tile({ name: "ok" }), tile({ name: "b", level: "high", weight: 9 }), tile({ name: "a", level: "critical", weight: 1 }), tile({ name: "c", level: "high", weight: 1, live: true })];
    expect([...tiles].sort(byHealth).map((t) => t.name)).toEqual(["a", "c", "b", "ok"]);
  });

  it("answers a client in plain words", () => {
    const tiles = [tile({ name: "balance", level: "critical", measure: "29% of 164 calls failed", headline: "404 · 30007 Balance lookup unsuccessful", live: true }), tile({ name: "billing", level: "critical" }), tile({ name: "share", level: "high" })];
    expect(answerOf(tiles, "the last 14 days")).toBe(
      "2 parts are failing badly in the last 14 days: balance and billing. Worst: balance, 29% of 164 calls failed (404 · 30007 Balance lookup unsuccessful). 1 is still happening (failed in the last hour). 0 of 3 parts are healthy.",
    );
    expect(answerOf([tile({ name: "ok" })], "the last 7 days")).toBe("Nothing is failing badly in the last 7 days. 1 of 1 part is healthy.");
  });
});
