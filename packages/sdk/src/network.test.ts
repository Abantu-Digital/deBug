import { describe, expect, it } from "vitest";
import { nameRequest, readProblemDetails } from "./network";

describe("nameRequest", () => {
  // Two services behind one gateway base, as in the Cell C app.
  const bases = ["https://gw.example.com/ppd/api", "https://sms.example.com/ppd/sms/"];

  it.each([
    ["https://gw.example.com/ppd/api/buy/purchase-history?pageSize=20", "buy", "/buy/purchase-history", true],
    ["https://gw.example.com/ppd/api/promo-offers?msisdn=27841234567", "promo-offers", "/promo-offers", true],
    ["https://gw.example.com/ppd/api/profile/contracts/4411/doc", "profile", "/profile/contracts/:id/doc", true],
    ["https://gw.example.com/ppd/api/profile/a@b.co#top", "profile", "/profile/:id", true],
    ["https://gw.example.com/ppd/api", "/", "/", true],
    ["https://sms.example.com/ppd/sms/send", "send", "/send", true],
    // A base must end on a segment boundary.
    ["https://sms.example.com/ppd/smsHistory/list", "sms.example.com", "/ppd/smsHistory/list", false],
    ["https://other.example.com/v1/orders/8812", "other.example.com", "/v1/orders/:id", false],
    ["https://other.example.com", "other.example.com", "/", false],
    ["/v1/feed", "v1", "/v1/feed", false],
  ])("%s is %s %s", (url, service, path, matched) => {
    expect(nameRequest(url, bases)).toEqual({ service, path, matched });
  });

  it("names by host when no base URLs are set", () => {
    expect(nameRequest("https://api.x.com/v1/me")).toEqual({ service: "api.x.com", path: "/v1/me", matched: false });
  });
});

describe("readProblemDetails", () => {
  it("reads RFC 9457 problem details", () => {
    expect(
      readProblemDetails(JSON.stringify({ type: "about:blank", title: "Insufficient airtime", status: 422, code: 4021, traceId: "00-4f2c", errors: ["balance too low", "try a smaller bundle"] })),
    ).toEqual({ backendTitle: "Insufficient airtime", backendCode: 4021, traceId: "00-4f2c", backendErrors: "balance too low; try a smaller bundle" });
  });

  it("flattens ASP.NET validation errors and reads common variants", () => {
    expect(readProblemDetails(JSON.stringify({ message: "Invalid", code: "PAY-402", trace_id: "abc", errors: { Amount: ["too high", "not a number"], Msisdn: "required" } }))).toEqual({
      backendTitle: "Invalid",
      backendCode: "PAY-402",
      traceId: "abc",
      backendErrors: "Amount: too high, not a number; Msisdn: required",
    });
    expect(readProblemDetails(JSON.stringify({ error: "Gone", correlationId: "c-1", errors: [{ message: "m" }, { detail: "d" }, 3] }))).toEqual({
      backendTitle: "Gone",
      backendCode: null,
      traceId: "c-1",
      backendErrors: "m; d",
    });
  });

  it("masks phone numbers and emails the backend quotes", () => {
    expect(readProblemDetails(JSON.stringify({ title: "0821234567 not found", errors: ["mail a.b@example.co.za failed", "+27 82 123 4567"] }))).toMatchObject({
      backendTitle: "••• not found",
      backendErrors: "mail ••• failed; •••",
    });
  });

  it("matches a base without case in the scheme and host", () => {
    expect(nameRequest("HTTPS://GW.Example.com/ppd/api/buy/x", ["https://gw.example.com/ppd/api"])).toEqual({ service: "buy", path: "/buy/x", matched: true });
  });

  it("caps long text", () => {
    const d = readProblemDetails(JSON.stringify({ title: "t".repeat(300), errors: ["e".repeat(900)] }));
    expect(d?.backendTitle).toHaveLength(200);
    expect(d?.backendErrors).toHaveLength(500);
  });

  it.each([undefined, "", "<html>502 Bad Gateway</html>", "[1,2]", "null", "{}", JSON.stringify({ status: 500, errors: [] })])(
    "says nothing for %j",
    (body) => {
      expect(readProblemDetails(body)).toBeUndefined();
    },
  );
});
