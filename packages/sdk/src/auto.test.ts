import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Envelope, type Event } from "@debugkit/schema";
import { DebugClient, type InitOptions } from "./client";
import { normaliseUrl } from "./auto";

const g = globalThis as Record<string, any>;
let realFetch: unknown;
let clients: DebugClient[] = [];

beforeEach(() => {
  realFetch = g.fetch;
});
afterEach(async () => {
  for (const c of clients) await c.close();
  clients = [];
  g.fetch = realFetch;
  delete g.XMLHttpRequest;
});

/** A client whose uploads go to `sent`, with the app's own `fetch` replaced by `appFetch`. */
function setup(opts: Partial<InitOptions> = {}, appFetch?: (url: string) => Promise<Response>) {
  const sent: Event[] = [];
  const upload = vi.fn(async (_url: string, init: { body: string }) => {
    sent.push(...Envelope.parse(JSON.parse(init.body)).events);
    return new Response("", { status: 202 });
  });
  const app = appFetch ? vi.fn(appFetch) : undefined;
  if (app) g.fetch = app;
  const c = new DebugClient().init({
    endpoint: "https://ingest.example/x",
    ingestKey: "pk_test",
    app: { id: "web", version: "1.0.0" },
    context: { os: { name: "web" }, runtime: { name: "browser" } },
    fetch: upload as unknown as typeof fetch,
    flushIntervalMs: 0,
    ...opts,
  });
  clients.push(c);
  return { c, sent, upload, app };
}

const errors = (evs: Event[]) => evs.filter((e) => e.type === "error");
const sessions = (evs: Event[]) => evs.flatMap((e) => (e.type === "session" ? [e.status] : []));

describe("normaliseUrl", () => {
  it("drops query strings, credentials and ids", () => {
    expect(normaliseUrl("https://u:p@api.x.com/v1/orders/8812/items?token=abc#f")).toBe("api.x.com/v1/orders/:id/items");
    expect(normaliseUrl("/v1/users/3f2c1a9e-1b2c-4d5e-8f90-123456789abc")).toBe("/v1/users/:id");
    expect(normaliseUrl("/feed?page=2")).toBe("/feed");
    expect(normaliseUrl("/v1/auth/otp/verify")).toBe("/v1/auth/otp/verify");
  });
});

describe("network capture", () => {
  it("reports 5xx responses with the endpoint, and records every request as a breadcrumb", async () => {
    const { c, sent } = setup({ autoCapture: { sessions: false }, network: { flows: [["/feed", "feed.load"]] } }, async (url) =>
      new Response("", { status: url.includes("feed") ? 502 : 200 }),
    );
    await fetch("https://api.x.com/v1/me");
    await fetch("https://api.x.com/v1/feed?page=2");
    await c.flush();
    const [e] = errors(sent);
    expect(e).toMatchObject({
      flow: "feed.load",
      handled: true,
      tags: { source: "network" },
      error: { name: "HttpError", message: "GET api.x.com/v1/feed responded 502" },
      request: { method: "GET", url: "api.x.com/v1/feed", status: 502 },
    });
    if (e?.type !== "error") throw new Error("expected an error");
    expect(e.breadcrumbs?.map((b) => b.message.replace(/\(\d+ms\)/, "(n)"))).toEqual(["GET api.x.com/v1/me → 200 (n)", "GET api.x.com/v1/feed → 502 (n)"]);
    // The stack points at this test, where the request was made, not at the SDK's wrapper.
    expect(e.error.frames?.[0]?.file).toContain("auto.test.ts");
  });

  it("reports network failures, ignores aborts and never records its own uploads", async () => {
    const { c, sent, upload, app } = setup({ autoCapture: { sessions: false } }, async (url) => {
      if (url.includes("abort")) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      throw new TypeError("Network request failed");
    });
    await expect(fetch("/v1/pay")).rejects.toThrow();
    await expect(fetch("/v1/abort")).rejects.toThrow();
    await c.flush();
    expect(errors(sent).map((e) => e.type === "error" && e.error.message)).toEqual(["GET /v1/pay failed: Network request failed"]);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(app).toHaveBeenCalledTimes(2); // only the app's two requests; uploads bypass the patch
  });

  it("restores fetch on close", async () => {
    const appFetch = async () => new Response("");
    const { c } = setup({}, appFetch);
    const patched = g.fetch;
    expect((patched as { __debug?: boolean }).__debug).toBe(true);
    await c.close();
    expect((g.fetch as { __debug?: boolean }).__debug).toBeUndefined();
  });

  it("captures XMLHttpRequest, but not the XHR that fetch uses underneath (React Native)", async () => {
    class FakeXhr {
      status = 0;
      listeners: Record<string, (() => void)[]> = {};
      open(_m: string, _u: string) {}
      send() {
        this.status = 503;
        queueMicrotask(() => this.listeners.loadend?.forEach((f) => f()));
      }
      addEventListener(t: string, f: () => void) {
        (this.listeners[t] ??= []).push(f);
      }
    }
    g.XMLHttpRequest = FakeXhr;
    // fetch implemented on top of XHR, as whatwg-fetch does in React Native.
    const xhrFetch = (url: string) =>
      new Promise<Response>((resolve) => {
        const x = new g.XMLHttpRequest();
        x.open("GET", url);
        x.addEventListener("loadend", () => resolve(new Response("", { status: x.status })));
        x.send();
      });
    const { c, sent } = setup({ autoCapture: { sessions: false } }, xhrFetch);
    await fetch("/v1/feed");
    const x = new g.XMLHttpRequest();
    x.open("post", "/v1/upload");
    x.send();
    await new Promise((r) => setTimeout(r, 0));
    await c.flush();
    expect(errors(sent).map((e) => e.type === "error" && e.request?.url)).toEqual(["/v1/feed", "/v1/upload"]);
  });
});

