import { createFileRoute } from "@tanstack/react-router";
import { authorizeApi } from "~/server/auth";
import { config } from "~/server/config";
import { buildIssueDetail } from "~/server/queries";
import { getStore } from "~/server/store";

/** GET /api/issues/<fingerprint>?app=<id> — one issue with breakdowns, sample stack, breadcrumbs and hints. */
export const Route = createFileRoute("/api/issues/$fingerprint")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (!authorizeApi(request)) return Response.json({ error: "unauthorized" }, { status: 401 });
        const q = new URL(request.url).searchParams;
        const app = q.get("app");
        if (!app) return Response.json({ error: "app query param required" }, { status: 400 });
        const range = { range: q.get("range") ?? undefined, from: q.get("from") ?? undefined, to: q.get("to") ?? undefined };
        const detail = await buildIssueDetail(await getStore(), app, params.fingerprint, config().severity, Date.now(), { range, retentionDays: config().retentionDays });
        if (!detail) return Response.json({ error: "not found" }, { status: 404 });
        return Response.json(detail);
      },
    },
  },
});
