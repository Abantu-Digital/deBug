import { deBug, useDebugNavigation } from "@debugkit/sdk/react";
import { useState } from "react";

function Bomb(): never {
  throw new Error("Render crash from <Bomb /> in the Vite example");
}

export function App() {
  const [status, setStatus] = useState("Tap a button. Events appear on the dashboard at localhost:4400.");
  const [bomb, setBomb] = useState(false);
  const [page, setPage] = useState("/home");
  useDebugNavigation(page); // any router: pass the current path

  if (bomb) return <Bomb />;

  const buttons: [string, () => void | Promise<void>][] = [
    ["Failing login (track + handled error)", async () => {
      deBug.breadcrumb("ui", "Clicked Sign in");
      try {
        await deBug.track("auth.login", "submit_password", async () => {
          const res = await fetch("http://localhost:4400/api/does-not-exist");
          if (!res.ok) throw new Error(`Login failed: ${res.status} ${res.statusText}`);
        });
      } catch {
        setStatus("Logged a failed login and its error under auth.login.");
      }
    }],
    ["Custom event (search used)", () => {
      deBug.event("search.used", { flow: "search.query", outcome: "success", props: { results: 12 } });
      setStatus("Logged a success event for search.query.");
    }],
    ["Uncaught error in a handler", () => {
      setStatus("Threw an error nobody caught (window error handler).");
      setTimeout(() => {
        throw new TypeError("Cannot read properties of undefined (reading 'items')");
      });
    }],
    ["Unhandled promise rejection", () => {
      void Promise.reject(new Error("Unhandled rejection from the Vite example"));
      setStatus("Rejected a promise nobody handled.");
    }],
    ["Render crash (error boundary)", () => setBomb(true)],
    ["Go to /settings", () => setPage(page === "/settings" ? "/home" : "/settings")],
  ];

  return (
    <main style={{ fontFamily: "system-ui", maxWidth: 520, margin: "48px auto", padding: "0 16px", display: "grid", gap: 12 }}>
      <h1 style={{ margin: 0 }}>deBug playground</h1>
      <p style={{ margin: 0, color: "#666" }}>Vite + React · app id vite-react-example · page {page}</p>
      {buttons.map(([label, run]) => (
        <button key={label} onClick={run} style={{ padding: "12px 14px", borderRadius: 8, border: 0, background: "#c8252f", color: "white", fontWeight: 600, cursor: "pointer", textAlign: "left" }}>
          {label}
        </button>
      ))}
      <p id="status">{status}</p>
    </main>
  );
}
