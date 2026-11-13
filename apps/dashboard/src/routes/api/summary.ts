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
        if (!(await authorizeApi(request))) return Response.json({ error: "unauthorized" }, { status: 401 });
        const q = new URL(request.url).searchParams;
        const app = q.get("app") ?? undefined;
        const range = { range: q.get("range") ?? undefined, from: q.get("from") ?? undefined, to: q.get("to") ?? undefined };
        const summary = await buildSummary(await getStore(), app, config().severity, Date.now(), { range, retentionDays: config().retentionDays });
        if (!summary) return Response.json({ error: "no data" }, { status: 404 });
        return Response.json({ ...summary, _fields: SUMMARY_FIELDS, _severityThresholds24h: config().severity });
      },
    },
  },
});
