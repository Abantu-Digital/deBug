import { beforeEach, describe, expect, it, vi } from "vitest";

const rn = vi.hoisted(() => ({
  Platform: { OS: "android", Version: 34, constants: { Release: "14", Model: "fallback-model", reactNativeVersion: { major: 0, minor: 83, patch: 1 } } as Record<string, unknown> },
  NativeModules: { RNDeviceInfo: {} } as Record<string, unknown>,
  Dimensions: { get: () => ({ width: 411.4, height: 914.3 }) },
  PixelRatio: { get: () => 2.625, getFontScale: () => 1.15 },
  AppState: { addEventListener: () => ({ remove() {} }) },
}));
vi.mock("react-native", () => rn);

const { setDeviceInfoLoader, staticDeviceTags, liveDeviceTags, freeDiskBand, detailsTag } = await import("./device");
const { initReactNative, mmkvStorage } = await import("./react-native");
const { DebugClient } = await import("./client");

/** A Huawei phone without Google services, low on storage, in airplane mode. */
const huawei = {
  getModel: () => "P40",
  getBrand: () => "HUAWEI",
  getVersion: () => "4.2.0",
  getBuildNumber: () => "420",
  isTablet: () => false,
  getTotalMemorySync: () => 8 * 1024 ** 3,
  hasGmsSync: () => false,
  hasHmsSync: () => true,
  isLowRamDevice: () => false,
  getApiLevelSync: () => 29,
  getFreeDiskStorageSync: () => 300 * 1024 * 1024,
  getCarrierSync: () => "Cell C",
  getInstallerPackageNameSync: () => "com.huawei.appmarket",
  isAirplaneModeSync: () => true,
  getFontScaleSync: () => 1.3,
  // Things deBug must never read:
  getUniqueIdSync: () => "SECRET-ID",
  getDeviceNameSync: () => "Sam's phone",
};

function client() {
  const sent: { context: Record<string, any>; events: { type: string; tags?: Record<string, string> }[] }[] = [];
  const fetch = vi.fn(async (_u: string, init: { body: string }) => (sent.push(JSON.parse(init.body)), new Response("", { status: 202 })));
  return { c: new DebugClient(), sent, fetch: fetch as never };
}
const opts = { endpoint: "https://ingest.example/x", ingestKey: "pk_test", app: { id: "megatron" }, autoCapture: false as const, flushIntervalMs: 0 };

beforeEach(() => {
  rn.NativeModules.RNDeviceInfo = {};
  rn.Platform.OS = "android";
  setDeviceInfoLoader(() => huawei);
});

