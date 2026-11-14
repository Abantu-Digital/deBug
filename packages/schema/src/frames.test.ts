import { describe, expect, it } from "vitest";
import { parseStack } from "./core";
import { cleanFnName, markLibraryFrames } from "./frames";
import { stagingRequestStack } from "./fixtures/staging-stack";

const inAppNames = (stack: string) => parseStack(stack).filter((f) => f.inApp).map((f) => cleanFnName(f.fn));

describe("library frames in React Native bundles", () => {
  it("skips axios and the Hermes runtime on the Cell C staging stack: the first app frame is the app's API layer", () => {
    const names = inAppNames(stagingRequestStack);
    expect(names[0]).toBe("attemptApiRequest");
    expect(names.slice(0, 6)).toEqual(["attemptApiRequest", "attemptApiRequest", "sendHttpRequest", "sendHttpRequest", "dispatchApiRequest", "makeApiRequest"]);
  });

  it("marks distinctive library names anywhere, and React's event plumbing at the bottom", () => {
    const frames = parseStack(stagingRequestStack);
    for (const name of ["dispatchXhrRequest", "dispatchRequest", "#executeFetch", "executeDispatch", "batchedUpdatesImpl", "batchedUpdates$1", "dispatchEvent"])
      expect(frames.find((f) => f.fn === name)?.inApp, name).toBe(false);
    expect(frames.find((f) => f.fn === "_onRefresh")?.inApp).toBe(true);
    // Generic-sounding library names below the app's frames are left alone: they could be the app's.
    expect(frames.find((f) => f.fn === "fetchFn")?.inApp).toBe(true);
  });

  it("treats shared names (request, fetch, run) as library code only at the top of the stack", () => {
    const frames = parseStack(stagingRequestStack);
    expect(frames.find((f) => f.fn === "request")?.inApp).toBe(false); // under axios at the top
    // Below the app's own frames, a function called fetch or run may be the app's: left alone.
    expect(frames.find((f) => f.fn === "run")?.inApp).toBe(true);
    const app = parseStack(["Error: x", "    at request (main.jsbundle:10:1)", "    at Profile (main.jsbundle:20:1)"].join("\n"));
    expect(app[0]).toMatchObject({ fn: "request", inApp: true }); // nothing above it is a library's
  });

  it("finds the library run once the SDK's own wrapper frame is dropped from the top", () => {
    const withWrapper = stagingRequestStack.replace("Error: GET failed\n", "Error: GET failed\n    at wrapped (/build/main.jsbundle:900:3)\n");
    const sliced = parseStack(withWrapper).slice(1);
    expect(sliced.find((f) => f.fn === "xhr")?.inApp).toBe(true); // the wrapper hid the run
    expect(markLibraryFrames(sliced).filter((f) => f.inApp)[0]?.fn).toBe("?anon_0_attemptApiRequest");
  });

  it("knows axios and React Native callbacks that can top a stack", () => {
    const stack = ["Error: Network Error", "    at onloadend (main.jsbundle:1:1)", "    at handleLoad (main.jsbundle:2:1)", "    at setReadyState (main.jsbundle:3:1)", "    at loadProfile (main.jsbundle:4:1)"].join("\n");
    expect(inAppNames(stack)).toEqual(["loadProfile"]);
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
