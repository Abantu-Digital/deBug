import { describe, expect, it, vi } from "vitest";
import type { ReadStore } from "@debugkit/adapters";
import { seedDemo } from "./demo";
import { warmUp } from "./warm";

describe("warmUp", () => {
  it("reads the first app's summary and endpoints", async () => {
    const store = await seedDemo();
    const rollups = vi.spyOn(store, "getRollups");
    await warmUp(store as ReadStore);
    expect(rollups).toHaveBeenCalled();
  });

  it("does nothing when no app has sent anything", async () => {
    const listIssues = vi.fn();
    await warmUp({ listApps: async () => [], listIssues } as unknown as ReadStore);
    expect(listIssues).not.toHaveBeenCalled();
  });
});
