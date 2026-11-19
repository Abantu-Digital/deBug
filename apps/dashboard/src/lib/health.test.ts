import { describe, expect, it } from "vitest";
import type { EndpointHealth } from "../server/endpoints";
import { answerOf, byHealth, endpointLevel, endpointsOf, headlineOf, outageOf, serviceKeys, serviceLevel, servicesOf, serviceTile, UNNAMED, whoseLine, type HealthTileData } from "./health";

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

describe("upstream outages", () => {
  const down = (who: string[], statuses: { key: string; count: number }[]) => ({ who, failures: statuses.reduce((n, x) => n + x.count, 0), statuses, last: "2026-11-18T11:58:00Z" });

  it("adds people up once across a service's endpoints, and takes whose it is from its busiest endpoint with one set", () => {
    const [s] = servicesOf([
      ep({ service: "Balance", path: "/a", calls: 50, kind: "upstream", provider: "Cell C", down: down(["u1", "u2"], [{ key: "503", count: 2 }]) }),
      ep({ service: "Balance", path: "/b", calls: 80, down: down(["u2", "u3"], [{ key: "timed out", count: 1 }, { key: "503", count: 1 }]) }),
    ]);
    expect(s).toMatchObject({ kind: "upstream", provider: "Cell C", down: { users: 3, failures: 4, statuses: [{ key: "503", count: 3 }, { key: "timed out", count: 1 }] } });
  });

  it("is an outage from 3 people, says what failed, and doesn't repeat the provider's name", () => {
    const s = (o: object) => ({ service: "Balance", kind: "upstream" as const, provider: "Cell C", ...o });
    expect(outageOf(s({ down: { users: 2, failures: 9, statuses: [{ key: "503", count: 9 }], last: "" } }))).toBeUndefined();
    expect(outageOf(s({ down: { users: 3, failures: 3, statuses: [{ key: "503", count: 3 }], last: "" } }))).toBe("Cell C Balance is down: a 5xx for 3 people in the last 15 min");
    expect(outageOf(s({ down: { users: 4, failures: 4, statuses: [{ key: "no answer", count: 4 }], last: "" } }))).toBe("Cell C Balance is down: no answer for 4 people in the last 15 min");
    expect(outageOf(s({ service: "Cell C balance", down: { users: 3, failures: 3, statuses: [{ key: "503", count: 1 }, { key: "timed out", count: 2 }], last: "" } }))).toBe(
      "Cell C balance is down: no answer or a 5xx for 3 people in the last 15 min",
    );
    expect(outageOf({ service: "Accounts", kind: "ours", down: { users: 3, failures: 3, statuses: [{ key: "500", count: 3 }], last: "" } })).toBe("Accounts is down: a 5xx for 3 people in the last 15 min");
  });

  it("makes an endpoint that's down for 3 people critical, whatever its share", () => {
    expect(endpointLevel(ep({ calls: 1000, failedCalls: 6, down: down(["u1", "u2", "u3"], [{ key: "503", count: 6 }]) }))).toBe("critical");
    expect(endpointLevel(ep({ calls: 1000, failedCalls: 6, down: down(["u1", "u1", "u2"], [{ key: "503", count: 6 }]) }))).toBe("low");
  });

  it("makes the box critical and puts it first, with whose service it is", () => {
    const rows = [ep({ service: "Balance", calls: 1000, failedCalls: 6, kind: "upstream", provider: "Cell C", down: down(["u1", "u2", "u3"], [{ key: "503", count: 6 }]) })];
    const t = serviceTile(servicesOf(rows)[0]!, rows, NOW);
    expect(t).toMatchObject({ level: "critical", side: "upstream", sideLabel: "Cell C service", provider: "Cell C", outage: "Cell C Balance is down: a 5xx for 3 people in the last 15 min" });
    expect([tile({ name: "a", level: "critical", weight: 99, live: true }), t].sort(byHealth)[0]).toBe(t);
  });

  it("leads the client answer with the outage and whose it is", () => {
    const cellc = tile({ name: "Balance", level: "critical", side: "upstream", provider: "Cell C", outage: "Cell C Balance is down: a 5xx for 3 people in the last 15 min", measure: "1% of 1,000 calls failed", live: true });
    expect(answerOf([cellc, tile({ name: "ok" })], "the last 24 hours")).toBe(
      "Cell C Balance is down: a 5xx for 3 people in the last 15 min. It's Cell C's service, not our backend or the app. 1 part is failing badly in the last 24 hours: Balance. 1 is still happening (failed in the last hour). 1 of 2 parts are healthy.",
    );
    const ours = tile({ name: "Accounts", level: "critical", side: "ours", outage: "Accounts is down: a 5xx for 4 people in the last 15 min" });
    const app = tile({ name: "App code", kind: "app", level: "high", measure: "2 crash or code errors open, 5 times" });
    expect(answerOf([ours, app], "today")).toBe(
      "Accounts is down: a 5xx for 4 people in the last 15 min. It's our own backend, not an upstream service or the app. 1 part is failing badly in today: Accounts. Worst otherwise: App code, 2 crash or code errors open, 5 times. 0 of 2 parts are healthy.",
    );
    expect(whoseLine({ side: "upstream" })).toBe("It's a third party's service, not our backend or the app.");
    expect(whoseLine({})).toBe("");
  });
});
