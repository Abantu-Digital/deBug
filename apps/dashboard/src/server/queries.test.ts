import { describe, expect, it } from "vitest";
import { MemoryStore } from "@debugkit/adapters/memory";
import { ingest } from "@debugkit/ingest";
import { DEFAULT_SEVERITY_THRESHOLDS } from "@debugkit/schema";
import { seedDemo } from "./demo";
import { buildIssueDetail, buildSummary } from "./queries";

describe("buildSummary", () => {
  it("tells the demo story: auth.login regression on 2.4.0 / android 14 is the critical issue", async () => {
    const store = await seedDemo();
    const s = (await buildSummary(store, undefined, DEFAULT_SEVERITY_THRESHOLDS))!;
    expect(s.app).toBe("megaton-native");
    expect(s.flows[0]?.flow).toBe("auth.login");
    expect(s.issues[0]?.severity).toBe("critical");
    expect(s.issues[0]?.culprit).toContain("handleOtpResponse");
    expect(s.narrative[0]).toMatch(/errors in the last 14 days/);
    expect(s.range).toMatchObject({ preset: "14d", days: 14, granularity: "day" });
    expect(s.trend).toHaveLength(14);
    // severity order is monotonic
    const order = { critical: 3, high: 2, medium: 1, low: 0 };
    for (let i = 1; i < s.issues.length; i++) expect(order[s.issues[i - 1]!.severity]).toBeGreaterThanOrEqual(order[s.issues[i]!.severity]);

    const d = (await buildIssueDetail(store, s.app, s.issues[0]!.fingerprint, DEFAULT_SEVERITY_THRESHOLDS))!;
    expect(d.hints.map((h) => h.title)).toEqual(expect.arrayContaining(["Concentrated on app version 2.4.0", "A value is missing when the code expects it"]));
    expect(d.issue.count24h).toBe(s.issues[0]!.count24h);
  });

  it("counts only the trailing 24h toward severity", async () => {
    const store = new MemoryStore();
    const now = Date.parse("2026-11-09T12:00:00Z");
    const send = async (ts: string, n: number) => {
      const events = Array.from({ length: n }, (_, i) => ({
        type: "error" as const,
        id: `evt_${ts}_${i}`.replace(/\W/g, ""),
        ts,
        flow: "auth.login",
        error: { name: "Error", message: "x", stack: "Error\n    at f (/app/src/a.ts:1:1)" },
      }));
      const env = { sdk: { name: "t", version: "1" }, context: { app: { id: "a" }, os: { name: "ios" }, runtime: { name: "rn" } }, session: { id: "s", startedAt: ts }, events };
      expect((await ingest(JSON.stringify(env), "k", { store, keys: { k: "a" }, now: () => new Date(ts) })).status).toBe(202);
    };
    await send("2026-11-08T06:00:00.000Z", 90); // 30h ago — outside the window
    await send("2026-11-09T10:00:00.000Z", 6); // 2h ago
    const s = (await buildSummary(store, "a", DEFAULT_SEVERITY_THRESHOLDS, now, { range: { range: "24h" } }))!;
    expect(s.issues[0]).toMatchObject({ count24h: 6, countRange: 6, countTotal: 96, severity: "medium" });
    expect(s.totals).toMatchObject({ errors24h: 6, errorsRange: 6, errorsPrev: 90 });
    expect(s.trend).toHaveLength(24); // hourly
  });
});

describe("date ranges", () => {
  const now = Date.parse("2026-11-13T12:00:00Z");
  async function seeded() {
    const store = new MemoryStore();
    const send = async (ts: string, n: number, msg = "x") => {
      const events = Array.from({ length: n }, (_, i) => ({ type: "error" as const, id: `evt_${ts}_${msg}_${i}`.replace(/\W/g, ""), ts, flow: "auth.login", error: { name: "Error", message: msg, stack: `Error\n    at ${msg} (/app/src/${msg}.ts:1:1)` } }));
      const env = { sdk: { name: "t", version: "1" }, context: { app: { id: "a" }, os: { name: "ios" }, runtime: { name: "rn" } }, session: { id: "s", startedAt: ts }, events };
      await ingest(JSON.stringify(env), "k", { store, keys: { k: "a" }, now: () => new Date(ts) });
    };
    await send("2026-11-12T09:00:00.000Z", 4, "recent"); // yesterday
    await send("2026-10-20T09:00:00.000Z", 7, "older"); // 24 days ago
    return store;
  }

  it("counts only the chosen days, and compares with the period before", async () => {
    const store = await seeded();
    const week = (await buildSummary(store, "a", DEFAULT_SEVERITY_THRESHOLDS, now, { range: { range: "7d" } }))!;
    expect(week.totals.errorsRange).toBe(4);
    expect(week.issues.map((i) => i.title)).toEqual(["Error: recent"]); // the older issue isn't in the last 7 days
    const month = (await buildSummary(store, "a", DEFAULT_SEVERITY_THRESHOLDS, now, { range: { range: "30d" } }))!;
    expect(month.totals.errorsRange).toBe(11);
    expect(month.issues).toHaveLength(2);
    const custom = (await buildSummary(store, "a", DEFAULT_SEVERITY_THRESHOLDS, now, { range: { range: "custom", from: "2026-10-15", to: "2026-10-25" } }))!;
    expect(custom.range).toMatchObject({ preset: "custom", days: 11, label: "15 Oct – 25 Oct" });
    expect(custom.totals.errorsRange).toBe(7);
    expect(custom.issues.map((i) => i.countRange)).toEqual([7]);
  });

  it("switches to weekly points past 90 days, and reports retention", async () => {
    const store = await seeded();
    await store.putSettings("a", { retentionDays: 60 });
    const s = (await buildSummary(store, "a", DEFAULT_SEVERITY_THRESHOLDS, now, { range: { range: "custom", from: "2026-06-01", to: "2026-11-13" } }))!;
    expect(s.range.granularity).toBe("week");
    expect(s.trend.length).toBeLessThanOrEqual(25);
    expect(s.trend.reduce((a, p) => a + p.errors, 0)).toBe(11);
    expect(s.retention).toMatchObject({ days: 60, source: "setting", detailsFrom: "2026-09-14" });
  });

  it("ignores nonsense ranges", async () => {
    const store = await seeded();
    const s = (await buildSummary(store, "a", DEFAULT_SEVERITY_THRESHOLDS, now, { range: { range: "custom", from: "nope", to: "2026-01-01" } }))!;
    expect(s.range.preset).toBe("14d");
  });
});
