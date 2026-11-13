// The deBug dashboard as one request handler, for any Node host: the local server (server.mjs),
// a Firebase function (onRequest), or a Lambda behind a Function URL (see lambda.mjs).
// Serves built assets from dist/client and hands every other request to the TanStack Start app.
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("./dist/client", import.meta.url));
const TYPES = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".txt": "text/plain",
};

let app;
/** The built TanStack Start app (loaded once, on the first request). */
const loadApp = () => (app ??= import("./dist/server/server.js").then((m) => m.default));

/** A static file under dist/client for this path, or undefined. Never escapes the folder. */
export function staticFile(pathname, root = ROOT) {
  if (pathname === "/") return undefined;
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  const file = normalize(join(root, decoded));
  if (!file.startsWith(root + sep)) return undefined;
  return existsSync(file) && statSync(file).isFile() ? file : undefined;
}

/** The web Request for a Node request. Hosts that already read the body (Firebase, Express) leave it in rawBody. */
export function toRequest(req) {
  const proto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() || (req.socket?.encrypted ? "https" : "http");
  const host = req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost";
  const url = new URL(req.originalUrl ?? req.url ?? "/", `${proto}://${host}`);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) headers.append(k, String(one));
  }
  const method = req.method ?? "GET";
  let body;
  if (method !== "GET" && method !== "HEAD") body = Buffer.isBuffer(req.rawBody) ? req.rawBody : Readable.toWeb(req);
  return new Request(url, { method, headers, body, duplex: body && !Buffer.isBuffer(body) ? "half" : undefined });
}

/** Write a web Response to a Node response, keeping every Set-Cookie header. */
export async function sendResponse(res, response, method = "GET") {
  const headers = {};
  response.headers.forEach((v, k) => {
    if (k !== "set-cookie") headers[k] = v;
  });
  const cookies = response.headers.getSetCookie?.() ?? [];
  if (cookies.length) headers["set-cookie"] = cookies;
  res.writeHead(response.status, headers);
  if (response.body && method !== "HEAD") Readable.fromWeb(response.body).pipe(res);
  else res.end();
}

/**
 * The dashboard as `(req, res) => Promise<void>`. Settings come from process.env (see .env.example).
 * Options: `root` (the built client assets), `app` (a fetch handler, for tests).
 */
export function createHandler(options = {}) {
  const root = options.root ?? ROOT;
  return async function debugkitDashboard(req, res) {
    try {
      const url = new URL(req.originalUrl ?? req.url ?? "/", "http://x");
      const file = staticFile(url.pathname, root);
      if (file && (req.method === "GET" || req.method === "HEAD")) {
        res.writeHead(200, {
          "content-type": TYPES[extname(file)] ?? "application/octet-stream",
          "cache-control": url.pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
        });
        if (req.method === "HEAD") return void res.end();
        return void createReadStream(file).pipe(res);
      }
      const fetchApp = options.app ?? (await loadApp());
      const response = await fetchApp.fetch(toRequest(req));
      await sendResponse(res, response, req.method);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) res.writeHead(500);
      res.end("Internal error");
    }
  };
}
