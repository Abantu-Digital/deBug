/**
 * Which versions of deBug a project runs: the newest SDK an app has sent from, and the ingest that
 * received it. The dashboard compares them with its own to say when something is behind.
 */
export interface Versions {
  /** The newest SDK version seen for the app (by semver, not by arrival), and when it was last seen (refreshed about daily). */
  sdk?: { version: string; seenAt: string };
  /** The ingest version that last wrote this record, and when. */
  ingest?: { version: string; at: string };
}

/** What one ingest saw: the envelope's SDK version (when it's a version) and its own. */
export interface VersionsSeen {
  sdk?: string;
  ingest: string;
  at: string;
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** "1.2.3", "1.2.3-beta.1" (a leading "v" and build metadata are allowed), or undefined. */
export function parseVersion(v: string | undefined): { major: number; minor: number; patch: number; pre?: string } | undefined {
  const m = v ? SEMVER.exec(v.trim()) : null;
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] } : undefined;
}

/**
 * A string that sorts like the version, so a store can keep the newest with a plain comparison:
 * "000001.000002.000003~" for a release, "000001.000002.000003-beta.000002" for a prerelease, which
 * sorts below it ("-" comes before "~"). Numeric prerelease parts are padded, so beta.10 sorts above
 * beta.2, and below letters, as semver has it. Undefined when it isn't a version.
 */
export function versionKey(v: string | undefined): string | undefined {
  const p = parseVersion(v);
  if (!p) return undefined;
  const pad = (n: number) => String(Math.min(n, 999_999)).padStart(6, "0");
  const pre = p.pre?.split(".").map((part) => (/^\d+$/.test(part) ? pad(Number(part)) : part)).join(".");
  return `${pad(p.major)}.${pad(p.minor)}.${pad(p.patch)}${pre ? `-${pre}` : "~"}`;
}

/** Negative when a is older than b, 0 when the same, positive when newer; versions that don't parse sort lowest. */
export function compareVersions(a: string | undefined, b: string | undefined): number {
  const ka = versionKey(a) ?? "";
  const kb = versionKey(b) ?? "";
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/** The record after `seen`: the newer SDK of the two (seen again: its time moves on), and this ingest. */
export function mergeVersions(cur: Versions | null | undefined, seen: VersionsSeen): Versions {
  const sdk = versionKey(seen.sdk) !== undefined && compareVersions(seen.sdk, cur?.sdk?.version) >= 0 ? seen.sdk : undefined;
  return {
    ...(sdk ? { sdk: { version: sdk, seenAt: seen.at } } : cur?.sdk ? { sdk: cur.sdk } : {}),
    ingest: { version: seen.ingest, at: seen.at },
  };
}
