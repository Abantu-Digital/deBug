import { DebugClient } from "./client";

export { DebugClient, SDK_VERSION } from "./client";
export type { InitOptions, EventMeta, QueueStorage } from "./client";
export { browserContext, expoContext } from "./context";
export { parseStack } from "@debug/schema";

/** Default singleton: `import { deBug } from "@debug/sdk"`. */
export const deBug = new DebugClient();
