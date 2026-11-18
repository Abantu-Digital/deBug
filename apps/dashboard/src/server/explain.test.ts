import { describe, expect, it } from "vitest";
import { CATEGORIES, parseStack, type Classification, type StoredEvent } from "@debugkit/schema";
import { classify } from "@debugkit/ingest";
import { resumeIncident } from "../../../../packages/ingest/src/fixtures/resume-incident";
import { stagingRequestStack } from "../../../../packages/schema/src/fixtures/staging-stack";
import { explain, explanationMarkdown, thingOf, userAction, type ExplainIssue } from "./explain";

const NOW = Date.parse("2026-11-14T13:05:00Z");

function stored(event: StoredEvent["event"], os = "ios", model?: string): StoredEvent {
  return {
    app: "cell-c",
    day: "2026-11-14",
    event,
    context: { app: { id: "cell-c", environment: "preview" }, os: { name: os }, runtime: { name: "react-native" }, device: { type: "phone", model } },
    sessionId: "s",
    receivedAt: "2026-11-14T13:00:01.400Z",
  };
}
const issue: ExplainIssue = { count24h: 1, countRange: 1, lastSeen: "2026-11-14T13:00:01.304Z", status: "open" };
const base = { issue, rangeLabel: "the last 14 days", now: NOW };

describe("explain: the Cell C staging getBalances failure", () => {
  const e = { ...resumeIncident[4]!, error: { ...resumeIncident[4]!.error, frames: parseStack(stagingRequestStack) } };
  const labels = classify(e);
  const x = explain({
    ...base,
    issue: { ...issue, culprit: "attemptApiRequest (main.jsbundle:235308)", incidentTitle: "Requests failed on app resume (iOS)" },
    labels,
    lastEvent: stored(e),
    users: 1,
    durations: [16, 3, 49],
  });

  it("tells support what the user saw, in plain words, why, whether it's still happening and who to pass it to", () => {
    expect(x.summary).toBe(
      "Balances didn't load for 1 user on iPhone right after reopening the app (after pull to refresh). " +
        "The app had just been reopened and the phone hadn't reconnected yet. Not a server outage. " +
        "Several requests failed at the same moment. " +
        "It's still happening: last seen within the hour. Pass to: app team.",
    );
  });

  it("gives developers the evidence across occurrences, where, what started it and a fix", () => {
    expect(x.technical.headline).toBe("Request never sent · owner: App team · impact: Degraded");
    expect(x.technical.evidence).toEqual([
      "No HTTP status after 3–49 ms: too fast to have reached a server.",
      "Request: `POST api-b.example.com/api/balance/getBalances`.",
      "The app came to the foreground 5.9 s before; no request has succeeded since.",
      "2 other requests failed in the 5 s before, across 2 hosts.",
      'Part of the incident "Requests failed on app resume (iOS)".',
    ]);
    expect(x.technical.where).toBe("`attemptApiRequest (main.jsbundle:235308)`, started by `_onRefresh` (pull to refresh)");
    expect(x.technical.fix).toMatch(/NetInfo `isConnected` on AppState `active`/);
  });

  it("copies as Markdown for a ticket, link first", () => {
    const md = explanationMarkdown("NetworkError: POST …/getBalances failed", x, "https://debug.example/issues/fp?app=cell-c");
    expect(md.split("\n").slice(0, 3)).toEqual(["## NetworkError: POST …/getBalances failed", "", "deBug: https://debug.example/issues/fp?app=cell-c"]);
    expect(md).toContain("### What happened");
    expect(md).toContain("### For developers");
    expect(md).toContain("**General advice:**");
  });
});

