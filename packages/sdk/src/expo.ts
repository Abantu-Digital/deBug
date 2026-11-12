import * as Application from "expo-application";
import * as Device from "expo-device";
import { deBug, type DebugClient } from "./index";
import { mergeContext, type ContextPatch } from "./context";
import { initReactNative, type ReactNativeInitOptions } from "./react-native";

export * from "./react-native";

function osName(raw: string | null): string {
  const n = (raw ?? "").toLowerCase();
  if (n.includes("android")) return "android";
  if (n === "ios" || n === "ipados") return "ios";
  return n || "unknown"; // web: the browser's OS, e.g. "mac os"
}

const DEVICE_TYPES = { 1: "phone", 2: "tablet", 3: "desktop", 4: "tv" } as const;

/** Device and app context from expo-device and expo-application. */
export function expoContext(): ContextPatch {
  return {
    os: Device.osVersion ? { name: osName(Device.osName), version: Device.osVersion } : undefined,
    device: {
      model: Device.modelName ?? undefined,
      manufacturer: Device.manufacturer ?? undefined,
      brand: Device.brand ?? undefined,
      isEmulator: !Device.isDevice,
      memoryMb: Device.totalMemory ? Math.round(Device.totalMemory / 1024 / 1024) : undefined,
      type: DEVICE_TYPES[(Device.deviceType ?? 0) as keyof typeof DEVICE_TYPES] ?? "unknown",
    },
    app: {
      version: Application.nativeApplicationVersion ?? undefined,
      build: Application.nativeBuildVersion ?? undefined,
    } as ContextPatch["app"],
  };
}

/** Initialise deBug in an Expo app. Device, OS and app version are filled in automatically. */
export function initExpo(options: Omit<ReactNativeInitOptions, "deviceInfo">, client: DebugClient = deBug): DebugClient {
  const ctx = expoContext();
  const merged = mergeContext(ctx, options.context ?? {});
  // Drop undefined os so the react-native fallback is kept when expo-device has no data (e.g. web).
  if (!ctx.os) delete (merged as { os?: unknown }).os;
  return initReactNative(
    { ...options, app: { ...(ctx.app as object), ...options.app } as ReactNativeInitOptions["app"], context: merged },
    client,
  );
}
