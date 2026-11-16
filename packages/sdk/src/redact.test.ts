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

describe("redactText leaks found in review", () => {
  it("redacts fields in JSON cut short (a body read only up to its first 64 KB)", () => {
    const cut = `{"password":"hunter2","otp": 123456,"items":[{"name":"a","pin":"1234"},{"name":"b`;
    const out = redactText(cut);
    expect(out).not.toMatch(/hunter2|123456|1234"/);
    expect(out).toContain('"items":[{"name":"a"');
  });

  it("masks a card number sent as a JSON number, and leaves other numbers alone", () => {
    expect(JSON.parse(redactText(JSON.stringify({ number: 4111111111111111, amount: 1500, msisdn: 27841234567 })))).toEqual({
      number: "•••• 1111",
      amount: 1500,
      msisdn: 27841234567,
    });
  });

  it("redacts JSON and forms held inside a string field", () => {
    const body = { payload: JSON.stringify({ otp: "123456", to: "084" }), query: "pin=1234&page=2" };
    const out = JSON.parse(redactText(JSON.stringify(body)));
    expect(JSON.parse(out.payload)).toEqual({ otp: "[redacted]", to: "084" });
    expect(out.query).toBe("pin=%5Bredacted%5D&page=2");
  });

  it("redacts forms with keyless pairs and bracketed or dotted keys", () => {
    expect(redactText("flag&token=abc&user[password]=x&card.cvv=1&page=2")).toBe("flag&token=%5Bredacted%5D&user[password]=%5Bredacted%5D&card.cvv=%5Bredacted%5D&page=2");
  });

  it("masks card numbers next to letters and split by dots or underscores", () => {
    expect(redactValues("pan_4111111111111111 and 4111.1111.1111.1111 or 4111_1111_1111_1111")).toBe("pan_•••• 1111 and •••• 1111 or •••• 1111");
    expect(redactValues("id 94111111111111111")).toBe("id 94111111111111111"); // part of a longer number
  });

  it("redacts secret fields in plain text", () => {
    expect(redactText('OTP check failed: otp: 123456, "pin": "9999", msisdn: 0841234567')).toBe('OTP check failed: otp: [redacted], "pin": "[redacted]", msisdn: 0841234567');
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
