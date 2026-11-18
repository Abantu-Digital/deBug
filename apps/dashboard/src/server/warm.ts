import type { ReadStore } from "@debugkit/adapters";
import { config } from "./config";
import { buildEndpoints } from "./endpoints";
import { buildSummary } from "./queries";

/**
 * Fills the store cache with what the home page reads (the summary and the endpoints for the
 * first app, over the default period), in the background as the server starts. Nothing waits on
 * it and a failure is ignored: the page reads for itself.
 */
export async function warmUp(store: ReadStore, now = Date.now()): Promise<void> {
  const app = (await store.listApps())[0];
  if (!app) return;
  const opts = { retentionDays: config().retentionDays };
  await Promise.all([buildEndpoints(store, app, now, opts), buildSummary(store, app, config().severity, now, opts)]);
}
