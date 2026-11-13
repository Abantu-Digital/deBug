import { beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "@debugkit/adapters/memory";
import { latencyBucket, percentileMs } from "@debugkit/schema";
import { ingest } from "./index";
import { clearSettingsCache, handleAdmin } from "./admin";
import { clearAlertMemory, sendAlerts } from "./alerts";
import { countryOf } from "./country";

const TOKEN = "admin_token_0123456789abcdef";
const HOOK = "https://hooks.slack.com/services/T000/B000/abcdefghijklmnop";
let n = 0;

async function send(store: MemoryStore, events: unknown[], ctx: Record<string, unknown> = {}) {
  const ts = new Date().toISOString();
  const env = {
    sdk: { name: "t", version: "1" },
    context: { app: { id: "shop", version: "1.0.0" }, os: { name: "ios" }, runtime: { name: "rn" }, ...ctx },
    session: { id: `s${++n}`, startedAt: ts },
    events: events.map((e) => ({ id: `ev${++n}xxxxxxx`, ts, ...(e as object) })),
  };
  return ingest(JSON.stringify(env), "pk", { store, keys: { pk: "shop" } });
}
const rows = (store: MemoryStore, dim: string) => [...store.rollups.values()].filter((r) => r.dimension === dim).map((r) => [r.key, r.events, r.errors]);

beforeEach(() => {
  clearSettingsCache();
  clearAlertMemory();
});

describe("request timings", () => {
  it("rolls metric events into request counts and a latency histogram, without storing them", async () => {
    const store = new MemoryStore();
    const buckets = new Array(13).fill(0);
    buckets[latencyBucket(120)] = 8; // 200ms bucket
    buckets[latencyBucket(4200)] = 2; // 5s bucket
    expect((await send(store, [{ type: "metric", name: "http", key: "GET /v1/feed", count: 10, errors: 1, buckets }])).status).toBe(202);
    expect(rows(store, "requests")).toEqual([["GET /v1/feed", 10, 1]]);
    expect(rows(store, "latency").sort()).toEqual([["GET /v1/feed|2", 8, 0], ["GET /v1/feed|10", 2, 0]].sort());
    expect(store.events).toHaveLength(0);
    expect(percentileMs(buckets, 0.5)).toBe(200);
    expect(percentileMs(buckets, 0.95)).toBe(5000);
  });

  it("rejects malformed metric events", async () => {
    const store = new MemoryStore();
    expect((await send(store, [{ type: "metric", name: "http", key: "GET /x", count: 1, errors: 0, buckets: [1] }])).status).toBe(400);
  });
});

describe("steps, network and country", () => {
  it("rolls up step outcomes, and errors by network and country", async () => {
    const store = new MemoryStore();
    await send(
      store,
      [
        { type: "event", name: "auth.login.submit_otp", flow: "auth.login", step: "submit_otp", outcome: "failure" },
        { type: "event", name: "auth.login.submit_otp", flow: "auth.login", step: "submit_otp", outcome: "success" },
        { type: "error", error: { name: "Error", message: "x" } },
      ],
      { network: { type: "cellular" }, timezone: "Africa/Johannesburg", locale: "en-US" },
    );
    expect(rows(store, "flowStep").sort()).toEqual([["auth.login|submit_otp|failure", 1, 0], ["auth.login|submit_otp|success", 1, 0]]);
    expect(rows(store, "network")).toEqual([["cellular", 0, 1]]);
    expect(rows(store, "country")).toEqual([["ZA", 0, 1]]); // the timezone wins over an en-US locale
  });

  it("works out the country from timezone, then locale", () => {
    expect(countryOf({ timezone: "Europe/London", locale: "en-ZA" })).toBe("GB");
    expect(countryOf({ timezone: "Mars/Olympus", locale: "pt-BR" })).toBe("BR");
    expect(countryOf({})).toBe("unknown");
  });
});

describe("alerts", () => {
  const issue = { app: "shop", fingerprint: "abc", title: "TypeError: x", flow: "checkout.payment", culprit: "pay (src/pay.ts:3)", ts: "t", firstTs: "t", by: 1, lastEvent: {} as never, version: "2.4.0" };

  it("posts new and regressed issues to Slack, at most once an hour each", async () => {
    const posts: { url: string; text: string }[] = [];
    const post = async (url: string, body: unknown) => void posts.push({ url, text: (body as { text: string }).text });
    const issues = new Map([["abc", issue]]);
    const settings = { alerts: { slackWebhookUrl: HOOK, dashboardUrl: "https://debug.example" }, criticalFlows: ["checkout.payment"] };
    expect(await sendAlerts("shop", { created: ["abc"], regressed: [] }, issues, settings, post)).toBe(1);
    expect(posts[0]!.url).toBe(HOOK);
    expect(posts[0]!.text).toContain("New issue in *shop*: <https://debug.example/issues/abc?app=shop|TypeError: x>");
    expect(posts[0]!.text).toContain("flow `checkout.payment` (critical)");
    expect(await sendAlerts("shop", { created: ["abc"], regressed: [] }, issues, settings, post)).toBe(0); // within the hour
    expect(await sendAlerts("shop", { created: [], regressed: ["abc"] }, issues, settings, post)).toBe(1);
  });

  it("respects the switches, and never posts to a non-Slack URL", async () => {
    const posts: unknown[] = [];
    const post = async (_u: string, b: unknown) => void posts.push(b);
    const issues = new Map([["abc", { ...issue, flow: "feed.load" }]]);
    expect(await sendAlerts("shop", { created: ["abc"], regressed: [] }, issues, { alerts: { slackWebhookUrl: HOOK, newIssues: false } }, post)).toBe(0);
    expect(await sendAlerts("shop", { created: ["abc"], regressed: [] }, issues, { alerts: { slackWebhookUrl: HOOK, onlyCriticalFlows: true }, criticalFlows: ["checkout.payment"] }, post)).toBe(0);
    expect(await sendAlerts("shop", { created: ["abc"], regressed: [] }, issues, { alerts: { slackWebhookUrl: "https://evil.example/hook" } }, post)).toBe(0);
    expect(posts).toHaveLength(0);
  });
});

describe("settings for flows and alerts", () => {
  const put = (store: MemoryStore, body: unknown) => handleAdmin({ method: "PUT", path: "/admin/settings", body: JSON.stringify({ app: "shop", ...(body as object) }), authorization: `Bearer ${TOKEN}` }, { store, adminToken: TOKEN });

  it("validates critical flows and the webhook, and masks the webhook when read back", async () => {
    const store = new MemoryStore();
    expect((await put(store, { criticalFlows: ["Checkout Payment"] })).status).toBe(400);
    expect((await put(store, { alerts: { slackWebhookUrl: "http://169.254.169.254/latest" } })).status).toBe(400);
    expect((await put(store, {})).status).toBe(400);
    const ok = await put(store, { criticalFlows: ["checkout.payment"], alerts: { slackWebhookUrl: HOOK, regressions: false } });
    expect(ok.body.settings).toMatchObject({ criticalFlows: ["checkout.payment"], alerts: { slackWebhookUrl: "https://hooks.slack.com/…mnop", regressions: false } });
    // Saving the masked value back keeps the real one.
    await put(store, { alerts: { slackWebhookUrl: "https://hooks.slack.com/…mnop", newIssues: true } });
    expect((await store.getSettings("shop"))?.alerts?.slackWebhookUrl).toBe(HOOK);
    // Retention is untouched by these changes.
    expect((await store.getSettings("shop"))?.retentionDays).toBeUndefined();
  });
});