describe("explain: every category reads cleanly", () => {
  it.each(CATEGORIES)("%s", (category) => {
    const labels: Classification = { category, owner: "unknown", impact: "degraded", causes: [] };
    const request = category.startsWith("network.") || ["server", "auth", "client_request"].includes(category) ? { method: "GET", url: "api.x/v1/orders/:id" } : undefined;
    const event = { id: "evt-000001", ts: "2026-11-14T13:00:00Z", type: "error" as const, handled: true, error: { name: "Error", message: "x" }, request };
    const x = explain({ ...base, labels, lastEvent: stored(event, "android"), users: 3 });
    for (const text of [x.summary, x.technical.headline, x.technical.fix, ...x.technical.evidence]) {
      expect(text).not.toMatch(/undefined|NaN|\[object|0 ms/);
      expect(text.length).toBeGreaterThan(10);
    }
    expect(x.summary).toMatch(/Pass to: .+\.$/);
    // 3 users, platforms not given: don't claim they were all on Android.
    expect(x.summary).not.toContain("Android");
    // The offline issue spans every call the phone couldn't make, so it isn't named after one.
    if (request && category !== "network.offline") expect(x.summary).toMatch(/^Orders /);
  });

  it("adds a line for every cause, in the summary and the fix", () => {
    const labels: Classification = { category: "server", owner: "backend", impact: "degraded", causes: ["burst", "slow_network", "new_in_release", "regressed", "single_device"] };
    const x = explain({ ...base, labels, lastEvent: stored({ id: "evt-000002", ts: "2026-11-14T13:00:00Z", type: "error", handled: true, error: { name: "HttpError", message: "x" }, request: { method: "GET", url: "api.x/v1/feed", status: 503 } }, "android", "SM-A105F") });
    expect(x.summary).toContain("Several requests failed at the same moment.");
    expect(x.summary).toContain("The connection was slow.");
    expect(x.summary).toContain("It started in the latest version of the app.");
    expect(x.summary).toContain("It was marked fixed, but it has come back.");
    expect(x.summary).toContain("It's only been seen on one phone model (SM-A105F).");
    expect(x.technical.fix).toContain("Reproduce on that model first.");
    expect(x.technical.fix).toContain("The earlier fix didn't hold");
  });

  it("names platforms when they're known for everyone", () => {
    const labels: Classification = { category: "server", owner: "backend", impact: "degraded", causes: [] };
    expect(explain({ ...base, labels, users: 40, platforms: ["ios", "android"] }).summary).toMatch(/for 40 users on iPhone and Android\./);
  });

  it("says when it's fixed, ignored or quiet", () => {
    const labels: Classification = { category: "server", owner: "backend", impact: "degraded", causes: [] };
    expect(explain({ ...base, labels, issue: { ...issue, status: "resolved" } }).summary).toContain("It's marked fixed.");
    expect(explain({ ...base, labels, issue: { ...issue, count24h: 0, countRange: 3 } }).summary).toContain("It hasn't happened in the last 24 hours (3 times in the last 14 days).");
    expect(explain({ ...base, labels, issue: { ...issue, count24h: 4, lastSeen: "2026-11-14T09:00:00Z" } }).summary).toContain("It happened 4 times in the last 24 hours.");
  });
});

describe("plain words", () => {
  it("names the thing a request was for", () => {
    expect(thingOf("api-b.example.com/api/balance/getBalances")).toBe("balances");
    expect(thingOf("api-b.example.com/api/balance/getDetailedSummary")).toBe("detailed summary");
    expect(thingOf("api-a.example.com/api/app-force-update")).toBe("app force update");
    expect(thingOf("api.x/v1/orders/:id")).toBe("orders");
    expect(thingOf("api.x")).toBeUndefined();
  });

  it("names what the user did from a known handler only", () => {
    expect(userAction(parseStack(stagingRequestStack))).toEqual({ fn: "_onRefresh", action: "pull to refresh" });
    expect(userAction(parseStack("Error: x\n    at onPressBuy (main.jsbundle:1:1)"))).toEqual({ fn: "onPressBuy", action: "a tap" });
    expect(userAction(parseStack("Error: x\n    at handleResponse (main.jsbundle:1:1)"))).toBeUndefined();
    expect(userAction(parseStack("Error: x\n    at onLayout (main.jsbundle:1:1)"))).toBeUndefined();
  });
});

describe("explain: host names from Settings", () => {
  const hosts = [{ match: "api-b.example.com/api/balance", name: "Balance service", owner: "backend" as const }];

  it("names the service in the summary and the request line", () => {
    const e = resumeIncident[4]!;
    const x = explain({ ...base, labels: classify(e, { hosts }), lastEvent: stored(e), users: 1, hosts });
    expect(x.summary).toMatch(/^Balances \(Balance service\) didn't load for 1 user on iPhone/);
    expect(x.summary).toMatch(/Pass to: app team\.$/); // never sent: still the app's, whoever owns the host
    expect(x.technical.evidence).toContain("Request: `POST api-b.example.com/api/balance/getBalances` (Balance service).");
  });

  it("passes server errors to the host's owner, by name", () => {
    const e = {
      ...resumeIncident[4]!,
      error: { name: "HttpError", message: "POST api-b.example.com/api/balance/getBalances responded 503" },
      request: { method: "POST", url: "api-b.example.com/api/balance/getBalances", status: 503, durationMs: 220 },
      breadcrumbs: [],
    };
    const x = explain({ ...base, labels: classify(e, { hosts }), lastEvent: stored(e), hosts });
    expect(x.summary).toMatch(/^Balances \(Balance service\) failed with a server error\./);
    expect(x.summary).toMatch(/Pass to: backend team \(Balance service\)\.$/);
  });
});

describe("explain: the offline issue (ABA-132)", () => {
  it("passes it to the app team with no endpoint to blame", () => {
    const labels: Classification = { category: "network.offline", owner: "unknown", impact: "degraded", causes: [] };
    const event = { id: "evt-000002", ts: "2026-11-14T13:00:00Z", type: "error" as const, handled: true, error: { name: "NetworkError", message: "x" }, request: { method: "GET", url: "api.x/v1/orders/:id", durationMs: 20 } };
    const x = explain({ ...base, labels, lastEvent: stored(event, "android"), users: 3 });
    expect(x.summary).toMatch(/^Requests never left the phone/);
    expect(x.summary).toContain("Pass to: app team, to handle being offline. No endpoint or server is at fault.");
    expect(x.technical.evidence.join(" ")).not.toContain("Request:");
  });
});
