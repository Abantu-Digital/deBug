import { describe, expect, it } from "vitest";
import type { Breadcrumb, ErrorEvent } from "@debugkit/schema";
import { classify, issueCauses, withIssueCauses } from "./classify";
import { resumeIncident } from "./fixtures/resume-incident";

const TS = "2026-11-14T10:00:10.000Z";
const at = (secondsBefore: number) => new Date(Date.parse(TS) - secondsBefore * 1000).toISOString();

function err(over: Partial<ErrorEvent> = {}): ErrorEvent {
  return { id: "evt-00000001", ts: TS, type: "error", handled: true, error: { name: "Error", message: "boom" }, ...over } as ErrorEvent;
}
const net = (method: string, url: string, status: number | null, ms: number, secondsBefore: number, level?: Breadcrumb["level"]): Breadcrumb => ({
  ts: at(secondsBefore),
  category: "network",
  message: `${method} ${url} → ${status ?? "failed"} (${ms}ms)`,
  level: level ?? (status === null || status >= 500 ? "error" : "info"),
  data: { status, durationMs: ms },
});
const ui = (message: string, secondsBefore: number): Breadcrumb => ({ ts: at(secondsBefore), category: "ui", message, level: "info" });
const failed = (url: string, durationMs: number, message = `GET ${url} failed`) =>
  err({ handled: true, tags: { source: "network" }, error: { name: "NetworkError", message }, request: { method: "GET", url, durationMs } });
const http = (status: number) =>
  err({ tags: { source: "network" }, error: { name: "HttpError", message: `GET api.x/v1/me responded ${status}` }, request: { method: "GET", url: "api.x/v1/me", status, durationMs: 120 } });

describe("classify: the Cell C staging resume incident", () => {
  const labels = resumeIncident.map((e) => classify(e));

  it("labels all six failures as requests the app sent before the phone reconnected", () => {
    for (const l of labels) expect(l).toMatchObject({ category: "network.never_sent", owner: "app", impact: "degraded" });
  });

  it("ties every one of them to reopening the app, even the one 5.9 s later", () => {
    for (const l of labels) expect(l.causes).toContain("resumed_from_background");
  });

  it("sees the burst from the second failure on, never the first", () => {
    expect(labels.map((l) => l.causes.includes("burst"))).toEqual([false, true, true, true, true, true]);
  });

  it("matches the worked example in docs/taxonomy.md (getBalances, 16 ms)", () => {
    const e = resumeIncident.find((x) => x.request!.url.endsWith("getBalances"))!;
    expect(classify(e)).toEqual({ category: "network.never_sent", owner: "app", impact: "degraded", causes: ["resumed_from_background", "burst"] });
  });
});

describe("classify: categories, in rule order", () => {
  it("network.timeout: no status, and the SDK says it timed out", () => {
    expect(classify(failed("api.x/v1/feed", 30_000, "GET api.x/v1/feed timed out")).category).toBe("network.timeout");
    expect(classify(failed("api.x/v1/feed", 30_000, "GET api.x/v1/feed timed out: AbortError")).category).toBe("network.timeout");
  });

  it("network.never_sent: no status, under 100 ms", () => {
    expect(classify(failed("api.x/v1/feed", 99)).category).toBe("network.never_sent");
  });

  it("network.failed: no status, 100 ms or more (DNS, TLS, refused)", () => {
    expect(classify(failed("api.x/v1/feed", 100)).category).toBe("network.failed");
  });

  it("auth, server and client_request by status", () => {
    expect(classify(http(401)).category).toBe("auth");
    expect(classify(http(403)).category).toBe("auth");
    expect(classify(http(503)).category).toBe("server");
    expect(classify(http(422)).category).toBe("client_request");
  });

  it("crash: uncaught, from the global handler, and fatal", () => {
    expect(classify(err({ handled: false, severity: "critical", tags: { source: "global-handler" } })).category).toBe("crash");
    expect(classify(err({ handled: false, severity: "critical", tags: { source: "uncaughtException" } })).category).toBe("crash");
  });

  it("uncaught, not crash, when the global handler's error wasn't fatal", () => {
    expect(classify(err({ handled: false, tags: { source: "global-handler" } })).category).toBe("uncaught");
    expect(classify(err({ handled: false, tags: { source: "window.onerror" } })).category).toBe("uncaught");
    expect(classify(err({ handled: false })).category).toBe("uncaught"); // withDebug on the server
  });

  it("screen_crash from an error boundary", () => {
    expect(classify(err({ handled: false, tags: { source: "error-boundary" } })).category).toBe("screen_crash");
  });

  it("unhandled_rejection whichever platform spelled it", () => {
    for (const source of ["unhandled-rejection", "unhandledrejection", "unhandledRejection"])
      expect(classify(err({ handled: false, tags: { source } })).category).toBe("unhandled_rejection");
  });

  it("app_reported when the app called deBug.error()", () => {
    expect(classify(err()).category).toBe("app_reported");
  });

  it("other for anything left: a handled request error with a status nothing else covers", () => {
    expect(classify(http(302)).category).toBe("other");
  });
});

