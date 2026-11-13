import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Platform: { OS: "android", Version: 34, constants: { Release: "14" } },
  NativeModules: { RNDeviceInfo: {} },
  Dimensions: { get: () => ({ width: 393, height: 852 }) },
  PixelRatio: { get: () => 3, getFontScale: () => 1 },
  AppState: { addEventListener: () => ({ remove() {} }) },
}));
// expo-device that can't read much (an emulator image, say): its gaps mustn't erase device-info's answers.
vi.mock("expo-device", () => ({ osName: "Android", osVersion: "14", modelName: null, manufacturer: null, brand: null, isDevice: true, totalMemory: null, deviceType: null }));
vi.mock("expo-application", () => ({ nativeApplicationVersion: "4.2.0", nativeBuildVersion: "420" }));

const { setDeviceInfoLoader } = await import("./device");
const { initExpo } = await import("./expo");
const { DebugClient } = await import("./client");
const { mergeContext } = await import("./context");

describe("initExpo", () => {
  it("collects device details with nothing passed, and Expo's gaps don't erase them", async () => {
    setDeviceInfoLoader(() => ({ getModel: () => "Pixel 8", getBrand: () => "google", isTablet: () => false, hasGmsSync: () => true, getCarrierSync: () => "Vodacom" }));
    const sent: { context: Record<string, any>; events: { tags?: Record<string, string> }[] }[] = [];
    const c = new DebugClient();
    initExpo(
      { endpoint: "https://i.example/x", ingestKey: "pk", app: { id: "megatron" }, autoCapture: false, flushIntervalMs: 0, fetch: (async (_u: string, i: { body: string }) => (sent.push(JSON.parse(i.body)), new Response("", { status: 202 }))) as never },
      c,
    );
    c.error(new Error("x"));
    await c.flush();
    expect(sent[0]!.context.device).toMatchObject({ model: "Pixel 8", brand: "google", type: "phone", screen: { width: 393 } });
    expect(sent[0]!.context.app).toMatchObject({ version: "4.2.0", build: "420" });
    expect(sent[0]!.events[0]!.tags).toMatchObject({ "device.mobileServices": "gms", "network.carrier": "Vodacom" });
  });

  it("merges context without letting undefined wipe a value", () => {
    expect(mergeContext({ device: { model: "A", type: "phone" } }, { device: { model: undefined, brand: "B" } })).toEqual({ device: { model: "A", type: "phone", brand: "B" } });
  });
});
