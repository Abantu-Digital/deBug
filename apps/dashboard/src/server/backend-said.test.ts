import { describe, expect, it } from "vitest";
import { classify } from "@debugkit/ingest";
import type { StoredEvent } from "@debugkit/schema";
import { backendSaid, saidBy } from "./backend-said";
import { explain, type ExplainIssue } from "./explain";

const NOW = Date.parse("2026-11-18T12:00:00Z");
const URL = "2qpssug3bh.execute-api.af-south-1.amazonaws.com/ppd/api/balance/getBalances";
const hosts = [{ match: "2qpssug3bh.execute-api.af-south-1.amazonaws.com/ppd/api/balance", name: "balance" }];

function failed(id: string, status: number, body?: unknown, crumb?: Record<string, unknown>): StoredEvent {
  return {
    app: "cell-c",
    day: "2026-11-18",
    sessionId: "s",
    receivedAt: "2026-11-18T11:00:00Z",
    context: { app: { id: "cell-c" }, os: { name: "android" }, runtime: { name: "react-native" }, device: { type: "phone" } },
    event: {
      type: "error",
      id,
      ts: "2026-11-18T11:00:00.000Z",
      handled: true,
      error: { name: "HttpError", message: `POST ${URL} responded ${status}` },
      request: { method: "POST", url: URL, status, durationMs: 800 },
      ...(body !== undefined ? { response: { status, body: typeof body === "string" ? body : JSON.stringify(body) } } : {}),
      breadcrumbs: crumb ? [{ ts: "2026-11-18T10:59:59.500Z", category: "network", level: "error", message: "balance failed", data: { method: "POST", path: "/ppd/api/balance/getBalances", status, ...crumb } }] : [],
    },
  } as unknown as StoredEvent;
}

const balance404 = (id: string) => failed(id, 404, { title: "Balance lookup unsuccessful", status: 404, code: 30007, traceId: "e23b0b7d-b0ab" });
const issue: ExplainIssue = { count24h: 14, countRange: 14, lastSeen: "2026-11-18T11:00:00Z", status: "open" };

describe("what the backend said (ABA-161)", () => {
  it("reads the code, message and trace from a Problem Details body", () => {
    expect(saidBy(balance404("1"), hosts)).toEqual({ status: 404, code: "30007", message: "Balance lookup unsuccessful", traceId: "e23b0b7d-b0ab", service: "balance" });
  });

  it("prefers the app's own breadcrumb for the call, and counts codes across occurrences", () => {
    const fromCrumb = failed("3", 404, "not json", { backendCode: "30007", backendTitle: "Balance lookup unsuccessful", traceId: "t-3" });
    const said = backendSaid([fromCrumb, balance404("2"), balance404("1")], hosts);
    expect(said).toMatchObject({ message: "Balance lookup unsuccessful", code: "30007", traceId: "t-3", codes: [{ key: "30007", count: 3 }] });
  });

  it("masks phone numbers and emails, and drops quotes and Markdown, before anything is quoted", () => {
    const said = saidBy(failed("1", 404, { message: 'The subscriber 625202607 does not "exist" *now*', code: "x`y" }), hosts);
    expect(said?.message).toBe("The subscriber ••• does not 'exist' now");
    expect(said?.code).toBeUndefined();
    expect(saidBy(failed("1", 404, { message: 625202607 }), hosts)).toBeUndefined();
  });

  it("doesn't take a gateway's stock words for the service's reason", () => {
    expect(backendSaid([failed("1", 500, { message: "Internal server error" })], hosts)).toBeUndefined();
    expect(backendSaid([failed("1", 403, { message: "Missing Authentication Token" })], hosts)).toBeUndefined();
  });

  it("has nothing when the backend gave no reason of its own", () => {
    expect(backendSaid([failed("1", 400, { ok: false })], hosts)).toBeUndefined();
    expect(backendSaid([failed("1", 400)], hosts)).toBeUndefined();
  });
});

describe("explain leads with what the backend said", () => {
  it("a 4xx with the backend's title: its words, not a guess at an invalid request", () => {
    const e = balance404("1");
    const x = explain({ issue, labels: classify(e.event as never), lastEvent: e, users: 1, hosts, rangeLabel: "the last 14 days", backend: backendSaid([e, balance404("2")], hosts), now: NOW });
    expect(x.summary).toMatch(/^The balance service answered 404 "Balance lookup unsuccessful" \(code 30007\) for 1 user on Android\. That's the service's own reason: start there\./);
    expect(x.summary).not.toMatch(/invalid/);
    expect(x.technical.evidence[0]).toBe('HTTP 404, and the backend\'s own answer: "Balance lookup unsuccessful" (code 30007), trace `e23b0b7d-b0ab`.');
    expect(x.technical.evidence[1]).toBe("Backend codes in recent occurrences: 30007 × 2.");
    expect(x.technical.fix).toMatch(/^Search the balance logs for code 30007 or trace e23b0b7d-b0ab at the times above/);
    expect(x.summary).toMatch(/Pass to: whoever runs the balance service, with code 30007 and trace e23b0b7d-b0ab\.$/);
  });

  it("a sign-in refusal keeps the app's side of the advice", () => {
    const e = failed("1", 401, { title: "Session expired", code: "AUTH_01" });
    const x = explain({ issue, labels: classify(e.event as never), lastEvent: e, hosts, rangeLabel: "the last 14 days", backend: backendSaid([e], hosts), now: NOW });
    expect(x.technical.fix).toMatch(/^Search the balance logs for code AUTH_01/);
    expect(x.technical.fix).toMatch(/token/i);
  });

  it("a 5xx with only a code in the body", () => {
    const e = failed("1", 502, { code: "UPSTREAM_DOWN" });
    const x = explain({ issue, labels: classify(e.event as never), lastEvent: e, hosts, rangeLabel: "the last 14 days", backend: backendSaid([e], hosts), now: NOW });
    expect(x.summary).toMatch(/^The balance service answered 502 \(code UPSTREAM_DOWN\)\./);
    expect(x.technical.fix).toMatch(/^Search the balance logs for code UPSTREAM_DOWN/);
  });

  it("a 4xx with neither keeps today's wording", () => {
    const e = failed("1", 400);
    const x = explain({ issue, labels: classify(e.event as never), lastEvent: e, hosts, rangeLabel: "the last 14 days", backend: backendSaid([e], hosts), now: NOW });
    expect(x.summary).toMatch(/were rejected\. The server refused what the app sent as invalid\./);
  });
});
