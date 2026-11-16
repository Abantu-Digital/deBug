import { afterEach, describe, expect, it, vi } from "vitest";
import { ingestBehindWarning, INGEST_VERSION_HEADER } from "./version";

describe("ingestBehindWarning", () => {
  it("warns when the ingest is a minor or a major behind, naming both versions and the fix", () => {
    expect(ingestBehindWarning("0.7.2", "0.8.0")).toBe(
      "ingest is 0.7.2, this SDK is 0.8.0: some fields will be dropped. Run npx debugkit upgrade.",
    );
    expect(ingestBehindWarning("0.9.4", "1.0.0")).toContain("ingest is 0.9.4");
  });

  it("says nothing for a patch behind, the same version, an ingest ahead, or no version", () => {
    expect([
      ingestBehindWarning("0.8.0", "0.8.3"),
      ingestBehindWarning("0.8.0", "0.8.0"),
      ingestBehindWarning("0.9.0", "0.8.0"),
      ingestBehindWarning("1.0.0", "0.9.0"),
      ingestBehindWarning(null, "0.8.0"),
      ingestBehindWarning("", "0.8.0"),
    ]).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
  });

  it("says nothing when either version won't parse", () => {
    expect(ingestBehindWarning("dev", "0.8.0")).toBeUndefined();
    expect(ingestBehindWarning("0.7.0", "dev")).toBeUndefined();
  });

  it("reads prereleases and a leading v by their major and minor", () => {
    expect(ingestBehindWarning("v0.7.0", "0.8.0-next.1")).toContain("ingest is v0.7.0");
  });
});

describe("the client's ingest version check", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function client(debug: boolean, ingestVersion?: string) {
    vi.stubGlobal("__DEBUGKIT_SDK_VERSION__", "0.9.0");
    vi.resetModules();
    const { DebugClient } = await import("./client");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = vi.fn(
      async () => new Response("", { status: 202, headers: ingestVersion ? { [INGEST_VERSION_HEADER]: ingestVersion } : {} }),
    );
    const c = new DebugClient().init({
      endpoint: "https://ingest.example/x",
      ingestKey: "pk_test",
      app: { id: "app" },
      autoCapture: false,
      debug,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    const send = async () => {
      c.error(new Error("boom"));
      await c.flush();
    };
    const warnings = () => warn.mock.calls.filter((args) => String(args[1]).startsWith("ingest is"));
    return { c, send, warnings };
  }

  it("warns once per launch in debug mode when the ingest is behind", async () => {
    const { c, send, warnings } = await client(true, "0.8.1");
    await send();
    await send();
    expect(warnings()).toEqual([
      ["[deBug]", "ingest is 0.8.1, this SDK is 0.9.0: some fields will be dropped. Run npx debugkit upgrade."],
    ]);
    await c.close();
  });

  it("says nothing outside debug mode", async () => {
    const { c, send, warnings } = await client(false, "0.8.1");
    await send();
    expect(warnings()).toEqual([]);
    await c.close();
  });

  it("says nothing when the versions match, or the ingest sends no version", async () => {
    for (const version of ["0.9.0", undefined]) {
      const { c, send, warnings } = await client(true, version);
      await send();
      expect(warnings()).toEqual([]);
      await c.close();
    }
  });

  it("checks the next response when the first has no version", async () => {
    vi.stubGlobal("__DEBUGKIT_SDK_VERSION__", "0.9.0");
    vi.resetModules();
    const { DebugClient } = await import("./client");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const versions = [undefined, "0.7.0"];
    const fetch = vi.fn(async () => {
      const v = versions.shift();
      return new Response("", { status: 202, headers: v ? { [INGEST_VERSION_HEADER]: v } : {} });
    });
    const c = new DebugClient().init({
      endpoint: "https://ingest.example/x",
      ingestKey: "pk_test",
      app: { id: "app" },
      autoCapture: false,
      debug: true,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    c.error(new Error("a"));
    await c.flush();
    c.error(new Error("b"));
    await c.flush();
    expect(warn.mock.calls.some((args) => String(args[1]).startsWith("ingest is 0.7.0"))).toBe(true);
    await c.close();
  });

  it("never fails a send over a response it can't read headers from", async () => {
    vi.resetModules();
    const { DebugClient } = await import("./client");
    const sent: unknown[] = [];
    const fetch = vi.fn(async (_u: string, init: { body: string }) => {
      sent.push(init.body);
      return { status: 202, ok: true, headers: { get: () => { throw new Error("no headers"); } } } as unknown as Response;
    });
    const c = new DebugClient().init({
      endpoint: "https://ingest.example/x",
      ingestKey: "pk_test",
      app: { id: "app" },
      autoCapture: false,
      debug: true,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    c.error(new Error("boom"));
    await c.flush();
    expect(sent).toHaveLength(1);
    await c.close();
  });
});
