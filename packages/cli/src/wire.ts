import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { AppInfo } from "./detect";
import { installCommand } from "./detect";
import { capture, interactive, which } from "./exec";
import { ensureGitignored, environment, upsertEnv } from "./state";
import { code, dim, p, yes } from "./ui";

export interface Connection {
  endpoint: string;
  ingestKey: string;
}

export const ENV_ENDPOINT = "DEBUG_ENDPOINT";
export const ENV_KEY = "DEBUG_KEY";

/** Install the SDK (and Expo's device modules) if the app doesn't have them yet. */
export async function installSdk(app: AppInfo) {
  if (!app.hasSdk) {
    const [cmd, args] = installCommand(app.packageManager, ["@debugkit/sdk"]);
    if (await yes(`Install ${code("@debugkit/sdk")} with ${app.packageManager}?`)) {
      const s = p.spinner();
      s.start(`${cmd} ${args.join(" ")}`);
      const r = await capture(cmd, args, { cwd: app.cwd });
      if (r.code !== 0) {
        s.error("Install failed");
        p.log.error(r.stderr.slice(-800));
        throw new Error("Couldn't install @debugkit/sdk. Install it yourself and run npx debugkit init again.");
      }
      s.stop(`Installed @debugkit/sdk`);
      app.hasSdk = true;
    }
  }
  if (app.platform === "expo" && app.missingExpoModules.length) {
    const exit = await interactive("npx", ["expo", "install", ...app.missingExpoModules], { cwd: app.cwd });
    if (exit !== 0) p.log.warn("Couldn't install expo-device and expo-application. Run: npx expo install expo-device expo-application");
  }
}

/** Where the endpoint and key go: the app's .env for platforms with public env vars. */
export function writeAppEnv(app: AppInfo, conn: Connection): string | undefined {
  if (!app.envPrefix) return undefined;
  const file = join(app.cwd, ".env");
  upsertEnv(file, { [`${app.envPrefix}${ENV_ENDPOINT}`]: conn.endpoint, [`${app.envPrefix}${ENV_KEY}`]: conn.ingestKey });
  return file;
}

export const ENV_ENVIRONMENT = "DEBUG_ENVIRONMENT";

/** EAS's built-in environments; a profile in eas.json pulls one of these at build time. */
const EAS_ENVIRONMENTS = ["development", "preview", "production"];

/** The three values one environment's builds need, under the platform's public prefix. */
export function envValues(app: AppInfo, conn: Connection, env: string): Record<string, string> {
  const pre = app.envPrefix ?? "";
  return { [`${pre}${ENV_ENDPOINT}`]: conn.endpoint, [`${pre}${ENV_KEY}`]: conn.ingestKey, [`${pre}${ENV_ENVIRONMENT}`]: env };
}

/**
 * The generated debug.ts for each platform. It switches itself off when the build has no
 * endpoint, and, with environments, in development builds too. So the same file works for
 * every build: only the environment's variables differ.
 */
