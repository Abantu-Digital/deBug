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
    // A fetch failure is reported once its body has been read.
    await new Promise((r) => setTimeout(r, 0));
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
    // A fetch failure is reported once its body has been read, so after the XHR's.
    expect(errors(sent).map((e) => e.type === "error" && e.request?.url)).toEqual(["/v1/upload", "/v1/feed"]);
  });
});

describe("named calls and backend error details", () => {
  const problem = JSON.stringify({ title: "Insufficient airtime", status: 422, code: 4021, traceId: "00-4f2c", errors: ["balance too low"] });
  const network = { baseUrls: ["https://gw.example.com/ppd/api"], isFailure: (s: number) => s >= 400 };
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("names fetch calls by service, and adds what the backend said to a failure, while the app still reads the body", async () => {
    const { c, sent } = setup({ autoCapture: { sessions: false }, network }, async (url) =>
      url.includes("with-airtime") ? new Response(problem, { status: 422 }) : new Response("{}", { status: 200 }),
    );
    await fetch("https://gw.example.com/ppd/api/buy/purchase-history?pageSize=3");
    const res = await fetch("https://gw.example.com/ppd/api/buy/with-airtime", { method: "POST" });
    expect(await res.json()).toMatchObject({ title: "Insufficient airtime" });
    await settle();
    await c.flush();

    const [e] = errors(sent);
    if (e?.type !== "error") throw new Error("expected an error");
    // The issue's message (and so its grouping) is unchanged.
    expect(e.error.message).toBe("POST gw.example.com/ppd/api/buy/with-airtime responded 422");
    const [ok, failed] = e.breadcrumbs ?? [];
    expect(ok?.message).toMatch(/^GET \/buy\/purchase-history → 200 \(\d+ms\)$/);
    expect(ok?.data).toEqual({ service: "buy", path: "/buy/purchase-history", method: "GET", status: 200, durationMs: expect.any(Number), outcome: "answered" });
    expect(failed?.level).toBe("error");
    expect(failed?.data).toMatchObject({
      service: "buy",
      path: "/buy/with-airtime",
      status: 422,
      outcome: "answered",
      backendTitle: "Insufficient airtime",
      backendCode: 4021,
      traceId: "00-4f2c",
      backendErrors: "balance too low",
    });
  });

  it("reads an XHR failure's body as it finishes, for text and json response types", async () => {
    class FakeXhr {
      status = 0;
      responseType = "";
      responseText = "";
      response: unknown = null;
      url = "";
      listeners: Record<string, (() => void)[]> = {};
      open(_m: string, u: string) {
        this.url = u;
      }
      send() {
        this.status = 422;
        this.responseText = problem;
        this.response =
          this.responseType === "json"
            ? JSON.parse(problem)
            : this.url.includes("bytes")
              ? new TextEncoder().encode(this.url.includes("binary") ? "\u0000\u00ff" : problem).buffer
              : problem;
        queueMicrotask(() => this.listeners.loadend?.forEach((f) => f()));
      }
      addEventListener(t: string, f: () => void) {
        (this.listeners[t] ??= []).push(f);
      }
    }
    g.XMLHttpRequest = FakeXhr;
    const { c, sent } = setup({ autoCapture: { sessions: false }, network });
    const text = new g.XMLHttpRequest();
    text.open("POST", "https://gw.example.com/ppd/api/buy/with-airtime");
    text.send();
    const json = new g.XMLHttpRequest();
    json.responseType = "json";
    json.open("POST", "https://gw.example.com/ppd/api/share/transfer");
    json.send();
    const blob = new g.XMLHttpRequest();
    blob.responseType = "arraybuffer";
    blob.open("GET", "https://gw.example.com/ppd/api/profile/contracts/1/doc");
    blob.send();
    // Apps that download files ask for bytes, and their error bodies come back as bytes too.
    const bytes = new g.XMLHttpRequest();
    bytes.responseType = "arraybuffer";
    bytes.open("GET", "https://gw.example.com/ppd/api/contracts/bytes");
    bytes.send();
    const binary = new g.XMLHttpRequest();
    binary.responseType = "arraybuffer";
    binary.open("GET", "https://gw.example.com/ppd/api/contracts/bytes/binary");
    binary.send();
    await settle();
    await c.flush();

    const e = errors(sent).at(-1);
    if (e?.type !== "error") throw new Error("expected an error");
    expect(e.breadcrumbs?.map((b) => [b.data?.service, b.data?.traceId])).toEqual([
      ["buy", "00-4f2c"],
      ["share", "00-4f2c"],
      ["profile", undefined], // an arraybuffer that isn't bytes is not read
      ["contracts", "00-4f2c"],
      ["contracts", undefined], // bytes that aren't text are not an error body
    ]);
  });

  it("keeps the backend's details when the same failure repeats, and the trail as it was", async () => {
    const { c, sent } = setup({ autoCapture: { sessions: false }, network }, async (url) =>
      url.includes("pay") ? new Response(problem, { status: 422 }) : new Response("{}", { status: 200 }),
    );
    // Repeats collapse only when their messages match, durations included: hold the clock.
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    await fetch("https://gw.example.com/ppd/api/buy/pay");
    await fetch("https://gw.example.com/ppd/api/buy/pay");
    await fetch("https://gw.example.com/ppd/api/buy/after");
    clock.mockRestore();
    await settle();
    await c.flush();
    const [first, second] = errors(sent);
    if (first?.type !== "error" || second?.type !== "error") throw new Error("expected two errors");
    // The two failures collapse into one breadcrumb, which keeps the backend's details.
    expect(second.breadcrumbs?.map((b) => b.data?.traceId)).toEqual(["00-4f2c"]);
    expect(second.breadcrumbs?.[0]?.data?.repeated).toBe(2);
    // The call made after the failure isn't in its trail.
    expect(first.breadcrumbs?.some((b) => b.message.includes("/after"))).toBe(false);
  });

  it("sends a failure still waiting for its body when the client closes", async () => {
    let release: (body: string) => void = () => undefined;
    const { c, sent } = setup({ autoCapture: { sessions: false }, network }, async () => {
      const res = new Response(problem, { status: 500 });
      Object.defineProperty(res, "clone", { value: () => ({ text: () => new Promise<string>((r) => (release = r)) }) });
      return res;
    });
    await fetch("https://gw.example.com/ppd/api/buy/slow");
    await c.close();
    release(problem); // too late: already sent, without the details
    expect(errors(sent)).toHaveLength(1);
  });

  it("records no answer as unreachable, without backend fields", async () => {
    const { c, sent } = setup({ autoCapture: { sessions: false }, network }, async () => {
      throw new TypeError("Network request failed");
    });
    await expect(fetch("https://gw.example.com/ppd/api/login/send-otp")).rejects.toThrow();
    await c.flush();
    const [e] = errors(sent);
    if (e?.type !== "error") throw new Error("expected an error");
    expect(e.breadcrumbs?.[0]?.data).toEqual({ service: "login", path: "/login/send-otp", method: "GET", status: null, durationMs: expect.any(Number), outcome: "unreachable" });
  });

  it("never reads the body of a successful call, and survives a body that can't be read", async () => {
    const clone = vi.fn();
    const { c, sent } = setup({ autoCapture: { sessions: false }, network }, async (url) => {
      const res = new Response("{}", { status: url.includes("broken") ? 500 : 200 });
      if (url.includes("broken")) {
        Object.defineProperty(res, "clone", { value: () => { throw new Error("used"); } });
      } else Object.defineProperty(res, "clone", { value: clone });
      return res;
    });
    await fetch("https://gw.example.com/ppd/api/buy/ok");
    await fetch("https://gw.example.com/ppd/api/buy/broken");
    await settle();
    await c.flush();
    expect(clone).not.toHaveBeenCalled();
    expect(errors(sent)).toHaveLength(1);
  });
});

