import { createFileRoute } from "@tanstack/react-router";
import { authorizeApi } from "~/server/auth";
import { config } from "~/server/config";
import { buildSummary, SUMMARY_FIELDS } from "~/server/queries";
import { getStore } from "~/server/store";

/** GET /api/summary?app=<id>  — the overview as JSON, for agents and scripts. */
export const Route = createFileRoute("/api/summary")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!authorizeApi(request)) return Response.json({ error: "unauthorized" }, { status: 401 });
        const app = new URL(request.url).searchParams.get("app") ?? undefined;
        const summary = await buildSummary(await getStore(), app, config().severity);
        if (!summary) return Response.json({ error: "no data" }, { status: 404 });
        return Response.json({ ...summary, _fields: SUMMARY_FIELDS, _severityThresholds24h: config().severity });
      },
    },
  },
});
