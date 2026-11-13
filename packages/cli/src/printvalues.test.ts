import { describe, expect, it, vi } from "vitest";
import { printValues } from "./wire";

describe("values to copy", () => {
  it("are printed as plain lines, with no box characters", () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((s: string) => void lines.push(s));
    printValues("Set these:", { EXPO_PUBLIC_DEBUG_ENDPOINT: "https://africa-south1-x.cloudfunctions.net/debugIngest" });
    spy.mockRestore();
    expect(lines[0]).toBe("EXPO_PUBLIC_DEBUG_ENDPOINT=https://africa-south1-x.cloudfunctions.net/debugIngest");
    expect(lines.join("")).not.toMatch(/[│┃|]/);
  });
});
