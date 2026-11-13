import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM without types
import { createHandler, staticFile } from "../../handler.mjs";
// @ts-expect-error plain ESM without types
import { handler as lambda } from "../../lambda.mjs";

const root = mkdtempSync(join(tmpdir(), "dbk-client-"));
mkdirSync(join(root, "assets"));
writeFileSync(join(root, "assets", "app.js"), "console.log(1)");

/** Stands in for the built app: echoes what it was given and sets two cookies. */
const app = {
  async fetch(req: Request) {
    const headers = new Headers({ "content-type": "application/json" });
    headers.append("set-cookie", "a=1; Path=/");
    headers.append("set-cookie", "b=2; Path=/");
    return new Response(JSON.stringify({ url: req.url, method: req.method, cookie: req.headers.get("cookie"), body: req.body ? await req.text() : null }), { status: 201, headers });
  },
};

describe("dashboard handler", () => {
  it("serves assets, passes everything else to the app, and keeps both cookies", async () => {
    const srv = createServer(createHandler({ root, app }));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    try {
      const asset = await fetch(`${base}/assets/app.js`);
      expect(asset.headers.get("cache-control")).toContain("immutable");
      expect(await asset.text()).toBe("console.log(1)");
      const r = await fetch(`${base}/login?x=1`, { method: "POST", body: "email=a", headers: { cookie: "__session=s", "x-forwarded-proto": "https" } });
      expect(r.status).toBe(201);
      expect(r.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
      expect(await r.json()).toMatchObject({ method: "POST", cookie: "__session=s", body: "email=a", url: expect.stringMatching(/^https:\/\/127\.0\.0\.1:\d+\/login\?x=1$/) });
    } finally {
      srv.close();
    }
  });

  it("never serves files outside the client folder", () => {
    expect(staticFile("/assets/app.js", root)).toBeTruthy();
    expect(staticFile("/../package.json", root)).toBeUndefined();
    expect(staticFile("/%2e%2e/%2e%2e/etc/passwd", root)).toBeUndefined();
    expect(staticFile("/%E0%A4%A", root)).toBeUndefined();
    expect(staticFile("/", root)).toBeUndefined();
  });

  it("reads a body a host already parsed (Firebase rawBody)", async () => {
    const out: { status?: number; body: string } = { body: "" };
    const { Writable } = await import("node:stream");
    const sink = Object.assign(new Writable({ write: (c, _e, cb) => ((out.body += c), cb()) }), { writeHead: (s: number) => (out.status = s), headersSent: false });
    await createHandler({ root, app })({ method: "POST", url: "/x", headers: { host: "h" }, rawBody: Buffer.from("hi") } as never, sink as never);
    await new Promise((r) => sink.on("finish", r));
    expect(out.status).toBe(201);
    expect(JSON.parse(out.body).body).toBe("hi");
  });
});

describe("dashboard on Lambda", () => {
  const event = (over: Record<string, unknown>) => ({ rawPath: "/", rawQueryString: "", headers: { host: "abc.lambda-url.af-south-1.on.aws" }, requestContext: { http: { method: "GET" } }, ...over });

  it("turns a Function URL event into a request and back, cookies included", async () => {
    const r = await lambda(event({ rawPath: "/login", rawQueryString: "next=%2F", cookies: ["a=1", "b=2"], body: Buffer.from("email=a").toString("base64"), isBase64Encoded: true, requestContext: { http: { method: "POST" } } }), {}, { root, app });
    expect(r.statusCode).toBe(201);
    expect(r.cookies).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    expect(JSON.parse(r.body)).toEqual({ url: "https://abc.lambda-url.af-south-1.on.aws/login?next=%2F", method: "POST", cookie: "a=1; b=2", body: "email=a" });
  });

  it("serves the built assets", async () => {
    const r = await lambda(event({ rawPath: "/assets/app.js" }), {}, { root, app });
    expect(r).toMatchObject({ statusCode: 200, body: "console.log(1)", isBase64Encoded: false });
  });
});

describe("index errors", async () => {
  const { isIndexError } = await import("./errors");
  it("are recognised, so the page explains them instead of showing the raw error", () => {
    expect(isIndexError("9 FAILED_PRECONDITION: The query requires an index. You can create it here: https://…")).toBe(true);
    expect(isIndexError("That index is currently building and cannot be used yet")).toBe(true);
    expect(isIndexError("permission denied")).toBe(false);
  });
});
