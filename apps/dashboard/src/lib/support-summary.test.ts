import { describe, expect, it } from "vitest";
import { maskCustomer, screensOf, supportSummary, ticketText } from "./support-summary";
import type { TimelineItem } from "~/server/event";

const item = (category: TimelineItem["category"], message: string, extra: Partial<TimelineItem> = {}): TimelineItem => ({ ts: "2026-11-16T10:42:00.000Z", category, message, level: "info", failed: false, ...extra });
const base = {
  ts: "2026-11-16T10:42:05.000Z",
  user: { id: "27841234567", anonymousId: "inst-1" },
  context: { app: { id: "a", version: "10.1.28" }, os: { name: "android", version: "15" }, runtime: { name: "react-native" }, device: {} },
  error: { name: "HttpError", message: "POST /payments/pay responded 402" },
  handled: true,
  timeline: [
    item("navigation", "Dashboard"),
    item("navigation", "Dashboard → Buy"),
    item("navigation", "Buy → Checkout"),
    item("ui", "Tapped \"Pay\"", { data: { label: "Pay", screen: "Checkout" } }),
  ],
  request: { service: "payments", method: "POST", path: "/payments/pay", status: 402, backendTitle: "Insufficient funds", traceId: "4f2c9a1b", failed: true },
  after: [item("ui", "Showed \"Payment failed\""), item("navigation", "Checkout → Buy")],
};
const at = () => "10:42";

describe("support summary", () => {
  it("tells the ticket's example story", () => {
    expect(supportSummary(base as never, at).sentences.join(" ")).toBe(
      '10:42 · Customer 084•••4567 on Android 15, app 10.1.28.' +
        ' Went Dashboard → Buy → Checkout, tapped "Pay". The payments service answered 402 "Insufficient funds" (trace 4f2c…). They saw "Payment failed" and went back to Buy.',
    );
  });

  it("says what it can when less was recorded", () => {
    const s = supportSummary({ ...base, user: {}, timeline: [], request: undefined, after: [], handled: false, error: { name: "TypeError", message: "x is undefined" } } as never, at);
    expect(s.sentences).toEqual(["10:42 · A signed-out customer on Android 15, app 10.1.28.", "The app hit an error: TypeError: x is undefined."]);
  });

  it("puts an unanswered call and an expired session in plain words", () => {
    const off = supportSummary({ ...base, request: { service: "balance", status: undefined, outcome: "unreachable", failed: true } } as never, at);
    expect(off.sentences[2]).toBe("The balance service didn't answer (unreachable).");
    const expired = supportSummary({ ...base, request: { service: "auth", status: 401, outcome: "sessionExpired", failed: true } } as never, at);
    expect(expired.sentences[2]).toBe("The auth service said their session had expired (401).");
  });

  it("copies the summary with the event link and the trace id", () => {
    const text = ticketText(supportSummary(base as never, at), "https://debug.example/events/e1", "4f2c9a1b");
    expect(text.split("\n")).toEqual([expect.stringMatching(/^10:42 · Customer 084•••4567/), "", "Event: https://debug.example/events/e1", "Trace: 4f2c9a1b"]);
  });

  it("masks customer numbers and reads screens from navigation", () => {
    expect(maskCustomer("0841234567")).toBe("084•••4567");
    expect(maskCustomer("+27 84 123 4567")).toBe("084•••4567");
    expect(maskCustomer("user_183")).toBe("user_183");
    expect(maskCustomer("cust-000123456")).toBe("cus•••456");
    expect(screensOf([item("navigation", "Login → Otp"), item("navigation", "Otp → Otp"), item("navigation", "Otp → Home")])).toEqual(["Login", "Otp", "Home"]);
  });
});
