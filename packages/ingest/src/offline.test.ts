import { describe, expect, it } from "vitest";
import { MemoryStore } from "@debugkit/adapters/memory";
import { DebugClient } from "@debugkit/sdk";
import { OFFLINE_FINGERPRINT, type Breadcrumb } from "@debugkit/schema";
import { ingest } from "./index";

/** ABA-132: a phone going offline is one problem, not one issue per endpoint it couldn't reach. */

const DAY = "2026-11-16";
const at = (s: number) => new Date(Date.UTC(2026, 10, 16, 7, 52, s)).toISOString();
const NOW = new Date(Date.UTC(2026, 10, 16, 8, 0, 0));

/** A call that never left the phone: no status after a few milliseconds. */
const neverSent = (s: number, method: string, url: string, trail: Breadcrumb[] = [], tags?: Record<string, string>) => ({
  type: "error" as const,
  id: `evt_${s}_${url.replace(/\W/g, "")}`.slice(0, 60),
  ts: at(s),
  handled: true,
  tags: { source: "network", ...tags },
  error: { name: "NetworkError", message: `${method} ${url} failed` },
  request: { method, url, durationMs: 30 },
  breadcrumbs: trail,
});
const failedCrumb = (s: number, method: string, url: string): Breadcrumb => ({ ts: at(s), category: "network", level: "error", message: `${method} ${url} → failed (30ms)`, data: { status: null, durationMs: 30 } });

async function send(store: MemoryStore, events: unknown[], sessionId = "s1") {
  const env = {
    sdk: { name: "t", version: "0.9.0" },
    context: { app: { id: "cell-c", version: "10.1.29" }, os: { name: "android", version: "17" }, runtime: { name: "react-native" }, device: { model: "SM-S921B" } },
    user: { anonymousId: `install-${sessionId}` },
    session: { id: sessionId, startedAt: at(0) },
    events,
  };
  expect((await ingest(JSON.stringify(env), "k", { store, keys: { k: "cell-c" }, now: () => NOW })).status).toBe(202);
}
const rollup = async (store: MemoryStore, d: Parameters<MemoryStore["getRollups"]>[1]) =>
  Object.fromEntries((await store.getRollups("cell-c", d, DAY, DAY)).map((r) => [r.key, r.errors]));

const BAL = "2qpssug3bh.execute-api.af-south-1.amazonaws.com/ppd/api/cellc/balance/getBalances";
const SUM = "2qpssug3bh.execute-api.af-south-1.amazonaws.com/ppd/api/cellc/balance/getDetailedSummary";
const HIST = "3eysq9x2ub.execute-api.af-south-1.amazonaws.com/ppd/api/notifications/get-history";

describe("offline bursts (ABA-132)", () => {
  it("a burst across endpoints becomes the one offline issue, with no endpoint, owner or incident", async () => {
    const store = new MemoryStore();
    // Each failure arrives in its own upload, as the SDK flushes on every error.
    await send(store, [neverSent(1, "POST", BAL, [], { "network.airplaneMode": "true" })]);
    await send(store, [neverSent(2, "POST", SUM, [failedCrumb(1, "POST", BAL)])]);
    await send(store, [neverSent(3, "GET", HIST, [failedCrumb(1, "POST", BAL), failedCrumb(2, "POST", SUM)])]);

    const issues = await store.listIssues("cell-c");
    expect(issues.map((i) => i.fingerprint)).toEqual([OFFLINE_FINGERPRINT]);
    expect(issues[0]).toMatchObject({ count: 3, title: "Phone offline: requests never left the phone" });
    expect(issues[0]!.lastEvent.labels).toMatchObject({ category: "network.offline", owner: "unknown" });
    expect(await rollup(store, "endpoint")).toEqual({});
    expect(await rollup(store, "owner")).toEqual({});
    expect(await rollup(store, "incident")).toEqual({});
    expect(await rollup(store, "category")).toEqual({ "network.offline": 3 });
    // The errors themselves are still stored, for the bursts on the issue page.
    expect(store.events.filter((e) => e.fingerprint === OFFLINE_FINGERPRINT)).toHaveLength(3);
  });

  it("folds the first failure of a burst too, though nothing failed before it", async () => {
    const store = new MemoryStore();
    await send(store, [neverSent(1, "POST", BAL)]);
    const [issue] = await store.listIssues("cell-c");
    expect(issue!.fingerprint).toBe(OFFLINE_FINGERPRINT);
    expect(await rollup(store, "endpoint")).toEqual({});
    expect(await rollup(store, "flow")).toEqual({});
  });

  it("a timeout or a server error is never folded, burst or not", async () => {
    const store = new MemoryStore();
    const trail = [failedCrumb(1, "POST", BAL), failedCrumb(2, "POST", SUM)];
    await send(store, [
      { ...neverSent(3, "GET", HIST, trail), error: { name: "NetworkError", message: `GET ${HIST} timed out` }, request: { method: "GET", url: HIST, durationMs: 30_000 } },
      { ...neverSent(4, "POST", BAL, trail), id: "evt_server_err", error: { name: "HttpError", message: `POST ${BAL} responded 503` }, request: { method: "POST", url: BAL, status: 503, durationMs: 800 } },
    ]);
    expect((await store.listIssues("cell-c")).map((i) => i.fingerprint)).not.toContain(OFFLINE_FINGERPRINT);
  });
});

describe("request timings leave out calls that never left the phone (ABA-132)", () => {
  it("leaves them out of the requests and failures the endpoint is charged with", async () => {
    const sent: { events: { type: string; count?: number; errors?: number }[] }[] = [];
    const client = new DebugClient().init({
      endpoint: "x",
      ingestKey: "k",
      app: { id: "cell-c", version: "10.1.29" },
      context: { os: { name: "android" }, runtime: { name: "react-native" } },
      autoCapture: false,
      fetch: (async (_u: string, init: { body: string }) => {
        sent.push(JSON.parse(init.body));
        return new Response("{}", { status: 202 });
      }) as unknown as typeof globalThis.fetch,
    });
    const record = (r: object) => (client as unknown as { recordRequest(r: object): void }).recordRequest({ method: "POST", url: `https://${BAL}`, ...r });
    record({ status: 200, durationMs: 900 });
    record({ status: 500, durationMs: 700 });
    record({ durationMs: 30 }); // never sent
    record({ durationMs: 30_000, timedOut: true }); // timed out: a real failure
    (client as unknown as { queueTimings(force: boolean): void }).queueTimings(true);
    await client.flush();
    await client.close();
    const metric = sent.flatMap((b) => b.events).find((e) => e.type === "metric");
    expect(metric).toMatchObject({ count: 3, errors: 2 });
    expect(metric).not.toHaveProperty("unsent");
  });
});
