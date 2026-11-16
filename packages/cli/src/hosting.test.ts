import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectApp } from "./detect";
import { DASHBOARD_CODEBASE, DASHBOARD_FUNCTION, dotenv, hostedEnv, writeDashboardSource, writeHostingConfig } from "./hosting";
import { writeFunctionSource } from "./providers/firebase";
import { environment, readEnv } from "./state";

const local = {
  DEBUG_STORE: "firestore",
  PORT: "4400",
  GOOGLE_CLOUD_PROJECT: "acme",
  DEBUG_SESSION_SECRET: "s".repeat(64),
  DEBUG_DASHBOARD_USERS: "me@acme.dev=scrypt.ab.cd",
  DEBUG_API_TOKEN: "dbk_x",
  DEBUG_ADMIN_URL: "https://ingest/admin",
  DEBUG_ADMIN_TOKEN: "adm_x",
  DEBUG_RETENTION_DAYS: "60",
  DEBUGKIT_LOGIN_EMAIL: "me@acme.dev",
};

describe("hosted dashboard settings", () => {
  it("splits secrets from plain settings, and leaves out what hosts reserve", () => {
    const { plain, secret } = hostedEnv(local, "https://acme-debug.web.app", { DEBUG_COOKIE_NAME: "__session" });
    expect(plain).toEqual({ DEBUG_DASHBOARD_URL: "https://acme-debug.web.app", DEBUG_COOKIE_NAME: "__session", DEBUG_STORE: "firestore", DEBUG_ADMIN_URL: "https://ingest/admin", DEBUG_RETENTION_DAYS: "60" });
    expect(Object.keys(secret).sort()).toEqual(["DEBUG_ADMIN_TOKEN", "DEBUG_API_TOKEN", "DEBUG_DASHBOARD_USERS", "DEBUG_SESSION_SECRET"]);
    expect({ ...plain, ...secret }).not.toHaveProperty("PORT");
    expect({ ...plain, ...secret }).not.toHaveProperty("GOOGLE_CLOUD_PROJECT");
  });

  it("refuses to host without a login", () => {
    expect(() => hostedEnv({ DEBUG_STORE: "firestore" }, "https://x")).toThrow(/login/);
  });

  it("tells the hosted dashboard its environment, only when there is one", () => {
    const local = { DEBUG_STORE: "firestore", DEBUG_SESSION_SECRET: "s", DEBUG_DASHBOARD_USERS: "u" };
    expect(hostedEnv(local, "https://x").plain.DEBUG_ENVIRONMENT).toBeUndefined();
    environment.set("preview");
    try {
      expect(hostedEnv(local, "https://x").plain.DEBUG_ENVIRONMENT).toBe("preview");
    } finally {
      environment.set(undefined);
    }
  });

  it("quotes values so a = or , in a password hash survives", () => {
    const file = join(mkdtempSync(join(tmpdir(), "env-")), ".env");
    writeFileSync(file, dotenv({ DEBUG_DASHBOARD_USERS: "a@b.c=scrypt.1.2,d@e.f=scrypt.3.4" }));
    expect(readEnv(file).DEBUG_DASHBOARD_USERS).toBe("a@b.c=scrypt.1.2,d@e.f=scrypt.3.4");
  });
});

describe("Firebase hosting files", () => {
  it("adds the dashboard next to ingest, and a re-run of init keeps it", () => {
    const appDir = mkdtempSync(join(tmpdir(), "debugkit-"));
    writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: "megatron", dependencies: { expo: "58" } }));
    const ctx = { app: detectApp(appDir), ingestKey: "pk_live_abc", dashboardPort: 4400, retentionDays: 60, adminToken: "adm_x" };
    const dir = writeFunctionSource(ctx, "africa-south1", "acme");
    const { plain, secret } = hostedEnv(local, "https://acme-debug.web.app");
    const src = writeDashboardSource(dir, { region: "africa-south1", projectId: "acme", serviceAccount: "debugkit-dashboard@acme.iam.gserviceaccount.com", dependency: "^0.6.0", plain, secret });
    writeHostingConfig(dir, "acme-debug", "africa-south1");

    const index = readFileSync(join(src, "index.js"), "utf8");
    expect(index).toContain(`export const ${DASHBOARD_FUNCTION} = onRequest(`);
    expect(index).toContain('"serviceAccount":"debugkit-dashboard@acme.iam.gserviceaccount.com"');
    // Secrets only in the per-project file, which .debugkit/.gitignore covers.
    expect(readFileSync(join(src, ".env"), "utf8")).not.toMatch(/SESSION_SECRET|ADMIN_TOKEN|USERS|API_TOKEN/);
    expect(readEnv(join(src, ".env.acme")).DEBUG_SESSION_SECRET).toBe("s".repeat(64));

    // Running init again rewrites ingest's part of firebase.json and keeps the dashboard's.
    writeFunctionSource(ctx, "africa-south1", "acme");
    writeHostingConfig(dir, "acme-debug", "africa-south1"); // and hosting again doesn't duplicate
    const fj = JSON.parse(readFileSync(join(dir, "firebase.json"), "utf8"));
    expect(fj.functions.map((f: { codebase: string }) => f.codebase)).toEqual(["debugkit", DASHBOARD_CODEBASE]);
    expect(fj.hosting).toEqual([{ site: "acme-debug", public: "hosting-public", ignore: ["firebase.json", "**/.*"], rewrites: [{ source: "**", function: { functionId: DASHBOARD_FUNCTION, region: "africa-south1" } }] }]);
    expect(fj.firestore).toMatchObject({ indexes: "firestore.indexes.json" });
  });
});