describe("sessions", () => {
  it("marks a session started, then errored and crashed once each, and never samples them out", async () => {
    const { c, sent } = setup({ autoCapture: { network: false }, sampleRate: 0 });
    c.error(new Error("handled"));
    c.error(new Error("boom"), { handled: false });
    c.error(new Error("fatal"), { handled: false, fatal: true });
    c.error(new Error("fatal again"), { handled: false, fatal: true });
    await c.flush();
    expect(sessions(sent)).toEqual(["started", "errored", "crashed"]);
    expect(errors(sent)).toHaveLength(2); // sampleRate 0 drops ordinary errors; fatal ones always go
  });

  it("startSession() begins a new session id", async () => {
    const { c, sent } = setup({ autoCapture: { network: false } });
    await c.flush();
    c.startSession();
    await c.flush();
    expect(sessions(sent)).toEqual(["started", "started"]);
  });
});

describe("noise control", () => {
  it("rate-limits one repeating error", async () => {
    const { c, sent } = setup({ autoCapture: false, maxErrorsPerMinute: 60 });
    for (let i = 0; i < 30; i++) c.error(new Error("loop"));
    c.error(new Error("different"));
    await c.flush();
    await c.flush();
    expect(errors(sent)).toHaveLength(11);
  });

  it("collapses repeated breadcrumbs and records console warnings", async () => {
    const { c, sent } = setup({ autoCapture: { console: true, network: false, sessions: false } });
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Re-init so the console patch wraps the spy.
      c.init({ endpoint: "https://ingest.example/x", ingestKey: "k", app: { id: "web" }, fetch: (c as any).opts.fetch, flushIntervalMs: 0, autoCapture: { console: true, network: false, sessions: false } });
      console.warn("slow render", { ms: 120 });
      c.navigated("/a");
      c.navigated("/a");
      c.navigated("/b");
      c.error(new Error("x"));
      await c.flush();
    } finally {
      await c.close();
      spy.mockRestore();
    }
    const e = errors(sent)[0];
    if (e?.type !== "error") throw new Error("expected an error");
    expect(e.breadcrumbs?.map((b) => `${b.category}:${b.message}`)).toEqual(['log:slow render {"ms":120}', "navigation:/a", "navigation:/a → /b"]);
  });
});

describe("older ingest", () => {
  it("falls back to 0.1 payloads when the ingest rejects session markers", async () => {
    const bodies: { events: { type: string; request?: unknown }[] }[] = [];
    // Mimics a 0.1 ingest: it only knows "error" and "event", and rejects unknown keys strictly enough.
    const old = vi.fn(async (_u: string, init: { body: string }) => {
      const b = JSON.parse(init.body);
      bodies.push(b);
      const ok = b.events.every((e: { type: string; request?: unknown }) => (e.type === "error" || e.type === "event") && !e.request);
      return new Response("", { status: ok ? 202 : 400 });
    });
    const { c } = setup({ fetch: old as unknown as typeof fetch, autoCapture: { network: false } });
    c.error(new Error("still delivered"));
    await c.flush();
    await c.flush();
    c.error(new Error("second"));
    await c.flush();
    expect(bodies.map((b) => b.events.map((e) => e.type).join(","))).toEqual(["session,error", "error", "error"]);
  });
});

describe("enabled: false", () => {
  it("patches nothing, sends nothing, and keeps the API safe to call", async () => {
    const appFetch = vi.fn(async () => new Response("", { status: 503 }));
    g.fetch = appFetch;
    const upload = vi.fn(async () => new Response("", { status: 202 }));
    const c = new DebugClient().init({ enabled: false, endpoint: "", ingestKey: "", app: { id: "web" }, fetch: upload as unknown as typeof fetch, flushIntervalMs: 0 });
    clients.push(c);
    expect(c.enabled).toBe(false);
    expect(g.fetch).toBe(appFetch); // fetch not wrapped
    await fetch("/v1/feed");
    c.error(new Error("ignored"));
    c.event("ignored");
    c.breadcrumb("ui", "ignored");
    await expect(c.track("auth.login", "submit", async () => 42)).resolves.toBe(42);
    await expect(c.track("auth.login", "submit", async () => Promise.reject(new Error("still thrown")))).rejects.toThrow("still thrown");
    await c.flush();
    expect(upload).not.toHaveBeenCalled();
  });

  it("switching off after an enabled init undoes the instrumentation", async () => {
    const { c, app } = setup({}, async () => new Response(""));
    expect((g.fetch as { __debug?: boolean }).__debug).toBe(true);
    c.init({ enabled: false, endpoint: "", ingestKey: "", app: { id: "web" } });
    expect(g.fetch).toBe(app);
    expect(c.enabled).toBe(false);
  });
});
