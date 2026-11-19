import { describe, expect, it } from "vitest";
import { MemoryStore } from "@debugkit/adapters/memory";
import { ingest } from "@debugkit/ingest";
import { DEFAULT_SEVERITY_THRESHOLDS } from "@debugkit/schema";
import { endpointsOf, servicesOf, serviceTile } from "../lib/health";
import { DEMO_UPSTREAM, keepUpstreamDown, seedDemo } from "./demo";
import { buildEndpoints, isServerDown } from "./endpoints";
import { buildHealth } from "./health";
import { buildSummary } from "./queries";

/**
 * Upstream outages: a host (or a path on our gateway) marked "upstream, Cell C" in Settings that
 * gets no answer or a 5xx for many people at once reads as Cell C being down, not our backend.
 */

const NOW = Date.parse("2026-11-19T08:00:00.000Z");
const minAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const GATEWAY = "gw.example.com";
const URL = `${GATEWAY}/ppd/api/balance/getBalances`;

/** One person's failed balance call, `m` minutes ago: a status, or none (timed out). */
async function fail(s: MemoryStore, user: string, m: number, status: number | undefined) {
  const env = {
    sdk: { name: "t", version: "1" },
    context: { app: { id: "a", version: "1.0.0" }, os: { name: "android", version: "15" }, runtime: { name: "react-native" }, device: { model: "Pixel 8a" } },
    user: { id: user, anonymousId: `inst-${user}` },
    session: { id: `s-${user}-${m}`, startedAt: minAgo(m) },
    events: [
      {
        type: "error",
        id: `evt_${user}_${m}`.padEnd(13, "0"),
        ts: minAgo(m),
        handled: true,
        tags: { source: "network" },
        error: status ? { name: "HttpError", message: `POST ${URL} responded ${status}` } : { name: "NetworkError", message: `POST ${URL} timed out` },
        request: { method: "POST", url: URL, status, durationMs: 900 },
      },
    ],
  };
  expect((await ingest(JSON.stringify(env), "k", { store: s, keys: { k: "a" }, now: () => new Date(Date.parse(minAgo(m)) + 1000) })).status).toBe(202);
}

async function upstreamStore() {
  const s = new MemoryStore();
  await s.putSettings("a", {
    hosts: [
      { match: GATEWAY, name: "Our API", kind: "ours" },
      { match: `${GATEWAY}/ppd/api/balance`, name: "Balance", kind: "upstream", provider: "Cell C" },
    ],
  });
  return s;
}

const report = async (s: MemoryStore, now = NOW) => (await buildEndpoints(s, "a", now, { range: { range: "24h" } }))!;

