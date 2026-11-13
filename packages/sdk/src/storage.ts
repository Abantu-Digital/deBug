import type { QueueStorage } from "./client";

/** The parts of an MMKV instance deBug uses (react-native-mmkv v2 and v3). */
export interface MMKVLike {
  getString(key: string): string | undefined;
  set(key: string, value: string): void;
}

/**
 * deBug's queue, crashes and install id in MMKV. MMKV writes synchronously, so a fatal crash is
 * saved before React Native closes the app. Give deBug an instance of its own, so clearing the
 * app's storage (on sign-out, say) leaves it alone:
 *
 *   storage: mmkvStorage(new MMKV({ id: "debugkit" }))
 */
export function mmkvStorage(mmkv: MMKVLike): QueueStorage {
  return {
    getItem: async (key) => mmkv.getString(key) ?? null,
    setItem: async (key, value) => mmkv.set(key, value),
    setItemSync: (key, value) => mmkv.set(key, value),
  };
}
