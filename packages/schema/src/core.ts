/**
 * Zod-free half of the schema: types, constants and pure helpers.
 * Client code (the SDK) imports only this entry so validators never reach app bundles.
 */
import type { Severity, StackFrame } from "./index";
import type { LabelInfo } from "./taxonomy";
import { markLibraryFrames, RN_BUNDLE } from "./frames";

export type {
  Flow,
  Device,
  Context,
  ContextInput,
  Breadcrumb,
  StackFrame,
  Severity,
  ErrorEvent,
  CustomEvent,
  SessionEvent,
  MetricEvent,
  Event,
  EventInput,
  Envelope,
  EnvelopeInput,
  StoredEvent,
  Issue,
  IssueStatus,
  RollupDimension,
  RollupIncrement,
  RollupRow,
} from "./index";

export { cleanFnName, markLibraryFrames, RN_BUNDLE } from "./frames";
export { hostNameFor, hostOf, MAX_HOST_NAMES, nameUrl, nameUrlsIn, normaliseHostMatch, validHostNames, type HostName } from "./hosts";
export {
  CATEGORIES,
  CATEGORY_INFO,
  OWNERS,
  OWNER_INFO,
  IMPACTS,
  IMPACT_INFO,
  IMPACT_ORDER,
  CAUSES,
  CAUSE_INFO,
  type Category,
  type Owner,
  type Impact,
  type Cause,
  type Classification,
  type LabelInfo,
} from "./taxonomy";

export const SCHEMA_VERSION = 1;

/** What the SDK puts in place of a secret it redacted, in headers, bodies and queries. */
export const REDACTED = "[redacted]";

/**
 * Errors and events an app makes on purpose (a dev tools "Error testing" screen, `npx debugkit
 * test`) carry this tag as "true". They get their own issues, stay out of every count and rate,
 * and are hidden unless asked for (ABA-133).
 */
export const TEST_TAG = "test";

/** Whether an error or event was made on purpose to test deBug. */
export const isTestEvent = (e: { tags?: Record<string, string> } | undefined): boolean => e?.tags?.[TEST_TAG] === "true";

/** A failure with no HTTP status faster than this never reached a server: the request never left the phone. */
export const NEVER_SENT_MS = 100;

/**
 * The one issue that collects every request that never left the phone (ABA-132). Not a problem
 * with any endpoint or owner, so it stays out of their counts and shows under Connectivity.
 */
export const OFFLINE_FINGERPRINT = "offline";

/** The offline issue's title. */
export const OFFLINE_TITLE = "Phone offline: requests never left the phone";

/** Whether an issue is the offline one. */
export const isOfflineIssue = (i: { fingerprint: string } | undefined): boolean => i?.fingerprint === OFFLINE_FINGERPRINT;

/** Tag the React Native SDK sets on Android: "true" when airplane mode was on at the time. */
export const AIRPLANE_TAG = "network.airplaneMode";

/** Whether an issue is made of test errors: its newest occurrence carries the tag. */
export const isTestIssue = (i: { lastEvent?: { event: { tags?: Record<string, string> } } } | undefined): boolean => isTestEvent(i?.lastEvent?.event);

/** The most of a failed call's captured body kept, in characters (16 KB). */
export const MAX_CAPTURED_BODY = 16_384;
/** The most breadcrumbs an error event carries. */
export const MAX_BREADCRUMBS = 50;

/** "2.10.0" sorts after "2.9.1"; pre-release and build suffixes compare as text. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/);
  const pb = b.split(/[.+-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "";
    const y = pb[i] ?? "";
    const d = /^\d+$/.test(x) && /^\d+$/.test(y) ? Number(x) - Number(y) : x.localeCompare(y);
    if (d) return d;
  }
  return 0;
}

/** How a release is labelled: the store version, plus the OTA update when there is one ("2.4.0+a1b2c3d"). */
export function releaseKey(app: { version?: string; update?: string }): string {
  const v = app.version || "unknown";
  return app.update ? `${v}+${app.update.slice(0, 12)}` : v;
}

