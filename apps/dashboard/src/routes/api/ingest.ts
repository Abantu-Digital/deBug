import { createFileRoute } from "@tanstack/react-router";
import { CORS_HEADERS, ingest, parseIngestKeys } from "@debug/ingest";
import { config } from "~/server/config";
import { getLocalWriteStore } from "~/server/store";

/**
 * POST /api/ingest — local development ingest, available only in demo mode.
 * Point the SDK at http://localhost:4400/api/ingest with ingestKey "pk_local".
 * In production, events go to the ingest function in your own cloud instead.
 */
export const Route = createFileRoute("/api/ingest")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS_HEADERS }),
      POST: async ({ request }) => {
        const store = await getLocalWriteStore();
        if (!store) {
          return Response.json(
            { ok: false, error: "Local ingest is only available when DEBUG_STORE=demo. Send events to your cloud ingest function." },
            { status: 404, headers: CORS_HEADERS },
          );
        }
        const out = await ingest(await request.text(), request.headers.get("x-debug-key") ?? undefined, {
          store,
          keys: parseIngestKeys(config().localIngestKeys),
        });
        return Response.json(out.body, { status: out.status, headers: CORS_HEADERS });
      },
    },
  },
});
