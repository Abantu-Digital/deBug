import { DebugClient } from "./client";

export { DebugClient, SDK_NAME, SDK_VERSION } from "./client";
export type { InitOptions, EventMeta, QueueStorage, AutoCaptureOptions, NetworkOptions } from "./client";
export { normaliseUrl } from "./auto";
export type { BaseUrl } from "./network";
export { browserContext, mergeContext, type ContextPatch } from "./context";
export { parseStack, TEST_TAG } from "@debugkit/schema/core";
export type { Breadcrumb, EventInput, Severity, StackFrame } from "@debugkit/schema/core";

/**
 * Default client. Framework entry points (`/react`, `/react-native`, `/expo`, `/node`) use this
 * same instance, so `import { deBug } from "@debugkit/sdk"` works everywhere.
 */
export const deBug = new DebugClient();
