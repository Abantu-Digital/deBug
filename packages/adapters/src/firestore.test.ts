import { describe, expect, it } from "vitest";
import { FirestoreStore } from "./firestore";

/** Just enough Firestore for one app document: get, set with merge (deep, like Firestore's), and transactions. */
function fakeDb() {
  const docs = new Map<string, Record<string, unknown>>();
  const merge = (a: Record<string, any>, b: Record<string, any>): Record<string, any> => {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === "object" && !Array.isArray(v) && a[k] && typeof a[k] === "object" ? merge(a[k], v) : v;
    return out;
  };
  const ref = (path: string) => ({
    path,
    async get() {
      const d = docs.get(path);
      return { exists: !!d, data: () => d };
    },
    async set(v: Record<string, unknown>, o?: { merge?: boolean }) {
      docs.set(path, o?.merge ? merge(docs.get(path) ?? {}, v) : v);
    },
  });
  const db = {
    collection: (c: string) => ({ doc: (id: string) => ref(`${c}/${id}`) }),
    async runTransaction(fn: (tx: unknown) => Promise<void>) {
      const tx = { get: (r: ReturnType<typeof ref>) => r.get(), set: (r: ReturnType<typeof ref>, v: Record<string, unknown>, o?: { merge?: boolean }) => void r.set(v, o) };
      await fn(tx);
    },
  };
  return { db: db as never, docs };
}

describe("FirestoreStore versions", () => {
  it("keeps the newest SDK and the ingest on the app's document, leaving its other fields alone", async () => {
    const { db, docs } = fakeDb();
    const store = new FirestoreStore(db);
    docs.set("debug_apps/a", { id: "a", name: "Cell C" });
    expect(await store.getVersions("a")).toEqual({});
    await store.recordVersions("a", { sdk: "0.8.0", ingest: "0.9.0", at: "t1" });
    await store.recordVersions("a", { sdk: "0.7.2", ingest: "0.9.0", at: "t2" });
    expect(await store.getVersions("a")).toEqual({ sdk: { version: "0.8.0", seenAt: "t1" }, ingest: { version: "0.9.0", at: "t2" } });
    expect(docs.get("debug_apps/a")).toMatchObject({ id: "a", name: "Cell C" });
  });
});
