import { describe, expect, it } from "vitest";
import { rangeBounds, resolveRange } from "./range";

const NOW = Date.parse("2026-11-16T12:00:00.000Z");

describe("rangeBounds", () => {
  it("is the last 24 hours for 24h", () => {
    expect(rangeBounds(resolveRange({ range: "24h" }, NOW), NOW)).toEqual({ start: "2026-11-15T12:00:00.000Z", end: "2026-11-16T12:00:00.000Z" });
  });

  it("is whole UTC days for a custom range, so later occurrences stay out", () => {
    expect(rangeBounds(resolveRange({ range: "custom", from: "2026-11-01", to: "2026-11-03" }, NOW), NOW)).toEqual({ start: "2026-11-01T00:00:00.000Z", end: "2026-11-03T23:59:59.999Z" });
  });
});
