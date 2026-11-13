#!/usr/bin/env node
// Local or self-hosted deBug dashboard: `npx @debugkit/dashboard`, or `pnpm build && pnpm start` here.
// The same handler runs hosted in Firebase (handler.mjs) and on AWS Lambda (lambda.mjs).
import { createServer } from "node:http";

try {
  process.loadEnvFile(process.env.DEBUG_ENV_FILE ?? ".env");
} catch {}
process.env.NODE_ENV ??= "production";

const { createHandler } = await import("./handler.mjs");
const port = Number(process.env.PORT ?? 4400);
const host = process.env.HOST ?? "127.0.0.1"; // bind to localhost by default; set HOST=0.0.0.0 behind a proxy

createServer(createHandler()).listen(port, host, () => console.log(`deBug dashboard on http://${host}:${port}`));
