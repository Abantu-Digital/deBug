import { describe, expect, it, vi } from "vitest";
import { Envelope, type Event } from "@debugkit/schema";
import { DebugClient } from "./client";
import { describeTouchTarget, touchHandlers } from "./touch";

function setup() {
  const sent: Event[] = [];
  const fetch = vi.fn(async (_u: string, init: { body: string }) => {
    sent.push(...Envelope.parse(JSON.parse(init.body)).events);
    return new Response("", { status: 202 });
  });
  const options = {
    endpoint: "https://ingest.example/x",
    ingestKey: "pk_test",
    app: { id: "app" },
    fetch: fetch as unknown as typeof globalThis.fetch,
    flushIntervalMs: 0,
    autoCapture: false as const,
  };
  return { c: new DebugClient().init(options), sent, options };
}

/** A touched Text inside a Pressable with a label, inside a screen. */
const fiber = (props: Record<string, unknown>[]) =>
  props.reduceRight<{ memoizedProps: Record<string, unknown>; return: unknown } | null>((parent, p) => ({ memoizedProps: p, return: parent }), null);
const touch = (x: number, y: number, t: number, inst?: unknown) => ({ nativeEvent: { pageX: x, pageY: y, timestamp: t }, _targetInst: inst as never });

const trail = async (c: DebugClient, sent: Event[]) => {
  c.error(new Error("boom"));
  await c.flush();
  const e = sent.find((x) => x.type === "error");
  if (e?.type !== "error") throw new Error("expected an error");
  return e.breadcrumbs ?? [];
};

describe("describeTouchTarget", () => {
  it("names the nearest element with a label or testID, preferring neither", () => {
    expect(describeTouchTarget(fiber([{ children: "Buy" }, { accessibilityLabel: "Buy now", testID: "buy-button" }, { testID: "screen" }]) as never)).toEqual({
      label: "Buy now",
      testID: "buy-button",
    });
    expect(describeTouchTarget(fiber([{ value: "0841234567" }, { "aria-label": "Phone" }]) as never)).toEqual({ label: "Phone", testID: undefined });
    expect(describeTouchTarget(fiber([{ children: "x" }]) as never)).toBeUndefined();
    expect(describeTouchTarget(null)).toBeUndefined();
  });
});

describe("taps", () => {
  it("masks phone numbers and emails in labels and testIDs", () => {
    expect(describeTouchTarget(fiber([{ accessibilityLabel: "Call 0821234567", testID: "row-a.b@example.co.za" }]) as never)).toEqual({
      label: "Call •••",
      testID: "•••", // the email mask takes the whole token
    });
  });

  it("records a tap by label, with the testID and the screen", async () => {
    const { c, sent } = setup();
    c.navigated("/buy");
    const h = touchHandlers(c);
    h.onTouchStart(touch(10, 10, 1000, fiber([{}, { accessibilityLabel: "Buy now", testID: "buy-button" }])));
    h.onTouchEnd(touch(12, 11, 1100));
    const crumbs = await trail(c, sent);
    expect(crumbs.at(-1)).toMatchObject({ category: "ui", message: 'Tapped "Buy now"', data: { label: "Buy now", testID: "buy-button", screen: "/buy" } });
  });

  it("can prefer the testID, and skips ignored ones", async () => {
    const { c, sent } = setup();
    const h = touchHandlers(c, { labelFrom: "testID", ignoreTestIDs: ["debug-"] });
    h.onTouchStart(touch(0, 0, 0, fiber([{ accessibilityLabel: "Pay", testID: "pay-button" }])));
    h.onTouchEnd(touch(0, 0, 50));
    h.onTouchStart(touch(0, 0, 100, fiber([{ testID: "debug-shake" }])));
    h.onTouchEnd(touch(0, 0, 150));
    const crumbs = await trail(c, sent);
    expect(crumbs.filter((b) => b.category === "ui").map((b) => b.message)).toEqual(["Tapped pay-button"]);
  });

  it("ignores scrolls, long presses, unnamed elements and a touch end with no start", async () => {
    const { c, sent } = setup();
    const h = touchHandlers(c);
    const named = fiber([{ testID: "row" }]);
    h.onTouchStart(touch(0, 0, 0, named));
    h.onTouchEnd(touch(0, 80, 200)); // a scroll
    h.onTouchStart(touch(0, 0, 0, named));
    h.onTouchEnd(touch(0, 0, 600)); // a long press
    h.onTouchStart({ ...touch(0, 0, 0, named), nativeEvent: { pageX: 0, pageY: 0, timestamp: 0, touches: [{}, {}] } });
    h.onTouchEnd(touch(0, 0, 50)); // a second finger: a pinch
    h.onTouchStart(touch(0, 0, 0, fiber([{}])));
    h.onTouchEnd(touch(0, 0, 10)); // nothing to name it by
    h.onTouchEnd(touch(0, 0, 10));
    const crumbs = await trail(c, sent);
    expect(crumbs.filter((b) => b.category === "ui")).toEqual([]);
  });

  it("never throws into the app, and records nothing after close()", async () => {
    const { c, sent, options } = setup();
    const h = touchHandlers(c);
    const hostile = { get memoizedProps(): never { throw new Error("no"); } };
    expect(() => h.onTouchStart(touch(0, 0, 0, hostile))).not.toThrow();
    expect(() => h.onTouchEnd({} as never)).not.toThrow();
    await c.close();
    h.onTouchStart(touch(0, 0, 0, fiber([{ testID: "x" }])));
    h.onTouchEnd(touch(0, 0, 10));
    c.init(options);
    expect((await trail(c, sent)).filter((b) => b.category === "ui")).toEqual([]);
  });
});
