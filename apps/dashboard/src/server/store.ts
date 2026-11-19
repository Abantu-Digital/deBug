import type { ReadStore, WriteStore } from "@debugkit/adapters";
import { config } from "./config";
import { cacheStore, type StoreCache } from "./store-cache";

let store: Promise<ReadStore> | undefined;
let cache: StoreCache | undefined;

/** The dashboard only ever reads. Point it at read-only credentials. */
export function getStore(): Promise<ReadStore> {
  return (store ??= create().then((s) => {
    cache = cacheStore(s);
    // Read the health wall now, so the first person to open the dashboard doesn't wait for it.
    void import("./warm").then((m) => m.warmUp(cache!.store)).catch(() => undefined);
    return cache.store;
  }));
}

/** Forget every cached read: called after the dashboard changes anything (status, settings, team). */
export function clearStoreCache(): void {
  cache?.clear();
}

/**
 * Demo mode only: the in-memory store also accepts events, so a local app can send to
 * http://localhost:4400/api/ingest and see them on the dashboard. Real stores stay read-only.
 */
export async function getLocalWriteStore(): Promise<WriteStore | null> {
  const kind = config().store;
  if (kind !== "demo" && kind !== "memory") return null;
  return (await getStore()) as unknown as WriteStore;
}

async function create(): Promise<ReadStore> {
  const cfg = config();
  switch (cfg.store) {
    case "firestore": {
      const { initializeApp, getApps } = await import("firebase-admin/app");
      const { getFirestore } = await import("firebase-admin/firestore");
      const { FirestoreStore } = await import("@debugkit/adapters/firestore");
      if (!getApps().length) initializeApp();
      return new FirestoreStore(getFirestore(), { root: cfg.firestoreRoot });
    }
    case "dynamodb": {
      const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
      const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
      const { DynamoStore } = await import("@debugkit/adapters/dynamodb");
      return new DynamoStore(DynamoDBDocumentClient.from(new DynamoDBClient({})), { table: cfg.dynamoTable });
    }
    case "memory": {
      const { MemoryStore } = await import("@debugkit/adapters/memory");
      return new MemoryStore();
    }
    default: {
      const { keepUpstreamDown, seedDemo } = await import("./demo");
      const demo = await seedDemo();
      keepUpstreamDown(demo, clearStoreCache);
      return demo;
    }
  }
}
