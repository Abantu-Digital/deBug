import type { ContextInput } from "@debug/schema";

type Partial2<T> = { [K in keyof T]?: T[K] extends object ? Partial<T[K]> : T[K] };
export type ContextPatch = Partial2<ContextInput>;

/** Best-effort context for browsers. React Native apps should use `expoContext`. */
export function browserContext(): ContextPatch {
  if (typeof navigator === "undefined") return { runtime: { name: "node", version: process?.versions?.node } };
  const ua = navigator.userAgent;
  const os =
    /Android ([\d.]+)/.exec(ua)?.[1] ? { name: "android", version: /Android ([\d.]+)/.exec(ua)?.[1] }
    : /OS (\d+[_\d]*) like Mac/.exec(ua) ? { name: "ios", version: /OS (\d+[_\d]*) like Mac/.exec(ua)?.[1]?.replace(/_/g, ".") }
    : /Mac OS X/.test(ua) ? { name: "macos" }
    : /Windows/.test(ua) ? { name: "windows" }
    : { name: "web" };
  const conn = (navigator as { connection?: { effectiveType?: string } }).connection;
  return {
    os,
    runtime: { name: "browser" },
    device: {
      type: /Mobi/.test(ua) ? "phone" : "desktop",
      screen: typeof screen !== "undefined" ? { width: screen.width, height: screen.height, scale: globalThis.devicePixelRatio } : undefined,
    },
    network: conn ? { type: "unknown", effectiveType: conn.effectiveType, isConnected: navigator.onLine } : undefined,
    locale: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

/**
 * Context for Expo / React Native. Pass the modules in so the SDK has no hard
 * native dependencies:
 *
 *   import * as Device from "expo-device";
 *   import * as Application from "expo-application";
 *   import { Platform } from "react-native";
 *   deBug.init({ ..., context: expoContext({ Device, Application, Platform }) })
 */
export function expoContext(mods: {
  Platform: { OS: string; Version: string | number };
  Device?: {
    modelName?: string | null;
    manufacturer?: string | null;
    brand?: string | null;
    isDevice?: boolean;
    totalMemory?: number | null;
    deviceType?: number | null; // expo-device DeviceType enum
  };
  Application?: { nativeApplicationVersion?: string | null; nativeBuildVersion?: string | null };
}): ContextPatch {
  const { Platform, Device, Application } = mods;
  const type = ({ 1: "phone", 2: "tablet", 3: "desktop", 4: "tv" } as const)[Device?.deviceType ?? 0] ?? "unknown";
  const hermes = typeof (globalThis as { HermesInternal?: unknown }).HermesInternal !== "undefined";
  return {
    os: { name: Platform.OS, version: String(Platform.Version) },
    runtime: { name: "react-native", engine: hermes ? "hermes" : "jsc" },
    device: {
      model: Device?.modelName ?? undefined,
      manufacturer: Device?.manufacturer ?? undefined,
      brand: Device?.brand ?? undefined,
      isEmulator: Device ? !Device.isDevice : undefined,
      memoryMb: Device?.totalMemory ? Math.round(Device.totalMemory / 1024 / 1024) : undefined,
      type,
    },
    app: {
      version: Application?.nativeApplicationVersion ?? undefined,
      build: Application?.nativeBuildVersion ?? undefined,
    } as ContextPatch["app"],
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}
