import { CORS_HEADERS, ingest, type IngestOptions } from "./index";

interface HttpEvent {
  body?: string | null;
  isBase64Encoded?: boolean;
  headers?: Record<string, string | undefined>;
  requestContext?: { http?: { method?: string } };
  httpMethod?: string;
}

/**
 * Handler for AWS Lambda behind a Function URL or API Gateway (v1 or v2):
 *
 *   import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
 *   import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
 *   import { DynamoStore } from "@debugkit/adapters/dynamodb";
 *   import { lambdaHandler } from "@debugkit/ingest/lambda";
 *   import { parseIngestKeys } from "@debugkit/ingest";
 *
 *   const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
 *   export const handler = lambdaHandler({
 *     store: new DynamoStore(doc, { table: process.env.DEBUG_TABLE! }),
 *     keys: parseIngestKeys(process.env.DEBUG_INGEST_KEYS),
 *   });
 */
export function lambdaHandler(opts: IngestOptions) {
  return async (event: HttpEvent) => {
    const method = event.requestContext?.http?.method ?? event.httpMethod ?? "POST";
    if (method === "OPTIONS") return { statusCode: 204, headers: CORS_HEADERS, body: "" };
    if (method !== "POST") return reply(405, { ok: false, error: "method not allowed" });
    const headers = Object.fromEntries(Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : (event.body ?? "");
    try {
      const out = await ingest(raw, headers["x-debug-key"], opts);
      return reply(out.status, out.body);
    } catch (err) {
      console.error("[deBug] ingest failed", err);
      return reply(500, { ok: false, error: "internal" });
    }
  };
}

const reply = (statusCode: number, body: unknown) => ({
  statusCode,
  headers: { ...CORS_HEADERS, "content-type": "application/json" },
  body: JSON.stringify(body),
});
