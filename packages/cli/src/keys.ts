/**
 * Ingest keys as the ingest function reads them: "key:appId,key2:appId2" (see parseIngestKeys).
 * Keys are public and write-only; each one can only write to its own app.
 */
export const keyEntry = (key: string, appId: string) => `${key}:${appId}`;

/**
 * Add a key to an existing list without dropping any. Builds already in users' hands carry the
 * old keys, so replacing the list would silently reject their events.
 */
export function mergeKeys(existing: string | undefined, key: string, appId: string): string {
  const pairs = (existing ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[^:\s]+:[^:\s]+$/.test(s));
  if (!pairs.some((p) => p.split(":")[0] === key)) pairs.push(keyEntry(key, appId));
  return pairs.join(",");
}
