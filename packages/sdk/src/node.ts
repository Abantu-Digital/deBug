import dc from "node:diagnostics_channel";
import os from "node:os";
import { deBug, type DebugClient, type InitOptions } from "./index";
import { mergeContext, timezone, type ContextPatch } from "./context";
import { normaliseUrl } from "./auto";

/** Context for Node servers (TanStack Start server functions, Next API routes, Express ...). */
export function nodeContext(): ContextPatch {
  return {
    os: { name: os.platform(), version: os.release() },
    runtime: { name: "node", version: process.versions.node },
    device: { type: "unknown", memoryMb: Math.round(os.totalmem() / 1024 / 1024) },
    timezone: timezone(),
  };
}

export interface NodeInitOptions extends InitOptions {
  /** Capture uncaught exceptions and unhandled rejections, then exit like Node would. Default true. */
  captureProcessErrors?: boolean;
  /** Max time to wait for a final flush before exiting on a fatal error. Default 2000ms. */
  shutdownTimeoutMs?: number;
  /** Report responses your server sends with a 5xx status. Default true (needs `autoCapture.network`). */
  captureServerErrors?: boolean;
}

let installed = false;

/** Initialise deBug on a Node server. */
export function initNode(options: NodeInitOptions, client: DebugClient = deBug): DebugClient {
  const { captureProcessErrors = true, shutdownTimeoutMs = 2000, ...rest } = options;
  const auto = rest.autoCapture === false ? false : { console: false, ...(typeof rest.autoCapture === "object" ? rest.autoCapture : {}) };
  // Process-level hooks below replace the browser-style global handlers.
  client.init({ ...rest, autoCapture: auto === false ? false : { ...auto, errors: false }, context: mergeContext(nodeContext(), rest.context ?? {}) });
  if (client.autoCapture.network) instrumentNodeHttp(client, rest.captureServerErrors ?? true);
  if (!captureProcessErrors || installed) return client;
  installed = true;

  const flushThenExit = async (err: unknown) => {
    await Promise.race([client.flush(), new Promise((r) => setTimeout(r, shutdownTimeoutMs))]);
    console.error(err);
    process.exit(1);
  };
  // Adding these listeners disables Node's default crash, so we re-create it after flushing.
  process.on("uncaughtException", (err) => {
    client.error(err, { handled: false, fatal: true, tags: { source: "uncaughtException" } });
    void flushThenExit(err);
  });
  process.on("unhandledRejection", (reason) => {
    client.error(reason, { handled: false, tags: { source: "unhandledRejection" } });
    if (process.listenerCount("unhandledRejection") === 1) void flushThenExit(reason);
  });
  process.on("beforeExit", () => void client.flush());
  return client;
}

/**
 * Wrap a server handler so any error it throws is reported (and re-thrown).
 * Good for TanStack Start server functions and route handlers:
 *   .handler(withDebug("checkout.payment", async ({ data }) => { ... }))
 */
type ClientReq = { method?: string; protocol?: string; host?: string; path?: string; getHeader?(n: string): unknown; __debugStart?: number; __debugStack?: string };
type ServerReq = { method?: string; url?: string; __debugStart?: number };
let httpInstrumented = false;

/**
 * Outgoing requests made with node:http/https (axios, got, SDKs) and responses this server
 * sends, through Node's diagnostics channels. `fetch` is covered by the shared instrumentation.
 */
function instrumentNodeHttp(client: DebugClient, captureServer: boolean) {
  if (httpInstrumented || typeof dc?.subscribe !== "function") return;
  httpInstrumented = true;
  const sink = client.sink();
  // The Host header keeps a non-default port; request.host doesn't.
  const urlOf = (r: ClientReq) => `${r.protocol ?? "http:"}//${String(r.getHeader?.("host") ?? r.host ?? "")}${r.path ?? ""}`;
  dc.subscribe("http.client.request.start", (m) => {
    const r = (m as { request: ClientReq }).request;
    r.__debugStart = Date.now();
    r.__debugStack = new Error().stack;
  });
  dc.subscribe("http.client.response.finish", (m) => {
    const { request: r, response } = m as { request: ClientReq; response: { statusCode?: number } };
    const url = urlOf(r);
    if (sink.ignored(url)) return;
    sink.request({ method: r.method ?? "GET", url, status: response.statusCode, durationMs: Date.now() - (r.__debugStart ?? Date.now()), stack: r.__debugStack });
  });
  dc.subscribe("http.client.request.error", (m) => {
    const { request: r, error } = m as { request: ClientReq; error: unknown };
    const url = urlOf(r);
    if (sink.ignored(url)) return;
    sink.request({ method: r.method ?? "GET", url, error, durationMs: Date.now() - (r.__debugStart ?? Date.now()), stack: r.__debugStack });
  });
  if (!captureServer) return;
  dc.subscribe("http.server.request.start", (m) => {
    (m as { request: ServerReq }).request.__debugStart = Date.now();
  });
  dc.subscribe("http.server.response.finish", (m) => {
    const { request: r, response } = m as { request: ServerReq; response: { statusCode?: number } };
    const status = response.statusCode ?? 0;
    if (status < 500) return;
    const url = normaliseUrl(r.url ?? "/");
    const method = (r.method ?? "GET").toUpperCase();
    client.captureError(
      { name: "HttpServerError", message: `${method} ${url} responded ${status}`, frames: [] },
      { handled: true, tags: { source: "http-server" } },
      { method, url, status, durationMs: Date.now() - (r.__debugStart ?? Date.now()) },
    );
  });
}

export function withDebug<A extends unknown[], R>(flow: string, fn: (...args: A) => Promise<R>, client: DebugClient = deBug) {
  return async (...args: A): Promise<R> => {
    try {
      return await fn(...args);
    } catch (err) {
      client.error(err, { flow, handled: false });
      await client.flush();
      throw err;
    }
  };
}

export * from "./index";
