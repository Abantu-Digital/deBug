import { beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "@debugkit/adapters/memory";
import { compareVersions, isRegression, releaseKey } from "@debugkit/schema";
import { ingest } from "./index";
import { clearSettingsCache, handleAdmin } from "./admin";

const TOKEN = "admin_token_0123456789abcdef";
let n = 0;

/** Send one envelope straight to ingest. */
async function send(store: MemoryStore, opts: { user?: string; version?: string; update?: string; error?: string; crash?: boolean; ts?: string }) {
  const ts = opts.ts ?? new Date().toISOString();
  const events: unknown[] = [{ type: "session", id: `s${++n}xxxxxxx`, ts, status: "started" }];
  if (opts.error) events.push({ type: "error", id: `e${++n}xxxxxxx`, ts, handled: !opts.crash, error: { name: "TypeError", message: opts.error, stack: `TypeError\n    at ${opts.error.replace(/\W/g, "")} (/app/src/a.ts:1:1)` } });
  if (opts.crash) events.push({ type: "session", id: `c${++n}xxxxxxx`, ts, status: "crashed" });
  const env = {
    sdk: { name: "t", version: "1" },
    context: { app: { id: "shop", version: opts.version ?? "1.0.0", update: opts.update }, os: { name: "ios" }, runtime: { name: "rn" } },
    user: { id: opts.user, anonymousId: `anon-${opts.user ?? "x"}` },
    session: { id: `sess${n}`, startedAt: ts },
    events,
  };
  const out = await ingest(JSON.stringify(env), "pk", { store, keys: { pk: "shop" } });
  expect(out.status).toBe(202);
}

beforeEach(() => clearSettingsCache());

describe("users affected", () => {
  it("counts distinct users per app, crash and issue, storing only hashes", async () => {
    const store = new MemoryStore();
    await send(store, { user: "alice", error: "boom" });
    await send(store, { user: "alice", error: "boom" });
    await send(store, { user: "bob", error: "boom", crash: true });
    await send(store, { user: "carol" });
    const today = new Date().toISOString().slice(0, 10);
    const fp = [...store.issues.values()][0]!.fingerprint;
    expect(await store.countUsers("shop", "app", today)).toBe(3);
    expect(await store.countUsers("shop", `issue:${fp}`, today)).toBe(2);
    expect(await store.countUsers("shop", "crash", today)).toBe(1);
    expect([...store.users.keys()].join(" ")).not.toMatch(/alice|bob|carol/);
  });
});

describe("releases", () => {
  it("rolls sessions up per release, including the OTA update", async () => {
    const store = new MemoryStore();
    await send(store, { version: "2.4.0" });
    await send(store, { version: "2.4.0", update: "a1b2c3d4e5f6g7h8" });
    const keys = [...store.rollups.values()].filter((r) => r.dimension === "release").map((r) => r.key).sort();
    expect(keys).toEqual(["2.4.0", "2.4.0+a1b2c3d4e5f6"]);
    expect(releaseKey({ version: "3.0.0" })).toBe("3.0.0");
  });

  it("compares versions numerically", () => {
    expect(compareVersions("2.10.0", "2.9.1")).toBeGreaterThan(0);
    expect(compareVersions("2.4.0", "2.4.0")).toBe(0);
    expect(isRegression("2.4.1", "2.4.0", undefined, "t")).toBe(false); // old build, not a regression
    expect(isRegression("2.4.1", "2.5.0", undefined, "t")).toBe(true);
  });
});

describe("issue status", () => {
  it("resolves through the admin route and flags a regression in the fixed release", async () => {
    const store = new MemoryStore();
    await send(store, { version: "2.4.0", error: "login" });
    const fp = [...store.issues.values()][0]!.fingerprint;
    const admin = (body: unknown) => handleAdmin({ method: "PUT", path: "/admin/issue", body: JSON.stringify(body), authorization: `Bearer ${TOKEN}` }, { store, adminToken: TOKEN });

    expect((await admin({ app: "shop", fingerprint: fp, status: "nope" })).status).toBe(400);
    expect((await admin({ app: "shop", fingerprint: "deadbeefdeadbeef", status: "resolved" })).status).toBe(404);
    expect((await admin({ app: "shop", fingerprint: fp, status: "resolved", resolvedIn: "2.4.1" })).body).toMatchObject({ ok: true, status: "resolved", resolvedIn: "2.4.1" });

    await send(store, { version: "2.4.0", error: "login" }); // someone still on the old build
    expect(store.issues.get(`shop/${fp}`)?.status).toBe("resolved");
    await send(store, { version: "2.4.1", error: "login" }); // back in the fixed build
    expect(store.issues.get(`shop/${fp}`)).toMatchObject({ status: "regressed", firstVersion: "2.4.0", lastVersion: "2.4.1" });

    await admin({ app: "shop", fingerprint: fp, status: "ignored" });
    expect(store.issues.get(`shop/${fp}`)).toMatchObject({ status: "ignored", resolvedIn: undefined });
  });
});
