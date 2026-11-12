import { describe, expect, it, vi } from "vitest";
import { Envelope } from "@debug/schema";
import { DebugClient } from "./client";
import { parseStack } from "@debug/schema";

function setup(status = 200) {
  const sent: unknown[] = [];
  const fetch = vi.fn(async (_url: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body));
    return new Response("", { status });
  });
  const c = new DebugClient().init({
    endpoint: "https://ingest.example/x",
    ingestKey: "pk_test",
    app: { id: "megaton-native", version: "2.3.1" },
    context: { os: { name: "android", version: "14" }, runtime: { name: "react-native" } },
    captureGlobalErrors: false,
    fetch: fetch as unknown as typeof globalThis.fetch,
  });
  return { c, sent, fetch };
}

describe("sdk", () => {
  it("sends schema-valid envelopes with breadcrumbs", async () => {
    const { c, sent } = setup();
    c.breadcrumb("navigation", "Login");
    c.error(new TypeError("otp is undefined"), { flow: "auth.login", step: "submit_otp" });
    await c.flush();
    expect(sent).toHaveLength(1);
    const env = Envelope.parse(sent[0]);
    const ev = env.events[0]!;
    expect(ev.type).toBe("error");
    if (ev.type === "error") {
      expect(ev.error.name).toBe("TypeError");
      expect(ev.breadcrumbs?.[0]?.message).toBe("Login");
      expect(ev.flow).toBe("auth.login");
    }
    await c.close();
  });

  it("track() logs success and failure outcomes", async () => {
    const { c, sent } = setup();
    await c.track("auth.login", "submit", async () => 1);
    await expect(c.track("auth.login", "submit", async () => { throw new Error("401"); })).rejects.toThrow();
    await c.flush();
    const events = sent.flatMap((s) => Envelope.parse(s).events);
    expect(events.map((e) => (e.type === "event" ? e.outcome : "error"))).toEqual(["success", "failure", "error"]);
    await c.close();
  });

  it("track() can skip the error when it is reported elsewhere", async () => {
    const { c, sent } = setup();
    await expect(c.track("checkout.payment", "charge", async () => { throw new Error("502"); }, { captureError: false })).rejects.toThrow();
    await c.flush();
    const events = sent.flatMap((s) => Envelope.parse(s).events);
    expect(events.map((e) => e.type)).toEqual(["event"]);
    await c.close();
  });

  it("re-queues on 5xx and drops on 4xx", async () => {
    const bad = setup(503);
    bad.c.error("boom");
    await bad.c.flush();
    expect((bad.c as any).queue).toHaveLength(1);
    await bad.c.close();

    const rejected = setup(400);
    rejected.c.error("boom");
    await rejected.c.flush();
    expect((rejected.c as any).queue).toHaveLength(0);
    await rejected.c.close();
  });

  it("beforeSend can scrub or drop", async () => {
    const { c, sent } = setup();
    (c as any).opts.beforeSend = (e: any) => (e.type === "event" && e.name === "secret" ? null : e);
    c.event("secret");
    c.event("ok");
    await c.flush();
    expect(Envelope.parse(sent[0]).events.map((e: any) => e.name)).toEqual(["ok"]);
    await c.close();
  });
});

describe("parseStack", () => {
  it("parses V8/Hermes and JSC frames and marks node_modules as not in-app", () => {
    const frames = parseStack(
      [
        "TypeError: x",
        "    at submit (/app/src/screens/Login.tsx:42:13)",
        "    at /app/node_modules/react-native/Libraries/x.js:1:2",
        "onPress@/app/src/Button.tsx:10:5",
      ].join("\n"),
    );
    expect(frames).toEqual([
      { fn: "submit", file: "/app/src/screens/Login.tsx", line: 42, col: 13, inApp: true },
      { fn: undefined, file: "/app/node_modules/react-native/Libraries/x.js", line: 1, col: 2, inApp: false },
      { fn: "onPress", file: "/app/src/Button.tsx", line: 10, col: 5, inApp: true },
    ]);
  });
});
