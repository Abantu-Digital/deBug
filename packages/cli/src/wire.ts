import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { AppInfo } from "./detect";
import { installCommand } from "./detect";
import { capture, interactive } from "./exec";
import { ensureGitignored, upsertEnv } from "./state";
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
  if (app.platform === "expo") {
    const exit = await interactive("npx", ["expo", "install", "expo-device", "expo-application"], { cwd: app.cwd });
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

/** The generated debug.ts for each platform. */
export function initFile(app: AppInfo, conn: Connection): { path: string; contents: string; then: string[] } {
  const ext = app.typescript ? "ts" : "js";
  const path = join(app.cwd, app.sourceDir, `debug.${ext}`);
  const rel = relative(app.cwd, path);
  const bang = app.typescript ? "!" : "";
  const env = (k: string) => (app.envPrefix === "VITE_" ? `import.meta.env.${app.envPrefix}${k}` : `process.env.${app.envPrefix ?? ""}${k}`);
  const header = `// Set up by npx debugkit init. Import this file once, as early as possible.\n`;
  const appId = JSON.stringify(app.appId);

  switch (app.platform) {
    case "expo":
      return {
        path,
        contents: `${header}import { initExpo } from "@debugkit/sdk/expo";

export const deBug = initExpo({
  endpoint: ${env(ENV_ENDPOINT)}${bang},
  ingestKey: ${env(ENV_KEY)}${bang},
  app: { id: ${appId}, environment: __DEV__ ? "development" : "production" },
});
`,
        then: [
          `Import it first in your root layout (${code(app.expoRouter ? "app/_layout.tsx" : "App.tsx")}): ${code(`import "./${rel.replace(/\.(ts|js)$/, "")}";`)} (adjust the path)`,
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
  endpoint: ${JSON.stringify(conn.endpoint)},
  ingestKey: ${JSON.stringify(conn.ingestKey)}, // public and write-only: safe to ship in the app
  app: { id: ${appId}, environment: __DEV__ ? "development" : "production" },
});
`,
        then: [
          `Import it first in ${code("index.js")}: ${code(`import "./${rel.replace(/\.(ts|js)$/, "")}";`)}`,
          `Wrap your root component in ${code("<DebugErrorBoundary>")} from ${code("@debugkit/sdk/react-native")}`,
          ...(app.reactNavigation ? [`Spread ${code("{...trackReactNavigation(navRef)}")} onto your NavigationContainer for screen breadcrumbs`] : []),
        ],
      };
    case "node":
      return {
        path,
        contents: `${header}import { initNode } from "@debugkit/sdk/node";

export const deBug = initNode({
  endpoint: process.env.${ENV_ENDPOINT}${bang},
  ingestKey: process.env.${ENV_KEY}${bang},
  app: { id: ${appId}, version: process.env.npm_package_version },
});
`,
        then: [`Import it at the very top of your server entry`, `Set ${code(ENV_ENDPOINT)} and ${code(ENV_KEY)} in the server's environment (they're in .env)`],
      };
    default: {
      // Browser apps: React, Vite, TanStack Start, Next.js (client side).
      const guard = app.platform === "next" || app.platform === "tanstack-start" ? `if (typeof window !== "undefined") ` : "";
      return {
        path,
        contents: `${header}import { deBug } from "@debugkit/sdk/react";

${guard}deBug.init({
  endpoint: ${env(ENV_ENDPOINT)}${bang},
  ingestKey: ${env(ENV_KEY)}${bang},
  app: { id: ${appId}${app.version ? `, version: ${JSON.stringify(app.version)}` : ""} },
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

/** Write debug.ts (asking before replacing one) and the env vars. Returns the steps left for the developer. */
export async function wireApp(app: AppInfo, conn: Connection): Promise<string[]> {
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

  const f = initFile(app, conn);
  const rel = relative(app.cwd, f.path);
  if (!existsSync(f.path) || (await yes(`${rel} already exists. Replace it?`, false))) {
    mkdirSync(dirname(f.path), { recursive: true });
    writeFileSync(f.path, f.contents);
    p.log.success(`Created ${code(rel)}`);
  } else {
    p.log.info(`Kept your ${rel}. The generated version is:\n${dim(f.contents)}`);
  }
  return f.then;
}
