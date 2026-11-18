import { describe, expect, it } from "vitest";
import type { EndpointsReport } from "./endpoints";
import { appTile, buildAppCode, buildHealth } from "./health";
import type { IssueRow, Summary } from "./queries";

const NOW = Date.parse("2026-11-18T12:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

const issue = (o: Partial<IssueRow>): IssueRow =>
  ({ fingerprint: "f", title: "TypeError: Cannot read property 'amount' of null", status: "open", severity: "medium", countRange: 1, count24h: 1, lastSeen: ago(30), labels: { category: "uncaught" }, ...o }) as IssueRow;

describe("the app code box", () => {
  it("takes its worst open crash or code error, leaving failed calls to the service boxes", () => {
    const t = appTile(
      [
        // In the summary's order: worst first.
        issue({ fingerprint: "b", severity: "high", countRange: 1, title: "Error: screen crashed" }),
        issue({ fingerprint: "a", severity: "medium", countRange: 3 }),
        issue({ fingerprint: "c", severity: "critical", labels: { category: "server" } as IssueRow["labels"] }),
        issue({ fingerprint: "d", severity: "critical", status: "resolved" }),
      ],
      NOW,
    );
    expect(t).toMatchObject({ kind: "app", level: "high", headline: "Error: screen crashed", measure: "2 crash or code errors open, 4 times", live: true });
  });

  it("leaves out errors made on purpose to test deBug", () => {
    expect(appTile([issue({ fingerprint: "t", severity: "high", test: true })], NOW)).toMatchObject({ level: "healthy" });
  });

  it("is green with nothing open", () => {
    expect(appTile([], NOW)).toMatchObject({ level: "healthy", measure: "No crashes or code errors", live: false });
  });
});

describe("buildHealth", () => {
  it("ranks every box worst first, counts the levels and writes the client answer", () => {
    const endpoints = {
      services: [
        { key: "promo", service: "promo", endpoints: 1, calls: 100, failedCalls: 0, failureRate: 0, worstP95: 300, failures: 0 },
        { key: "balance", service: "balance", endpoints: 1, calls: 164, failedCalls: 48, failureRate: 0.29, worstP95: 5000, failures: 34, lastFailure: ago(10) },
      ],
      endpoints: [],
    } as unknown as EndpointsReport;
    const summary = { app: "cell-c", apps: ["cell-c"], range: { label: "the last 14 days" }, retention: {}, issues: [], totals: { testIssues: 2 } } as unknown as Summary;
    const h = buildHealth(endpoints, summary, NOW);
    expect(h.folded).toEqual({ tests: 2 });
    expect(h.tiles.map((t) => [t.name, t.level])).toEqual([
      ["balance", "critical"],
      ["App code", "healthy"],
      ["promo", "healthy"],
    ]);
    expect(h.counts).toEqual({ critical: 1, high: 0, medium: 0, low: 0, healthy: 2 });
    expect(h.answer).toContain("1 part is failing badly in the last 14 days: balance.");
    expect(h.answer).toContain("2 of 3 parts are healthy.");
  });
});

describe("buildAppCode", () => {
  it("lists the app's own open issues, and keeps resolved or ignored ones apart", () => {
    const summary = {
      app: "cell-c",
      apps: ["cell-c"],
      range: { label: "the last 14 days" },
      retention: {},
      issues: [
        issue({ fingerprint: "a" }),
        issue({ fingerprint: "b", status: "resolved" }),
        issue({ fingerprint: "c", status: "ignored" }),
        issue({ fingerprint: "net", labels: { category: "server" } as IssueRow["labels"] }),
        issue({ fingerprint: "test", test: true }),
      ],
    } as unknown as Summary;
    const r = buildAppCode(summary, NOW);
    expect(r.open.map((i) => i.fingerprint)).toEqual(["a"]);
    expect(r.closed.map((i) => i.fingerprint)).toEqual(["b", "c"]);
    expect(r.tests.map((i) => i.fingerprint)).toEqual(["test"]);
    expect(r.tile).toMatchObject({ name: "App code", level: "medium" });
  });
});
