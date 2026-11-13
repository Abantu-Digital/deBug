// The deBug dashboard on AWS Lambda, behind a Function URL (payload format 2.0).
// Deployed by `npx debugkit deploy-dashboard`; settings come from the function's environment.
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { staticFile } from "./handler.mjs";

process.env.NODE_ENV ??= "production";

const TEXT = /^(text\/|application\/(json|javascript)|image\/svg)/;
const TYPES = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".json": "application/json", ".txt": "text/plain" };

let app;
const loadApp = () => (app ??= import("./dist/server/server.js").then((m) => m.default));

/** A web Request for a Function URL event. */
export function eventToRequest(event) {
  const h = event.headers ?? {};
  const url = new URL(`https://${h["x-forwarded-host"] ?? h.host ?? event.requestContext?.domainName ?? "localhost"}${event.rawPath ?? "/"}${event.rawQueryString ? `?${event.rawQueryString}` : ""}`);
  const headers = new Headers();
  for (const [k, v] of Object.entries(h)) if (v !== undefined) headers.set(k, String(v));
  // Function URLs move cookies out of the headers.
  if (event.cookies?.length) headers.set("cookie", event.cookies.join("; "));
  const method = event.requestContext?.http?.method ?? "GET";
  const body = method === "GET" || method === "HEAD" || event.body == null ? undefined : Buffer.from(event.body, event.isBase64Encoded ? "base64" : "utf8");
  return new Request(url, { method, headers, body });
}

/** A Function URL result for a web Response. */
export async function responseToResult(response, method = "GET") {
  const headers = {};
  response.headers.forEach((v, k) => {
    if (k !== "set-cookie") headers[k] = v;
  });
  const cookies = response.headers.getSetCookie?.() ?? [];
  const buf = method === "HEAD" || !response.body ? Buffer.alloc(0) : Buffer.from(await response.arrayBuffer());
  const text = TEXT.test(headers["content-type"] ?? "");
  return { statusCode: response.status, headers, cookies, body: buf.toString(text ? "utf8" : "base64"), isBase64Encoded: !text };
}

export async function handler(event, _context, options = {}) {
  try {
    const method = event.requestContext?.http?.method ?? "GET";
    const file = (method === "GET" || method === "HEAD") && staticFile(event.rawPath ?? "/", options.root);
    if (file) {
      const type = TYPES[extname(file)] ?? "application/octet-stream";
      const buf = readFileSync(file);
      const text = TEXT.test(type);
      return {
        statusCode: 200,
        headers: { "content-type": type, "cache-control": (event.rawPath ?? "").startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache" },
        body: method === "HEAD" ? "" : buf.toString(text ? "utf8" : "base64"),
        isBase64Encoded: !text && method !== "HEAD",
      };
    }
    const fetchApp = options.app ?? (await loadApp());
    return await responseToResult(await fetchApp.fetch(eventToRequest(event)), method);
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: "Internal error" };
  }
}
