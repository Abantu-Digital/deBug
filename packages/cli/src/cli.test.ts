import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectApp, toAppId } from "./detect";
import { hashPassword } from "./dashboard";
import { mergeKeys } from "./keys";
import { awsProfiles, lookup } from "./providers/aws";
import { functionRegion, writeFunctionSource } from "./providers/firebase";
import { readEnv, upsertEnv } from "./state";
import { initFile, writeAppEnv } from "./wire";
import { scryptSync } from "node:crypto";

function app(pkg: object, files: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "debugkit-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), c);
  }
  return dir;
}

const conn = { endpoint: "https://europe-west1-acme.cloudfunctions.net/debugIngest", ingestKey: "pk_live_abc" };

describe("detect", () => {
  it("recognises each platform and its env prefix", () => {
    const cases: [object, string, string | undefined][] = [
      [{ dependencies: { expo: "58", "expo-router": "6", "react-native": "0.88" } }, "expo", "EXPO_PUBLIC_"],
      [{ dependencies: { "react-native": "0.88" } }, "react-native", undefined],
      [{ dependencies: { next: "16", react: "19" } }, "next", "NEXT_PUBLIC_"],
      [{ dependencies: { "@tanstack/react-start": "1", react: "19" } }, "tanstack-start", "VITE_"],
      [{ dependencies: { react: "19" }, devDependencies: { vite: "8" } }, "vite-react", "VITE_"],
      [{ dependencies: { express: "5" } }, "node", undefined],
    ];
    for (const [pkg, platform, prefix] of cases) {
      const a = detectApp(app({ name: "x", ...pkg }));
      expect([a.platform, a.envPrefix]).toEqual([platform, prefix]);
    }
  });

  it("picks the package manager from the lockfile and the app id from the name", () => {
    const a = detectApp(app({ name: "@acme/Megatron Native" }, { "pnpm-lock.yaml": "", "src/index.ts": "" }));
    expect(a.packageManager).toBe("pnpm");
    expect(a.appId).toBe("megatron-native");
    expect(a.sourceDir).toBe("src");
    expect(toAppId("---")).toBe("app");
  });
});

describe("wiring", () => {
  it("writes Expo env vars and an initExpo file that reads them", () => {
    const dir = app({ name: "megatron", dependencies: { expo: "58", "expo-router": "6" } }, { "tsconfig.json": "{}" });
    const a = detectApp(dir);
    writeAppEnv(a, conn);
    expect(readEnv(join(dir, ".env"))).toEqual({ EXPO_PUBLIC_DEBUG_ENDPOINT: conn.endpoint, EXPO_PUBLIC_DEBUG_KEY: conn.ingestKey });
    const f = initFile(a, conn);
    expect(f.path).toBe(join(dir, "debug.ts"));
    expect(f.contents).toContain(`from "@debugkit/sdk/expo"`);
    expect(f.contents).toContain("process.env.EXPO_PUBLIC_DEBUG_ENDPOINT!");
    expect(f.then.join("\n")).toContain("useDebugExpoRouter");
  });

  it("bakes the endpoint into bare React Native, which has no env vars", () => {
    const f = initFile(detectApp(app({ name: "rn", dependencies: { "react-native": "0.88" } })), conn);
    expect(f.path.endsWith("debug.js")).toBe(true);
    expect(f.contents).toContain(JSON.stringify(conn.endpoint));
  });

  it("uses import.meta.env for Vite and guards the server for TanStack Start", () => {
    const vite = initFile(detectApp(app({ name: "w", version: "1.2.0", dependencies: { react: "19", vite: "8" } })), conn);
    expect(vite.contents).toContain("import.meta.env.VITE_DEBUG_ENDPOINT");
    expect(vite.contents).toContain('version: "1.2.0"');
    const start = initFile(detectApp(app({ name: "s", dependencies: { "@tanstack/react-start": "1", react: "19" } })), conn);
    expect(start.contents).toContain('if (typeof window !== "undefined") deBug.init');
  });

  it("upserts env files without touching other lines", () => {
    const dir = app({ name: "x" }, { ".env": "# mine\nAPI_URL=https://api\nVITE_DEBUG_KEY=old\n" });
    upsertEnv(join(dir, ".env"), { VITE_DEBUG_KEY: "new", VITE_DEBUG_ENDPOINT: "https://e" });
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe("# mine\nAPI_URL=https://api\nVITE_DEBUG_KEY=new\nVITE_DEBUG_ENDPOINT=https://e\n");
  });
});

