import { describe, expect, it } from "vitest";
import type { Breadcrumb, ErrorEvent, HostName } from "@debugkit/schema";
import { traceIdIn, traceOf, whereOf } from "./hops";

const at = (s: number) => new Date(Date.UTC(2026, 10, 16, 8, 31, s)).toISOString();
const crumb = (s: number, b: Omit<Breadcrumb, "ts" | "level"> & Partial<Pick<Breadcrumb, "level">>): Breadcrumb => ({ ts: at(s), level: "info", ...b });

const event = (e: Partial<ErrorEvent> & Pick<ErrorEvent, "error">): ErrorEvent => ({ id: "e1", ts: at(44), type: "error", handled: true, ...e }) as ErrorEvent;

const hosts: HostName[] = [{ match: "3eysq9x2ub.execute-api.af-south-1.amazonaws.com", name: "Core" }];

/** The Cell C subscribe 500: login, home, then the repeat call fails. No trace header came back. */
const subscribe500 = event({
  error: { name: "HttpError", message: "POST 3eysq9x2ub.execute-api.af-south-1.amazonaws.com/ppd/api/notifications/subscriptions/create-subscription responded 500" },
  breadcrumbs: [
    crumb(30, { category: "navigation", message: "/ → /login" }),
    crumb(32, { category: "ui", message: 'Tapped "Log in"', data: { label: "Log in", testID: null, screen: "/login" } }),
    crumb(40, { category: "navigation", message: "/login → /dashboard" }),
    crumb(43, { category: "network", message: "POST 3eysq9x2ub.execute-api.af-south-1.amazonaws.com/ppd/api/notifications/subscriptions/create-subscription → 204 (1612ms)" }),
    crumb(44, { category: "network", level: "error", message: "POST 3eysq9x2ub.execute-api.af-south-1.amazonaws.com/ppd/api/notifications/subscriptions/create-subscription → 500 (1768ms)" }),
  ],
  request: { method: "POST", url: "3eysq9x2ub.execute-api.af-south-1.amazonaws.com/ppd/api/notifications/subscriptions/create-subscription", status: 500, durationMs: 1768 },
});

