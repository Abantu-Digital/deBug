import { beforeAll, describe, expect, it, vi } from "vitest";
import { appNames, readSettings, writeSettings } from "./settings";

// The dashboard's own store in demo mode: the sample app is megatron-native.
beforeAll(() => vi.stubEnv("DEBUG_STORE", "demo"));

describe("the app's display name", () => {
  it("shows the demo app as Megatron Native, saves a new name, and clears back to the id", async () => {
    expect(await appNames(["megatron-native"])).toEqual({ "megatron-native": "Megatron Native" });
    expect((await writeSettings("megatron-native", { displayName: "  Megatron   App " })).displayName).toBe("Megatron App");
    await expect(writeSettings("megatron-native", { displayName: "x".repeat(61) })).rejects.toThrow(/60/);
    expect((await readSettings("megatron-native")).displayName).toBe("Megatron App");
    await writeSettings("megatron-native", { displayName: "" });
    expect(await appNames(["megatron-native"])).toEqual({});
    // Saving other settings leaves the name as it was.
    await writeSettings("megatron-native", { displayName: "Megatron Native" });
    await writeSettings("megatron-native", { criticalFlows: ["auth.login"] });
    expect((await readSettings("megatron-native")).displayName).toBe("Megatron Native");
  });
});
