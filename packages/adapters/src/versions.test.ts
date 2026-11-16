import { describe, expect, it } from "vitest";
import { MemoryStore } from "./memory";
import { compareVersions, mergeVersions, versionKey } from "./versions";

describe("versions", () => {
  it("orders by semver, not as text, with prereleases below their release", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-beta.2", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0-beta.10", "1.0.0-beta.2")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-beta", "1.0.0-beta.1")).toBeLessThan(0);
    expect(compareVersions("1.0.0-1", "1.0.0-alpha")).toBeLessThan(0);
    expect(compareVersions("v0.8.0", "0.8.0+build.5")).toBe(0);
    expect(compareVersions("dev", "0.1.0")).toBeLessThan(0);
    expect(versionKey("not a version")).toBeUndefined();
    expect([versionKey("0.9.0"), versionKey("0.10.0-rc.1"), versionKey("0.10.0")].sort()).toEqual([versionKey("0.9.0"), versionKey("0.10.0-rc.1"), versionKey("0.10.0")]);
  });

  it("keeps the newest SDK and the latest ingest", () => {
    const a = mergeVersions(undefined, { sdk: "0.8.0", ingest: "0.8.0", at: "t1" });
    const b = mergeVersions(a, { sdk: "0.7.2", ingest: "0.8.1", at: "t2" });
    expect(b).toEqual({ sdk: { version: "0.8.0", seenAt: "t1" }, ingest: { version: "0.8.1", at: "t2" } });
    expect(mergeVersions(b, { sdk: "garbage", ingest: "0.8.1", at: "t3" }).sdk).toEqual({ version: "0.8.0", seenAt: "t1" });
    // Seen again: the same version's time moves on.
    expect(mergeVersions(b, { sdk: "0.8.0", ingest: "0.8.1", at: "t4" }).sdk).toEqual({ version: "0.8.0", seenAt: "t4" });
  });

  it("is recorded and read back by the memory store", async () => {
    const s = new MemoryStore();
    expect(await s.getVersions("a")).toEqual({});
    await s.recordVersions("a", { sdk: "0.8.0", ingest: "0.8.0", at: "t1" });
    await s.recordVersions("a", { sdk: "0.7.2", ingest: "0.8.0", at: "t2" });
    expect(await s.getVersions("a")).toEqual({ sdk: { version: "0.8.0", seenAt: "t1" }, ingest: { version: "0.8.0", at: "t2" } });
  });
});
