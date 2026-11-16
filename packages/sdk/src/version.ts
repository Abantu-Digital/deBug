/**
 * Compares the ingest's version (its `x-debugkit-version` response header) with this SDK's.
 * Pure: no globals, never throws.
 */

/** The response header an ingest names its own version in. */
export const INGEST_VERSION_HEADER = "x-debugkit-version";

/** `major.minor` of a version like `0.8.0` or `0.9.0-next.1`, or undefined when it isn't one. */
function majorMinor(version: string): [number, number] | undefined {
  const m = /^v?(\d+)\.(\d+)\./.exec(version.trim());
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}

/**
 * The warning to log when the ingest is a minor or more behind this SDK, or undefined.
 * A patch behind, the same version, an ingest that's ahead, or a version that won't
 * parse gives no warning.
 */
export function ingestBehindWarning(ingest: string | null | undefined, sdk: string): string | undefined {
  if (!ingest) return undefined;
  const i = majorMinor(ingest);
  const s = majorMinor(sdk);
  if (!i || !s) return undefined;
  const behind = i[0] < s[0] || (i[0] === s[0] && i[1] < s[1]);
  if (!behind) return undefined;
  return `ingest is ${ingest.trim()}, this SDK is ${sdk}: some fields will be dropped. Run npx debugkit upgrade.`;
}