describe("where an error comes from", () => {
  it("a backend 5xx with no trace header: names the call, and says what to search the logs for", () => {
    const w = whereOf(subscribe500, { hosts, journeyOf: (s) => (s === "/dashboard" ? "Home" : undefined) });
    expect(w.hops.map((h) => h.kind)).toEqual(["journey", "screen", "action", "failing", "source"]);
    expect(w.hops.slice(0, 4)).toEqual([
      { kind: "journey", value: "Home" },
      { kind: "screen", value: "/dashboard" },
      { kind: "action", value: 'Tapped "Log in"' },
      { kind: "failing", value: "Core · POST /ppd/api/notifications/subscriptions/create-subscription → 500" },
    ]);
    expect(w.hops[4]).toEqual({ kind: "source", missing: true, ask: "No trace id in this response: search the Core logs for POST /ppd/api/notifications/subscriptions/create-subscription at 08:31:44 UTC." });
    expect(w.line).toBe('Home › /dashboard › Tapped "Log in" › Core · POST /ppd/api/notifications/subscriptions/create-subscription → 500');
  });

  it("never asks for a backend change in any hop it can't fill", () => {
    const asks = [subscribe500, event({ error: { name: "Error", message: "x" } })].flatMap((e) => whereOf(e).hops.flatMap((h) => (h.missing ? [h.ask] : [])));
    expect(asks.length).toBeGreaterThan(0);
    for (const a of asks) expect(a).not.toMatch(/ask the .*backend|send problem details|add a trace|make .* idempotent|return .*problem/i);
  });

  it("a 4xx that came back with trace headers: the source is the trace id the backend already sent", () => {
    const w = whereOf(
      event({
        error: { name: "HttpError", message: "GET hot-updater-jyxeb7knca-oa.a.run.app/api/check-update/app-version/ios/10.1.29/preview/:id/:id/:id responded 404" },
        breadcrumbs: [crumb(40, { category: "navigation", message: "/ → /dashboard" })],
        request: { method: "GET", url: "hot-updater-jyxeb7knca-oa.a.run.app/api/check-update/app-version/ios/10.1.29/preview/:id/:id/:id", status: 404, durationMs: 788 },
        response: { status: 404, body: '"404 Not Found"', headers: { "x-cloud-trace-context": "105445aa7843bc8bf206b12000100000/1;o=1", traceparent: "00-105445aa7843bc8bf206b12000100000-0000000000000001-01" } },
      }),
      { hosts: [{ match: "hot-updater-jyxeb7knca-oa.a.run.app", name: "App updates (OTA)" }] },
    );
    expect(w.hops[3]).toEqual({ kind: "failing", value: "App updates (OTA) · GET /api/check-update/app-version/ios/10.1.29/preview/:id/:id/:id → 404" });
    expect(w.hops[4]).toEqual({ kind: "source", value: "App updates (OTA) · traceparent 105445aa7843bc8bf206b12000100000" });
    expect(w.hops[2]).toMatchObject({ kind: "action", missing: true });
  });

  it("a timeout: no status, so the failing call says it got no answer", () => {
    const w = whereOf(
      event({
        error: { name: "NetworkError", message: "POST dcp6wvbgv6.execute-api.af-south-1.amazonaws.com/ppd/api/surveys/:id/responses timed out" },
        breadcrumbs: [crumb(1, { category: "ui", message: "App went to the background" })],
        request: { method: "POST", url: "dcp6wvbgv6.execute-api.af-south-1.amazonaws.com/ppd/api/surveys/:id/responses", durationMs: 122655 },
      }),
    );
    expect(w.hops[3]).toEqual({ kind: "failing", value: "POST dcp6wvbgv6.execute-api.af-south-1.amazonaws.com/ppd/api/surveys/:id/responses → no answer" });
    expect(w.hops[4]).toMatchObject({ kind: "source", missing: true });
    // "App went to the background" is not a tap.
    expect(w.hops[2]).toMatchObject({ kind: "action", missing: true });
  });

  it("an app crash: the failing code is the first app frame, and the source is its file", () => {
    const w = whereOf(
      event({
        flow: "buy.checkout",
        handled: false,
        tags: { source: "global-handler" },
        error: {
          name: "TypeError",
          message: "Cannot read property 'amount' of undefined",
          frames: [
            { fn: "dispatch", file: "node_modules/react/index.js", line: 10, inApp: false },
            { fn: "BuyConfirm", file: "src/features/buy/BuyConfirm.tsx", line: 88, col: 21, inApp: true },
          ],
        },
        breadcrumbs: [crumb(40, { category: "navigation", message: "/buy → /buy/confirm" }), crumb(41, { category: "ui", message: 'Tapped "Data 1 GB"' })],
      }),
    );
    expect(w.line).toBe('buy.checkout › /buy/confirm › Tapped "Data 1 GB" › BuyConfirm at BuyConfirm.tsx:88');
    expect(w.hops[4]).toEqual({ kind: "source", value: "src/features/buy/BuyConfirm.tsx" });
  });

  it("a screen crash with only library frames: says the file needs source maps", () => {
    const w = whereOf(
      event({
        tags: { source: "error-boundary" },
        error: { name: "TypeError", message: "x is undefined", frames: [{ fn: "renderWithHooks", file: "main.jsbundle", line: 17302, inApp: false }] },
        breadcrumbs: [crumb(40, { category: "navigation", message: "/profile → /errorTesting" })],
      }),
    );
    expect(w.hops[1]).toEqual({ kind: "screen", value: "/errorTesting" });
    expect(w.hops[3]).toMatchObject({ kind: "failing", missing: true, ask: expect.stringMatching(/source maps/) });
    expect(w.hops[4]).toMatchObject({ kind: "source", missing: true });
  });

  it("an event with no breadcrumbs and no frames: every hop it can't fill says why", () => {
    const w = whereOf(event({ error: { name: "Error", message: "deBug crash test: unhandled promise rejection" } }));
    expect(w.hops.filter((h) => h.missing).map((h) => h.kind)).toEqual(["journey", "screen", "action", "source"]);
    expect(w.hops[3]).toEqual({ kind: "failing", value: "Error: deBug crash test: unhandled promise rejection" });
    expect(w.line).toBe("Error: deBug crash test: unhandled promise rejection");
  });

  // From cellc-staging, 16 Nov (event mwjnu8jjn6oisfqjzn): the Error testing screen's screenCrash button on a preview build.
  it("a crash in a build without source maps: names the function, and says the file needs source maps", () => {
    const bundle = "/Users/expo/workingdir/build/ios/build/Build/Intermediates.noindex/ArchiveIntermediates/CellCPreview/BuildProductsPath/ReleasePreview-iphoneos/main.jsbundle";
    const w = whereOf(
      event({
        error: {
          name: "TypeError",
          message: "Cannot read property 'amount' of null",
          frames: [
            { fn: "readMissingBalance", file: bundle, line: 358444, col: 19, inApp: true },
            { fn: "ErrorTesting", file: bundle, line: 358361, col: 46, inApp: true },
          ],
        },
        breadcrumbs: [
          crumb(36, { category: "ui", message: 'Tapped "Profile"', data: { label: "Profile", testID: "tab-bar-item-3" } }),
          crumb(37, { category: "navigation", message: "/dashboard → /profile" }),
          crumb(40, { category: "ui", message: "Tapped profile-nav-item-Error testing", data: { label: null, testID: "profile-nav-item-Error testing" } }),
          crumb(41, { category: "navigation", message: "/profile → /errorTesting" }),
          crumb(43, { category: "ui", message: 'Tapped "errorTesting.screenCrash"', data: { label: "errorTesting.screenCrash", testID: "errorTesting.screenCrash" } }),
        ],
      }),
    );
    expect(w.line).toBe('/errorTesting › Tapped "errorTesting.screenCrash" › readMissingBalance (not source-mapped)');
    expect(w.hops[4]).toEqual({ kind: "source", missing: true, ask: "Not source-mapped: upload source maps for this build to see the file and line." });
  });

  // From cellc-staging, 16 Nov (event mwjqwug2h2w8nyelli): the hot-updater answers with Cloud Run's trace header only.
  it("reads Cloud Run's x-cloud-trace-context when there's no traceparent", () => {
    const w = whereOf(
      event({
        error: { name: "HttpError", message: "GET hot-updater-jyxeb7knca-oa.a.run.app/api/check-update/app-version/ios/10.1.29/preview/:id/:id/:id responded 404" },
        request: { method: "GET", url: "hot-updater-jyxeb7knca-oa.a.run.app/api/check-update/app-version/ios/10.1.29/preview/:id/:id/:id", status: 404, durationMs: 1010 },
        response: { status: 404, headers: { "content-type": "text/plain; charset=utf-8", server: "Google Frontend", "x-cloud-trace-context": "e5d58d1384f19ccbd850acbb0a2d2e89" } },
      }),
    );
    expect(w.hops[4]).toEqual({ kind: "source", value: "hot-updater-jyxeb7knca-oa.a.run.app · x-cloud-trace-context e5d58d1384f19ccbd850acbb0a2d2e89" });
  });

  it("ignores breadcrumbs after the error", () => {
    const later = event({ ...subscribe500, breadcrumbs: [...subscribe500.breadcrumbs!, crumb(50, { category: "navigation", message: "/dashboard → /profile" })] });
    expect(whereOf(later).hops[1]).toEqual({ kind: "screen", value: "/dashboard" });
  });
});

