import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cmdFor, environment } from "./state";

/**
 * Guard for multi-environment apps: a hint printed while the CLI runs must go through cmdFor(),
 * so it carries --env. A hardcoded "npx debugkit init" in a preview run sends people to the
 * wrong environment.
 */
const SRC = join(__dirname);
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(join(dir, d.name)) : d.name.endsWith(".ts") && !d.name.endsWith(".test.ts") ? [join(dir, d.name)] : []));

const COMMAND = /npx debugkit (init|dashboard|deploy-dashboard|test|guide|password)\b/;
/** Allowed: the help text (lists commands; --env is documented beside them), comments, headers written into generated files, and an explicit --env example. */
const allowed = (line: string) =>
  /^\s*(\/\/|\*|\/\*\*)/.test(line) ||
  /\$\{code\("npx debugkit [a-z-]+"\)\}\s{2,}/.test(line) ||
  /`\/\/ (Set up by|The deBug dashboard, hosted by|deBug ingest, deployed by) npx debugkit/.test(line) ||
  /npx debugkit init --env production/.test(line);

describe("--env in printed hints", () => {
  it("no hint hardcodes a command that should carry --env", () => {
    const offenders: string[] = [];
    for (const file of files(SRC)) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (COMMAND.test(line) && !allowed(line)) offenders.push(`${file.slice(SRC.length + 1)}:${i + 1}: ${line.trim().slice(0, 120)}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  it("cmdFor adds the environment", () => {
    environment.set("preview");
    expect(cmdFor("deploy-dashboard")).toBe("npx debugkit deploy-dashboard --env preview");
    environment.set(undefined);
    expect(cmdFor("init")).toBe("npx debugkit init");
  });
});

describe("hosted dashboards per environment", async () => {
  const { mkdtempSync, writeFileSync: write } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { paths, readConfig, writeConfig } = await import("./state");

  it("keeps each environment's hosted dashboard, login file and Firebase folder apart", () => {
    const dir = mkdtempSync(join(tmpdir(), "debugkit-env-"));
    write(join(dir, "package.json"), "{}");
    const base = { provider: "firebase" as const, appId: "megatron", ingestKey: "pk", dashboardPort: 4400, createdAt: "t" };
    environment.set("preview");
    writeConfig(dir, { ...base, endpoint: "https://staging", hosted: { url: "https://cellc-staging-debug.web.app", region: "us-central1", functionName: "debugkitDashboard", site: "cellc-staging-debug", deployedAt: "t" } });
    const preview = paths(dir);
    environment.set("production");
    writeConfig(dir, { ...base, endpoint: "https://prod" });
    expect(readConfig(dir)?.hosted).toBeUndefined();
    expect(paths(dir).dashboardEnv).not.toBe(preview.dashboardEnv);
    expect(paths(dir).firebase).not.toBe(preview.firebase);
    environment.set("preview");
    expect(readConfig(dir)?.hosted?.url).toBe("https://cellc-staging-debug.web.app");
    expect(readConfig(dir)?.endpoint).toBe("https://staging");
    environment.set(undefined);
  });
});

