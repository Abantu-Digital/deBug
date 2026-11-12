import type { ReadStore, WriteStore } from "@debug/adapters";
import { config } from "./config";

let store: Promise<ReadStore> | undefined;

/** The dashboard only ever reads. Point it at read-only credentials. */
export function getStore(): Promise<ReadStore> {
  return (store ??= create());
}

/**
 * Demo mode only: the in-memory store also accepts events, so a local app can send to
 * http://localhost:4400/api/ingest and see them on the dashboard. Real stores stay read-only.
 */
export async function getLocalWriteStore(): Promise<WriteStore | null> {
  if (config().store !== "demo") return null;
  return (await getStore()) as unknown as WriteStore;
}

async function create(): Promise<ReadStore> {
  const cfg = config();
  switch (cfg.store) {
    case "firestore": {
      const { initializeApp, getApps } = await import("firebase-admin/app");
      const { getFirestore } = await import("firebase-admin/firestore");
      const { FirestoreStore } = await import("@debug/adapters/firestore");
      if (!getApps().length) initializeApp();
      return new FirestoreStore(getFirestore(), { root: cfg.firestoreRoot });
    }
    case "dynamodb": {
      const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
      const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
      const { DynamoStore } = await import("@debug/adapters/dynamodb");
      return new DynamoStore(DynamoDBDocumentClient.from(new DynamoDBClient({})), { table: cfg.dynamoTable });
    }
    default: {
      const { seedDemo } = await import("./demo");
      return seedDemo();
    }
  }
}
