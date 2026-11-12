import { z } from "zod";

export const SCHEMA_VERSION = 1;

/** Dotted, lowercase identifier for a part of the app, e.g. "auth.login". */
export const Flow = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_]+(\.[a-z0-9_]+)*$/, "flow must be dotted lowercase, e.g. auth.login");

const Tags = z.record(z.string().max(200)).optional();
const Iso = z.string().datetime({ offset: true });

export const Device = z.object({
  model: z.string().optional(),
  manufacturer: z.string().optional(),
  brand: z.string().optional(),
  type: z.enum(["phone", "tablet", "desktop", "tv", "unknown"]).default("unknown"),
  isEmulator: z.boolean().optional(),
  memoryMb: z.number().optional(),
  screen: z.object({ width: z.number(), height: z.number(), scale: z.number().optional() }).optional(),
});

export const Os = z.object({
  name: z.string(), // "ios" | "android" | "web" | "macos" ...
  version: z.string().optional(),
});

export const AppInfo = z.object({
  id: z.string().min(1), // e.g. "megaton-native"
  version: z.string().optional(),
  build: z.string().optional(),
  environment: z.string().default("production"),
});

export const Runtime = z.object({
  name: z.string(), // "react-native" | "expo" | "browser" | "node"
  version: z.string().optional(),
  engine: z.string().optional(), // "hermes" | "jsc" | "v8"
});

export const Network = z.object({
  type: z.enum(["wifi", "cellular", "ethernet", "none", "unknown"]).default("unknown"),
  effectiveType: z.string().optional(), // "4g", "3g" ...
  isConnected: z.boolean().optional(),
});

export const Context = z.object({
  app: AppInfo,
  device: Device.default({}),
  os: Os,
  runtime: Runtime,
  network: Network.optional(),
  locale: z.string().optional(),
  timezone: z.string().optional(),
});

export const Breadcrumb = z.object({
  ts: Iso,
  category: z.enum(["navigation", "network", "ui", "log", "event", "custom"]),
  message: z.string().max(500),
  level: z.enum(["debug", "info", "warning", "error"]).default("info"),
  data: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});

export const StackFrame = z.object({
  fn: z.string().optional(),
  file: z.string().optional(),
  line: z.number().optional(),
  col: z.number().optional(),
  inApp: z.boolean().optional(),
});

export const Severity = z.enum(["low", "medium", "high", "critical"]);

const EventBase = z.object({
  id: z.string().min(8).max(64),
  ts: Iso,
  flow: Flow.optional(),
  step: z.string().max(64).optional(),
  tags: Tags,
});

export const ErrorEvent = EventBase.extend({
  type: z.literal("error"),
  handled: z.boolean().default(true),
  /** Developer's override. Otherwise severity is derived from occurrence counts. */
  severity: Severity.optional(),
  error: z.object({
    name: z.string().max(200).default("Error"),
    message: z.string().max(2000),
    stack: z.string().max(20_000).optional(),
    frames: z.array(StackFrame).max(100).optional(),
  }),
  breadcrumbs: z.array(Breadcrumb).max(50).optional(),
});

export const CustomEvent = EventBase.extend({
  type: z.literal("event"),
  name: z.string().min(1).max(100),
  outcome: z.enum(["success", "failure", "abandoned"]).optional(),
  props: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});

export const Event = z.discriminatedUnion("type", [ErrorEvent, CustomEvent]);

export const Envelope = z.object({
  schema: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
  sdk: z.object({ name: z.string(), version: z.string() }),
  context: Context,
  user: z.object({ id: z.string().optional(), anonymousId: z.string() }).optional(),
  session: z.object({ id: z.string(), startedAt: Iso }),
  events: z.array(Event).min(1).max(100),
});

export type Flow = z.infer<typeof Flow>;
export type Device = z.infer<typeof Device>;
export type Context = z.infer<typeof Context>;
export type ContextInput = z.input<typeof Context>;
export type Breadcrumb = z.infer<typeof Breadcrumb>;
export type StackFrame = z.infer<typeof StackFrame>;
export type Severity = z.infer<typeof Severity>;
export type ErrorEvent = z.infer<typeof ErrorEvent>;
export type CustomEvent = z.infer<typeof CustomEvent>;
export type Event = z.infer<typeof Event>;
export type EventInput = z.input<typeof Event>;
export type Envelope = z.infer<typeof Envelope>;
export type EnvelopeInput = z.input<typeof Envelope>;

/* ---------- Stored shapes (written by ingest, read by the dashboard) ---------- */

export interface StoredEvent {
  app: string;
  day: string; // YYYY-MM-DD (UTC)
  fingerprint?: string; // error events only
  event: Event;
  context: Context;
  user?: Envelope["user"];
  sessionId: string;
  receivedAt: string;
}

export interface Issue {
  app: string;
  fingerprint: string;
  title: string; // "TypeError: Cannot read property 'x' of undefined"
  culprit?: string; // top in-app frame, e.g. "LoginScreen.submit (Login.tsx:42)"
  flow?: string;
  firstSeen: string;
  lastSeen: string;
  count: number;
  lastEvent: StoredEvent;
}

/** Dimensions pre-aggregated at write time so the dashboard never scans raw events. */
export type RollupDimension =
  | "total"
  | "flow"
  | "issue"
  /** Like "issue" but `day` holds an hour bucket "YYYY-MM-DDTHH", used for the 24h severity window. */
  | "issueHour"
  | "os"
  | "appVersion"
  | "deviceModel"
  | "flowOutcome";

export interface RollupIncrement {
  app: string;
  day: string;
  dimension: RollupDimension;
  key: string;
  kind: "error" | "event";
  by: number;
}

export interface RollupRow {
  app: string;
  day: string;
  dimension: RollupDimension;
  key: string;
  errors: number;
  events: number;
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
export { parseStack } from "./stack";