describe("more of what the backend and the app already send", () => {
  const call500 = (body?: string) =>
    event({
      error: { name: "HttpError", message: "POST api.example.com/v1/pay responded 500" },
      request: { method: "POST", url: "https://api.example.com:8443/v1/pay", status: 500 },
      ...(body ? { response: { status: 500, body } } : {}),
    });

  it("a trace id in the JSON error body, when there's no trace header", () => {
    expect(whereOf(call500('{"message":"boom","traceId":"abc123"}')).hops[4]).toEqual({ kind: "source", value: "api.example.com · traceId abc123" });
  });

  it("an error code in the body, when there's no trace id anywhere", () => {
    expect(whereOf(call500('{"code":"PAY_DOWN"}')).hops[4]).toEqual({ kind: "source", value: "api.example.com · code PAY_DOWN" });
  });

  it("a URL with a scheme and port still names its host in the log search, and ignores a cut body", () => {
    expect(whereOf(call500('{"traceId":"abc…[truncated]')).hops[4]).toEqual({ kind: "source", missing: true, ask: "No trace id in this response: search the api.example.com logs for POST https://api.example.com:8443/v1/pay at 08:31:44 UTC." });
  });

  it("a tap known only by its testID, whatever the breadcrumb says", () => {
    const w = whereOf(event({ error: { name: "Error", message: "x" }, breadcrumbs: [crumb(40, { category: "ui", message: "Press", data: { label: null, testID: "buy-confirm" } })] }));
    expect(w.hops[2]).toEqual({ kind: "action", value: "Tapped buy-confirm" });
  });

  it("an unreadable event time doesn't break the log search", () => {
    const w = whereOf({ ...call500(), ts: "not a time" });
    expect(w.hops[4]).toMatchObject({ missing: true, ask: expect.stringContaining("at not a time.") });
  });
});