export function initFile(app: AppInfo, conn: Connection, multiEnv = environment.get() !== undefined): { path: string; contents: string; then: string[] } {
  const ext = app.typescript ? "ts" : "js";
  const path = join(app.cwd, app.sourceDir, `debug.${ext}`);
  const rel = relative(app.cwd, path);
  const env = (k: string) => (app.envPrefix === "VITE_" ? `import.meta.env.${app.envPrefix}${k}` : `process.env.${app.envPrefix ?? ""}${k}`);
  const header = `// Set up by npx debugkit init. Import this file once, as early as possible.\n`;
  const appId = JSON.stringify(app.appId);
  const importLine = `${code(`import "./${rel.replace(/\.(ts|js)$/, "")}";`)}`;

  switch (app.platform) {
    case "expo":
      return {
        path,
        contents: `${header}import { initExpo } from "@debugkit/sdk/expo";

const endpoint = ${env(ENV_ENDPOINT)};

export const deBug = initExpo({
  // ${multiEnv ? "On in release builds whose environment has a deBug endpoint (preview, production); off in\n  // development builds and local Metro runs." : "Off when the build has no deBug endpoint."}
  enabled: ${multiEnv ? "!__DEV__ && !!endpoint" : "!!endpoint"},
  endpoint: endpoint ?? "",
  ingestKey: ${env(ENV_KEY)} ?? "",
  app: { id: ${appId}, environment: ${env(ENV_ENVIRONMENT)} ?? (__DEV__ ? "development" : "production") },
});
`,
        then: [
          `Import it first in your root layout (${code(app.expoRouter ? "app/_layout.tsx" : "App.tsx")}): ${importLine} (adjust the path)`,
          `Wrap the root in ${code("<DebugErrorBoundary>")} from ${code("@debugkit/sdk/expo")} to catch render crashes`,
          ...(app.expoRouter ? [`Call ${code("useDebugExpoRouter()")} from ${code("@debugkit/sdk/expo-router")} in the root layout for screen breadcrumbs`] : []),
        ],
      };
    case "react-native":
      return {
        path,
        contents: `${header}import { initReactNative } from "@debugkit/sdk/react-native";
// Optional, for model and app version: npm install react-native-device-info, then pass deviceInfo: DeviceInfo.

export const deBug = initReactNative({
  enabled: ${multiEnv ? "!__DEV__ // release builds only" : "true"},
  endpoint: ${JSON.stringify(conn.endpoint)},
  ingestKey: ${JSON.stringify(conn.ingestKey)}, // public and write-only: safe to ship in the app
  app: { id: ${appId}, environment: __DEV__ ? "development" : "production" },
});
`,
        then: [
          `Import it first in ${code("index.js")}: ${importLine}`,
          `Wrap your root component in ${code("<DebugErrorBoundary>")} from ${code("@debugkit/sdk/react-native")}`,
          ...(app.reactNavigation ? [`Spread ${code("{...trackReactNavigation(navRef)}")} onto your NavigationContainer for screen breadcrumbs`] : []),
          ...(multiEnv ? [`Bare React Native has no per-build env vars, so ${code("debug.ts")} holds one environment's endpoint. For one per environment, read them with react-native-config.`] : []),
        ],
      };
    case "node":
      return {
        path,
        contents: `${header}import { initNode } from "@debugkit/sdk/node";

export const deBug = initNode({
  enabled: !!process.env.${ENV_ENDPOINT}, // off where no endpoint is set
  endpoint: process.env.${ENV_ENDPOINT} ?? "",
  ingestKey: process.env.${ENV_KEY} ?? "",
  app: { id: ${appId}, version: process.env.npm_package_version, environment: process.env.${ENV_ENVIRONMENT} ?? process.env.NODE_ENV },
});
`,
        then: [`Import it at the very top of your server entry`, `Set ${code(ENV_ENDPOINT)} and ${code(ENV_KEY)} in the server's environment`],
      };
    default: {
      // Browser apps: React, Vite, TanStack Start, Next.js (client side).
      const vite = app.envPrefix === "VITE_";
      const guard = app.platform === "next" || app.platform === "tanstack-start" ? `typeof window !== "undefined" && ` : "";
      const prod = vite ? "import.meta.env.PROD" : `process.env.NODE_ENV === "production"`;
      const fallbackEnv = vite ? "import.meta.env.MODE" : "process.env.NODE_ENV";
      return {
        path,
        contents: `${header}import { deBug } from "@debugkit/sdk/react";

const endpoint = ${env(ENV_ENDPOINT)};

deBug.init({
  enabled: ${guard}${multiEnv ? `${prod} && ` : ""}!!endpoint,
  endpoint: endpoint ?? "",
  ingestKey: ${env(ENV_KEY)} ?? "",
  app: { id: ${appId}${app.version ? `, version: ${JSON.stringify(app.version)}` : ""}, environment: ${env(ENV_ENVIRONMENT)} ?? ${fallbackEnv} },
});

export { deBug };
`,
        then: [
          `Import it first in your client entry (${code(app.platform === "next" ? "a client component in app/layout.tsx" : app.platform === "tanstack-start" ? "src/router.tsx" : "src/main.tsx")})`,
          `Wrap the app in ${code("<DebugErrorBoundary>")} from ${code("@debugkit/sdk/react")}`,
          ...(app.platform === "tanstack-start" || app.platform === "next" ? [`For server errors, see ${code("initNode")} and ${code("withDebug")} in the SDK README`] : []),
        ],
      };
    }
  }
}

