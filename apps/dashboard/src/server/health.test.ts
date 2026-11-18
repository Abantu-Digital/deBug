import { describe, expect, it } from "vitest";
import type { EndpointsReport } from "./endpoints";
import { appTile, buildHealth } from "./health";
import type { IssueRow, Summary } from "./queries";

const NOW = Date.parse("2026-11-18T12:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

const issue = (o: Partial<IssueRow>): IssueRow =>
  ({ fingerprint: "f", title: "TypeError: Cannot read property 'amount' of null", status: "open", severity: "medium", countRange: 1, count24h: 1, lastSeen: ago(30), labels: { category: "uncaught" }, ...o }) as IssueRow;

describe("the app code box", () => {
  it("takes its worst open crash or code error, leaving failed calls to the service boxes", () => {
    const t = appTile(
      [
        issue({ fingerprint: "a", severity: "medium", countRange: 3 }),
        issue({ fingerprint: "b", severity: "high", countRange: 1, title: "Error: screen crashed" }),
        issue({ fingerprint: "c", severity: "critical", labels: { category: "server" } as IssueRow["labels"] }),
        issue({ fingerprint: "d", severity: "critical", status: "resolved" }),
      ],
      NOW,
    );
    expect(t).toMatchObject({ kind: "app", level: "high", headline: "Error: screen crashed", fingerprint: "b", measure: "2 crash or code errors open, 4 times", live: true });
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
    const summary = { app: "cell-c", apps: ["cell-c"], range: { label: "the last 14 days" }, retention: {}, issues: [] } as unknown as Summary;
    const h = buildHealth(endpoints, summary, NOW);
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
