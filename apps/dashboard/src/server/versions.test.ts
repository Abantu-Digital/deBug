import { describe, expect, it } from "vitest";
import { MemoryStore } from "@debugkit/adapters/memory";
import { bannerText } from "../lib/version-text";
import { buildVersionStatus, DASHBOARD_VERSION, versionStatus } from "./versions";

const rec = (sdk?: string, ingest?: string, at = "2026-11-16T09:00:00.000Z") => ({
  ...(sdk ? { sdk: { version: sdk, seenAt: at } } : {}),
  ...(ingest ? { ingest: { version: ingest, at } } : {}),
});

describe("version status", () => {
  it("is in step when everything runs the same version", () => {
    expect(versionStatus([rec("0.9.0", "0.9.0")], "0.9.0")).toMatchObject({ level: "none", behind: [], newest: "0.9.0" });
  });

  it("shows the banner when the app's SDK is a minor ahead of ingest and the dashboard, naming both and the fix", () => {
    const s = versionStatus([rec("0.8.0", "0.7.2")], "0.7.2", "preview");
    expect(s).toMatchObject({ level: "banner", newest: "0.8.0", command: "npx debugkit upgrade --env preview" });
    expect(s.behind.map((p) => [p.part, p.version])).toEqual([["ingest", "0.7.2"], ["dashboard", "0.7.2"]]);
    expect(bannerText(s)).toBe("Your app sends SDK 0.8.0, but ingest is 0.7.2 and this dashboard is 0.7.2. Newer data and pages won't show until you run:");
  });

  it("calls an ingest that records no version older, once apps have sent anything", () => {
    const s = versionStatus([rec(), rec()], "0.9.0");
    expect(s).toMatchObject({ level: "banner", command: "npx debugkit upgrade" });
    expect(bannerText(s)).toBe("deBug is out of step: ingest predates version tracking. Newer data and pages won't show until you run:");
    expect(versionStatus([], "0.9.0").level).toBe("none");
  });

  it("only notes a patch behind, or an app on an older SDK", () => {
    expect(versionStatus([rec("0.9.1", "0.9.0")], "0.9.1")).toMatchObject({ level: "note", behind: [{ part: "ingest", version: "0.9.0" }] });
    expect(versionStatus([rec("0.7.0", "0.9.0")], "0.9.0")).toMatchObject({ level: "note", behind: [{ part: "sdk", version: "0.7.0" }] });
  });

  it("shows when the dashboard is the one behind", () => {
    expect(versionStatus([rec("0.9.0", "0.9.0")], "0.8.3")).toMatchObject({ level: "banner", behind: [{ part: "dashboard" }] });
  });

  it("takes the newest SDK across apps and the ingest that wrote last", () => {
    const s = versionStatus([rec("0.8.0", "0.8.0", "2026-11-10T00:00:00.000Z"), rec("0.9.0", "0.9.0", "2026-11-16T00:00:00.000Z")], "0.9.0");
    expect(s.parts.map((p) => p.version)).toEqual(["0.9.0", "0.9.0", "0.9.0"]);
    expect(s.level).toBe("none");
  });

  it("reads every app's record from the store, against this dashboard's own version", async () => {
    const store = new MemoryStore();
    await store.registerApp("a");
    await store.recordVersions("a", { sdk: "99.0.0", ingest: DASHBOARD_VERSION, at: "2026-11-16T09:00:00.000Z" });
    const s = await buildVersionStatus(store);
    expect(s.parts.find((p) => p.part === "dashboard")!.version).toBe(DASHBOARD_VERSION);
    expect(s).toMatchObject({ level: "banner", newest: "99.0.0" });
  });
});
