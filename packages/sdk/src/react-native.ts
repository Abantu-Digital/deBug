import { AppState, Platform } from "react-native";
import { deBug, type DebugClient, type InitOptions } from "./index";
import { locale, mergeContext, timezone, type ContextPatch } from "./context";

export * from "./react";

/** The subset of react-native-device-info we read. Pass the module itself: `import DeviceInfo from "react-native-device-info"`. */
export interface DeviceInfoModule {
  getModel(): string;
  getBrand(): string;
  getVersion(): string;
  getBuildNumber(): string;
  isTablet(): boolean;
  getManufacturerSync?(): string;
  isEmulatorSync?(): boolean;
  getTotalMemorySync?(): number;
}

type RNConstants = {
  Release?: string;
  Model?: string;
  Brand?: string;
  Manufacturer?: string;
  Fingerprint?: string;
  reactNativeVersion?: { major: number; minor: number; patch: number };
};

/**
 * Context for bare React Native. Reads what `react-native` exposes on its own; pass
 * react-native-device-info for model, app version and memory on both platforms.
 */
export function nativeContext(opts: { deviceInfo?: DeviceInfoModule } = {}): ContextPatch {
  const c = (Platform.constants ?? {}) as RNConstants;
  const di = opts.deviceInfo;
  const rn = c.reactNativeVersion;
  const hermes = typeof (globalThis as { HermesInternal?: unknown }).HermesInternal !== "undefined";
  const call = <T,>(fn?: () => T) => {
    try {
      return fn?.();
    } catch {
      return undefined;
    }
  };
  const totalMemory = call(di?.getTotalMemorySync?.bind(di));
  return {
    os: { name: Platform.OS, version: Platform.OS === "android" ? (c.Release ?? String(Platform.Version)) : String(Platform.Version) },
    runtime: { name: "react-native", version: rn ? `${rn.major}.${rn.minor}.${rn.patch}` : undefined, engine: hermes ? "hermes" : "jsc" },
    device: {
      model: call(di?.getModel?.bind(di)) ?? c.Model,
      brand: call(di?.getBrand?.bind(di)) ?? c.Brand,
      manufacturer: call(di?.getManufacturerSync?.bind(di)) ?? c.Manufacturer,
      isEmulator: call(di?.isEmulatorSync?.bind(di)) ?? (c.Fingerprint ? /generic|emulator/i.test(c.Fingerprint) : undefined),
      memoryMb: totalMemory ? Math.round(totalMemory / 1024 / 1024) : undefined,
      type: di ? (call(di.isTablet?.bind(di)) ? "tablet" : "phone") : Platform.OS === "ios" && (Platform as { isPad?: boolean }).isPad ? "tablet" : "phone",
    },
    app: { version: call(di?.getVersion?.bind(di)), build: call(di?.getBuildNumber?.bind(di)) } as ContextPatch["app"],
    locale: locale(),
    timezone: timezone(),
  };
}

export interface ReactNativeInitOptions extends InitOptions {
  deviceInfo?: DeviceInfoModule;
  /**
   * Report unhandled promise rejections (Hermes). Default "production": in development React
   * Native's own yellow-box warning keeps working. `true` captures in development too.
   */
  captureUnhandledRejections?: boolean | "production";
}

declare const __DEV__: boolean | undefined;

const SESSION_TIMEOUT_MS = 30 * 60_000;

/** Initialise deBug in a React Native app (bare or Expo). Fills in device context and flushes when the app is backgrounded. */
export function initReactNative(options: ReactNativeInitOptions, client: DebugClient = deBug): DebugClient {
  const { deviceInfo, captureUnhandledRejections = "production", ...rest } = options;
  // Switched off: don't touch the device at all.
  if (rest.enabled === false) return client.init(rest);
  const base = nativeContext({ deviceInfo });
  client.init({
    ...rest,
    app: { ...(base.app as object), ...rest.app },
    context: mergeContext(base, rest.context ?? {}),
  });
  if (!client.enabled) return client; // enabled: false — no listeners, no rejection tracking

  // Sessions end after 30 minutes in the background; coming back after that starts a new one.
  let backgroundedAt = 0;
  AppState.addEventListener("change", (state) => {
    if (state === "active") {
      if (client.autoCapture.lifecycle) client.sink().lifecycle("foreground");
      if (backgroundedAt && Date.now() - backgroundedAt > SESSION_TIMEOUT_MS) client.startSession();
      backgroundedAt = 0;
    } else if (!backgroundedAt) {
      backgroundedAt = Date.now();
      if (client.autoCapture.lifecycle) client.sink().lifecycle("background");
      else void client.flush();
    }
  });

  const dev = typeof __DEV__ !== "undefined" && __DEV__;
  const tracker = (globalThis as { HermesInternal?: { enablePromiseRejectionTracker?: (o: object) => void } }).HermesInternal
    ?.enablePromiseRejectionTracker;
  if (tracker && (captureUnhandledRejections === true || (captureUnhandledRejections === "production" && !dev))) {
    tracker({
      allRejections: true,
      onUnhandled: (_id: number, reason: unknown) => client.error(reason, { handled: false, tags: { source: "unhandled-rejection" } }),
      onHandled: () => {},
    });
  }
  return client;
}

/** Minimal shape of a React Navigation container ref. */
interface NavigationRefLike {
  getCurrentRoute(): { name: string } | undefined;
}

/**
 * Breadcrumbs for React Navigation. Spread the result onto your container:
 *   const nav = useNavigationContainerRef();
 *   <NavigationContainer ref={nav} {...trackReactNavigation(nav)}>
 */
export function trackReactNavigation(ref: NavigationRefLike, client: DebugClient = deBug) {
  const record = () => {
    const name = ref.getCurrentRoute()?.name;
    if (name) client.navigated(name);
  };
  return { onReady: record, onStateChange: record };
}
