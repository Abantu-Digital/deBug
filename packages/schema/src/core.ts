/**
 * Zod-free half of the schema: types, constants and pure helpers.
 * Client code (the SDK) imports only this entry so validators never reach app bundles.
 */
import type { Severity, StackFrame } from "./index";

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
  Event,
  EventInput,
  Envelope,
  EnvelopeInput,
  StoredEvent,
  Issue,
  RollupDimension,
  RollupIncrement,
  RollupRow,
} from "./index";

export const SCHEMA_VERSION = 1;

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
 * frames count as in-app and the function name carries the signal.
 */
const RN_BUNDLE = /\.(?:js)?bundle\b/;

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
  return frames;
}
