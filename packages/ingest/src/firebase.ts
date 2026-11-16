import { handleAdmin } from "./admin";
import { CORS_HEADERS, ingest, type IngestOptions } from "./index";
import { INGEST_VERSION, VERSION_HEADER } from "./version";

/**
 * Express-style handler for Firebase Cloud Functions (v2):
 *
 *   import { onRequest } from "firebase-functions/v2/https";
 *   import { getFirestore } from "firebase-admin/firestore";
 *   import { initializeApp } from "firebase-admin/app";
 *   import { FirestoreStore } from "@debugkit/adapters/firestore";
 *   import { firebaseHandler } from "@debugkit/ingest/firebase";
 *   import { parseIngestKeys } from "@debugkit/ingest";
 *
 *   initializeApp();
 *   export const debugIngest = onRequest(
 *     firebaseHandler({ store: new FirestoreStore(getFirestore()), keys: parseIngestKeys(process.env.DEBUG_INGEST_KEYS) }),
 *   );
 */
export function firebaseHandler(opts: IngestOptions & { adminToken?: string }) {
  return async (
    req: { method: string; path?: string; query?: Record<string, unknown>; header(name: string): string | undefined; rawBody?: Buffer; body?: unknown },
    res: { set(h: Record<string, string>): unknown; status(n: number): { json(b: unknown): void; send(b?: unknown): void } },
  ) => {
    res.set({ [VERSION_HEADER]: INGEST_VERSION });
    const rawText = () => req.rawBody?.toString("utf8") ?? (typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {}));
    // Settings routes for the dashboard (server to server: no CORS).
    if (req.path?.startsWith("/admin")) {
      try {
        const query = Object.fromEntries(Object.entries(req.query ?? {}).map(([k, v]) => [k, typeof v === "string" ? v : undefined]));
        const out = await handleAdmin({ method: req.method, path: req.path, query, body: req.method === "GET" ? "" : rawText(), authorization: req.header("authorization") }, { store: opts.store, adminToken: opts.adminToken, retentionDays: opts.retentionDays });
        return res.status(out.status).json(out.body);
      } catch (err) {
        console.error("[deBug] admin request failed", err);
        return res.status(500).json({ ok: false, error: "internal" });
      }
    }
    res.set(CORS_HEADERS);
    if (req.method === "OPTIONS") return res.status(204).send();
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method not allowed" });
    const raw = rawText();
    try {
      const out = await ingest(raw, req.header("x-debug-key"), opts);
      res.status(out.status).json(out.body);
    } catch (err) {
      console.error("[deBug] ingest failed", err);
      res.status(500).json({ ok: false, error: "internal" });
    }
  };
}
