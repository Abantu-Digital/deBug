import { describe, expect, it, vi } from "vitest";
import { Envelope, type Event } from "@debugkit/schema";

// Effects run at once, so the hook can be called without a renderer.
vi.mock("react", async () => ({ ...(await vi.importActual<object>("react")), useEffect: (fn: () => void) => void fn() }));

const { DebugClient } = await import("./client");
const { useDebugNavigation } = await import("./react");

function setup() {
  const sent: Event[] = [];
  const fetch = vi.fn(async (_u: string, init: { body: string }) => {
    sent.push(...Envelope.parse(JSON.parse(init.body)).events);
    return new Response("", { status: 202 });
  });
  const c = new DebugClient().init({
    endpoint: "https://ingest.example/x",
    ingestKey: "pk_test",
    app: { id: "app" },
    fetch: fetch as unknown as typeof globalThis.fetch,
    flushIntervalMs: 0,
    autoCapture: false,
  });
  return { c, sent };
}

const trail = (sent: Event[]) => {
  const e = sent.find((x) => x.type === "error");
  if (e?.type !== "error") throw new Error("expected an error");
  return e.breadcrumbs?.map((b) => b.message);
};

describe("navigation", () => {
  it("records screens from the router hook, ignoring repeats", async () => {
    const { c, sent } = setup();
    for (const path of ["/dashboard", "/dashboard", "/buy", undefined]) useDebugNavigation(path, c);
    c.error(new Error("boom"));
    await c.flush();
    expect(trail(sent)).toEqual(["/dashboard", "/dashboard → /buy"]);
  });

  it("records nothing after close(), and again after the next init()", async () => {
    const { c, sent } = setup();
    useDebugNavigation("/dashboard", c);
    await c.close();
    useDebugNavigation("/buy", c);
    c.breadcrumb("ui", "tapped Buy");
    c.init({ ...(c as unknown as { opts: Parameters<typeof c.init>[0] }).opts });
    useDebugNavigation("/checkout", c);
    c.error(new Error("boom"));
    await c.flush();
    expect(trail(sent)).toEqual(["/dashboard", "/dashboard → /checkout"]);
  });

  it("never lets a breadcrumb or a broken client throw into the app", () => {
    const { c } = setup();
    const badMessage = { toString: () => { throw new Error("no"); } } as unknown as string;
    expect(() => c.breadcrumb("ui", badMessage)).not.toThrow();
    const broken = { navigated: () => { throw new Error("broken"); } } as unknown as InstanceType<typeof DebugClient>;
    expect(() => useDebugNavigation("/buy", broken)).not.toThrow();
  });
});
