// A named import: bundlers keep just this field, not the whole package.json.
import { version } from "../package.json";

/** This ingest's version: the package's, which every release bumps with the SDK's (one changeset group). */
export const INGEST_VERSION: string = version;

/** Sent on every ingest response, so an SDK (or the CLI) can tell how old the ingest it talks to is. */
export const VERSION_HEADER = "x-debugkit-version";