describe("providers", () => {
  it("writes a deployable Firebase function with the ingest key and region", () => {
    const dir = app({ name: "megatron", dependencies: { expo: "58" } });
    const out = writeFunctionSource({ app: detectApp(dir), ingestKey: "pk_live_abc", dashboardPort: 4400 }, "africa-south1");
    const firebaseJson = JSON.parse(readFileSync(join(out, "firebase.json"), "utf8"));
    expect(firebaseJson.functions[0]).toMatchObject({ source: "functions", codebase: "debugkit" });
    expect(readFileSync(join(out, "functions", "index.js"), "utf8")).toContain('region: "africa-south1", invoker: "public"');
    expect(readFileSync(join(out, "functions", ".env"), "utf8")).toBe("DEBUG_INGEST_KEYS=pk_live_abc:megatron\n");
    expect(JSON.parse(readFileSync(join(out, "firestore.indexes.json"), "utf8")).fieldOverrides[0]).toMatchObject({ fieldPath: "expireAt", ttl: true });
  });

  it("reads AWS profiles from config and credentials", () => {
    const home = mkdtempSync(join(tmpdir(), "aws-"));
    mkdirSync(join(home, ".aws"));
    writeFileSync(join(home, ".aws", "config"), "[default]\nregion = af-south-1\n\n[profile work]\nsso_start_url = https://x.awsapps.com/start\nregion = eu-west-1\n\n[sso-session corp]\nsso_region = eu-west-1\n");
    writeFileSync(join(home, ".aws", "credentials"), "[default]\naws_access_key_id = AKIA\n[ci]\naws_access_key_id = AKIA2\n");
    expect(awsProfiles(home)).toEqual([
      { name: "default", region: "af-south-1", sso: false },
      { name: "work", region: "eu-west-1", sso: true },
      { name: "ci", sso: false },
    ]);
  });

  it("hashes dashboard passwords the way the dashboard checks them", () => {
    const [, salt, hash] = hashPassword("correct-horse-battery").split(".");
    expect(scryptSync("correct-horse-battery", Buffer.from(salt!, "hex"), 64).toString("hex")).toBe(hash);
  });
});

describe("safety on re-runs", () => {
  it("adds ingest keys without dropping the ones shipped builds use", () => {
    expect(mergeKeys(undefined, "pk_a", "shop")).toBe("pk_a:shop");
    expect(mergeKeys("pk_old:shop,pk_x:other", "pk_new", "shop")).toBe("pk_old:shop,pk_x:other,pk_new:shop");
    expect(mergeKeys("pk_a:shop", "pk_a", "shop")).toBe("pk_a:shop");
    expect(mergeKeys(" , bad, pk_a:shop", "pk_b", "shop")).toBe("pk_a:shop,pk_b:shop");
  });

  it("keeps existing keys in the Firebase function's .env when run again", () => {
    const dir = app({ name: "megatron", dependencies: { expo: "58" } });
    const a = detectApp(dir);
    writeFunctionSource({ app: a, ingestKey: "pk_live_first", dashboardPort: 4400 }, "us-central1");
    const out = writeFunctionSource({ app: a, ingestKey: "pk_live_second", dashboardPort: 4400 }, "us-central1");
    expect(readFileSync(join(out, "functions", ".env"), "utf8")).toBe("DEBUG_INGEST_KEYS=pk_live_first:megatron,pk_live_second:megatron\n");
  });

  it("treats only 'not found' as missing, and rethrows access errors", async () => {
    const fail = (name: string) => () => Promise.reject(Object.assign(new Error(name), { name }));
    await expect(lookup(fail("ResourceNotFoundException"))).resolves.toBeUndefined();
    await expect(lookup(fail("NoSuchEntityException"))).resolves.toBeUndefined();
    await expect(lookup(fail("AccessDeniedException"))).rejects.toThrow("AccessDeniedException");
    await expect(lookup(async () => 1)).resolves.toBe(1);
  });

  it("maps Firestore locations to a Cloud Functions region", () => {
    expect(functionRegion("nam5")).toBe("us-central1");
    expect(functionRegion("eur3")).toBe("europe-west1");
    expect(functionRegion("africa-south1")).toBe("africa-south1");
    expect(functionRegion("australia-southeast2")).toBe("australia-southeast2");
  });

  it("only installs the Expo modules that are missing", () => {
    expect(detectApp(app({ name: "e", dependencies: { expo: "58", "expo-device": "8" } })).missingExpoModules).toEqual(["expo-application"]);
    expect(detectApp(app({ name: "w", dependencies: { react: "19" } })).missingExpoModules).toEqual([]);
  });
});
