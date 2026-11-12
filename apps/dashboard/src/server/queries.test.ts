import { describe, expect, it } from "vitest";
import { MemoryStore } from "@debug/adapters/memory";
import { ingest } from "@debug/ingest";
import { DEFAULT_SEVERITY_THRESHOLDS } from "@debug/schema";
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
    expect(s.narrative[0]).toMatch(/errors in the last 24 hours/);
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
    const s = (await buildSummary(store, "a", DEFAULT_SEVERITY_THRESHOLDS, now))!;
    expect(s.issues[0]).toMatchObject({ count24h: 6, countTotal: 96, severity: "medium" });
    expect(s.totals).toMatchObject({ errors24h: 6, errorsPrev24h: 90 });
  });
});
