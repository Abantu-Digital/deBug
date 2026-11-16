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

  it("reads prereleases, a leading v and a version without a patch by their major and minor", () => {
    expect(ingestBehindWarning("v0.7.0", "0.8.0-next.1")).toContain("ingest is v0.7.0");
    expect(ingestBehindWarning("0.7", "0.8.0")).toContain("ingest is 0.7");
    expect(ingestBehindWarning("0.8", "0.8.0")).toBeUndefined();
  });
});

describe("the client's ingest version check", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  const reply = (version?: string) =>
    new Response("", { status: 202, headers: version ? { [INGEST_VERSION_HEADER]: version } : {} });

  /** A 0.9.0 client whose ingest answers with `respond`; `send` reports one error and flushes. */
  async function client(debug: boolean, respond: () => Response) {
    vi.stubGlobal("__DEBUGKIT_SDK_VERSION__", "0.9.0");
    vi.resetModules();
    const { DebugClient } = await import("./client");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = vi.fn(async () => respond());
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
    const warnings = (start: string) => warn.mock.calls.filter((args) => String(args[1]).startsWith(start));
    return { c, send, warnings, fetch };
  }

  it("warns once per launch in debug mode when the ingest is behind", async () => {
    const { c, send, warnings } = await client(true, () => reply("0.8.1"));
    await send();
    await send();
    expect(warnings("ingest is")).toEqual([
      ["[deBug]", "ingest is 0.8.1, this SDK is 0.9.0: some fields will be dropped. Run npx debugkit upgrade."],
    ]);
    await c.close();
  });

  it("says nothing outside debug mode", async () => {
    const { c, send, warnings } = await client(false, () => reply("0.8.1"));
    await send();
    expect(warnings("ingest is")).toEqual([]);
    await c.close();
  });

  it("says nothing when the versions match, or the ingest sends no version", async () => {
    for (const version of ["0.9.0", undefined]) {
      const { c, send, warnings } = await client(true, () => reply(version));
      await send();
      expect(warnings("ingest is")).toEqual([]);
      await c.close();
    }
  });

  it("checks the next response when the first has no version", async () => {
    const versions = [undefined, "0.7.0"];
    const { c, send, warnings } = await client(true, () => reply(versions.shift()));
    await send();
    await send();
    expect(warnings("ingest is 0.7.0")).toHaveLength(1);
    await c.close();
  });

  it("never fails a send over a response it can't read headers from", async () => {
    const unreadable = () =>
      ({ status: 202, ok: true, headers: { get: () => { throw new Error("no headers"); } } }) as unknown as Response;
    const { c, send, warnings, fetch } = await client(true, unreadable);
    await send();
    await c.flush();
    expect(fetch).toHaveBeenCalledTimes(1); // sent once, and not requeued for a retry
    expect(warnings("flush failed")).toEqual([]);
    await c.close();
  });
});
