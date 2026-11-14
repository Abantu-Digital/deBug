import { describe, expect, it } from "vitest";
import { CATEGORIES, parseStack, type Classification, type StoredEvent } from "@debugkit/schema";
import { classify } from "@debugkit/ingest";
import { resumeIncident } from "../../../../packages/ingest/src/fixtures/resume-incident";
import { stagingRequestStack } from "../../../../packages/schema/src/fixtures/staging-stack";
import { explain, explanationMarkdown, userAction } from "./explain";

const NOW = Date.parse("2026-11-14T13:05:00Z");

function stored(event: StoredEvent["event"], os = "ios"): StoredEvent {
  return { app: "cell-c", day: "2026-11-14", event, context: { app: { id: "cell-c", environment: "preview" }, os: { name: os }, runtime: { name: "react-native" }, device: { type: "phone" } }, sessionId: "s", receivedAt: "2026-11-14T13:00:01.400Z" };
}
const base = { count24h: 1, countRange: 1, rangeLabel: "the last 14 days", lastSeen: "2026-11-14T13:00:01.304Z", status: "open", now: NOW };

describe("explain: the Cell C staging getBalances failure", () => {
  const e = { ...resumeIncident[4]!, error: { ...resumeIncident[4]!.error, frames: parseStack(stagingRequestStack) } };
  const labels = classify(e);
  const x = explain({ ...base, labels, lastEvent: stored(e), culprit: "attemptApiRequest (main.jsbundle:235308)", users: 1, incidentTitle: "Requests failed on app resume (iOS)" });

  it("tells support what the user saw, why, whether it's still happening and who to pass it to", () => {
    expect(x.summary).toBe(
      "The getBalances request didn't load for 1 user on iPhone right after reopening the app (after pull to refresh). " +
        "The app had just been reopened and the phone hadn't reconnected yet, so the request never left the phone. Not a server outage. " +
        "It's still happening: last seen within the hour. Pass to: the app team.",
    );
  });

  it("gives developers the evidence, where, what started it and a fix", () => {
    expect(x.technical.headline).toBe("Request never sent · owner: App team · impact: Degraded");
    expect(x.technical.evidence).toEqual([
      "No HTTP status after 16 ms: too fast to have reached a server.",
      "The app came to the foreground 5.9 s before; no request has succeeded since.",
      "2 other requests failed in the 5 s before, across 2 hosts.",
      'Part of the incident "Requests failed on app resume (iOS)".',
    ]);
    expect(x.technical.where).toBe("`attemptApiRequest (main.jsbundle:235308)`, started by `_onRefresh` (pull to refresh)");
    expect(x.technical.fix).toMatch(/NetInfo `isConnected` on AppState `active`/);
  });

  it("copies as Markdown for a ticket", () => {
    const md = explanationMarkdown("NetworkError: POST …/getBalances failed", x, "https://debug.example/issues/fp?app=cell-c");
    expect(md).toContain("### What happened");
    expect(md).toContain("### For developers");
    expect(md).toContain("**Suggested fix:**");
    expect(md).toContain("deBug: https://debug.example/issues/fp?app=cell-c");
  });
});

describe("explain: every category reads cleanly", () => {
  it.each(CATEGORIES)("%s", (category) => {
    const labels: Classification = { category, owner: "unknown", impact: "degraded", causes: [] };
    const request = category.startsWith("network.") || ["server", "auth", "client_request"].includes(category) ? { method: "GET", url: "api.x/v1/orders/:id", durationMs: 40 } : undefined;
    const event = { id: "evt-000001", ts: "2026-11-14T13:00:00Z", type: "error" as const, handled: true, error: { name: "Error", message: "x" }, request };
    const x = explain({ ...base, labels, lastEvent: stored(event, "android") });
    for (const text of [x.summary, x.technical.headline, x.technical.fix, ...x.technical.evidence]) {
      expect(text).not.toMatch(/undefined|NaN|\[object/);
      expect(text.length).toBeGreaterThan(10);
    }
    expect(x.summary).toMatch(/Pass to: .+\.$/);
    if (request) expect(x.summary).toMatch(/^The orders request /);
  });

  it("says when it's fixed, ignored or quiet", () => {
    const labels: Classification = { category: "server", owner: "backend", impact: "degraded", causes: [] };
    expect(explain({ ...base, labels, status: "resolved" }).summary).toContain("It's marked fixed.");
    expect(explain({ ...base, labels, count24h: 0, countRange: 3 }).summary).toContain("It hasn't happened in the last 24 hours (3 times in the last 14 days).");
    expect(explain({ ...base, labels, count24h: 4, lastSeen: "2026-11-14T09:00:00Z" }).summary).toContain("It happened 4 times in the last 24 hours.");
  });
});

describe("userAction", () => {
  it("names what the user did from the handler, skipping library frames", () => {
    expect(userAction(parseStack(stagingRequestStack))).toEqual({ fn: "_onRefresh", action: "pull to refresh" });
    expect(userAction(parseStack("Error: x\n    at onPressBuy (main.jsbundle:1:1)"))).toEqual({ fn: "onPressBuy" });
    expect(userAction(parseStack("Error: x\n    at loadProfile (main.jsbundle:1:1)"))).toBeUndefined();
  });
});
