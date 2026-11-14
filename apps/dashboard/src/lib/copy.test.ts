import { describe, expect, it, vi } from "vitest";
import { copyText } from "./copy";

function fakeDoc(execResult: boolean | Error) {
  const area = { value: "", style: {} as Record<string, string>, setAttribute: vi.fn(), select: vi.fn(), remove: vi.fn() };
  const doc = {
    createElement: vi.fn(() => area),
    body: { appendChild: vi.fn() },
    execCommand: vi.fn(() => {
      if (execResult instanceof Error) throw execResult;
      return execResult;
    }),
  };
  return { doc: doc as unknown as Document, area };
}

describe("copyText", () => {
  it("uses the Clipboard API when it's allowed", async () => {
    const writeText = vi.fn(async () => {});
    const { doc } = fakeDoc(true);
    expect(await copyText("hello", doc, { clipboard: { writeText } } as unknown as Navigator)).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(doc.execCommand).not.toHaveBeenCalled();
  });

  it("falls back to a hidden textarea when the clipboard is blocked, and cleans up", async () => {
    const nav = { clipboard: { writeText: vi.fn(async () => Promise.reject(new Error("NotAllowedError"))) } } as unknown as Navigator;
    const { doc, area } = fakeDoc(true);
    expect(await copyText("## Ticket", doc, nav)).toBe(true);
    expect(area.value).toBe("## Ticket");
    expect(doc.execCommand).toHaveBeenCalledWith("copy");
    expect(area.remove).toHaveBeenCalled();
  });

  it("reports failure when neither works", async () => {
    const nav = {} as Navigator; // no clipboard at all
    const { doc, area } = fakeDoc(new Error("blocked"));
    expect(await copyText("x", doc, nav)).toBe(false);
    expect(area.remove).toHaveBeenCalled();
  });
});
