import { describe, expect, it, vi } from "vitest";
import type { ReadStore } from "@debugkit/adapters";
import { cacheStore, FRESH_MS, STALE_MS } from "./store-cache";

function fakeStore() {
  let n = 0;
  const store = {
    listApps: vi.fn(async () => [`app${++n}`]),
    getMember: vi.fn(async () => null),
    newRead: vi.fn(async () => 1),
    setIssueStatus: vi.fn(async () => null),
  };
  return { store, ro: store as unknown as ReadStore };
}

describe("cacheStore", () => {
  it("reads once for the same call, at the same time or within FRESH_MS", async () => {
    let t = 0;
    const { store, ro } = fakeStore();
    const c = cacheStore(ro, () => t);
    const [a, b] = await Promise.all([c.store.listApps(), c.store.listApps()]);
    expect(a).toEqual(["app1"]);
    expect(b).toEqual(["app1"]);
    t = FRESH_MS - 1;
    expect(await c.store.listApps()).toEqual(["app1"]);
    expect(store.listApps).toHaveBeenCalledTimes(1);
  });

  it("serves a stale read at once and reads again in the background", async () => {
    let t = 0;
    const { store, ro } = fakeStore();
    const c = cacheStore(ro, () => t);
    await c.store.listApps();
    t = FRESH_MS + 1;
    expect(await c.store.listApps()).toEqual(["app1"]);
    await Promise.resolve();
    expect(await c.store.listApps()).toEqual(["app2"]);
    expect(store.listApps).toHaveBeenCalledTimes(2);
  });

  it("reads again past STALE_MS, after a write, and after clear()", async () => {
    let t = 0;
    const { store, ro } = fakeStore();
    const c = cacheStore(ro, () => t);
    await c.store.listApps();
    t = STALE_MS + 1;
    expect(await c.store.listApps()).toEqual(["app2"]);
    await (c.store as unknown as typeof store).setIssueStatus();
    expect(await c.store.listApps()).toEqual(["app3"]);
    c.clear();
    expect(await c.store.listApps()).toEqual(["app4"]);
  });

  it("doesn't let a background read from before a write put old data back", async () => {
    let t = 0;
    let release!: (v: string[]) => void;
    const store = { listApps: vi.fn().mockResolvedValueOnce(["old"]).mockImplementationOnce(() => new Promise((r) => (release = r))).mockResolvedValue(["new"]) };
    const c = cacheStore(store as unknown as ReadStore, () => t);
    await c.store.listApps();
    t = FRESH_MS + 1;
    await c.store.listApps(); // starts the background read
    c.clear(); // a write happens meanwhile
    release(["before the write"]);
    await Promise.resolve();
    expect(await c.store.listApps()).toEqual(["new"]);
  });

  it("never caches sign-in and team reads, and leaves calls it doesn't know alone", async () => {
    const { store, ro } = fakeStore();
    const c = cacheStore(ro);
    await c.store.listApps();
    await c.store.getMember("a@b.c");
    await c.store.getMember("a@b.c");
    expect(store.getMember).toHaveBeenCalledTimes(2);
    await (c.store as unknown as typeof store).newRead();
    await c.store.listApps();
    expect(store.listApps).toHaveBeenCalledTimes(1);
  });

  it("doesn't keep a failed read", async () => {
    const store = { listApps: vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce(["ok"]) };
    const c = cacheStore(store as unknown as ReadStore);
    await expect(c.store.listApps()).rejects.toThrow("down");
    expect(await c.store.listApps()).toEqual(["ok"]);
  });
});
