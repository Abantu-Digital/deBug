import type { AppInfo } from "../detect";
import type { DebugkitConfig } from "../state";

export interface ProviderResult {
  config: Omit<DebugkitConfig, "createdAt" | "dashboardPort" | "appId">;
  /** Settings the dashboard needs to read this provider's data, without the login settings. */
  dashboardEnv: Record<string, string>;
  /** Plain-language summary of what was created and where, shown at the end. */
  created: string[];
}

export interface SetupContext {
  app: AppInfo;
  ingestKey: string;
  dashboardPort: number;
  /** How long raw events are kept until the app has a setting (DEBUG_RETENTION_DAYS). */
  retentionDays: number;
  /** Secret the dashboard uses to change settings through the ingest function (DEBUG_ADMIN_TOKEN). */
  adminToken: string;
}

/** What the dashboard needs to change settings through the deployed ingest function. */
export const adminEnv = (endpoint: string, ctx: SetupContext) => ({
  DEBUG_ADMIN_URL: `${endpoint.replace(/\/+$/, "")}/admin`,
  DEBUG_ADMIN_TOKEN: ctx.adminToken,
  DEBUG_RETENTION_DAYS: String(ctx.retentionDays),
});
