import { describe, expect, it } from "vitest";
import { ErrorEvent, MAX_CAPTURED_BODY } from "./index";

const base = { id: "evt-00000001", ts: "2026-11-16T10:00:00.000Z", type: "error" as const, error: { message: "POST /x responded 500" } };

describe("a failed call's captured request and response", () => {
  it("is cut to size on the way in, not rejected", () => {
    const long = "x".repeat(MAX_CAPTURED_BODY * 2);
    const e = ErrorEvent.parse({
      ...base,
      request: { method: "POST", url: "/x", status: 500, query: long, headers: { a: "y".repeat(3000) }, body: long, bodySize: long.length, truncated: true },
      response: { status: 500, body: long },
    });
    expect(e.request?.body).toHaveLength(MAX_CAPTURED_BODY + "…[truncated]".length);
    expect(e.request?.query?.endsWith("…[truncated]")).toBe(true);
    expect(e.request?.headers?.a).toHaveLength(2000);
    expect(e.response?.body?.endsWith("…[truncated]")).toBe(true);
  });

  it("keeps a body the SDK already cut, with its marker, as it is", () => {
    const cut = `${"x".repeat(MAX_CAPTURED_BODY)}…[truncated, 40 KB total]`;
    expect(ErrorEvent.parse({ ...base, response: { status: 502, body: cut } }).response?.body).toBe(cut);
  });

  it("keeps at most 100 headers", () => {
    const headers = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`h${i}`, "v"]));
    expect(Object.keys(ErrorEvent.parse({ ...base, response: { status: 500, headers } }).response?.headers ?? {})).toHaveLength(100);
  });
});
