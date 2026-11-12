import { deBug, initNode } from "@debugkit/sdk/node";

// Server side. Called lazily from server functions so nothing here reaches the client bundle.
export function ensureServerDebug() {
  if (deBug.initialized) return deBug;
  return initNode({
    endpoint: process.env.DEBUG_ENDPOINT ?? "http://localhost:4400/api/ingest",
    ingestKey: "pk_local",
    app: { id: "tanstack-start-example", version: "1.0.0", environment: "server" },
    // Don't let deBug exit the Vite dev server on a stray error. Leave this on in production.
    captureProcessErrors: false,
  });
}
