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
        const app = new URL(request.url).searchParams.get("app");
        if (!app) return Response.json({ error: "app query param required" }, { status: 400 });
        const detail = await buildIssueDetail(await getStore(), app, params.fingerprint, config().severity);
        if (!detail) return Response.json({ error: "not found" }, { status: 404 });
        return Response.json(detail);
      },
    },
  },
});
