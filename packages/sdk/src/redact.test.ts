import { describe, expect, it } from "vitest";
import { binaryBody, captureBody, redactHeaders, redactText, redactValues } from "./redact";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl";
const CARD = "4111 1111 1111 1111"; // passes Luhn

describe("redactHeaders", () => {
  it("redacts auth, cookies and any header named for a token, key or secret, and keeps the rest", () => {
    expect(
      redactHeaders({
        Authorization: "Bearer abc",
        Cookie: "s=1",
        "Set-Cookie": "s=2",
        "x-id-token": "t",
        "X-Api-Key": "k",
        "client-secret": "c",
        "Content-Type": "application/json",
        "x-acting-as-msisdn": "27841234567",
        "x-trace": `jwt ${JWT}`,
      }),
    ).toEqual({
      authorization: "[redacted]",
      cookie: "[redacted]",
      "set-cookie": "[redacted]",
      "x-id-token": "[redacted]",
      "x-api-key": "[redacted]",
      "client-secret": "[redacted]",
      "content-type": "application/json",
      "x-acting-as-msisdn": "27841234567",
      "x-trace": "jwt [redacted]",
    });
  });

  it("redacts headers the app names", () => {
    expect(redactHeaders({ "x-device-pin": "1", "x-session": "2" }, { headers: ["X-Session"] })).toEqual({ "x-device-pin": "1", "x-session": "[redacted]" });
  });

  it("leaves no headers as none", () => {
    expect(redactHeaders(undefined)).toBeUndefined();
  });
});

describe("redactText", () => {
  it("redacts secret fields at any depth, without case, and keeps everything else", () => {
    const body = {
      msisdn: "0841234567",
      Password: "hunter2",
      otpCode: "123456",
      card: { cardNumber: CARD, CVV: "123", expiry: "12/29", holder: "N Dlamini" },
      tokens: [{ accessToken: "a", refreshToken: "r", idToken: "i" }],
      pin: "1234",
      code: 4021,
      amount: 25,
      nested: { verificationCode: "9", apiKey: "k", secret: "s", token: "t", pan: "p", cvc: "c", otp: "o" },
    };
    expect(JSON.parse(redactText(JSON.stringify(body)))).toEqual({
      msisdn: "0841234567",
      Password: "[redacted]",
      otpCode: "[redacted]",
      card: { cardNumber: "[redacted]", CVV: "[redacted]", expiry: "12/29", holder: "N Dlamini" },
      tokens: [{ accessToken: "[redacted]", refreshToken: "[redacted]", idToken: "[redacted]" }],
      pin: "[redacted]",
      code: 4021,
      amount: 25,
      nested: { verificationCode: "[redacted]", apiKey: "[redacted]", secret: "[redacted]", token: "[redacted]", pan: "[redacted]", cvc: "[redacted]", otp: "[redacted]" },
    });
  });

  it("masks JWTs and card numbers in any field, but not other long numbers", () => {
    expect(JSON.parse(redactText(JSON.stringify({ ref: JWT, note: `card ${CARD}`, orderId: "1234567890123456", phone: "27841234567" })))).toEqual({
      ref: "[redacted]",
      note: "card •••• 1111",
      orderId: "1234567890123456", // fails Luhn: an id, not a card
      phone: "27841234567",
    });
  });

  it("redacts the fields the app names", () => {
    expect(JSON.parse(redactText(JSON.stringify({ idNumber: "8001015009087", name: "x" }), { fields: ["IdNumber"] }))).toEqual({ idNumber: "[redacted]", name: "x" });
  });

  it("redacts forms and query strings by key", () => {
    expect(redactText("msisdn=0841234567&password=hunter2&Otp=1&page=2")).toBe("msisdn=0841234567&password=%5Bredacted%5D&Otp=%5Bredacted%5D&page=2");
    expect(redactText("a=1&token=eyJx")).toBe("a=1&token=%5Bredacted%5D");
  });

  it("masks values in plain text and in JSON that doesn't parse", () => {
    expect(redactText(`Bearer ${JWT} failed for ${CARD}`)).toBe("Bearer [redacted] failed for •••• 1111");
    expect(redactText(`{"broken": "${JWT}"`)).toBe('{"broken": "[redacted]"');
  });
});

describe("captureBody", () => {
  it("redacts, then cuts a long body with a marker saying how big it was", () => {
    const long = JSON.stringify({ password: "x", data: "a".repeat(20_000) });
    const out = captureBody(long, 16_384);
    expect(out.truncated).toBe(true);
    expect(out.body?.startsWith('{"password":"[redacted]"')).toBe(true);
    expect(out.body).toMatch(/…\[truncated, 20 KB total\]$/);
    expect(out.body?.length).toBe(16_384 + "…[truncated, 20 KB total]".length);
    expect(out.bodySize).toBe(JSON.stringify({ password: "[redacted]", data: "a".repeat(20_000) }).length);
  });

  it("keeps a short body whole, and records nothing for none", () => {
    expect(captureBody('{"a":1}', 16_384)).toEqual({ body: '{"a":1}', bodySize: 7 });
    expect([captureBody(undefined, 10), captureBody("", 10)]).toEqual([{}, {}]);
  });

  it("describes a binary body by size and type only", () => {
    expect(binaryBody(412 * 1024, "application/pdf")).toEqual({ body: "[binary 412 KB, application/pdf]", bodySize: 412 * 1024 });
    expect(binaryBody(undefined, undefined)).toEqual({ body: "[binary]", bodySize: undefined });
  });
});

describe("redactValues", () => {
  it("leaves ordinary text alone", () => {
    expect(redactValues("Insufficient airtime for 0841234567")).toBe("Insufficient airtime for 0841234567");
  });
});