describe("trace ids the backend already sends", () => {
  it("reads W3C traceparent, Google Cloud's and AWS X-Ray's headers down to the trace id", () => {
    expect(traceIdIn("traceparent", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(traceIdIn("x-cloud-trace-context", "105445aa7843bc8bf206b12000100000/1;o=1")).toBe("105445aa7843bc8bf206b12000100000");
    expect(traceIdIn("x-amzn-trace-id", "Root=1-5759e988-bd862e3fe1be46a994272793;Parent=53995c3f42cd8ad8;Sampled=1")).toBe("1-5759e988-bd862e3fe1be46a994272793");
    expect(traceIdIn("x-request-id", "abc-123")).toBe("abc-123");
  });

  it("rejects a malformed or all-zero traceparent", () => {
    expect(traceIdIn("traceparent", "garbage-x")).toBeUndefined();
    expect(traceIdIn("traceparent", "00-00000000000000000000000000000000-00f067aa0ba902b7-01")).toBeUndefined();
  });

  it("prefers traceparent, skips redacted or invalid values, then the body, then the app's breadcrumb", () => {
    const tp = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    expect(traceOf({ "x-request-id": "r1", traceparent: tp }, undefined, undefined)).toEqual({ from: "traceparent", id: "4bf92f3577b34da6a3ce929d0e0e4736" });
    expect(traceOf({ traceparent: "[redacted]", "x-request-id": "r1" }, undefined, undefined)).toEqual({ from: "x-request-id", id: "r1" });
    expect(traceOf({ traceparent: "garbage-x", "x-request-id": "r1" }, undefined, undefined)).toEqual({ from: "x-request-id", id: "r1" });
    expect(traceOf({}, '{"trace_id":"b1"}', { traceId: "c1", failed: true })).toEqual({ from: "traceId", id: "b1" });
    expect(traceOf(undefined, undefined, { traceId: "4f2c9a", failed: true })).toEqual({ from: "traceId", id: "4f2c9a" });
    expect(traceOf({}, undefined, { failed: true })).toBeUndefined();
  });
});