/** Upper bounds (ms) of the request-timing histogram buckets; one more bucket holds anything slower. */
export const LATENCY_BUCKETS_MS = [50, 100, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 10000] as const;

export function latencyBucket(ms: number): number {
  const i = LATENCY_BUCKETS_MS.findIndex((edge) => ms <= edge);
  return i === -1 ? LATENCY_BUCKETS_MS.length : i;
}

/** The p-th percentile (0–1) from bucket counts, as the bucket's upper bound (or ">10000"). */
export function percentileMs(buckets: number[], p: number): number | null {
  const total = buckets.reduce((a, b) => a + b, 0);
  if (!total) return null;
  let seen = 0;
  for (let i = 0; i < buckets.length; i++) {
    seen += buckets[i]!;
    if (seen >= p * total) return i < LATENCY_BUCKETS_MS.length ? LATENCY_BUCKETS_MS[i]! : Infinity;
  }
  return Infinity;
}

/** Has an issue resolved in `resolvedIn` come back in `version`? */
export function isRegression(resolvedIn: string | undefined, version: string | undefined, resolvedAt: string | undefined, ts: string): boolean {
  if (resolvedIn && version) return compareVersions(version, resolvedIn) >= 0;
  return !!resolvedAt && ts > resolvedAt;
}

/* ---------- Severity (shared by ingest + dashboard) ---------- */

export interface SeverityThresholds {
  critical: number;
  high: number;
  medium: number;
}

/** Occurrences in the trailing 24h window. */
export const DEFAULT_SEVERITY_THRESHOLDS: SeverityThresholds = { critical: 100, high: 25, medium: 5 };

export function severityFromCount(count: number, t: SeverityThresholds = DEFAULT_SEVERITY_THRESHOLDS): Severity {
  if (count >= t.critical) return "critical";
  if (count >= t.high) return "high";
  if (count >= t.medium) return "medium";
  return "low";
}

export const SEVERITY_ORDER: Record<Severity, number> = { critical: 3, high: 2, medium: 1, low: 0 };

/** How each severity level reads in the dashboard: always in words, never by colour alone. */
export const SEVERITY_INFO: Record<Severity, LabelInfo> = {
  critical: { name: "Critical", description: "Customers are blocked, or the app closes, for many of them. Act now." },
  high: { name: "High", description: "Customers are blocked, or many have a degraded experience." },
  medium: { name: "Medium", description: "A few customers have a degraded experience, or a silent failure is frequent." },
  low: { name: "Low", description: "A one-off, or silent and rare." },
};

/* ---------- Stack parsing ---------- */


// V8/Hermes: "    at fn (file:line:col)" or "    at file:line:col"
const V8 = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/;
// JSC/Firefox: "fn@file:line:col"
const GECKO = /^\s*(.*?)@(.+?):(\d+):(\d+)\s*$/;

const NOT_IN_APP = [/node_modules/, /\bnative\b/, /\[native code\]/, /InternalBytecode/];

/**
 * React Native ships one JS bundle, so every frame points at it: in development a Metro URL
 * (".../entry.bundle//&platform=ios&dev=true..."), in release "address at index.android.bundle"
 * or "main.jsbundle". We can't tell app code from library code without source maps, so bundle
 * frames count as in-app and the function name carries the signal: known library functions are
 * marked by name (see ./frames).
 */

function cleanFile(file: string): string {
  return file.replace(/^address at /, "");
}

export function parseStack(stack: string | undefined): StackFrame[] {
  if (!stack) return [];
  const frames: StackFrame[] = [];
  for (const raw of stack.split("\n")) {
    const m = V8.exec(raw) ?? GECKO.exec(raw);
    if (!m) continue;
    const [, fn, rawFile, line, col] = m;
    const file = cleanFile(rawFile ?? "");
    frames.push({
      fn: fn || undefined,
      file,
      line: Number(line),
      col: Number(col),
      inApp: RN_BUNDLE.test(file) ? !/^(?:anonymous|eval|global code)$/.test(fn ?? "") : !NOT_IN_APP.some((re) => re.test(file)),
    });
    if (frames.length >= 100) break;
  }
  return markLibraryFrames(frames);
}
