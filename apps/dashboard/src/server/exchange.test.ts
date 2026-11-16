import { describe, expect, it } from "vitest";
import { exchangeOf } from "./exchange";

const ev = (extra: Record<string, unknown>) =>
  ({ type: "error", id: "e1", ts: "2026-11-16T10:42:00.000Z", handled: true, error: { name: "HttpError", message: "POST /buy → 422" }, ...extra }) as never;

describe("exchange", () => {
  it("reads the request and response the SDK captured, with the whole URL from its breadcrumb", () => {
    const x = exchangeOf(
      ev({
        request: { method: "post", url: "/buy/with-airtime", status: 422, query: "?msisdn=[redacted]", headers: { "content-type": "application/json", authorization: "[redacted]", n: 3 }, body: '{"amount":50}', bodySize: 13 },
        response: { status: 422, headers: { "content-type": "application/problem+json" }, body: '{"title":"Insufficient funds"}', bodySize: 30 },
        breadcrumbs: [{ ts: "2026-11-16T10:41:59.000Z", category: "network", level: "error", message: "POST https://api.cellc.example/buy/with-airtime → 422 (98ms)", data: { hasBodies: true } }],
      }),
    )!;
    expect(x.request).toEqual({ method: "POST", url: "/buy/with-airtime", fullUrl: "https://api.cellc.example/buy/with-airtime", query: "msisdn=[redacted]", headers: { "content-type": "application/json", authorization: "[redacted]" }, body: '{"amount":50}', bodySize: 13, truncated: undefined });
    expect(x.response).toMatchObject({ status: 422, body: '{"title":"Insufficient funds"}' });
  });

  it("has nothing to show for a request without captured headers or bodies, or for no request", () => {
    expect(exchangeOf(ev({ request: { method: "GET", url: "/x", status: 500 } }))).toBeUndefined();
    expect(exchangeOf(ev({}))).toBeUndefined();
  });

  it("keeps a request with no answer", () => {
    const x = exchangeOf(ev({ request: { method: "GET", url: "/x", headers: { accept: "*/*" } } }))!;
    expect(x.response).toBeUndefined();
    expect(x.request.fullUrl).toBeUndefined();
  });
});
