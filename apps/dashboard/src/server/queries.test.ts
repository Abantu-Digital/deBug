import { describe, expect, it } from "vitest";
import { MemoryStore } from "@debugkit/adapters/memory";
import { ingest } from "@debugkit/ingest";
import { DEFAULT_SEVERITY_THRESHOLDS } from "@debugkit/schema";
import { seedDemo } from "./demo";
import { buildIssueDetail, buildSummary, issueLabels } from "./queries";

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

describe("who and when", () => {
  const now = Date.parse("2026-11-13T12:00:00Z");
  async function app() {
    const store = new MemoryStore();
    let n = 0;
    const send = async (ts: string, user: string, version: string, opts: { error?: string; crash?: boolean } = {}) => {
      const events: unknown[] = [{ type: "session", id: `s${++n}xxxxxxxx`, ts, status: "started" }];
      if (opts.error) events.push({ type: "error", id: `e${++n}xxxxxxxx`, ts, error: { name: "TypeError", message: opts.error, stack: `TypeError\n    at ${opts.error} (/app/src/${opts.error}.ts:1:1)` } });
      if (opts.crash) events.push({ type: "session", id: `c${++n}xxxxxxxx`, ts, status: "crashed" });
      const env = { sdk: { name: "t", version: "1" }, context: { app: { id: "a", version }, os: { name: "ios" }, runtime: { name: "rn" } }, user: { id: user, anonymousId: user }, session: { id: `x${n}`, startedAt: ts }, events };
      await ingest(JSON.stringify(env), "k", { store, keys: { k: "a" }, now: () => new Date(ts) });
    };
    await send("2026-11-05T09:00:00.000Z", "u1", "2.3.0", { error: "old" });
    await send("2026-11-10T09:00:00.000Z", "u2", "2.4.0", { error: "fresh", crash: true });
    await send("2026-11-12T09:00:00.000Z", "u3", "2.4.0");
    await send("2026-11-12T10:00:00.000Z", "u4", "2.4.0", { error: "fresh" });
    return store;
  }

  it("reports users, crash-free users and release markers for the range", async () => {
    const s = (await buildSummary(await app(), "a", DEFAULT_SEVERITY_THRESHOLDS, now, { range: { range: "7d" } }))!;
    expect(s.health).toMatchObject({ users: 3, crashedUsers: 1 });
    expect(s.health.crashFreeUsersRate).toBeCloseTo(2 / 3);
    expect(s.latestVersion).toBe("2.4.0");
    expect(s.releases.map((r) => [r.release, r.firstDay])).toEqual([["2.4.0", "2026-11-10"]]); // 2.3.0 first appeared before the range
    const fresh = s.issues.find((i) => i.title === "TypeError: fresh")!;
    expect(fresh).toMatchObject({ newInLatest: true, firstVersion: "2.4.0", users: 2, status: "open" });
  });

  it("leaves ignored and resolved issues out of the story", async () => {
    const store = await app();
    const fresh = [...store.issues.values()].find((i) => i.title === "TypeError: fresh")!;
    await store.setIssueStatus("a", fresh.fingerprint, { status: "ignored" });
    const s = (await buildSummary(store, "a", DEFAULT_SEVERITY_THRESHOLDS, now, { range: { range: "30d" } }))!;
    expect(s.issues.find((i) => i.fingerprint === fresh.fingerprint)?.status).toBe("ignored");
    expect(s.totals.activeIssues).toBe(1);
    expect(s.narrative.join(" ")).not.toContain("TypeError: fresh");
  });

  it("builds a prefilled ticket for Linear and GitHub", async () => {
    const store = await app();
    const fresh = [...store.issues.values()].find((i) => i.title === "TypeError: fresh")!;
    const d = (await buildIssueDetail(store, "a", fresh.fingerprint, DEFAULT_SEVERITY_THRESHOLDS, now, { range: { range: "7d" }, trackers: { linearTeam: "ABA", githubRepo: "Abantu-Digital/deBug", dashboardUrl: "https://debug.example" } }))!;
    expect(d.affectedUsers).toBe(2);
    const linear = new URL(d.links.linear!);
    expect(linear.origin + linear.pathname).toBe("https://linear.app/team/ABA/new");
    expect(linear.searchParams.get("title")).toBe("[deBug] TypeError: fresh");
    expect(linear.searchParams.get("description")).toContain("2 users affected");
    expect(linear.searchParams.get("description")).toContain(`https://debug.example/issues/${fresh.fingerprint}?app=a`);
    expect(d.links.github).toMatch(/^https:\/\/github\.com\/Abantu-Digital\/deBug\/issues\/new\?/);
    const none = (await buildIssueDetail(store, "a", fresh.fingerprint, DEFAULT_SEVERITY_THRESHOLDS, now))!;
    expect(none.links).toEqual({});
  });
});

