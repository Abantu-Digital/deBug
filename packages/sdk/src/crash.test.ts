import { afterEach, describe, expect, it, vi } from "vitest";
import { DebugClient } from "./client";
import { normaliseUrl } from "./auto";

/** Storage with a synchronous write, like MMKV. `async` writes only land when awaited. */
function mmkvLike() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: async (k: string) => data.get(k) ?? null,
    setItem: async (k: string, v: string) => void data.set(k, v),
    setItemSync: (k: string, v: string) => void data.set(k, v),
  };
}

type Handler = (err: unknown, isFatal?: boolean) => void;
const g = globalThis as Record<string, unknown>;
afterEach(() => {
  delete g.ErrorUtils;
});

/** React Native's ErrorUtils, whose default handler "kills the app" on a fatal error. */
function fakeReactNative() {
  let handler: Handler | undefined;
  let killed = false;
  const rnDefault: Handler = (_e, fatal) => {
    if (fatal) killed = true;
  };
  handler = rnDefault;
  g.ErrorUtils = { setGlobalHandler: (h: Handler) => (handler = h), getGlobalHandler: () => handler };
  return { crash: (err: unknown) => handler!(err, true), killed: () => killed };
}

const base = { endpoint: "https://ingest.example/x", ingestKey: "pk_test", app: { id: "megatron", version: "1.0.0" }, context: { os: { name: "android" }, runtime: { name: "react-native" } } };
const auto = { errors: true, network: false, console: false, navigation: false, clicks: false, lifecycle: false, sessions: true };

describe("fatal crashes on React Native", () => {
  it("are saved before the app dies, and sent on the next launch", async () => {
    const storage = mmkvLike();
    const rn = fakeReactNative();
    // The upload never finishes: the app is killed first.
    const hang = vi.fn(() => new Promise<Response>(() => {}));
    const before = new DebugClient().init({ ...base, storage, autoCapture: auto, fetch: hang as never, flushIntervalMs: 0 });
    await Promise.resolve();
    rn.crash(new TypeError("Cannot read property 'msisdn' of undefined"));
    expect(rn.killed()).toBe(true);

    // Only what was written synchronously survives.
    const saved = JSON.parse(storage.data.get("debug.queue.v1") ?? storage.data.get([...storage.data.keys()].find((k) => k.includes("queue"))!) ?? "[]");
    expect(saved.some((e: { type: string; error?: { message: string } }) => e.type === "error" && e.error?.message.includes("msisdn"))).toBe(true);
    void before;

    // Next launch: the crash is sent.
    delete g.ErrorUtils;
    const sent: { events: { type: string; status?: string; handled?: boolean }[] }[] = [];
    const ok = vi.fn(async (_u: string, init: { body: string }) => (sent.push(JSON.parse(init.body)), new Response("", { status: 202 })));
    const after = new DebugClient().init({ ...base, storage, autoCapture: { ...auto, errors: false }, fetch: ok as never, flushIntervalMs: 0 });
    await new Promise((r) => setTimeout(r, 0));
    await after.flush();
    const events = sent.flatMap((b) => b.events);
    expect(events.some((e) => e.type === "error" && e.handled === false)).toBe(true);
    expect(events.some((e) => e.type === "session" && e.status === "crashed")).toBe(true);
    // Sent once, not twice.
    expect(events.filter((e) => e.type === "error")).toHaveLength(1);
    await after.close();
  });

  it("keep a batch that was mid-upload when the app died", async () => {
    const storage = mmkvLike();
    const rn = fakeReactNative();
    const hang = vi.fn(() => new Promise<Response>(() => {}));
    const c = new DebugClient().init({ ...base, storage, autoCapture: auto, fetch: hang as never, flushIntervalMs: 0 });
    await Promise.resolve();
    c.error(new Error("handled before the crash"));
    void c.flush(); // this upload never finishes
    rn.crash(new Error("boom"));
    const saved = JSON.parse([...storage.data.entries()].find(([k]) => k.includes("queue"))![1]) as { error?: { message: string } }[];
    const messages = saved.map((e) => e.error?.message).filter(Boolean);
    expect(messages).toEqual(expect.arrayContaining(["handled before the crash", "boom"]));
  });
});

describe("robustness", () => {
  it("a throwing beforeSend doesn't stop events", async () => {
    const sent: unknown[] = [];
    const c = new DebugClient().init({
      ...base,
      autoCapture: false,
      flushIntervalMs: 0,
      beforeSend: () => {
        throw new Error("bad hook");
      },
      fetch: (async (_u: string, i: { body: string }) => (sent.push(JSON.parse(i.body)), new Response("", { status: 202 }))) as never,
    });
    c.error(new Error("still sent"));
    await c.flush();
    expect(sent).toHaveLength(1);
  });
});

describe("personal data in URLs", () => {
  it("masks phone numbers and emails in paths, keeps versions and words", () => {
    expect(normaliseUrl("https://api.cellc.co.za/v2/subscribers/+27821234567/bundles")).toBe("api.cellc.co.za/v2/subscribers/:id/bundles");
    expect(normaliseUrl("/v1/linked/msisdn-0821234567")).toBe("/v1/linked/:id");
    expect(normaliseUrl("/v1/users/sam%40acme.dev/profile")).toBe("/v1/users/:id/profile");
    expect(normaliseUrl("/v1/users/082 123 4567")).toBe("/v1/users/:id");
    expect(normaliseUrl("/api/v1.2.3/feed")).toBe("/api/v1.2.3/feed");
    expect(normaliseUrl("/v2/bundles/data-500mb")).toBe("/v2/bundles/data-500mb");
  });
});
