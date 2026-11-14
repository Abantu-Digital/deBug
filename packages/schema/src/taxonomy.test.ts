import { describe, expect, it } from "vitest";
import * as core from "./core";
import { CATEGORIES, CATEGORY_INFO, CAUSES, CAUSE_INFO, IMPACTS, IMPACT_INFO, IMPACT_ORDER, OWNERS, OWNER_INFO } from "./taxonomy";

const sets = [
  ["category", CATEGORIES, CATEGORY_INFO],
  ["owner", OWNERS, OWNER_INFO],
  ["impact", IMPACTS, IMPACT_INFO],
  ["cause", CAUSES, CAUSE_INFO],
] as const;

describe("taxonomy", () => {
  it.each(sets)("every %s id has plain-language text, and nothing extra", (_name, ids, info) => {
    expect(Object.keys(info).sort()).toEqual([...ids].sort());
    for (const id of ids) {
      const { label, description } = (info as Record<string, { label: string; description: string }>)[id]!;
      expect(label.length).toBeGreaterThan(0);
      expect(label.length).toBeLessThanOrEqual(40);
      expect(description).toMatch(/\.$/);
    }
  });

  it("uses lowercase dotted ids, so they're safe in URLs, filters and rules", () => {
    for (const [, ids] of sets) for (const id of ids) expect(id).toMatch(/^[a-z_]+(\.[a-z_]+)?$/);
  });

  it("orders impact worst first", () => {
    expect([...IMPACTS].sort((a, b) => IMPACT_ORDER[b] - IMPACT_ORDER[a])).toEqual([...IMPACTS]);
  });

  it("is on the zod-free entry, so the SDK and dashboard can import it without validators", () => {
    expect(core.CATEGORIES).toBe(CATEGORIES);
    expect(core.CATEGORY_INFO).toBe(CATEGORY_INFO);
  });

  it("documents every id in docs/taxonomy.md", async () => {
    const { readFileSync } = await import("node:fs");
    const doc = readFileSync(new URL("../../../docs/taxonomy.md", import.meta.url), "utf8");
    for (const [, ids] of sets) for (const id of ids) expect(doc, id).toContain(`\`${id}\``);
  });
});
