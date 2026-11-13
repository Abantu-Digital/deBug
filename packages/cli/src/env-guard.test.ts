import { mkdtempSync, rmSync, writeFileSync as write } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dynamoTableUsedBy, environment, firebaseProjectUsedBy, writeConfig } from "./state";

/**
 * Each environment needs its own backend: in Project Megatron Native, preview is cellc-staging
 * and production cellc-8711b. init uses these checks to refuse a project another one already has.
 */
const dirs: string[] = [];
const tempApp = () => {
  const dir = mkdtempSync(join(tmpdir(), "debugkit-guard-"));
  write(join(dir, "package.json"), "{}");
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  environment.set(undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("one backend per environment", () => {
  type Cfg = Parameters<typeof writeConfig>[1];
  const base = { appId: "cell-c", ingestKey: "pk", dashboardPort: 4400, createdAt: "t" };
  const fb = (projectId: string): Cfg => ({ ...base, provider: "firebase", endpoint: `https://${projectId}`, firebase: { projectId, region: "africa-south1", location: "africa-south1" } });

  function megatron() {
    const dir = tempApp();
    environment.set("preview");
    writeConfig(dir, fb("cellc-staging"));
    return dir;
  }

  it("refuses production on preview's Firebase project, and accepts its own", () => {
    const dir = megatron();
    environment.set("production");
    expect(firebaseProjectUsedBy(dir, "cellc-staging")).toBe("the preview environment");
    expect(firebaseProjectUsedBy(dir, "cellc-8711b")).toBeUndefined();
  });

  it("lets an environment set itself up again on its own project", () => {
    const dir = megatron();
    environment.set("preview");
    expect(firebaseProjectUsedBy(dir, "cellc-staging")).toBeUndefined();
  });

  it("counts the unnamed setup, and AWS tables per region and account", () => {
    const dir = tempApp();
    writeConfig(dir, { ...base, provider: "aws", endpoint: "https://l", aws: { region: "af-south-1", table: "debugkit", functionName: "f", roleName: "r", account: "111" } });
    environment.set("preview");
    expect(dynamoTableUsedBy(dir, "debugkit", "af-south-1", "111")).toBe("the default setup");
    expect(dynamoTableUsedBy(dir, "debugkit", "eu-west-1", "111")).toBeUndefined();
    expect(dynamoTableUsedBy(dir, "debugkit", "af-south-1", "222")).toBeUndefined();
    expect(dynamoTableUsedBy(dir, "debugkit-preview", "af-south-1", "111")).toBeUndefined();
  });
});
