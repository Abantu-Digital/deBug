import { z } from "zod";
import { MAX_BREADCRUMBS, MAX_CAPTURED_BODY, SCHEMA_VERSION, type Classification } from "./core";

// Everything that does not need zod lives in ./core so client bundles stay small.
export * from "./core";

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
  /** Over-the-air update on top of the store version (hot-updater bundle id, expo-updates id). */
  update: z.string().max(100).optional(),
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

/**
 * Captured bodies: the SDK cuts at MAX_CAPTURED_BODY and adds a marker; ingest cuts again here
 * rather than reject an event that came in longer.
 */
const CUT_MARKER = "…[truncated]";
const CapturedText = z
  .string()
  .transform((s) => (s.length > MAX_CAPTURED_BODY + 64 ? `${s.slice(0, MAX_CAPTURED_BODY)}${CUT_MARKER}` : s));
const CapturedHeaders = z
  .record(z.string().transform((s) => s.slice(0, 2000)))
  .optional()
  .transform((h) => (h ? Object.fromEntries(Object.entries(h).slice(0, 100)) : h));
const CapturedBody = {
  body: CapturedText.optional(),
  /** The body's size before it was cut, in characters (bytes for a binary body). */
  bodySize: z.number().int().nonnegative().optional(),
  truncated: z.boolean().optional(),
};

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
  breadcrumbs: z.array(Breadcrumb).max(MAX_BREADCRUMBS).optional(),
  /** Set when the error is a failed HTTP request captured by the SDK's network instrumentation. */
  request: z
    .object({
      method: z.string().max(10),
      /** Path without query string or fragment, ids replaced with :id, e.g. "/v1/orders/:id". */
      url: z.string().max(500),
      status: z.number().int().optional(), // absent for network failures and timeouts
      durationMs: z.number().optional(),
      /** Below: only with the SDK's `network.bodies`, already redacted on the device. */
      query: CapturedText.optional(),
      headers: CapturedHeaders,
      ...CapturedBody,
    })
    .optional(),
  /** The failed request's response, with `network.bodies` (absent when there was no answer). */
  response: z
    .object({
      status: z.number().int(),
      headers: CapturedHeaders,
      ...CapturedBody,
    })
    .optional(),
});

export const CustomEvent = EventBase.extend({
  type: z.literal("event"),
  name: z.string().min(1).max(100),
  outcome: z.enum(["success", "failure", "abandoned"]).optional(),
  props: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});

/**
 * Session health, sent automatically by the SDK: "started" once per session, then at most one
 * "errored" (first unhandled error) and one "crashed" (fatal error). Crash-free rate per release
 * = 1 - crashed / started.
 */
export const SessionEvent = EventBase.extend({
  type: z.literal("session"),
  status: z.enum(["started", "errored", "crashed"]),
});

/**
 * Request timings for one endpoint over a period (about a minute), sent by the SDK instead of
 * one event per request. `buckets[i]` counts requests that took up to LATENCY_BUCKETS_MS[i]
 * milliseconds; the last bucket is everything slower.
 */
export const MetricEvent = EventBase.extend({
  type: z.literal("metric"),
  name: z.literal("http"),
  /** "<METHOD> <path>", as in ErrorEvent.request. */
  key: z.string().min(1).max(300),
  count: z.number().int().min(1).max(1_000_000),
  errors: z.number().int().min(0).max(1_000_000),
  buckets: z.array(z.number().int().min(0)).length(13),
  // Calls that never left the phone (ABA-132) aren't in count or errors: the endpoint never saw them.
});

export const Event = z.discriminatedUnion("type", [ErrorEvent, CustomEvent, SessionEvent, MetricEvent]);

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
export type SessionEvent = z.infer<typeof SessionEvent>;
export type MetricEvent = z.infer<typeof MetricEvent>;
export type Event = z.infer<typeof Event>;
export type EventInput = z.input<typeof Event>;
export type Envelope = z.infer<typeof Envelope>;
export type EnvelopeInput = z.input<typeof Envelope>;

/* ---------- Stored shapes (written by ingest, read by the dashboard) ---------- */

export interface StoredEvent {
  app: string;
  day: string; // YYYY-MM-DD (UTC)
  fingerprint?: string; // error events only
  /** Category, owner, impact and causes, set by the ingest classifier. Error events only. */
  labels?: Classification;
  /** The incident this error belongs to, "<cause>|<category>|<os>", when it's part of one. */
  incident?: string;
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
  /** open (default), resolved, ignored, or regressed (it came back in a version at or after resolvedIn). */
  status?: IssueStatus;
  /** The release that contains the fix. Events from older releases don't count as a regression. */
  resolvedIn?: string;
  resolvedAt?: string;
  regressedAt?: string;
  /** App versions of the first and most recent occurrence. */
  firstVersion?: string;
  lastVersion?: string;
}

export type IssueStatus = "open" | "resolved" | "ignored" | "regressed";

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
  | "flowOutcome"
  /** Session health: key "<appVersion>|started|errored|crashed", counted in `events`. */
  | "session"
  /** Failed HTTP requests captured by the SDK: key "<METHOD> <path>", counted in `errors`. */
  | "endpoint"
  /** Sessions per release (version, plus OTA update when there is one): key "<version>[+<update>]", counted in `events`. */
  | "release"
  /** track() outcomes per step: key "<flow>|<step>|<outcome>", counted in `events`. */
  | "flowStep"
  /** Requests per endpoint from metric events: key "<METHOD> <path>"; `events` = requests, `errors` = failed ones. */
  | "requests"
  /** Request timing histogram: key "<METHOD> <path>|<bucket index>", counted in `events`. */
  | "latency"
  /** Errors by network type (wifi, cellular, …). */
  | "network"
  /** Errors by country (ISO 3166 code from the device's timezone or locale; never from IP). */
  | "country"
  /** Errors by label (see docs/taxonomy.md): key is the category, owner or impact id. */
  | "category"
  | "owner"
  | "impact"
  /** Errors per incident: key "<cause>|<category>|<os>". */
  | "incident"
  /** Errors per issue within an incident: key "<cause>|<category>|<os>|<fingerprint>". */
  | "incidentIssue";

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