describe("device facts, read by the SDK", () => {
  it("loads react-native-device-info itself and tags every error and event", async () => {
    const { c, sent, fetch } = client();
    initReactNative({ ...opts, fetch }, c);
    c.error(new Error("payment failed"));
    c.event("bundle.bought");
    await c.flush();
    const env = sent[0]!;
    expect(env.context.device).toMatchObject({ model: "P40", brand: "HUAWEI", memoryMb: 8192, type: "phone", screen: { width: 411, height: 914, scale: 2.625 } });
    expect(env.context.app).toMatchObject({ version: "4.2.0", build: "420" });
    for (const e of sent.flatMap((b) => b.events))
      expect(e.tags).toMatchObject({
        "device.mobileServices": "hms",
        "device.lowRam": "false",
        "android.apiLevel": "29",
        "device.freeDisk": "<500MB",
        "device.fontScale": "1.3",
        "network.carrier": "Cell C",
        "app.installer": "com.huawei.appmarket",
        "network.airplaneMode": "true",
        "device.details": "full",
      });
    expect(JSON.stringify(sent)).not.toMatch(/SECRET-ID|Sam's phone/);
    await c.close();
  });

  it("falls back quietly when the native half is missing (Expo Go, not rebuilt)", async () => {
    rn.NativeModules.RNDeviceInfo = undefined;
    const loader = vi.fn(() => {
      throw new Error("NativeModule.RNDeviceInfo is null");
    });
    setDeviceInfoLoader(loader);
    const { c, sent, fetch } = client();
    initReactNative({ ...opts, fetch }, c);
    c.error(new Error("x"));
    await c.flush();
    expect(loader).not.toHaveBeenCalled(); // never even evaluated
    expect(sent[0]!.context.device).toMatchObject({ model: "fallback-model", screen: { width: 411 } });
    expect(sent[0]!.events[0]!.tags).toEqual({ "device.details": "limited", "device.fontScale": "1.1" }); // React Native's own font scale
  });

  it("sends no device.details tag when the app opts out with deviceInfo: null", async () => {
    const loader = vi.fn(() => huawei);
    setDeviceInfoLoader(loader);
    const { c, sent, fetch } = client();
    initReactNative({ ...opts, fetch, deviceInfo: null }, c);
    c.error(new Error("x"));
    await c.flush();
    expect(loader).not.toHaveBeenCalled();
    expect(sent[0]!.events[0]!.tags).not.toHaveProperty("device.details");
    await c.close();
  });

  it("tags device.details full for a module passed in, and leaves session markers untagged", async () => {
    rn.NativeModules.RNDeviceInfo = undefined; // the override is used as-is
    const { c, sent, fetch } = client();
    initReactNative({ ...opts, fetch, deviceInfo: huawei, autoCapture: { sessions: true } }, c);
    c.error(new Error("x"));
    await c.flush();
    const events = sent.flatMap((b) => b.events);
    expect(events.find((e) => e.type === "error")!.tags).toHaveProperty("device.details", "full");
    expect(events.find((e) => e.type === "session")?.tags?.["device.details"]).toBeUndefined();
    await c.close();
  });

  it("leaves device.details out with collect: { details: false }", () => {
    expect(detailsTag(undefined, false)).toEqual({ "device.details": "limited" });
    expect(detailsTag(undefined, false, { details: false })).toEqual({});
    expect(detailsTag(undefined, true)).toEqual({});
  });

  it("survives a loader that throws even with the native half present", () => {
    setDeviceInfoLoader(() => {
      throw new Error("boom");
    });
    const { c, fetch } = client();
    expect(() => initReactNative({ ...opts, fetch }, c)).not.toThrow();
  });

  it("reads nothing at all when deBug is off", () => {
    const loader = vi.fn(() => huawei);
    setDeviceInfoLoader(loader);
    const get = vi.spyOn(rn.Dimensions, "get");
    const { c } = client();
    initReactNative({ ...opts, enabled: false }, c);
    expect(loader).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    get.mockRestore();
  });

  it("leaves out facts turned off with collect, and iOS-only gaps", () => {
    expect(staticDeviceTags(huawei, { carrier: false, installer: false, freeDisk: false })).not.toHaveProperty("network.carrier");
    expect(staticDeviceTags(huawei, { carrier: false })).not.toHaveProperty("network.carrier");
    rn.Platform.OS = "ios";
    expect(staticDeviceTags({ ...huawei, getCarrierSync: () => "--" })).not.toHaveProperty("network.carrier"); // iOS 16+ placeholder
    expect(staticDeviceTags(huawei)).not.toHaveProperty("device.mobileServices");
    expect(liveDeviceTags(huawei)).toEqual({}); // iOS can't read airplane mode
  });

  it("bands free storage instead of sending bytes", () => {
    expect(freeDiskBand(100 * 1024 * 1024)).toBe("<500MB");
    expect(freeDiskBand(4 * 1024 ** 3)).toBe("2GB-8GB");
    expect(freeDiskBand(-1)).toBeUndefined();
  });
});

describe("mobile defaults", () => {
  type IOpts = { network: { isFailure: (s: number) => boolean; slowMs?: number }; maxBreadcrumbs: number };
  const optionsOf = (c: InstanceType<typeof DebugClient>) => (c as unknown as { opts: IOpts }).opts;

  it("counts a 4xx as a failure and keeps a longer trail", async () => {
    const { c, sent, fetch } = client();
    initReactNative({ ...opts, fetch, network: { slowMs: 1000 } }, c);
    const { network } = optionsOf(c);
    // The app's own network options are kept next to the default.
    expect([network.isFailure(422), network.isFailure(399), network.slowMs]).toEqual([true, false, 1000]);
    for (let i = 0; i < 70; i++) c.breadcrumb("ui", `tap ${i}`);
    c.error(new Error("boom"));
    await c.flush();
    const [e] = sent[0]!.events as { breadcrumbs?: unknown[] }[];
    expect(e?.breadcrumbs).toHaveLength(50);
  });

  it("keeps the app's own choices, and never more breadcrumbs than an event carries", () => {
    const { c: own, fetch } = client();
    initReactNative({ ...opts, fetch, maxBreadcrumbs: 10, network: { isFailure: (s) => s >= 500 } }, own);
    expect([optionsOf(own).maxBreadcrumbs, optionsOf(own).network.isFailure(422)]).toEqual([10, false]);

    const { c: many, fetch: manyFetch } = client();
    initReactNative({ ...opts, fetch: manyFetch, maxBreadcrumbs: 80, network: { isFailure: undefined } }, many);
    expect([optionsOf(many).maxBreadcrumbs, optionsOf(many).network.isFailure(422)]).toEqual([50, true]);
  });
});

describe("apps extend the tags", () => {
  it("tags, setTags and enrich add to deBug's own; the event's own tags win", async () => {
    const { c, sent, fetch } = client();
    initReactNative({ ...opts, fetch, tags: { plan: "prepaid", "network.carrier": "override" }, enrich: (e) => (e.type === "error" ? { screen: "Checkout" } : undefined) }, c);
    c.setTags({ region: "gauteng" });
    c.error(new Error("x"), { tags: { plan: "contract" } });
    c.setTags({ region: undefined });
    c.event("y");
    await c.flush();
    const [err, ev] = sent.flatMap((b) => b.events);
    expect(err!.tags).toMatchObject({ plan: "contract", region: "gauteng", screen: "Checkout", "network.carrier": "override", "device.mobileServices": "hms" });
    expect(ev!.tags).not.toHaveProperty("region");
    expect(ev!.tags).not.toHaveProperty("screen");
  });

  it("a throwing enrich is skipped, and re-init doesn't double the device tags", async () => {
    const { c, sent, fetch } = client();
    const source = vi.fn();
    initReactNative({ ...opts, fetch }, c);
    initReactNative({ ...opts, fetch, enrich: () => { throw new Error("bad"); } }, c);
    c.addTagSource(source);
    c.error(new Error("x"));
    await c.flush();
    expect(sent[0]!.events[0]!.tags).toHaveProperty("device.mobileServices", "hms");
    expect(source).toHaveBeenCalledTimes(1);
  });
});

describe("mmkvStorage", () => {
  it("writes synchronously for crashes, and reads back", async () => {
    const data = new Map<string, string>();
    const s = mmkvStorage({ getString: (k) => data.get(k), set: (k, v) => void data.set(k, v) });
    s.setItemSync!("q", "[1]");
    expect(data.get("q")).toBe("[1]");
    expect(await s.getItem("q")).toBe("[1]");
    expect(await s.getItem("missing")).toBeNull();
  });
});