describe("classify: owner", () => {
  it("backend for server errors", () => {
    expect(classify(http(500)).owner).toBe("backend");
  });

  it("app for an expired sign-in, unknown for any other refusal", () => {
    const expired = { ...http(401), breadcrumbs: [net("GET", "api.x/v1/home", 200, 80, 30)] };
    expect(classify(expired)).toMatchObject({ owner: "app", causes: ["auth_expired"] });
    expect(classify(http(401)).owner).toBe("unknown");
  });

  it("infrastructure when connections fail across several hosts at once, unknown for one", () => {
    const one = failed("api.x/v1/feed", 400);
    expect(classify(one).owner).toBe("unknown");
    const many = { ...one, breadcrumbs: [net("GET", "cdn.y/img", null, 400, 2)] };
    expect(classify(many)).toMatchObject({ owner: "infrastructure", causes: ["burst"] });
    const sameHost = { ...one, breadcrumbs: [net("GET", "api.x/v1/other", null, 400, 2)] };
    expect(classify(sameHost).owner).toBe("unknown");
  });
});

describe("classify: impact", () => {
  it("blocked for a crash, or any error in a critical flow", () => {
    expect(classify(err({ handled: false, severity: "critical", tags: { source: "global-handler" } })).impact).toBe("blocked");
    expect(classify(err({ flow: "checkout.payment" }), { criticalFlows: ["checkout.payment"] }).impact).toBe("blocked");
  });

  it("silent while the app is in the background, or for an app-reported error with no flow", () => {
    expect(classify({ ...failed("api.x/v1/sync", 20), breadcrumbs: [ui("App went to the background", 3)] }).impact).toBe("silent");
    expect(classify(err()).impact).toBe("silent");
  });

  it("degraded otherwise", () => {
    expect(classify(err({ flow: "home" })).impact).toBe("degraded");
    expect(classify(err({ handled: false, tags: { source: "error-boundary" } })).impact).toBe("degraded");
  });
});

describe("classify: causes", () => {
  it("resumed_from_background only while nothing has worked since reopening, within 10 s", () => {
    const e = failed("api.x/v1/feed", 20);
    expect(classify({ ...e, breadcrumbs: [ui("App came to the foreground", 6)] }).causes).toContain("resumed_from_background");
    expect(classify({ ...e, breadcrumbs: [ui("App came to the foreground", 11)] }).causes).not.toContain("resumed_from_background");
    expect(classify({ ...e, breadcrumbs: [ui("App came to the foreground", 6), net("GET", "api.x/v1/home", 200, 80, 3)] }).causes).not.toContain(
      "resumed_from_background",
    );
  });

  it("burst needs another failure in the 5 s before, not the error's own breadcrumb", () => {
    const e = failed("api.x/v1/feed", 20);
    const own = net("GET", "api.x/v1/feed", null, 20, 0);
    expect(classify({ ...e, breadcrumbs: [own] }).causes).not.toContain("burst");
    expect(classify({ ...e, breadcrumbs: [net("GET", "api.x/v1/a", null, 20, 6), own] }).causes).not.toContain("burst");
    expect(classify({ ...e, breadcrumbs: [net("GET", "api.x/v1/a", null, 20, 4), own] }).causes).toContain("burst");
  });

  it("slow_network when 2 of the last 5 requests were slow", () => {
    const slow = (s: number) => net("GET", "api.x/v1/a", 200, 3500, s, "warning");
    const ok = (s: number) => net("GET", "api.x/v1/a", 200, 80, s);
    expect(classify({ ...err(), breadcrumbs: [slow(9), ok(8), ok(7), ok(6), ok(5), slow(4)] }).causes).not.toContain("slow_network");
    expect(classify({ ...err(), breadcrumbs: [ok(9), slow(8), ok(7), ok(6), slow(5)] }).causes).toContain("slow_network");
  });
});

describe("issue causes", () => {
  it("new_in_release, regressed and single_device", () => {
    expect(issueCauses({ firstVersion: "2.4.0", latestVersion: "2.4.0" })).toEqual(["new_in_release"]);
    expect(issueCauses({ firstVersion: "2.3.0", latestVersion: "2.4.0" })).toEqual([]);
    expect(issueCauses({ status: "regressed" })).toEqual(["regressed"]);
    expect(issueCauses({ deviceModels: Array(5).fill("SM-A105F") })).toEqual(["single_device"]);
    expect(issueCauses({ deviceModels: Array(4).fill("SM-A105F") })).toEqual([]);
    expect(issueCauses({ deviceModels: [...Array(4).fill("SM-A105F"), "Pixel 8"] })).toEqual([]);
  });

  it("adds them to an error's labels without repeats", () => {
    const labels = classify(resumeIncident[0]!);
    const merged = withIssueCauses(labels, { status: "regressed", firstVersion: "10.1.29", latestVersion: "10.1.29" });
    expect(merged.causes).toEqual(["resumed_from_background", "new_in_release", "regressed"]);
    expect(withIssueCauses(merged, { status: "regressed" })).toBe(merged);
  });
});
