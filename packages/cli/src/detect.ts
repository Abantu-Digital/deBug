import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cmdFor } from "./state";

export type Platform = "expo" | "react-native" | "next" | "tanstack-start" | "vite-react" | "react" | "node";
export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface AppInfo {
  cwd: string;
  name: string;
  /** Lowercase, dotted-or-dashed id used as the deBug app id. */
  appId: string;
  version?: string;
  platform: Platform;
  expoRouter: boolean;
  reactNavigation: boolean;
  packageManager: PackageManager;
  hasSdk: boolean;
  /**
   * Native modules the SDK reads device and app details from, when the app doesn't have them yet.
   * They must be the app's own dependencies: React Native only links native code the app lists.
   */
  missingNativeModules: string[];
  /** Where the generated debug.ts goes: "src" when the app has one, otherwise the project root. */
  sourceDir: string;
  /** Prefix that exposes env vars to client code, or undefined when the platform has none. */
  envPrefix?: "EXPO_PUBLIC_" | "VITE_" | "NEXT_PUBLIC_";
  typescript: boolean;
}

export const PLATFORM_LABEL: Record<Platform, string> = {
  expo: "Expo",
  "react-native": "React Native",
  next: "Next.js",
  "tanstack-start": "TanStack Start",
  "vite-react": "React (Vite)",
  react: "React",
  node: "Node",
};

export function detectApp(cwd: string): AppInfo {
  let pkg: { name?: string; version?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
  try {
    pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
  } catch {
    throw new Error(`No package.json in ${cwd}. Run ${cmdFor("init")} from your app's folder.`);
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const has = (d: string) => d in deps;
  const platform: Platform = has("expo")
    ? "expo"
    : has("react-native")
      ? "react-native"
      : has("next")
        ? "next"
        : has("@tanstack/react-start")
          ? "tanstack-start"
          : has("vite") && has("react")
            ? "vite-react"
            : has("react")
              ? "react"
              : "node";
  const envPrefix =
    platform === "expo" ? "EXPO_PUBLIC_" : platform === "next" ? "NEXT_PUBLIC_" : platform === "vite-react" || platform === "tanstack-start" ? "VITE_" : undefined;
  const name = pkg.name ?? cwd.split(/[\\/]/).pop() ?? "app";
  return {
    cwd,
    name,
    appId: toAppId(name),
    version: pkg.version,
    platform,
    expoRouter: has("expo-router"),
    reactNavigation: has("@react-navigation/native"),
    packageManager: existsSync(join(cwd, "pnpm-lock.yaml"))
      ? "pnpm"
      : existsSync(join(cwd, "yarn.lock"))
        ? "yarn"
        : existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bun.lock"))
          ? "bun"
          : "npm",
    hasSdk: has("@debugkit/sdk"),
    missingNativeModules: (platform === "expo" ? ["expo-device", "expo-application", "react-native-device-info"] : platform === "react-native" ? ["react-native-device-info"] : []).filter((m) => !has(m)),
    sourceDir: existsSync(join(cwd, "src")) ? "src" : ".",
    envPrefix,
    typescript: existsSync(join(cwd, "tsconfig.json")) || has("typescript"),
  };
}

/** "@acme/Megatron Native" → "megatron-native" */
export function toAppId(name: string): string {
  return (
    name
      .replace(/^@[^/]+\//, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "app"
  );
}

export function installCommand(pm: PackageManager, pkgs: string[]): [string, string[]] {
  switch (pm) {
    case "pnpm":
      return ["pnpm", ["add", ...pkgs]];
    case "yarn":
      return ["yarn", ["add", ...pkgs]];
    case "bun":
      return ["bun", ["add", ...pkgs]];
    default:
      return ["npm", ["install", ...pkgs]];
  }
}
