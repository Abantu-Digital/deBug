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
}
