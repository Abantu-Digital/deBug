import { compareVersions, parseVersion, type ReadStore, type Versions } from "@debugkit/adapters";
// A named import: the bundle keeps just this field of the dashboard's package.json.
import { version as DASHBOARD_VERSION } from "../../package.json";

export { DASHBOARD_VERSION };

/** One part of a project's deBug and the version it runs (undefined: it doesn't say, so it predates version tracking). */
export interface VersionPart {
  part: "sdk" | "ingest" | "dashboard";
  version?: string;
  /** When ingest last saw this SDK, or last recorded itself. */
  at?: string;
}

/**
 * Whether a project's deBug is in step: the newest SDK any of its apps sends from, the ingest that
 * received it, and this dashboard. deBug releases them on one version, so an ingest or dashboard a
 * minor or more behind the newest misses fields or pages ("banner"); a patch behind, or an app on an
 * older SDK, only gets a note on Settings.
 */
export interface VersionStatus {
  parts: VersionPart[];
  /** The newest version among the parts. */
  newest?: string;
  /** The parts behind it, oldest first. */
  behind: VersionPart[];
  level: "banner" | "note" | "none";
  /** The command that brings ingest and the dashboard up to date. */
  command: string;
  /** Set when the dashboard knows the environment (DEBUG_ENVIRONMENT, set by the CLI). */
  environment?: string;
}

/** "minor" when a and b differ in major or minor, "patch" when only below that, undefined when the same. */
function gap(a: string | undefined, b: string | undefined): "minor" | "patch" | undefined {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return pa || pb ? "minor" : undefined;
  if (pa.major !== pb.major || pa.minor !== pb.minor) return "minor";
  return compareVersions(a, b) !== 0 ? "patch" : undefined;
}

/**
 * The project's versions from each app's record: the newest SDK across apps, and the ingest that
 * wrote last (one ingest serves all of a project's apps; a quiet app's record can be older). No
 * ingest version at all means the ingest predates version tracking.
 */
export function versionStatus(records: readonly Versions[], dashboard: string, environment?: string): VersionStatus {
  const sdk = records.flatMap((r) => (r.sdk ? [r.sdk] : [])).sort((a, b) => compareVersions(b.version, a.version))[0];
  const ingest = records.flatMap((r) => (r.ingest ? [r.ingest] : [])).sort((a, b) => b.at.localeCompare(a.at))[0];
  const parts: VersionPart[] = [
    { part: "sdk", version: sdk?.version, at: sdk?.seenAt },
    { part: "ingest", version: ingest?.version, at: ingest?.at },
    { part: "dashboard", version: dashboard },
  ];
  // Without any SDK version there's nothing to compare against but the dashboard itself.
  const known = parts.filter((p) => p.version && parseVersion(p.version));
  const newest = known.map((p) => p.version!).sort((a, b) => compareVersions(b, a))[0];
  const tracked = records.length > 0;
  const behind = parts
    // An SDK that hasn't said its version isn't behind anything; an ingest that hasn't is, once there are apps.
    .filter((p) => (p.part === "ingest" ? tracked && gap(p.version, newest) : p.version && gap(p.version, newest)))
    .sort((a, b) => compareVersions(a.version, b.version));
  // The banner is for what this project deploys (ingest, the dashboard); an app on an older SDK is only a note.
  const level = behind.some((p) => p.part !== "sdk" && gap(p.version, newest) === "minor") ? "banner" : behind.length ? "note" : "none";
  return { parts, newest, behind, level, command: `npx debugkit upgrade${environment ? ` --env ${environment}` : ""}`, environment };
}

export async function buildVersionStatus(store: ReadStore, environment?: string): Promise<VersionStatus> {
  const apps = await store.listApps();
  const records = await Promise.all(apps.map((a) => store.getVersions(a).catch((): Versions => ({}))));
  return versionStatus(records, DASHBOARD_VERSION, environment);
}
