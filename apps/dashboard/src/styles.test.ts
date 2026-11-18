import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Comments dropped so a brace in one can't end a block early. */
const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const LEVELS = ["critical", "high", "medium", "low", "healthy"] as const;

/** The custom properties set in the first block that matches `opener`. */
function tokens(opener: RegExp): Map<string, string> {
  const start = css.search(opener);
  const body = css.slice(start, css.indexOf("}", start));
  return new Map([...body.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1]!, m[2]!.toLowerCase()]));
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const themes = { light: tokens(/:root\s*\{/), dark: tokens(/prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{/) };

describe.each(Object.entries(themes))("level colours, %s theme", (_name, t) => {
  it.each(LEVELS)("%s text passes 4.5:1 on its surface", (level) => {
    const fg = t.get(`--level-${level}-fg`);
    const bg = t.get(`--level-${level}-bg`);
    expect(fg && bg).toBeTruthy();
    expect(contrast(fg!, bg!)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(LEVELS)("%s text passes 4.5:1 on the panel too (tiles put it there)", (level) => {
    expect(contrast(t.get(`--level-${level}-fg`)!, t.get("--panel")!)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(LEVELS)("%s edge stands out from the panel (3:1, WCAG 1.4.11 for UI boundaries)", (level) => {
    expect(contrast(t.get(`--level-${level}-edge`)!, t.get("--panel")!)).toBeGreaterThanOrEqual(3);
  });
});
