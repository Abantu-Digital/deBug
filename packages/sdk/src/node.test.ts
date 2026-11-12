import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Envelope, type Event } from "@debugkit/schema";
import { DebugClient } from "./client";
import { initNode } from "./node";

let server: http.Server;
let base = "";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.statusCode = req.url?.startsWith("/broken") ? 500 : 200;
    res.end("ok");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const get = (url: string) =>
  new Promise<number>((resolve, reject) => http.get(url, (res) => (res.resume(), res.on("end", () => resolve(res.statusCode ?? 0)))).on("error", reject));

describe("node", () => {
  it("records node:http requests and 5xx responses the server sends", async () => {
    const sent: Event[] = [];
    const client = initNode(
      {
        endpoint: "https://ingest.example/x",
        ingestKey: "k",
        app: { id: "api", version: "3.0.0" },
        captureProcessErrors: false,
        flushIntervalMs: 0,
        fetch: (async (_u: string, init: { body: string }) => {
          sent.push(...Envelope.parse(JSON.parse(init.body)).events);
          return new Response("", { status: 202 });
        }) as unknown as typeof fetch,
      },
      new DebugClient(),
    );
    expect(await get(`${base}/ok`)).toBe(200);
    expect(await get(`${base}/broken/42?secret=1`)).toBe(500);
    await expect(get("http://127.0.0.1:9/nothing")).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 20));
    await client.close();
    await client.flush();

    const errs = sent.flatMap((e) => (e.type === "error" ? [`${e.error.name}: ${e.error.message}`] : []));
    expect(errs).toContain("HttpServerError: GET /broken/:id responded 500"); // what this server sent
    expect(errs).toContain("HttpError: GET 127.0.0.1:" + base.split(":")[2] + "/broken/:id responded 500"); // what the client saw
    expect(errs.some((m) => m.startsWith("NetworkError: GET 127.0.0.1:9/nothing failed"))).toBe(true);
    expect(sent.find((e) => e.type === "session")).toMatchObject({ status: "started" });
  });
});
