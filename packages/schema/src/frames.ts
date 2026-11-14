import type { StackFrame } from "./index";

/**
 * React Native ships one bundle, so a stack can't tell app code from library code by file. Hermes
 * keeps function names, though, so known library and runtime functions are recognised by name.
 *
 * Two lists:
 * - LIBRARY names are distinctive enough to be library code wherever they appear.
 * - LIBRARY_AT_TOP names could just as well be an app's own (`request`, `fetchQuery`, `settle`).
 *   They count as library code only in the run of library frames at the top of the stack, i.e.
 *   directly under one we already know is a library's. Lower down they're left as app code.
 *
 * Add names from real stacks; keep each list grouped by library.
 */
const LIBRARY = new Set([
  // axios
  "dispatchXhrRequest",
  "throwIfCancellationRequested",
  "AxiosError",
  "onloadend",
  // React Native networking
  "__didCompleteResponse",
  "__didReceiveResponse",
  "__didReceiveData",
  "setReadyState",
  // Hermes / React Native runtime (also in InternalBytecode.js, which is never in-app)
  "tryCallOne",
  "tryCallTwo",
  "doResolve",
  "handleResolved",
  "finale",
  "flushedQueue",
  "invokeCallbackAndReturnFlushedQueue",
  "callFunctionReturnFlushedQueue",
  "__callFunction",
  "__guard",
  "callTimers",
  "_callTimer",
  "_allocateCallback",
  "asyncGeneratorStep",
  "_asyncToGenerator",
  "_next",
  "_throw",
  // React (renderer and events)
  "executeDispatch",
  "executeDispatchesInOrder",
  "processDispatchQueue",
  "dispatchEvent",
  "dispatchEventForPluginEventSystem",
  "batchedUpdatesImpl",
  "batchedUpdates$1",
  "batchedUpdates",
  "invokeGuardedCallbackImpl",
  "invokeGuardedCallback",
  "commitRootImpl",
  "performSyncWorkOnRoot",
  "renderWithHooks",
  "mountIndeterminateComponent",
  "beginWork",
  "flushPassiveEffects",
  "commitHookEffectListMount",
  // TanStack Query
  "#executeFetch",
]);

const LIBRARY_AT_TOP = new Set([
  // axios
  "xhr",
  "_request",
  "request",
  "wrap",
  "dispatchRequest",
  "transformData",
  "settle",
  "createError",
  "handleLoad",
  "handleError",
  "handleTimeout",
  // Babel's async helpers, when they're in the bundle rather than in Hermes' InternalBytecode
  "step",
  "spawn",
  // React Native networking
  "send",
  "sendRequest",
  "fetch",
  // TanStack Query
  "fetchFn",
  "fetchQuery",
  "executeMutation",
  "run",
  "start",
  "refetch",
  "onFetch",
]);

/** Hermes names async and generator bodies "?anon_0_name": the name is the function's own. */
export function cleanFnName(fn: string | undefined): string | undefined {
  if (!fn) return fn;
  return fn.replace(/^\?anon_\d+_/, "");
}

/** A React Native bundle: "main.jsbundle", "index.android.bundle", or a Metro dev URL "…/index.bundle//&platform=ios". */
export const RN_BUNDLE = /\.(?:js)?bundle\b/;

/**
 * Mark known library frames in a React Native bundle as not in-app. Frames outside a bundle (web,
 * Node) are left as they are: their file paths already say whether they're in node_modules.
 * Returns a new array; the input isn't changed. Never marks a frame in-app, so it's safe to run
 * again, e.g. after dropping a wrapper frame from the top.
 */
export function markLibraryFrames(frames: StackFrame[]): StackFrame[] {
  // True while every bundle frame so far, from the top, has been a known library's.
  let underLibrary = false;
  let seenBundleFrame = false;
  return frames.map((f) => {
    if (!f.file || !RN_BUNDLE.test(f.file)) return f; // runtime files (InternalBytecode) and web/Node frames
    const name = cleanFnName(f.fn);
    const library = !!name && (LIBRARY.has(name) || (underLibrary && LIBRARY_AT_TOP.has(name)));
    if (library) {
      if (!seenBundleFrame) underLibrary = true; // a run starts only at the top
    } else if (f.inApp !== false) underLibrary = false; // app code ends the run ("anonymous" doesn't)
    seenBundleFrame = true;
    return library && f.inApp !== false ? { ...f, inApp: false } : f;
  });
}
