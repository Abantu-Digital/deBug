import { describe, expect, it } from "vitest";
import type { Breadcrumb, ErrorEvent, HostName } from "@debugkit/schema";
import { findingsOf, type Finding } from "./detectors";

const T0 = Date.UTC(2026, 10, 16, 8, 31, 0);
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const crumb = (s: number, category: Breadcrumb["category"], message: string, level: Breadcrumb["level"] = "info"): Breadcrumb => ({ ts: at(s), category, level, message });
const net = (s: number, method: string, url: string, status: number | string) =>
  crumb(s, "network", `${method} ${url} → ${status}${typeof status === "number" ? " (100ms)" : ""}`, typeof status === "number" && status < 400 ? "info" : "error");

const error = (s: number, e: Partial<ErrorEvent>): ErrorEvent => ({ id: `e${s}`, ts: at(s), type: "error", handled: true, error: { name: "HttpError", message: "x" }, ...e }) as ErrorEvent;

const hosts: HostName[] = [{ match: "3eysq9x2ub.execute-api.af-south-1.amazonaws.com", name: "Core" }];
const SUB = "3eysq9x2ub.execute-api.af-south-1.amazonaws.com/ppd/api/notifications/subscriptions/create-subscription";
const ids = (fs: Finding[]) => fs.map((f) => f.id);

/** Cell C, 16 Nov 09:46 SAST (older occurrence): subscribe tried 4 times before login (401), then 204, then 500. */
const olderSubscribe = error(60, {
  breadcrumbs: [
    net(1, "POST", SUB, 401), net(5, "POST", SUB, 401), net(9, "POST", SUB, 401), net(13, "POST", SUB, 401),
    net(50, "POST", "6yy8lus7v4.execute-api.af-south-1.amazonaws.com/ppd/api/login/login", 200),
    crumb(50, "event", "Login Completed"),
    net(58, "POST", SUB, 204),
    net(60, "POST", SUB, 500),
  ],
  request: { method: "POST", url: SUB, status: 500, durationMs: 2075 },
});

/** Cell C, 10:31 SAST (newest): login, then 204, then 500 on the repeat. */
const newerSubscribe = error(300, {
  breadcrumbs: [crumb(290, "event", "Login Completed"), net(298.8, "POST", SUB, 204), net(300, "POST", SUB, 500)],
  request: { method: "POST", url: SUB, status: 500, durationMs: 1768 },
});

