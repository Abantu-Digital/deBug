import os from "node:os";
import { deBug, type DebugClient, type InitOptions } from "./index";
import { mergeContext, timezone, type ContextPatch } from "./context";

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
}

let installed = false;

/** Initialise deBug on a Node server. */
export function initNode(options: NodeInitOptions, client: DebugClient = deBug): DebugClient {
  const { captureProcessErrors = true, shutdownTimeoutMs = 2000, ...rest } = options;
  client.init({ ...rest, captureGlobalErrors: false, context: mergeContext(nodeContext(), rest.context ?? {}) });
  if (!captureProcessErrors || installed) return client;
  installed = true;

  const flushThenExit = async (err: unknown) => {
    await Promise.race([client.flush(), new Promise((r) => setTimeout(r, shutdownTimeoutMs))]);
    console.error(err);
    process.exit(1);
  };
  // Adding these listeners disables Node's default crash, so we re-create it after flushing.
  process.on("uncaughtException", (err) => {
    client.error(err, { handled: false, severity: "critical", tags: { source: "uncaughtException" } });
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
