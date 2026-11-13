import { Dimensions, NativeModules, PixelRatio, Platform } from "react-native";
import type { ContextPatch } from "./context";

/**
 * Device facts for React Native and Expo, read by the SDK itself. react-native-device-info is a
 * peer dependency (`npx debugkit init` installs it); without its native half (Expo Go, or an app
 * not rebuilt since it was added) the SDK falls back to what React Native exposes on its own.
 *
 * No identifiers, ever: no unique id, Android id, serial, MAC, IP address or device name.
 */

/** The parts of react-native-device-info deBug reads. Every method is optional: a missing one is skipped. */
export interface DeviceInfoModule {
  getModel?(): string;
  getBrand?(): string;
  getVersion?(): string;
  getBuildNumber?(): string;
  isTablet?(): boolean;
  getManufacturerSync?(): string;
  isEmulatorSync?(): boolean;
  getTotalMemorySync?(): number;
  hasGmsSync?(): boolean;
  hasHmsSync?(): boolean;
  isLowRamDevice?(): boolean;
  getApiLevelSync?(): number;
  getFreeDiskStorageSync?(): number;
  getCarrierSync?(): string;
  getInstallerPackageNameSync?(): string;
  isAirplaneModeSync?(): boolean;
  getFontScaleSync?(): number;
}

/** Turn single facts off, for apps that mustn't send them. All are on by default. */
export interface CollectOptions {
  /** Screen width, height and pixel ratio (device context). */
  screen?: boolean;
  /** The user's text-size setting, e.g. 1.3 (tag `device.fontScale`). */
  fontScale?: boolean;
  /** Google or Huawei mobile services, Android (tag `device.mobileServices`: gms, hms or none). */
  mobileServices?: boolean;
  /** Android's low-RAM flag (tag `device.lowRam`). */
  lowRam?: boolean;
  /** Android API level (tag `android.apiLevel`). */
  apiLevel?: boolean;
  /** Free storage as a band, never exact bytes (tag `device.freeDisk`). */
  freeDisk?: boolean;
  /** Mobile network operator (tag `network.carrier`). */
  carrier?: boolean;
  /** Where the app was installed from, e.g. com.android.vending (tag `app.installer`). */
  installer?: boolean;
  /** Airplane mode at the time of each event, Android (tag `network.airplaneMode`). */
  airplaneMode?: boolean;
}

const on = (c: CollectOptions | undefined, k: keyof CollectOptions) => c?.[k] !== false;

function read<T>(fn: (() => T) | undefined): T | undefined {
  try {
    return fn?.();
  } catch {
    return undefined;
  }
}

/** Native readers return placeholders when they have nothing ("unknown", "--" on iOS 16+). */
const known = (v: string | undefined) => (v === undefined || v === "" || v === "unknown" || v === "--" ? undefined : v);

/** Free storage, grouped so the tag splits devices instead of listing byte counts. */
const FREE_DISK_BANDS: { belowMb: number; label: string }[] = [
  { belowMb: 500, label: "<500MB" },
  { belowMb: 2048, label: "500MB-2GB" },
  { belowMb: 8192, label: "2GB-8GB" },
  { belowMb: Infinity, label: "8GB+" },
];

export function freeDiskBand(bytes: number | undefined): string | undefined {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return undefined;
  const mb = bytes / 1024 / 1024;
  return FREE_DISK_BANDS.find((b) => mb < b.belowMb)?.label;
}

type Loader = () => unknown;
let testLoader: Loader | undefined;
/** For tests: replace how react-native-device-info is loaded. */
export function setDeviceInfoLoader(fn: Loader) {
  testLoader = fn;
  cached = undefined;
}

let cached: { mod: DeviceInfoModule | undefined } | undefined;

/**
 * react-native-device-info, if both halves are there. The JavaScript half throws on import when
 * the native half is missing, so check the native module first and never let it escape.
 */
export function loadDeviceInfo(): DeviceInfoModule | undefined {
  if (cached) return cached.mod;
  let mod: DeviceInfoModule | undefined;
  try {
    const turbo = (globalThis as { __turboModuleProxy?: (name: string) => unknown }).__turboModuleProxy;
    const native = NativeModules?.RNDeviceInfo ?? read(() => turbo?.("RNDeviceInfo"));
    if (native) {
      // The require sits directly inside this try: Metro then treats it as optional, so an app
      // without the package still builds (and gets the fallback). The build keeps it a literal
      // require in every chunk; see tsup.config.ts.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const m = (testLoader ? testLoader() : require("react-native-device-info")) as { default?: DeviceInfoModule } & DeviceInfoModule;
      mod = m?.default ?? m;
    }
  } catch {
    mod = undefined;
  }
  cached = { mod };
  return mod;
}

