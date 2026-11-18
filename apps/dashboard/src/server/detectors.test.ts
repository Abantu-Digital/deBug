import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Breadcrumb, ErrorEvent, HostName } from "@debugkit/schema";
import { findingsOf, type Finding } from "./detectors";

const T0 = Date.UTC(2026, 10, 16, 8, 31, 0);
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const crumb = (s: number, category: Breadcrumb["category"], message: string, level: Breadcrumb["level"] = "info", data?: Breadcrumb["data"]): Breadcrumb => ({ ts: at(s), category, level, message, ...(data ? { data } : {}) });
/** The SDK's own network breadcrumb: "POST host/path → 204 (100ms)", written when the call ends. */
const net = (s: number, method: string, url: string, status: number | string, took = 100, data?: Breadcrumb["data"]) =>
  crumb(s, "network", `${method} ${url} → ${status}${typeof status === "number" ? ` (${took}ms)` : ""}`, typeof status === "number" && status < 400 ? "info" : "error", data);

const error = (s: number, e: Partial<ErrorEvent>): ErrorEvent => ({ id: `e${s}`, ts: at(s), type: "error", handled: true, error: { name: "HttpError", message: "x" }, ...e }) as ErrorEvent;

const hosts: HostName[] = [{ match: "3eysq9x2ub.execute-api.af-south-1.amazonaws.com", name: "Core" }];
const SUB = "3eysq9x2ub.execute-api.af-south-1.amazonaws.com/ppd/api/notifications/subscriptions/create-subscription";
const ids = (fs: Finding[]) => fs.map((f) => f.id);

/** Cell C, 16 Nov 09:46 SAST (older occurrence): subscribe tried 4 times before login (401), then 204 and 500 sent together. */
const olderSubscribe = error(60, {
  breadcrumbs: [
    net(1, "POST", SUB, 401), net(5, "POST", SUB, 401), net(9, "POST", SUB, 401), net(13, "POST", SUB, 401),
    net(50, "POST", "6yy8lus7v4.execute-api.af-south-1.amazonaws.com/ppd/api/login/login", 200),
    crumb(50, "event", "Login Completed"),
    net(58, "POST", SUB, 204, 2046),
    net(60, "POST", SUB, 500, 2075),
  ],
  request: { method: "POST", url: SUB, status: 500, durationMs: 2075 },
});

/** Cell C, 10:31 SAST (newest, event mwj08l5zf4qt7qd1v6): login, then 204 and 500 sent within a millisecond. */
const newerSubscribe = error(300, {
  breadcrumbs: [crumb(290, "event", "Login Completed"), net(298.843, "POST", SUB, 204, 1612), net(300, "POST", SUB, 500, 1768)],
  request: { method: "POST", url: SUB, status: 500, durationMs: 1768 },
});