/** Put one environment's values in EAS, so `eas build` and `eas env:pull` pick them up. */
async function writeEasEnv(app: AppInfo, values: Record<string, string>, env: string): Promise<boolean> {
  const [cmd, pre] = which("eas") ? ["eas", [] as string[]] : ["npx", ["-y", "eas-cli@latest"]];
  const s = p.spinner();
  s.start(`Setting ${Object.keys(values).length} variables in EAS's ${env} environment`);
  for (const [name, value] of Object.entries(values)) {
    const r = await capture(cmd, [...pre, "env:set", "--environment", env, "--name", name, "--value", value, "--visibility", "plaintext", "--scope", "project", "--non-interactive"], { cwd: app.cwd });
    if (r.code !== 0) {
      s.error(`EAS didn't accept ${name}`);
      p.log.warn((r.stderr || r.stdout).trim().split("\n").slice(-4).join("\n"));
      return false;
    }
  }
  s.stop(`Set ${Object.keys(values).map((k) => code(k)).join(", ")} in EAS's ${code(env)} environment`);
  return true;
}

/** Write debug.ts (asking before replacing one) and the endpoint and key. Returns the steps left for the developer. */
export async function wireApp(app: AppInfo, conn: Connection): Promise<string[]> {
  const env = environment.get();
  const extra: string[] = [];
  if (env) {
    // One of several environments: never touch .env (it would point every build at this one).
    const values = app.platform === "react-native" ? {} : envValues(app, conn, env);
    const usesEas = app.platform === "expo" && existsSync(join(app.cwd, "eas.json"));
    let done = Object.keys(values).length === 0;
    if (!done && usesEas && EAS_ENVIRONMENTS.includes(env) && (await yes(`Set the endpoint and key in EAS's ${env} environment (eas env:set)?`))) done = await writeEasEnv(app, values, env);
    if (!done) {
      p.note(Object.entries(values).map(([k, v]) => `${k}=${v}`).join("\n"), `Set these for your ${env} builds`);
      extra.push(usesEas ? `Set the variables above in EAS's ${code(env)} environment (${code(`eas env:set --environment ${env}`)})` : `Set the variables above wherever your ${code(env)} builds get their environment`);
    }
  } else {
    const envFile = writeAppEnv(app, conn);
    if (envFile) {
      p.log.success(`Wrote ${code(`${app.envPrefix}${ENV_ENDPOINT}`)} and ${code(`${app.envPrefix}${ENV_KEY}`)} to ${code(relative(app.cwd, envFile))}`);
    } else if (app.platform === "node") {
      upsertEnv(join(app.cwd, ".env"), { [ENV_ENDPOINT]: conn.endpoint, [ENV_KEY]: conn.ingestKey });
      p.log.success(`Wrote ${code(ENV_ENDPOINT)} and ${code(ENV_KEY)} to ${code(".env")}`);
    }
    if (envFile || app.platform === "node") {
      if (ensureGitignored(app.cwd, ".env")) p.log.info(dim("Added .env to .gitignore"));
    }
  }

  const f = initFile(app, conn);
  const rel = relative(app.cwd, f.path);
  const current = existsSync(f.path) ? readFileSync(f.path, "utf8") : undefined;
  if (current === f.contents) p.log.info(`${code(rel)} is already up to date`);
  else if (current === undefined || (await yes(`${rel} already exists. Replace it?`, false))) {
    mkdirSync(dirname(f.path), { recursive: true });
    writeFileSync(f.path, f.contents);
    p.log.success(`${current === undefined ? "Created" : "Updated"} ${code(rel)}`);
  } else {
    p.log.info(`Kept your ${rel}. The generated version is:\n${dim(f.contents)}`);
  }
  return [...extra, ...f.then];
}
