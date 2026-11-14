import type { StackFrame } from "./index";

/**
 * React Native ships one bundle, so a stack can't tell app code from library code by file. Hermes
 * keeps function names, though, so known library and runtime functions are recognised by name.
 *
 * Two lists:
 * - LIBRARY names are distinctive enough to be library code wherever they appear.
 * - SHARED names are common words an app might use too (`request`, `fetch`). They count as library
 *   code only in the run of library frames at the top of the stack, i.e. directly under one we
 *   already know is a library's.
 *
 * Add names from real stacks; keep each list grouped by library.
 */
const LIBRARY = new Set([
  // axios
  "dispatchXhrRequest",
  "dispatchRequest",
  "throwIfCancellationRequested",
  "transformData",
  "settle",
  "createError",
  "AxiosError",
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
  "fetchQuery",
  "fetchFn",
  "executeMutation",
]);

const SHARED = new Set([
  // axios
  "xhr",
  "_request",
  "request",
  "wrap",
  // React Native networking
  "send",
  "sendRequest",
  "fetch",
  // TanStack Query
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

const RN_BUNDLE = /\.(?:js)?bundle\b/;

/**
 * Mark known library frames in a React Native bundle as not in-app. Frames outside a bundle (web,
 * Node) are left as they are: their file paths already say whether they're in node_modules.
 * Returns a new array; the input isn't changed.
 */
export function markLibraryFrames(frames: StackFrame[]): StackFrame[] {
  // True while every bundle frame so far, from the top, has been a known library's.
  let underLibrary = false;
  let seenBundleFrame = false;
  return frames.map((f) => {
    if (!f.file || !RN_BUNDLE.test(f.file)) return f; // runtime files (InternalBytecode) and web/Node frames
    const name = cleanFnName(f.fn);
    const library = !!name && (LIBRARY.has(name) || (underLibrary && SHARED.has(name)));
    if (library) {
      if (!seenBundleFrame) underLibrary = true; // a run starts only at the top
    } else if (f.inApp !== false) underLibrary = false; // app code ends the run ("anonymous" doesn't)
    seenBundleFrame = true;
    return library && f.inApp !== false ? { ...f, inApp: false } : f;
  });
}
