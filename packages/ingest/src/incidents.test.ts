import { describe, expect, it } from "vitest";
import type { Classification } from "@debugkit/schema";
import { assignIncidents, incidentKey, parseIncidentKey, type BatchError } from "./incidents";

const labels = (over: Partial<Classification> = {}): Classification => ({ category: "network.never_sent", owner: "app", impact: "degraded", causes: [], ...over });

describe("incident keys", () => {
  it("are cause, category and OS: no fingerprint, so they survive new builds", () => {
    expect(incidentKey(labels({ causes: ["resumed_from_background", "burst"] }), "iOS")).toBe("resumed_from_background|network.never_sent|ios");
    expect(parseIncidentKey("resumed_from_background|network.never_sent|ios")).toEqual({ cause: "resumed_from_background", category: "network.never_sent", os: "ios" });
  });

  it("prefer resumed over burst, and only make a burst an incident for requests", () => {
    expect(incidentKey(labels({ category: "server", causes: ["burst"] }), "android")).toBe("burst|server|android");
    expect(incidentKey(labels({ category: "app_reported", causes: ["burst"] }), "android")).toBeUndefined();
    expect(incidentKey(labels({ category: "screen_crash", causes: ["resumed_from_background"] }), "ios")).toBe("resumed_from_background|screen_crash|ios");
  });

  it("need a grouping cause", () => {
    expect(incidentKey(labels({ causes: ["new_in_release", "slow_network"] }), "ios")).toBeUndefined();
  });
});

describe("assignIncidents", () => {
  const at = (s: number) => new Date(Date.UTC(2026, 10, 14, 12, 0, s)).toISOString();

  it("pulls the first failure of a burst in: it couldn't know the others were coming", () => {
    const batch: BatchError[] = [
      { ts: at(0), labels: labels({ category: "server" }) },
      { ts: at(2), labels: labels({ category: "server", causes: ["burst"] }) },
      { ts: at(3), labels: labels({ category: "server", causes: ["burst"] }) },
    ];
    assignIncidents(batch, "android");
    expect(batch.map((b) => b.incident)).toEqual(["burst|server|android", "burst|server|android", "burst|server|android"]);
  });

  it("leaves out errors of another category, or more than 5 s before", () => {
    const batch: BatchError[] = [
      { ts: at(0), labels: labels({ category: "server" }) },
      { ts: at(1), labels: labels({ category: "network.failed" }) },
      { ts: at(6), labels: labels({ category: "server", causes: ["burst"] }) },
    ];
    assignIncidents(batch, "android");
    expect(batch.map((b) => b.incident)).toEqual([undefined, undefined, "burst|server|android"]);
  });
});
