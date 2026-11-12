import { deBug, DebugErrorBoundary } from "@debugkit/sdk/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

// Browser context (OS, browser, screen, network) is detected automatically.
deBug.init({
  endpoint: import.meta.env.VITE_DEBUG_ENDPOINT ?? "http://localhost:4400/api/ingest",
  ingestKey: import.meta.env.VITE_DEBUG_KEY ?? "pk_local",
  app: { id: "vite-react-example", version: "1.0.0", environment: import.meta.env.MODE },
  flushIntervalMs: 2000,
  debug: true,
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DebugErrorBoundary
      flow="app.root"
      fallback={({ error, reset }) => (
        <div style={{ padding: 32, fontFamily: "system-ui" }}>
          <h1>Something went wrong</h1>
          <p>{error.message}</p>
          <p>deBug has recorded this crash.</p>
          <button onClick={reset}>Try again</button>
        </div>
      )}
    >
      <App />
    </DebugErrorBoundary>
  </StrictMode>,
);