describe("an upstream outage", () => {
  it("counts the people whose calls got no answer or a 5xx in the last 15 minutes, and nothing older or 4xx", async () => {
    const s = await upstreamStore();
    await fail(s, "u1", 2, 503);
    await fail(s, "u1", 3, 503); // the same person twice
    await fail(s, "u2", 5, undefined); // no answer
    await fail(s, "u3", 9, 502);
    await fail(s, "u4", 10, 404); // the request's fault, not the server's
    await fail(s, "u5", 20, 503); // too long ago
    const r = await report(s);
    const row = r.endpoints.find((e) => e.endpoint === `POST ${URL}`)!;
    expect(row).toMatchObject({ service: "Balance", kind: "upstream", provider: "Cell C" });
    expect(row.down).toMatchObject({ failures: 4, last: minAgo(2) });
    expect(new Set(row.down!.who)).toEqual(new Set(["u1", "u2", "u3"]));
    expect(row.down!.statuses).toEqual([{ key: "503", count: 2 }, { key: "502", count: 1 }, { key: "timed out", count: 1 }]);
  });

  it("reads as the upstream being down on Health and on its service page, by name and whose it is", async () => {
    const s = await upstreamStore();
    for (const [u, m] of [["u1", 1], ["u2", 4], ["u3", 7]] as const) await fail(s, u, m, 503);
    const r = await report(s);
    const tile = serviceTile(r.services.find((x) => x.key === "balance")!, r.endpoints, NOW);
    expect(tile).toMatchObject({
      level: "critical",
      side: "upstream",
      sideLabel: "Cell C service",
      outage: "Cell C Balance is down: a 5xx for 3 people in the last 15 min",
    });
    // The service page groups its own endpoints the same way.
    const page = endpointsOf("balance", r.endpoints);
    expect(serviceTile({ ...servicesOf(page)[0]!, key: "balance" }, page, NOW).outage).toBe(tile.outage);
  });

  it("isn't an outage when the failures are a small share of today's calls", async () => {
    const s = await upstreamStore();
    for (const [u, m] of [["u1", 1], ["u2", 4], ["u3", 7]] as const) await fail(s, u, m, 503);
    // 1,000 calls today, 3 of them failed: 0.3%.
    const env = {
      sdk: { name: "t", version: "1" },
      context: { app: { id: "a", version: "1.0.0" }, os: { name: "android", version: "15" }, runtime: { name: "react-native" }, device: { model: "Pixel 8a" } },
      session: { id: "s-busy", startedAt: minAgo(30) },
      events: [{ type: "metric", id: "evt_busy00001", ts: minAgo(30), name: "http", key: `POST ${URL}`, count: 1000, errors: 3, buckets: [0, 0, 1000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }],
    };
    expect((await ingest(JSON.stringify(env), "k", { store: s, keys: { k: "a" }, now: () => new Date(NOW) })).status).toBe(202);
    const r = await report(s);
    const svc = r.services.find((x) => x.key === "balance")!;
    expect(svc.down).toMatchObject({ users: 3, today: { calls: 1000, failed: 3 } });
    expect(serviceTile(svc, r.endpoints, NOW).outage).toBeUndefined();
  });

  it("isn't an outage for fewer than 3 people, or once it's over", async () => {
    const s = await upstreamStore();
    await fail(s, "u1", 1, 503);
    await fail(s, "u2", 2, 503);
    const two = await report(s);
    expect(serviceTile(two.services[0]!, two.endpoints, NOW).outage).toBeUndefined();
    await fail(s, "u3", 3, 503);
    const later = NOW + 20 * 60_000;
    const r = await report(s, later);
    expect(serviceTile(r.services[0]!, r.endpoints, later).outage).toBeUndefined();
  });
});

describe("isServerDown", () => {
  it("is a 5xx or no answer at all, not the app's own kinds of failure", () => {
    for (const s of ["500", "503", "no answer", "timed out", "unreachable"]) expect(isServerDown(s)).toBe(true);
    for (const s of ["404", "401", "sessionExpired", "schemaError", "connectionError"]) expect(isServerDown(s)).toBe(false);
  });
});

describe("the demo's Cell C outage", () => {
  it("reads as Cell C being down, not our backend or the app", async () => {
    const store = await seedDemo();
    const now = Date.now();
    const [e, s] = await Promise.all([buildEndpoints(store, undefined, now), buildSummary(store, undefined, DEFAULT_SEVERITY_THRESHOLDS, now)]);
    const h = buildHealth(e!, s!, now);
    expect(h.tiles[0]).toMatchObject({ key: "balance", level: "critical", sideLabel: "Cell C service", outage: "Cell C Balance is down: no answer or a 5xx for 7 people in the last 15 min" });
    expect(h.tiles.find((t) => t.name === "Megatron API")).toMatchObject({ level: "healthy", sideLabel: "Our backend" });
    expect(h.answer).toMatch(/^Cell C Balance is down: no answer or a 5xx for 7 people in the last 15 min\. It's Cell C's service, not our backend or the app\. /);
    expect(e!.endpoints.find((x) => x.endpoint.includes(DEMO_UPSTREAM))?.lastAnswer?.status).toBe(503);
  });

  it("stays down while the dashboard runs: each tick adds another burst", async () => {
    const store = await seedDemo();
    const down = async () => (await buildEndpoints(store, undefined, Date.now()))!.services.find((x) => x.key === "balance")!.down!.failures;
    expect(await down()).toBe(7);
    await new Promise<void>((resolve) => {
      const stop = keepUpstreamDown(store, () => (stop(), resolve()), 5);
    });
    expect(await down()).toBe(14);
  });
});