describe("where and how much", () => {
  const now = Date.parse("2026-11-13T12:00:00Z");
  it("reports step failure rates, endpoint percentiles, network and country, and bumps critical flows", async () => {
    const store = new MemoryStore();
    const ts = "2026-11-13T09:00:00.000Z";
    const buckets = new Array(13).fill(0);
    buckets[1] = 9; // ≤100ms
    buckets[8] = 1; // ≤2000ms
    const events = [
      { type: "event", id: "evt_000000001", ts, name: "checkout.payment.charge", flow: "checkout.payment", step: "charge", outcome: "failure" },
      { type: "event", id: "evt_000000002", ts, name: "checkout.payment.charge", flow: "checkout.payment", step: "charge", outcome: "success" },
      { type: "event", id: "evt_000000003", ts, name: "checkout.payment.charge", flow: "checkout.payment", step: "charge", outcome: "success" },
      { type: "error", id: "evt_000000004", ts, flow: "checkout.payment", error: { name: "Error", message: "declined", stack: "Error\n    at charge (/app/src/pay.ts:1:1)" } },
      { type: "metric", id: "evt_000000005", ts, name: "http", key: "POST /v1/pay", count: 10, errors: 1, buckets },
    ];
    const env = { sdk: { name: "t", version: "1" }, context: { app: { id: "a" }, os: { name: "ios" }, runtime: { name: "rn" }, network: { type: "cellular" }, timezone: "Africa/Johannesburg" }, session: { id: "s", startedAt: ts }, events };
    await ingest(JSON.stringify(env), "k", { store, keys: { k: "a" }, now: () => new Date(ts) });

    const plain = (await buildSummary(store, "a", DEFAULT_SEVERITY_THRESHOLDS, now, { range: { range: "7d" } }))!;
    expect(plain.steps).toEqual([{ flow: "checkout.payment", step: "charge", successes: 2, failures: 1, abandoned: 0, failureRate: 1 / 3 }]);
    expect(plain.timings).toEqual([{ endpoint: "POST /v1/pay", requests: 10, failed: 1, errorRate: 0.1, p50: 100, p95: 2000 }]);
    expect(plain.breakdowns.network).toEqual([{ key: "cellular", errors: 1 }]);
    expect(plain.breakdowns.country).toEqual([{ key: "ZA", errors: 1 }]);
    expect(plain.issues[0]!.severity).toBe("low");

    await store.putSettings("a", { criticalFlows: ["checkout.payment"] });
    const bumped = (await buildSummary(store, "a", DEFAULT_SEVERITY_THRESHOLDS, now, { range: { range: "7d" } }))!;
    expect(bumped.issues[0]!.severity).toBe("medium");
    expect(bumped.flows[0]).toMatchObject({ flow: "checkout.payment", critical: true });
    expect(bumped.narrative.join(" ")).toContain("checkout.payment (a critical flow)");
  });
});

describe("labels", () => {
  it("ingest labels the staging resume incident, and the summary shows the labels and breakdowns", async () => {
    const { resumeIncident } = await import("../../../../packages/ingest/src/fixtures/resume-incident");
    const store = new MemoryStore();
    const ts = resumeIncident[0]!.ts;
    const env = {
      sdk: { name: "t", version: "1" },
      context: { app: { id: "cell-c", version: "10.1.29" }, os: { name: "ios", version: "27.3" }, runtime: { name: "react-native" }, device: { model: "iPhone 16 Pro Max" } },
      session: { id: "s", startedAt: ts },
      events: resumeIncident,
    };
    const last = resumeIncident[resumeIncident.length - 1]!.ts;
    expect((await ingest(JSON.stringify(env), "k", { store, keys: { k: "cell-c" }, now: () => new Date(last) })).status).toBe(202);

    const s = (await buildSummary(store, "cell-c", DEFAULT_SEVERITY_THRESHOLDS, Date.parse(last)))!;
    expect(s.issues).toHaveLength(4);
    for (const i of s.issues) expect(i.labels).toMatchObject({ category: "network.never_sent", owner: "app", impact: "degraded" });
    expect(s.issues.every((i) => i.labels!.causes.includes("resumed_from_background"))).toBe(true);
    expect(s.breakdowns.category).toEqual([{ key: "network.never_sent", errors: 6 }]);
    expect(s.breakdowns.owner).toEqual([{ key: "app", errors: 6 }]);
    expect(s.breakdowns.impact).toEqual([{ key: "degraded", errors: 6 }]);
  });

  it("works out labels for issues stored before the classifier existed, and adds the issue's causes", async () => {
    const { resumeIncident } = await import("../../../../packages/ingest/src/fixtures/resume-incident");
    const event = resumeIncident[5]!;
    const old = {
      app: "cell-c",
      fingerprint: "fp",
      title: "t",
      firstSeen: event.ts,
      lastSeen: event.ts,
      count: 1,
      status: "regressed" as const,
      firstVersion: "10.1.29",
      // No labels: stored by an older ingest.
      lastEvent: { app: "cell-c", day: "2026-11-14", fingerprint: "fp", event, context: { app: { id: "cell-c" }, os: { name: "ios" }, runtime: { name: "rn" }, device: {} }, sessionId: "s", receivedAt: event.ts },
    };
    expect(issueLabels(old as never, "10.1.29")).toEqual({
      category: "network.never_sent",
      owner: "app",
      impact: "degraded",
      causes: ["resumed_from_background", "burst", "new_in_release", "regressed"],
    });
  });

  it("shows the same labels on the issue page as in the list", async () => {
    const store = await seedDemo();
    const s = (await buildSummary(store, undefined, DEFAULT_SEVERITY_THRESHOLDS))!;
    for (const i of s.issues) expect(i.labels?.category).toBeTruthy();
    const d = (await buildIssueDetail(store, s.app, s.issues[0]!.fingerprint, DEFAULT_SEVERITY_THRESHOLDS))!;
    expect(d.issue.labels?.category).toBe(s.issues[0]!.labels?.category);
  });
});
