import { describe, expect, it } from "vitest";
import { parseStack } from "./core";
import { cleanFnName, markLibraryFrames } from "./frames";
import { stagingRequestStack } from "../../ingest/src/fixtures/staging-stack";

const inAppNames = (stack: string) => parseStack(stack).filter((f) => f.inApp).map((f) => cleanFnName(f.fn));

describe("library frames in React Native bundles", () => {
  it("skips axios and the Hermes runtime on the Cell C staging stack: the first app frame is the app's API layer", () => {
    const names = inAppNames(stagingRequestStack);
    expect(names[0]).toBe("attemptApiRequest");
    expect(names.slice(0, 6)).toEqual(["attemptApiRequest", "attemptApiRequest", "sendHttpRequest", "sendHttpRequest", "dispatchApiRequest", "makeApiRequest"]);
  });

  it("marks distinctive library names anywhere, and React's event plumbing at the bottom", () => {
    const frames = parseStack(stagingRequestStack);
    for (const name of ["dispatchXhrRequest", "dispatchRequest", "fetchFn", "#executeFetch", "executeDispatch", "batchedUpdatesImpl", "batchedUpdates$1", "dispatchEvent"])
      expect(frames.find((f) => f.fn === name)?.inApp, name).toBe(false);
    expect(frames.find((f) => f.fn === "_onRefresh")?.inApp).toBe(true);
  });

  it("treats shared names (request, fetch, run) as library code only at the top of the stack", () => {
    const frames = parseStack(stagingRequestStack);
    expect(frames.find((f) => f.fn === "request")?.inApp).toBe(false); // under axios at the top
    // Below the app's own frames, a function called fetch or run may be the app's: left alone.
    expect(frames.find((f) => f.fn === "run")?.inApp).toBe(true);
    const app = parseStack(["Error: x", "    at request (main.jsbundle:10:1)", "    at Profile (main.jsbundle:20:1)"].join("\n"));
    expect(app[0]).toMatchObject({ fn: "request", inApp: true }); // nothing above it is a library's
  });

  it("leaves web and Node frames to their file paths", () => {
    const frames = markLibraryFrames([{ fn: "dispatchRequest", file: "/app/src/api.ts", line: 1, inApp: true }]);
    expect(frames[0]!.inApp).toBe(true);
  });

  it("cleans Hermes async names", () => {
    expect(cleanFnName("?anon_0_attemptApiRequest")).toBe("attemptApiRequest");
    expect(cleanFnName("?anon_12_t6")).toBe("t6");
    expect(cleanFnName("makeApiRequest")).toBe("makeApiRequest");
  });
});
