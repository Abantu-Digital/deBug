import { CORS_HEADERS, ingest, type IngestOptions } from "./index";

/**
 * Express-style handler for Firebase Cloud Functions (v2):
 *
 *   import { onRequest } from "firebase-functions/v2/https";
 *   import { getFirestore } from "firebase-admin/firestore";
 *   import { initializeApp } from "firebase-admin/app";
 *   import { FirestoreStore } from "@debug/adapters/firestore";
 *   import { firebaseHandler } from "@debug/ingest/firebase";
 *   import { parseIngestKeys } from "@debug/ingest";
 *
 *   initializeApp();
 *   export const debugIngest = onRequest(
 *     firebaseHandler({ store: new FirestoreStore(getFirestore()), keys: parseIngestKeys(process.env.DEBUG_INGEST_KEYS) }),
 *   );
 */
export function firebaseHandler(opts: IngestOptions) {
  return async (
    req: { method: string; header(name: string): string | undefined; rawBody?: Buffer; body?: unknown },
    res: { set(h: Record<string, string>): unknown; status(n: number): { json(b: unknown): void; send(b?: unknown): void } },
  ) => {
    res.set(CORS_HEADERS);
    if (req.method === "OPTIONS") return res.status(204).send();
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method not allowed" });
    const raw = req.rawBody?.toString("utf8") ?? (typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {}));
    try {
      const out = await ingest(raw, req.header("x-debug-key"), opts);
      res.status(out.status).json(out.body);
    } catch (err) {
      console.error("[deBug] ingest failed", err);
      res.status(500).json({ ok: false, error: "internal" });
    }
  };
}
