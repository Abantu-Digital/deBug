import { networkInterfaces } from "node:os";
import { keyEntry } from "../keys";
import { cmdFor } from "../state";
import { code, p } from "../ui";
import type { ProviderResult, SetupContext } from "./types";

/** This machine's address on the local network, so a phone or emulator can reach the dashboard. */
export function lanAddress(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254.")) return a.address;
  }
  return undefined;
}

/**
 * No cloud: the dashboard keeps events in memory and accepts them itself at /api/ingest.
 * Good for trying deBug out; the data is gone when the dashboard stops.
 */
export async function setupLocal(ctx: SetupContext): Promise<ProviderResult> {
  const mobile = ctx.app.platform === "expo" || ctx.app.platform === "react-native";
  const host = mobile ? (lanAddress() ?? "127.0.0.1") : "127.0.0.1";
  const endpoint = `http://${host}:${ctx.dashboardPort}/api/ingest`;
  if (mobile) p.log.info(`Phones and emulators reach this Mac at ${code(host)}, so the dashboard will listen on your local network (password protected).`);
  return {
    config: { provider: "local", endpoint, ingestKey: ctx.ingestKey, local: { port: ctx.dashboardPort } },
    dashboardEnv: {
      DEBUG_STORE: "memory",
      DEBUG_LOCAL_INGEST_KEYS: keyEntry(ctx.ingestKey, ctx.app.appId),
      ...(mobile ? { HOST: "0.0.0.0", DEBUG_INSECURE_COOKIES: "1" } : {}),
    },
    created: [
      `Nothing in the cloud: the dashboard stores events in memory while it runs`,
      `Ingest endpoint: ${code(endpoint)} (only while ${code(cmdFor("dashboard"))} is running)`,
    ],
  };
}
