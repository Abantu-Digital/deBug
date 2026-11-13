#!/usr/bin/env node
// Production server for a self-hosted deBug dashboard: `pnpm build && pnpm start`.
// Serves built assets from dist/client and hands every other request to the TanStack Start handler.
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

try {
  process.loadEnvFile(process.env.DEBUG_ENV_FILE ?? ".env");
} catch {}
process.env.NODE_ENV ??= "production";

const root = fileURLToPath(new URL("./dist/client", import.meta.url));
const { default: app } = await import("./dist/server/server.js");
const port = Number(process.env.PORT ?? 4400);
const host = process.env.HOST ?? "127.0.0.1"; // bind to localhost by default; set HOST=0.0.0.0 behind a proxy

const TYPES = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".json": "application/json", ".txt": "text/plain" };

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const file = normalize(join(root, decodeURIComponent(url.pathname)));
    if (file.startsWith(root) && url.pathname !== "/" && existsSync(file) && statSync(file).isFile()) {
      res.writeHead(200, {
        "content-type": TYPES[extname(file)] ?? "application/octet-stream",
        "cache-control": url.pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
      });
      return createReadStream(file).pipe(res);
    }
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : Readable.toWeb(req);
    const request = new Request(url, { method: req.method, headers: req.headers, body, duplex: "half" });
    const response = await app.fetch(request);
    const headers = {};
    response.headers.forEach((v, k) => {
      if (k !== "set-cookie") headers[k] = v;
    });
    const cookies = response.headers.getSetCookie?.() ?? [];
    if (cookies.length) headers["set-cookie"] = cookies;
    res.writeHead(response.status, headers);
    if (response.body && req.method !== "HEAD") Readable.fromWeb(response.body).pipe(res);
    else res.end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500);
    res.end("Internal error");
  }
}).listen(port, host, () => console.log(`deBug dashboard on http://${host}:${port}`));
