import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MemoryStore } from "@debugkit/adapters/memory";
import { CORS_HEADERS, INGEST_VERSION, ingest, VERSION_HEADER } from "./index";
import { lambdaHandler } from "./lambda";
import { firebaseHandler } from "./firebase";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const env = (app: string, sdk: string, id: string) =>
  JSON.stringify({
    sdk: { name: "@debugkit/sdk", version: sdk },
    context: { app: { id: app, version: "1.0.0" }, os: { name: "android" }, runtime: { name: "react-native" }, device: {} },
    session: { id: "s1", startedAt: "2026-11-16T09:00:00.000Z" },
    events: [{ type: "event", id, ts: "2026-11-16T09:00:01.000Z", name: "app.opened" }],
  });

describe("versions", () => {
  it("is the package's own version, sent and exposed on every response", () => {
    expect(INGEST_VERSION).toBe(pkg.version);
    expect(CORS_HEADERS).toMatchObject({ [VERSION_HEADER]: pkg.version, "access-control-expose-headers": "x-debugkit-version" });
    expect(VERSION_HEADER).toBe("x-debugkit-version");
  });

  it("records the newest SDK per app and this ingest, writing only when the SDK moves on", async () => {
    const store = new MemoryStore();
    let writes = 0;
    const record = store.recordVersions.bind(store);
    store.recordVersions = async (...a) => {
      writes++;
      return record(...a);
    };
    const keys = { k: "*" };
    const now = () => new Date("2026-11-16T09:01:00.000Z");
    expect((await ingest(env("v-app", "0.8.0", "evt_000000001"), "k", { store, keys, now })).status).toBe(202);
    await ingest(env("v-app", "0.8.0", "evt_000000002"), "k", { store, keys, now });
    await ingest(env("v-app", "0.7.2", "evt_000000003"), "k", { store, keys, now });
    expect(writes).toBe(1);
    await ingest(env("v-app", "0.9.0", "evt_000000004"), "k", { store, keys, now });
    expect(writes).toBe(2);
    expect(await store.getVersions("v-app")).toEqual({ sdk: { version: "0.9.0", seenAt: "2026-11-16T09:01:00.000Z" }, ingest: { version: pkg.version, at: "2026-11-16T09:01:00.000Z" } });
  });

  it("never fails an envelope because the versions couldn't be written", async () => {
    const store = new MemoryStore();
    store.recordVersions = async () => {
      throw new Error("down");
    };
    expect((await ingest(env("v-broken", "0.8.0", "evt_000000011"), "k", { store, keys: { k: "*" } })).status).toBe(202);
  });

  it("sets the header on accepted, rejected and admin responses alike", async () => {
    const store = new MemoryStore();
    const lambda = lambdaHandler({ store, keys: { k: "*" } });
    for (const event of [{ headers: { "x-debug-key": "k" }, body: env("v-l", "0.8.0", "evt_000000021") }, { headers: {}, body: "{}" }, { httpMethod: "OPTIONS" }, { rawPath: "/admin/settings", headers: {} }]) {
      const out = (await lambda(event as never)) as { headers: Record<string, string> };
      expect(out.headers[VERSION_HEADER]).toBe(pkg.version);
    }
    const set: Record<string, string> = {};
    const res = { set: (h: Record<string, string>) => Object.assign(set, h), status: () => ({ json() {}, send() {} }) };
    await firebaseHandler({ store, keys: {} })({ method: "POST", path: "/", header: () => undefined, body: "{}" }, res);
    expect(set[VERSION_HEADER]).toBe(pkg.version);
  });
});
