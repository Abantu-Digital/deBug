import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compareVersions, notesBetween, releaseNotes } from "./releases";
import type { DebugkitConfig } from "./state";
import { deployedVersions, upgradePlan } from "./upgrade";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempApp(files: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "debugkit-upgrade-"));
  dirs.push(dir);
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), JSON.stringify(c));
  }
  return dir;
}

const firebase: DebugkitConfig = {
  provider: "firebase",
  appId: "megatron",
  endpoint: "https://africa-south1-acme.cloudfunctions.net/debugIngest",
  ingestKey: "pk_live_abc",
  firebase: { projectId: "acme", region: "africa-south1", location: "africa-south1" },
  dashboardPort: 4400,
  createdAt: "2026-11-01T00:00:00Z",
  hosted: { url: "https://acme-debug.web.app", region: "us-central1", functionName: "debugkitDashboard", site: "acme-debug", deployedAt: "2026-11-01T00:00:00Z" },
};
const aws: DebugkitConfig = {
  ...firebase,
  provider: "aws",
  firebase: undefined,
  hosted: undefined,
  aws: { region: "af-south-1", table: "debugkit", functionName: "debugkit-ingest-debugkit", roleName: "r" },
};

const CHANGELOG_A = `# @debugkit/sdk

## 0.8.0

### Patch Changes

- 4ed7eb7: Customer lookup: a Customers page that finds sessions.
- 95d7bbb: Session timeline: a page per session.
- Updated dependencies [4ed7eb7]

## 0.7.0

### Minor Changes

- c823532: \`npx debugkit init\` runs start to finish. Hosting is offered next.
`;
const CHANGELOG_B = `# @debugkit/dashboard

## 0.8.0

- 4ed7eb7: Customer lookup: a Customers page that finds sessions.

## 0.6.1

- d0109e2: Fixes from the first pilot on a real React Native app.
`;

describe("release notes", () => {
  it("keeps each change's headline once, newest version first", () => {
    expect(releaseNotes([CHANGELOG_A, CHANGELOG_B])).toEqual([
      { version: "0.8.0", headlines: ["Customer lookup", "Session timeline"] },
      { version: "0.7.0", headlines: ["`npx debugkit init` runs start to finish"] },
      { version: "0.6.1", headlines: ["Fixes from the first pilot on a real React Native app"] },
    ]);
  });

  it("lists the versions after the deployed one, up to the CLI's, oldest first", () => {
    const notes = releaseNotes([CHANGELOG_A, CHANGELOG_B]);
    expect(notesBetween(notes, "0.6.1", "0.8.0")).toEqual(["0.7.0: `npx debugkit init` runs start to finish", "0.8.0: Customer lookup; Session timeline"]);
    expect(notesBetween(notes, "0.8.0", "0.8.0")).toEqual([]);
  });

  it("compares versions by number, not text", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("^0.7.2", "0.7.2")).toBe(0);
    expect(compareVersions(undefined, "0.1.0")).toBeLessThan(0);
  });

  it("reads this repo's changelogs", () => {
    const text = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
    expect(releaseNotes([text]).find((n) => n.version === "0.8.0")?.headlines).toContain("Customer lookup");
  });
});

describe("deployed versions", () => {
  it("uses the versions saved in the config", () => {
    const cfg = { ...firebase, version: "0.8.1", hosted: { ...firebase.hosted!, version: "0.8.0" } };
    expect(deployedVersions(tempApp(), cfg)).toEqual({ ingest: "0.8.1", dashboard: "0.8.0" });
  });

  it("reads an older Firebase setup from what npm installed, or else the range it asked for", () => {
    const dir = tempApp({
      ".debugkit/firebase/functions/package.json": { dependencies: { "@debugkit/ingest": "^0.7.0" } },
      ".debugkit/firebase/functions/node_modules/@debugkit/ingest/package.json": { version: "0.7.2" },
      ".debugkit/firebase/dashboard/package.json": { dependencies: { "@debugkit/dashboard": "^0.6.1" } },
    });
    expect(deployedVersions(dir, firebase)).toEqual({ ingest: "0.7.2", dashboard: "0.6.1" });
  });

  it("doesn't know an older AWS setup's version, and has no dashboard without hosting", () => {
    expect(deployedVersions(tempApp(), aws)).toEqual({ ingest: undefined, dashboard: undefined });
  });
});

describe("upgrade plan", () => {
  const notes = releaseNotes([CHANGELOG_A, CHANGELOG_B]);

  it("shows each part from its version to the CLI's, and what changed since the oldest", () => {
    const plan = upgradePlan(firebase, { ingest: "0.7.0", dashboard: "0.6.1" }, "0.8.0", notes);
    expect(plan.tooOld).toBeUndefined();
    expect(plan.upToDate).toBe(false);
    expect(plan.lines.join("\n")).toMatch(/Ingest.*0\.7\.0 → 0\.8\.0/);
    expect(plan.lines.join("\n")).toMatch(/Firestore indexes/);
    expect(plan.lines.join("\n")).toMatch(/Hosted dashboard.*0\.6\.1 → 0\.8\.0.*acme-debug\.web\.app/);
    expect(plan.notes).toEqual(["0.7.0: `npx debugkit init` runs start to finish", "0.8.0: Customer lookup; Session timeline"]);
  });

  it("refuses when something deployed is newer than the CLI", () => {
    const plan = upgradePlan(firebase, { ingest: "0.9.0", dashboard: "0.8.0" }, "0.8.0", notes);
    expect(plan.tooOld).toMatch(/0\.9\.0, newer than this CLI \(0\.8\.0\)/);
    expect(plan.tooOld).toMatch(/@debugkit\/cli@0\.9\.0 upgrade/);
  });

  it("is up to date only when every part is known to be at the CLI's version", () => {
    expect(upgradePlan(firebase, { ingest: "0.8.0", dashboard: "0.8.0" }, "0.8.0", notes).upToDate).toBe(true);
    expect(upgradePlan(firebase, { ingest: "0.8.0" }, "0.8.0", notes).upToDate).toBe(false);
  });

  it("on AWS has no indexes, and lists no notes when the version isn't recorded", () => {
    const plan = upgradePlan(aws, {}, "0.8.0", notes);
    expect(plan.lines.join("\n")).not.toMatch(/indexes/);
    expect(plan.lines.join("\n")).toMatch(/Lambda debugkit-ingest-debugkit in af-south-1/);
    expect(plan.lines.join("\n")).toMatch(/not set up/);
    expect(plan.notes).toEqual([]);
  });
});