describe("trail-pattern findings", () => {
  it("the subscribe 500: the repeat failed (sent twice at once) and calls before login, with app-side fixes and a log search", () => {
    const fs = findingsOf([olderSubscribe, newerSubscribe], hosts);
    expect(ids(fs)).toEqual(["repeat_failed", "called_before_login"]);
    const [repeat, early] = fs;
    expect(repeat).toMatchObject({ seen: 2, of: 2, why: "The app sent it again before the first call answered; the first worked (204), the repeat failed (500)." });
    expect(repeat!.fix).toBe("App: send it once per action. To see why the repeat failed, search the Core logs for POST /ppd/api/notifications/subscriptions/create-subscription sent at 08:35:58 UTC.");
    expect(early).toMatchObject({ seen: 1, of: 2, why: "Core · POST /ppd/api/notifications/subscriptions/create-subscription ran 4 times before login and got 401.", fix: "App: wait until login has finished before making this call." });
    expect(repeat!.evidence[0]).toMatch(/ UTC → 204$|sent, .* UTC → 204$/);
  });

  it("names the trace id the backend already sent, when there is one", () => {
    const withTrace = { ...newerSubscribe, response: { status: 500, headers: { "x-cloud-trace-context": "e5d58d1384f19ccbd850acbb0a2d2e89" } } };
    expect(findingsOf([withTrace], hosts)[0]!.fix).toBe("App: send it once per action. To see why the repeat failed, search the Core logs for trace id e5d58d1384f19ccbd850acbb0a2d2e89 (x-cloud-trace-context).");
  });

  it("a success half a minute before: the repeat failed, without calling it a duplicate", () => {
    const later = error(60, { breadcrumbs: [net(30, "POST", SUB, 204), net(60, "POST", SUB, 500)], request: { method: "POST", url: SUB, status: 500 } });
    const fs = findingsOf([later], hosts);
    expect(ids(fs)).toEqual(["repeat_failed"]);
    expect(fs[0]!.why).toBe("The first call worked (204); the repeat 30.1 s later failed (500).");
    expect(fs[0]!.fix).not.toMatch(/send it once/);
  });

  it("two sends of a failing call close together, with no success: a duplicate call", () => {
    const dup = error(3, { breadcrumbs: [net(1, "POST", SUB, 500), net(3, "POST", SUB, 500)], request: { method: "POST", url: SUB, status: 500 } });
    expect(findingsOf([dup], hosts)).toMatchObject([{ id: "duplicate_call", fix: "App: send it once per action. Look for two screens or effects that both trigger it." }]);
  });

  it("the app's own retry isn't a duplicate", () => {
    const retried = error(3, { breadcrumbs: [net(1, "POST", SUB, 500), net(3, "POST", SUB, 500, 100, { retry: 1 })], request: { method: "POST", url: SUB, status: 500 } });
    expect(findingsOf([retried], hosts)).toEqual([]);
  });

  it("nothing when the earlier success was long before", () => {
    const apart = error(200, { breadcrumbs: [net(1, "POST", SUB, 204), net(200, "POST", SUB, 500)], request: { method: "POST", url: SUB, status: 500 } });
    expect(findingsOf([apart], hosts)).toEqual([]);
  });

  it("doesn't count other endpoints, other hosts, or a path that ends the same way on another segment", () => {
    const req = { method: "POST", url: SUB, status: 500 };
    for (const other of [`${SUB}-v2`, SUB.replace("3eysq9x2ub", "zzzzzzzzzz"), "/create-subscription"]) {
      const e = error(3, { breadcrumbs: [net(2, "POST", other, 204), net(3, "POST", SUB, 500)], request: req });
      expect(findingsOf([e], hosts)).toEqual([]);
    }
  });

  it("matches the app's own breadcrumb, relative to its base URL", () => {
    const app = crumb(2, "network", "POST /notifications/subscriptions/create-subscription", "info", { method: "POST", path: "/notifications/subscriptions/create-subscription", status: 204, service: "core" });
    const e = error(3, { breadcrumbs: [app, net(3, "POST", SUB, 500)], request: { method: "POST", url: SUB, status: 500 } });
    expect(ids(findingsOf([e], hosts))).toContain("repeat_failed");
  });

  it("a 401 before login isn't flagged without a finished login after it", () => {
    for (const notLogin of ["Login Failed", "Login Screen Viewed", "Blog index"]) {
      const e = error(20, { breadcrumbs: [net(1, "POST", SUB, 401), crumb(10, "event", notLogin), net(20, "POST", SUB, 500)], request: { method: "POST", url: SUB, status: 500 } });
      expect(ids(findingsOf([e], hosts))).not.toContain("called_before_login");
    }
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
    expect(f!.why).toMatch(/was still running when the app went to the background, and gave up after 122\.7 s\.$/);
  });

  it("not a background hang: backgrounded before it was sent, a quick failure, or not a timeout", () => {
    const U = "x.example.com/s";
    const bgFirst = error(200, { error: { name: "NetworkError", message: `POST ${U} timed out` }, breadcrumbs: [crumb(10, "ui", "App went to the background")], request: { method: "POST", url: U, durationMs: 30_000 } });
    const quick = error(200, { error: { name: "NetworkError", message: `POST ${U} timed out` }, breadcrumbs: [crumb(199.5, "ui", "App went to the background")], request: { method: "POST", url: U, durationMs: 1_000 } });
    const failed = error(200, { error: { name: "NetworkError", message: `POST ${U} failed` }, breadcrumbs: [crumb(190, "ui", "App went to the background")], request: { method: "POST", url: U, durationMs: 30_000 } });
    expect(findingsOf([bgFirst, quick, failed])).toEqual([]);
  });

  it("a 401 after a long time in the background with no token refresh", () => {
    const BAL = "api.example.com/balance";
    const stale = error(4000, {
      breadcrumbs: [crumb(0, "ui", "App went to the background"), crumb(3990, "ui", "App came to the foreground"), net(4000, "POST", BAL, 401)],
      request: { method: "POST", url: BAL, status: 401 },
    });
    expect(findingsOf([stale])[0]).toMatchObject({ id: "no_refresh_before_401", fix: "App: refresh the session token when the app comes back, before other calls." });
    const refreshed = { ...stale, breadcrumbs: [...stale.breadcrumbs!.slice(0, 2), net(3995, "POST", "api.example.com/auth/refresh", 200), net(4000, "POST", BAL, 401)] };
    const short = { ...stale, breadcrumbs: [crumb(3900, "ui", "App went to the background"), crumb(3990, "ui", "App came to the foreground"), net(4000, "POST", BAL, 401)] };
    const stillAway = { ...stale, breadcrumbs: [crumb(0, "ui", "App went to the background"), crumb(3000, "ui", "App came to the foreground"), crumb(3500, "ui", "App went to the background"), net(4000, "POST", BAL, 401)] };
    for (const e of [refreshed, short, stillAway]) expect(findingsOf([e])).toEqual([]);
  });

  // Cell C OTA check: 404 on every check in every trail.
  it("an endpoint that answers the same 4xx every time: suggest marking it expected, counting each call once", () => {
    const OTA = "hot-updater-jyxeb7knca-oa.a.run.app/api/check-update/app-version/ios/10.1.29/preview/:id/:id/:id";
    const one = (s: number, earlier = s - 30) => error(s, { breadcrumbs: [net(earlier, "GET", OTA, 404), net(s, "GET", OTA, 404)], request: { method: "GET", url: OTA, status: 404 } });
    const [f] = findingsOf([one(100), one(200)]);
    expect(f).toMatchObject({ id: "expected_answer", seen: 2, of: 2, fix: "If 404 is this endpoint's normal answer, mark it as expected so it stops counting." });
    expect(f!.why).toMatch(/answered 404 \(4 of 4\)\.$/);
    // Two occurrences from one session share the call at 100: three calls, not four.
    expect(findingsOf([one(100), one(130, 100)])[0]!.why).toMatch(/\(3 of 3\)\.$/);
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
});

describe("no backend changes (ABA-137)", () => {
  // "Retry idempotent requests" is app advice; "make it idempotent" asks the backend to change.
  const BACKEND_CHANGE = /make (it|the \w+|\w+) idempotent|problem details|add a trace|return (a |an )?\d{3}|backend should|server should|fix it (there|on the server)|change the (backend|server|api)/i;

  it("no finding tells anyone to change their backend", () => {
    const OTA = "hot-updater-jyxeb7knca-oa.a.run.app/api/check-update/x";
    const all = findingsOf([olderSubscribe, newerSubscribe], hosts).concat(
      findingsOf([error(3, { breadcrumbs: [net(1, "POST", SUB, 500), net(3, "POST", SUB, 500)], request: { method: "POST", url: SUB, status: 500 } })], hosts),
      findingsOf([error(200, { breadcrumbs: [net(140, "GET", OTA, 404), net(170, "GET", OTA, 404), net(200, "GET", OTA, 404)], request: { method: "GET", url: OTA, status: 404 } })]),
      findingsOf([error(200, { error: { name: "NetworkError", message: "POST x.example.com/s timed out" }, breadcrumbs: [crumb(190, "ui", "App went to the background")], request: { method: "POST", url: "x.example.com/s", durationMs: 30_000 } })]),
      findingsOf([error(4000, { breadcrumbs: [crumb(0, "ui", "App went to the background"), crumb(3990, "ui", "App came to the foreground")], request: { method: "POST", url: "api.example.com/b", status: 401 } })]),
    );
    expect(new Set(all.map((f) => f.id)).size).toBe(6);
    for (const f of all) expect(`${f.why} ${f.fix}`).not.toMatch(BACKEND_CHANGE);
  });

  it("nor does any of the general advice in explain.ts", () => {
    const src = readFileSync(new URL("./explain.ts", import.meta.url), "utf8");
    const fixes = [...src.matchAll(/fix:[^\n]*\n?(?:\s*\?[^\n]*\n\s*:[^\n]*)?/g)].map((m) => m[0]);
    expect(fixes.length).toBeGreaterThan(10);
    for (const f of fixes) expect(f).not.toMatch(BACKEND_CHANGE);
  });
});
