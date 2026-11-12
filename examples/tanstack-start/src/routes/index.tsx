import { deBug } from "@debugkit/sdk/react";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { chargeCard } from "../server/fns";

export const Route = createFileRoute("/")({ component: Home });

function Bomb(): never {
  throw new Error("Render crash from <Bomb /> in the TanStack Start example");
}

function Home() {
  const [status, setStatus] = useState("Click a button. Events appear on the dashboard at localhost:4400.");
  const [bomb, setBomb] = useState(false);
  if (bomb) return <Bomb />;

  const buttons: [string, () => void | Promise<void>][] = [
    ["Server function error (withDebug)", async () => {
      try {
        // The server already reports the error (withDebug), so only record the failed outcome here.
        await deBug.track("checkout.payment", "charge", () => chargeCard(), { captureError: false });
      } catch (e) {
        setStatus(`Server said: ${(e as Error).message}. Reported from the server and the browser.`);
      }
    }],
    ["Client error (handled)", () => {
      deBug.error(new TypeError("Cannot read properties of null (reading 'cart')"), { flow: "cart.view" });
      setStatus("Logged a handled client error under cart.view.");
    }],
    ["Render crash (error boundary)", () => setBomb(true)],
  ];

  return (
    <main style={{ display: "grid", gap: 12 }}>
      <h1 style={{ margin: 0 }}>deBug playground</h1>
      <p style={{ margin: 0, color: "#666" }}>TanStack Start · app id tanstack-start-example</p>
      {buttons.map(([label, run]) => (
        <button key={label} onClick={run} style={{ padding: "12px 14px", borderRadius: 8, border: 0, background: "#c8252f", color: "white", fontWeight: 600, textAlign: "left", cursor: "pointer" }}>
          {label}
        </button>
      ))}
      <p id="status">{status}</p>
    </main>
  );
}
