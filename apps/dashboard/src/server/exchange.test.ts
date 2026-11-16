import { describe, expect, it } from "vitest";
import { exchangeOf } from "./exchange";

const ev = (extra: Record<string, unknown>) =>
  ({ type: "error", id: "e1", ts: "2026-11-16T10:42:00.000Z", handled: true, error: { name: "HttpError", message: "POST /buy → 422" }, ...extra }) as never;

describe("exchange", () => {
  it("reads the request and response the SDK captured; a URL that names its host gets https://", () => {
    const x = exchangeOf(
      ev({
        request: { method: "post", url: "api.cellc.example/buy/with-airtime", status: 422, query: "?msisdn=[redacted]", headers: { "content-type": "application/json", authorization: "[redacted]" }, body: '{"amount":50}', bodySize: 13 },
        response: { status: 422, headers: { "content-type": "application/problem+json" }, body: '{"title":"Insufficient funds"}', bodySize: 30 },
      }),
    )!;
    expect(x.request).toEqual({ method: "POST", url: "api.cellc.example/buy/with-airtime", fullUrl: "https://api.cellc.example/buy/with-airtime", query: "msisdn=[redacted]", headers: { "content-type": "application/json", authorization: "[redacted]" }, body: '{"amount":50}', bodySize: 13, truncated: undefined });
    expect(x.response).toMatchObject({ status: 422, body: '{"title":"Insufficient funds"}' });
  });

  it("leaves the host out when the SDK named the call by its path", () => {
    expect(exchangeOf(ev({ request: { method: "GET", url: "/v1/feed", headers: { accept: "*/*" } } }))!.request.fullUrl).toBeUndefined();
  });

  it("shows a captured call even with nothing in it: an empty 500, or a breadcrumb saying bodies were taken", () => {
    expect(exchangeOf(ev({ request: { method: "GET", url: "/x", status: 500 }, response: { status: 500 } }))!.response).toEqual({ status: 500, headers: undefined, body: undefined, bodySize: undefined, truncated: undefined });
    const flagged = ev({ request: { method: "GET", url: "/x" }, breadcrumbs: [{ ts: "2026-11-16T10:42:00.000Z", category: "network", message: "GET /x → failed", data: { hasBodies: true } }] });
    expect(exchangeOf(flagged)).toBeDefined();
  });

  it("has nothing to show without network.bodies, or without a request", () => {
    expect(exchangeOf(ev({ request: { method: "GET", url: "/x", status: 500 } }))).toBeUndefined();
    expect(exchangeOf(ev({}))).toBeUndefined();
  });
});
