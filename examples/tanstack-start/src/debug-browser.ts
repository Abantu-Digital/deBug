import { deBug } from "@debugkit/sdk/react";

// Browser side. Runs once when the client bundle loads.
if (typeof window !== "undefined" && !deBug.initialized) {
  deBug.init({
    endpoint: import.meta.env.VITE_DEBUG_ENDPOINT ?? "http://localhost:4400/api/ingest",
    ingestKey: "pk_local",
    app: { id: "tanstack-start-example", version: "1.0.0", environment: import.meta.env.MODE },
    flushIntervalMs: 2000,
  });
}