describe("trail-pattern findings", () => {
  it("the subscribe 500: success then failure, a duplicate call, and calls before login, with app-side fixes and a log search", () => {
    const fs = findingsOf([olderSubscribe, newerSubscribe], hosts);
    expect(ids(fs)).toEqual(["success_then_failure", "duplicate_call", "called_before_login"]);
    const [repeat, dup, early] = fs;
    expect(repeat).toMatchObject({ seen: 2, of: 2, why: "The first call worked (204); the repeat 1 s later failed (500)." });
    expect(repeat!.fix).toBe("To see why the repeat failed, search the Core logs for POST /ppd/api/notifications/subscriptions/create-subscription at 08:36:00 UTC.");
    expect(dup).toMatchObject({ seen: 2, of: 2, fix: "App: send it once per action. Look for two screens or effects that both trigger it." });
    expect(early).toMatchObject({ seen: 1, of: 2, why: "Core · POST /ppd/api/notifications/subscriptions/create-subscription ran 4 times before login and got 401.", fix: "App: wait until login has finished before making this call." });
  });

  it("names the trace id the backend already sent, when there is one", () => {
    const withTrace = { ...newerSubscribe, response: { status: 500, headers: { "x-cloud-trace-context": "e5d58d1384f19ccbd850acbb0a2d2e89" } } };
    expect(findingsOf([withTrace], hosts)[0]!.fix).toBe("To see why the repeat failed, search the Core logs for trace id e5d58d1384f19ccbd850acbb0a2d2e89 (x-cloud-trace-context).");
  });

  it("doesn't call it a duplicate when the earlier call was long before", () => {
    const apart = error(60, { breadcrumbs: [net(1, "POST", SUB, 204), net(60, "POST", SUB, 500)], request: { method: "POST", url: SUB, status: 500 } });
    expect(findingsOf([apart], hosts)).toEqual([]);
  });

  it("doesn't count other endpoints as the same call", () => {
    const other = error(3, { breadcrumbs: [net(2, "POST", `${SUB}-v2`, 204), net(3, "POST", SUB, 500)], request: { method: "POST", url: SUB, status: 500 } });
    expect(findingsOf([other], hosts)).toEqual([]);
  });

  it("a 401 before login isn't flagged without a login after it", () => {
    const noLogin = error(20, { breadcrumbs: [net(1, "POST", SUB, 401), net(20, "POST", SUB, 500)], request: { method: "POST", url: SUB, status: 500 } });
    expect(ids(findingsOf([noLogin], hosts))).not.toContain("called_before_login");
  });

  // Cell C, 14 Nov (event mwghc27lliod6cpinr): the survey answer sent, the app backgrounded, no answer after 122 s.
  it("a request that hung while the app was in the background", () => {
    const SURVEY = "dcp6wvbgv6.execute-api.af-south-1.amazonaws.com/ppd/api/surveys/:id/responses";
    const hung = error(200, {
      error: { name: "NetworkError", message: `POST ${SURVEY} timed out` },
      breadcrumbs: [crumb(78, "ui", "App went to the background"), net(200, "POST", SURVEY, "timed out")],
      request: { method: "POST", url: SURVEY, durationMs: 122_655 },
    });
    const [f] = findingsOf([hung]);
    expect(f).toMatchObject({ id: "hung_in_background", fix: "App: send it before the app goes to the background, or retry it when the app comes back." });
    expect(f!.why).toMatch(/was still running when the app went to the background, and gave up after 123 s\.$/);
  });

  it("a timeout with the app in the foreground isn't called a background hang", () => {
    const SURVEY = "x.example.com/s";
    const fg = error(200, { breadcrumbs: [crumb(10, "ui", "App went to the background"), net(200, "POST", SURVEY, "timed out")], request: { method: "POST", url: SURVEY, durationMs: 30_000 } });
    expect(findingsOf([fg])).toEqual([]);
  });

  it("a 401 after a long time in the background with no token refresh", () => {
    const BAL = "api.example.com/balance";
    const stale = error(4000, {
      breadcrumbs: [crumb(0, "ui", "App went to the background"), crumb(3990, "ui", "App came to the foreground"), net(4000, "POST", BAL, 401)],
      request: { method: "POST", url: BAL, status: 401 },
    });
    expect(findingsOf([stale])[0]).toMatchObject({ id: "no_refresh_before_401", fix: "App: refresh the session token when the app comes back, before other calls." });
    const refreshed = { ...stale, breadcrumbs: [...stale.breadcrumbs!.slice(0, 2), net(3995, "POST", "api.example.com/auth/refresh", 200), net(4000, "POST", BAL, 401)] };
    expect(findingsOf([refreshed])).toEqual([]);
  });

  // Cell C OTA check: 404 on every check in every trail.
  it("an endpoint that answers the same error every time: suggest marking it expected", () => {
    const OTA = "hot-updater-jyxeb7knca-oa.a.run.app/api/check-update/app-version/ios/10.1.29/preview/:id/:id/:id";
    const one = (s: number) => error(s, { breadcrumbs: [net(s - 30, "GET", OTA, 404), net(s, "GET", OTA, 404)], request: { method: "GET", url: OTA, status: 404 } });
    const [f] = findingsOf([one(100), one(200)]);
    expect(f).toMatchObject({ id: "expected_answer", seen: 2, of: 2, fix: "If 404 is this endpoint's normal answer, mark it as expected so it stops counting." });
    expect(f!.why).toMatch(/answered 404 \(4 of 4\)\.$/);
    const mixed = error(300, { breadcrumbs: [net(200, "GET", OTA, 200), net(250, "GET", OTA, 404), net(300, "GET", OTA, 404)], request: { method: "GET", url: OTA, status: 404 } });
    expect(ids(findingsOf([mixed]))).not.toContain("expected_answer");
  });

  // Found on the demo data: a feed that answers 502 every time is an outage, not its normal answer.
  it("a 5xx, 401, 403 or 429 every time is never called expected", () => {
    for (const status of [502, 401, 403, 429]) {
      const one = (s: number) => error(s, { breadcrumbs: [net(s - 30, "GET", "api.example.com/v1/feed", status), net(s, "GET", "api.example.com/v1/feed", status)], request: { method: "GET", url: "api.example.com/v1/feed", status } });
      expect(ids(findingsOf([one(100), one(200)]))).not.toContain("expected_answer");
    }
  });

  it("a crash with no request has nothing to say yet", () => {
    expect(findingsOf([error(10, { error: { name: "TypeError", message: "x" }, breadcrumbs: [crumb(5, "navigation", "/a → /b")] })])).toEqual([]);
  });

  it("never tells anyone to change their backend", () => {
    const all = findingsOf([olderSubscribe, newerSubscribe], hosts);
    for (const f of all) expect(`${f.why} ${f.fix}`).not.toMatch(/idempotent|problem details|add a trace|return (a |an )?\d{3}|backend should|change the (backend|server|api)/i);
  });
});