/** What goes in the device and app context: model, brand, memory, screen and so on. */
export function deviceContext(di: DeviceInfoModule | undefined, collect?: CollectOptions): ContextPatch {
  const c = (Platform.constants ?? {}) as { Model?: string; Brand?: string; Manufacturer?: string; Fingerprint?: string };
  const totalMemory = read(di?.getTotalMemorySync?.bind(di));
  const screen = on(collect, "screen") ? read(() => Dimensions.get("screen")) : undefined;
  const isTablet = read(di?.isTablet?.bind(di));
  return {
    device: {
      model: known(read(di?.getModel?.bind(di))) ?? c.Model,
      brand: known(read(di?.getBrand?.bind(di))) ?? c.Brand,
      manufacturer: known(read(di?.getManufacturerSync?.bind(di))) ?? c.Manufacturer,
      isEmulator: read(di?.isEmulatorSync?.bind(di)) ?? (c.Fingerprint ? /generic|emulator/i.test(c.Fingerprint) : undefined),
      memoryMb: totalMemory ? Math.round(totalMemory / 1024 / 1024) : undefined,
      type: isTablet !== undefined ? (isTablet ? "tablet" : "phone") : Platform.OS === "ios" && (Platform as { isPad?: boolean }).isPad ? "tablet" : "phone",
      ...(screen && screen.width > 0 ? { screen: { width: Math.round(screen.width), height: Math.round(screen.height), scale: read(() => PixelRatio.get()) } } : {}),
    },
    app: { version: known(read(di?.getVersion?.bind(di))), build: known(read(di?.getBuildNumber?.bind(di))) } as ContextPatch["app"],
  };
}

/** Facts that don't change while the app runs, as tags. */
export function staticDeviceTags(di: DeviceInfoModule | undefined, collect?: CollectOptions): Record<string, string> {
  const tags: Record<string, string> = {};
  if (on(collect, "fontScale")) {
    const scale = read(di?.getFontScaleSync?.bind(di)) ?? read(() => PixelRatio.getFontScale());
    if (typeof scale === "number" && scale > 0) tags["device.fontScale"] = scale.toFixed(1);
  }
  if (!di) return tags;
  if (Platform.OS === "android") {
    if (on(collect, "mobileServices")) tags["device.mobileServices"] = read(di.hasGmsSync?.bind(di)) ? "gms" : read(di.hasHmsSync?.bind(di)) ? "hms" : "none";
    if (on(collect, "lowRam")) {
      const low = read(di.isLowRamDevice?.bind(di));
      if (low !== undefined) tags["device.lowRam"] = String(low);
    }
    if (on(collect, "apiLevel")) {
      const api = read(di.getApiLevelSync?.bind(di));
      if (typeof api === "number" && api > 0) tags["android.apiLevel"] = String(api);
    }
  }
  if (on(collect, "freeDisk")) {
    const band = freeDiskBand(read(di.getFreeDiskStorageSync?.bind(di)));
    if (band) tags["device.freeDisk"] = band;
  }
  if (on(collect, "carrier")) {
    const carrier = known(read(di.getCarrierSync?.bind(di)));
    if (carrier) tags["network.carrier"] = carrier.slice(0, 60);
  }
  if (on(collect, "installer")) {
    const installer = known(read(di.getInstallerPackageNameSync?.bind(di)));
    if (installer) tags["app.installer"] = installer.slice(0, 100);
  }
  return tags;
}

/** Facts that change while the app runs, read for each event. Android only: iOS can't read airplane mode. */
export function liveDeviceTags(di: DeviceInfoModule | undefined, collect?: CollectOptions): Record<string, string> {
  if (!di || Platform.OS !== "android" || !on(collect, "airplaneMode")) return {};
  const airplane = read(di.isAirplaneModeSync?.bind(di));
  return airplane === undefined ? {} : { "network.airplaneMode": String(airplane) };
}