describe("a failed call's request and response (network.bodies)", () => {
  const network = { baseUrls: ["https://gw.example.com/ppd/api"], isFailure: (s: number) => s >= 400, bodies: { onFailure: true } };
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const problem = JSON.stringify({ title: "Bad OTP", status: 400, traceId: "t-1", token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln" });

  it("carries the fetch request and response, redacted, on the failure only", async () => {
    const { c, sent } = setup({ autoCapture: { sessions: false }, network }, async (url) =>
      url.includes("validate")
        ? new Response(problem, { status: 400, headers: { "content-type": "application/problem+json", "set-cookie": "s=1", "x-request-id": "r-9" } })
        : new Response("{}", { status: 200 }),
    );
    await fetch("https://gw.example.com/ppd/api/buy/ok");
    await fetch("https://gw.example.com/ppd/api/login/validate-otp?msisdn=27841234567&otp=123456", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer secret" },
      body: JSON.stringify({ msisdn: "27841234567", otp: "123456" }),
    });
    await settle();
    await c.flush();

    const [e] = errors(sent);
    if (e?.type !== "error") throw new Error("expected an error");
    expect(e.request).toMatchObject({
      method: "POST",
      status: 400,
      query: "msisdn=27841234567&otp=%5Bredacted%5D",
      headers: { "content-type": "application/json", authorization: "[redacted]" },
      body: '{"msisdn":"27841234567","otp":"[redacted]"}',
    });
    expect(e.response).toMatchObject({
      status: 400,
      headers: { "content-type": "application/problem+json", "set-cookie": "[redacted]", "x-request-id": "r-9" },
      body: '{"title":"Bad OTP","status":400,"traceId":"t-1","token":"[redacted]"}',
    });
    // The breadcrumb says the bodies are on the error; the successful call has none.
    expect(e.breadcrumbs?.map((b) => b.data?.hasBodies)).toEqual([undefined, true]);
  });

  it("carries XHR headers and bodies, and describes a binary response by size and type", async () => {
    class FakeXhr {
      status = 0;
      responseType = "";
      responseText = "";
      response: unknown = null;
      url = "";
      listeners: Record<string, (() => void)[]> = {};
      open(_m: string, u: string) {
        this.url = u;
      }
      setRequestHeader(_n: string, _v: string) {}
      send() {
        this.status = 500;
        const pdf = this.url.includes("doc");
        this.response = pdf ? new Uint8Array([0x25, 0x50, 0xff, 0xfe]).buffer : null;
        this.responseText = pdf ? "" : '{"title":"Down"}';
        queueMicrotask(() => this.listeners.loadend?.forEach((f) => f()));
      }
      getAllResponseHeaders() {
        return this.url.includes("doc") ? "content-type: application/pdf\r\n" : "content-type: application/json\r\nx-api-key: k\r\n";
      }
      getResponseHeader(n: string) {
        return n === "content-type" ? (this.url.includes("doc") ? "application/pdf" : "application/json") : null;
      }
      addEventListener(t: string, f: () => void) {
        (this.listeners[t] ??= []).push(f);
      }
    }
    g.XMLHttpRequest = FakeXhr;
    const { c, sent } = setup({ autoCapture: { sessions: false }, network });
    const x = new g.XMLHttpRequest();
    x.open("POST", "https://gw.example.com/ppd/api/share/transfer");
    x.setRequestHeader("Content-Type", "application/json");
    x.setRequestHeader("x-id-token", "secret");
    x.send(JSON.stringify({ to: "0841234567", pin: "1234" }));
    const doc = new g.XMLHttpRequest();
    doc.responseType = "arraybuffer";
    doc.open("GET", "https://gw.example.com/ppd/api/profile/contracts/1/doc");
    doc.send();
    await settle();
    await c.flush();

    const [transfer, pdf] = errors(sent);
    if (transfer?.type !== "error" || pdf?.type !== "error") throw new Error("expected two errors");
    expect(transfer.request).toMatchObject({ headers: { "content-type": "application/json", "x-id-token": "[redacted]" }, body: '{"to":"0841234567","pin":"[redacted]"}' });
    expect(transfer.response).toMatchObject({ status: 500, headers: { "x-api-key": "[redacted]" }, body: '{"title":"Down"}' });
    expect(pdf.response).toMatchObject({ status: 500, body: "[binary 1 KB, application/pdf]", bodySize: 4 });
  });

  it("carries no bodies when the option is off", async () => {
    const { c, sent } = setup({ autoCapture: { sessions: false }, network: { ...network, bodies: undefined } }, async () => new Response(problem, { status: 400 }));
    await fetch("https://gw.example.com/ppd/api/login/x", { method: "POST", body: "otp=1" });
    await settle();
    await c.flush();
    const [e] = errors(sent);
    if (e?.type !== "error") throw new Error("expected an error");
    expect([e.request?.body, e.request?.headers, e.response]).toEqual([undefined, undefined, undefined]);
  });

  it("keeps each upload under ingest's size limit when many failures carry bodies", async () => {
    const big = JSON.stringify({ data: "x".repeat(15_000) });
    const { c, upload } = setup({ autoCapture: { sessions: false }, network }, async () => new Response(big, { status: 500 }));
    // Queue many failures before any upload goes out.
    (c as unknown as { backoffUntil: number }).backoffUntil = Date.now() + 60_000;
    for (let i = 0; i < 40; i++) await fetch(`https://gw.example.com/ppd/api/buy/${i}x`, { method: "POST", body: big });
    await settle();
    (c as unknown as { backoffUntil: number }).backoffUntil = 0;
    while ((c as unknown as { queue: unknown[] }).queue.length) await c.flush();
    const sizes = upload.mock.calls.map(([, init]) => (init as { body: string }).body.length);
    expect(sizes.length).toBeGreaterThan(1);
    expect(Math.max(...sizes)).toBeLessThan(512 * 1024);
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

describe("request timings", () => {
  it("sends one metric event per endpoint with a latency histogram", async () => {
    const { c, sent } = setup({ autoCapture: { sessions: false } }, async (url) => new Response("", { status: url.includes("fail") ? 503 : 200 }));
    await fetch("/v1/feed");
    await fetch("/v1/feed");
    await fetch("/v1/fail");
    await c.close(); // closing sends the timings collected so far
    const metrics = sent.filter((e) => e.type === "metric");
    expect(metrics.map((m) => m.type === "metric" && [m.key, m.count, m.errors])).toEqual([["GET /v1/feed", 2, 0], ["GET /v1/fail", 1, 1]]);
    const m = metrics[0]!;
    if (m.type === "metric") expect(m.buckets.reduce((a, b) => a + b, 0)).toBe(2);
  });

  it("stops sending metrics, and only metrics, when an older ingest rejects them", async () => {
    const bodies: string[][] = [];
    const old = vi.fn(async (_u: string, init: { body: string }) => {
      const b = JSON.parse(init.body) as { events: { type: string }[] };
      bodies.push(b.events.map((e) => e.type));
      return new Response("", { status: b.events.some((e) => e.type === "metric") ? 400 : 202 });
    });
    const { c } = setup({ fetch: old as unknown as typeof fetch }, async () => new Response(""));
    await fetch("/v1/feed");
    await c.close();
    expect(bodies[bodies.length - 1]).toEqual(["session"]); // sessions kept, metrics dropped
    expect(bodies.flat()).toContain("metric");
  });
});
