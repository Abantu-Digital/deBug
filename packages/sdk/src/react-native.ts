import { AppState, Platform } from "react-native";
import { deBug, type DebugClient, type InitOptions } from "./index";
import { locale, mergeContext, timezone, type ContextPatch } from "./context";
import { deviceContext, liveDeviceTags, loadDeviceInfo, staticDeviceTags, type CollectOptions, type DeviceInfoModule } from "./device";

export * from "./react";

export type { CollectOptions, DeviceInfoModule } from "./device";
export { mmkvStorage, type MMKVLike } from "./storage";

type RNConstants = {
  Release?: string;
  reactNativeVersion?: { major: number; minor: number; patch: number };
};

/**
 * Context for React Native: OS, runtime, locale and timezone, plus the device (model, brand,
 * memory, screen) from react-native-device-info when it's installed, or from React Native alone.
 */
export function nativeContext(opts: { deviceInfo?: DeviceInfoModule; collect?: CollectOptions } = {}): ContextPatch {
  const c = (Platform.constants ?? {}) as RNConstants;
  const rn = c.reactNativeVersion;
  const hermes = typeof (globalThis as { HermesInternal?: unknown }).HermesInternal !== "undefined";
  return {
    os: { name: Platform.OS, version: Platform.OS === "android" ? (c.Release ?? String(Platform.Version)) : String(Platform.Version) },
    runtime: { name: "react-native", version: rn ? `${rn.major}.${rn.minor}.${rn.patch}` : undefined, engine: hermes ? "hermes" : "jsc" },
    ...deviceContext(opts.deviceInfo, opts.collect),
    locale: locale(),
    timezone: timezone(),
  };
}

export interface ReactNativeInitOptions extends InitOptions {
  /**
   * Not needed: deBug loads react-native-device-info itself. Pass a module only to override it
   * (in tests, say), or `null` to read nothing from it.
   */
  deviceInfo?: DeviceInfoModule | null;
  /** Device facts to leave out, e.g. `{ carrier: false }`. Everything is collected by default. */
  collect?: CollectOptions;
  /**
   * Report unhandled promise rejections (Hermes). Default "production": in development React
   * Native's own yellow-box warning keeps working. `true` captures in development too.
   */
  captureUnhandledRejections?: boolean | "production";
}

declare const __DEV__: boolean | undefined;

const SESSION_TIMEOUT_MS = 30 * 60_000;
let removeDeviceTags: (() => void) | undefined;

/** Initialise deBug in a React Native app (bare or Expo). Fills in device context and flushes when the app is backgrounded. */
export function initReactNative(options: ReactNativeInitOptions, client: DebugClient = deBug): DebugClient {
  const { deviceInfo, collect, captureUnhandledRejections = "production", ...rest } = options;
  removeDeviceTags?.();
  removeDeviceTags = undefined;
  // Switched off: don't touch the device at all.
  if (rest.enabled === false) return client.init(rest);
  const di = deviceInfo === null ? undefined : (deviceInfo ?? loadDeviceInfo());
  const base = nativeContext({ deviceInfo: di, collect });
  client.init({
    ...rest,
    app: { ...(base.app as object), ...rest.app },
    context: mergeContext(base, rest.context ?? {}),
  });
  if (!client.enabled) return client; // enabled: false — no listeners, no rejection tracking
  if (!di && deviceInfo !== null && rest.debug) console.log("[deBug] react-native-device-info isn't linked (Expo Go, or the app needs a rebuild): device details are limited");

  // Device facts on every error and event: fixed ones read once, on the first event; live ones each time.
  // device.details says whether react-native-device-info was there, so a release build missing
  // it shows on the dashboard instead of failing silently. No tag when the app opted out (null).
  const details: Record<string, string> = deviceInfo === null ? {} : { "device.details": di ? "full" : "limited" };
  let fixed: Record<string, string> | undefined;
  removeDeviceTags = client.addTagSource(() => ({ ...(fixed ??= { ...details, ...staticDeviceTags(di, collect) }), ...liveDeviceTags(di, collect) }));

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
