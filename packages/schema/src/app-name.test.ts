import { describe, expect, it } from "vitest";
import { appLabel, validAppName } from "./app-name";

describe("app display names", () => {
  it("cleans a name, and takes an empty one to mean the id", () => {
    expect(validAppName("  Megatron   Native ")).toEqual({ name: "Megatron Native" });
    expect(validAppName("")).toEqual({ name: "" });
    expect(validAppName("   ")).toEqual({ name: "" });
  });

  it("rejects what isn't a short line of text", () => {
    expect(validAppName(42)).toMatch(/text/);
    expect(validAppName("a\nb")).toMatch(/line breaks/);
    expect(validAppName("x".repeat(61))).toMatch(/60/);
  });

  it("shows the name, else the id", () => {
    expect(appLabel("megatron-native", "Megatron Native")).toBe("Megatron Native");
    expect(appLabel("megatron-native", "")).toBe("megatron-native");
    expect(appLabel("megatron-native", undefined)).toBe("megatron-native");
  });
});
