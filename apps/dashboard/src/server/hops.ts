import { cleanFnName, hostOf, nameUrlsIn, REDACTED, RN_BUNDLE, type ErrorEvent, type HostName, type StackFrame } from "@debugkit/schema";
import { exchangeOf } from "./exchange";
import { failedRequest, timelineOf, type ApiCall, type TimelineItem } from "./event";

/**
 * "Where it comes from" (ABA-140): fixed hops from the customer down to what broke, for any kind
 * of error. Journey › Screen › Last action › Failing call or code › Source.
 *
 * A hop the data can't fill says so, and says how to find it another way. It never asks the
 * client to change their backend (ABA-137): deBug plugs into backends as they are, so the source
 * of a backend error is whatever trace id the backend already sends, or the time and endpoint to
 * search its logs by.
 */
export type HopKind = "journey" | "screen" | "action" | "failing" | "source";

export type Hop =
  | { kind: HopKind; value: string; missing?: undefined }
  | { kind: HopKind; missing: true; ask: string };

export interface Where {
  /** Always the five kinds, in order. */
  hops: Hop[];
  /** For list rows: journey to failing call or code, the hops that have a value, joined by " › ". */
  line: string;
}

export interface WhereOptions {
  hosts?: readonly HostName[];
  /** A screen's journey (ABA-135); without it, only the flow the app sent names the journey. */
  journeyOf?: (screen: string) => string | undefined;
}

/* ---------- Trace ids the backend already sends */

/** Response headers that carry a trace or request id, best first. */
const TRACE_HEADERS = ["traceparent", "x-cloud-trace-context", "x-amzn-trace-id", "x-request-id", "x-amzn-requestid", "x-correlation-id", "request-id"] as const;

/** Body fields that carry one, as backends commonly name them. */
const TRACE_FIELDS = ["traceId", "trace_id", "requestId", "request_id", "correlationId", "correlation_id"] as const;

/** W3C traceparent: version, 32-hex trace id (not all zeros), parent id, flags. */
const TRACEPARENT = /^[\da-f]{2}-(?!0{32})([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/i;

/** The trace id inside a header value, or undefined when the value isn't one. */
export function traceIdIn(header: string, value: string): string | undefined {
  if (header === "traceparent") return TRACEPARENT.exec(value.trim())?.[1];
  if (header === "x-cloud-trace-context") return value.split("/")[0] || undefined;
  if (header === "x-amzn-trace-id") return /(?:^|;)\s*Root=([^;]+)/.exec(value)?.[1];
  return value.trim() || undefined;
}

/** A trace id or error code in a JSON response body, top level only. */
function idsInBody(body: string | undefined): { traceId?: string; code?: string } {
  if (!body || !body.trimStart().startsWith("{")) return {};
  try {
    const json = JSON.parse(body) as Record<string, unknown>;
    const text = (v: unknown) => (typeof v === "string" && v && v !== REDACTED ? v : typeof v === "number" ? String(v) : undefined);
    return { traceId: TRACE_FIELDS.map((k) => text(json[k])).find(Boolean), code: text(json.code) ?? text(json.errorCode) };
  } catch {
    return {}; // cut at 16 KB, or not JSON after all
  }
}

/** The trace id the backend already sent: a response header, then the body, then the app's breadcrumb. */
export function traceOf(headers: Readonly<Record<string, string>> | undefined, body: string | undefined, call: ApiCall | undefined): { from: string; id: string } | undefined {
  for (const h of TRACE_HEADERS) {
    const v = headers?.[h];
    const id = v && v !== REDACTED ? traceIdIn(h, v) : undefined;
    if (id) return { from: h, id };
  }
  const inBody = idsInBody(body).traceId;
  if (inBody) return { from: "traceId", id: inBody };
  if (call?.traceId) return { from: "traceId", id: call.traceId };
  return undefined;
}

/* ---------- The trail */

/** The last item that matches, scanning back from the end. */
const lastWhere = <T,>(items: readonly T[], ok: (x: T) => boolean): T | undefined => {
  for (let i = items.length - 1; i >= 0; i--) if (ok(items[i]!)) return items[i];
  return undefined;
};

/** "A → B" → "B"; "/" → "/". Navigation in another form is kept whole. */
const screenIn = (message: string) => (message.includes("→") ? message.split("→").pop()!.trim() : message.trim());

/** A tap, named by its label or testID (the SDK's touch capture), or by its message ("Tapped …", "Clicked …"). */
function tapOf(t: TimelineItem): string | undefined {
  if (t.category !== "ui") return undefined;
  const label = typeof t.data?.label === "string" && t.data.label ? t.data.label : undefined;
  const testID = typeof t.data?.testID === "string" && t.data.testID ? t.data.testID : undefined;
  if (label) return `Tapped "${label}"`;
  if (testID) return `Tapped ${testID}`;
  return /^(Tapped|Clicked) /.test(t.message) ? t.message : undefined;
}

/* ---------- What broke */

/**
 * What the error points at, decided once: the failed call (an error with a request), else the
 * first frame in the app's own code, mapped to a source file or still in the built bundle.
 * A crash that happens to follow a failed call is still a crash: only the error's own request
 * makes it a call (so failedRequest's "last failing call" fallback isn't used here).
 */
type Culprit =
  | { kind: "call"; call: ApiCall; host: string }
  | { kind: "code"; frame: StackFrame & { file: string }; fn?: string; mapped: boolean }
  | { kind: "none"; hasFrames: boolean };

/** RN bundles only: a web or Node frame isn't recognised as unmapped (frames.ts leaves those alone too). */
function culpritOf(ev: ErrorEvent, trail: readonly TimelineItem[], hosts: readonly HostName[]): Culprit {
  if (ev.request) return { kind: "call", call: failedRequest(ev.request, trail, hosts)!, host: hostOf(ev.request.url) };
  const frame = ev.error.frames?.find((f): f is StackFrame & { file: string } => !!f.inApp && !!f.file);
  if (frame) return { kind: "code", frame, fn: cleanFnName(frame.fn), mapped: !RN_BUNDLE.test(frame.file) };
  return { kind: "none", hasFrames: !!ev.error.frames?.length };
}

const NO_SOURCE_MAPS = "Not source-mapped: upload source maps for this build to see the file and line.";

/** "08:31:44 UTC" for the logs, which are rarely in the phone's timezone. */
export function utcTime(ts: string): string {
  const t = new Date(ts);
  return Number.isNaN(t.getTime()) ? ts : `${t.toISOString().slice(11, 19)} UTC`;
}

export const callLine = (c: ApiCall, withService = true) => `${withService && c.service ? `${c.service} · ` : ""}${c.method ?? ""} ${c.path ?? ""}`.replace(/\s+/g, " ").trim();

function failingHop(ev: ErrorEvent, c: Culprit, hosts: readonly HostName[]): Hop {
  const errorLine = () => nameUrlsIn(`${ev.error.name}: ${ev.error.message}`, hosts);
  switch (c.kind) {
    case "call":
      return { kind: "failing", value: `${callLine(c.call)} → ${c.call.status ?? "no answer"}` };
    case "code": {
      const file = `${c.frame.file.split("/").pop()}${c.frame.line ? `:${c.frame.line}` : ""}`;
      if (c.mapped) return { kind: "failing", value: `${c.fn ? `${c.fn} at ` : ""}${file}` };
      return c.fn ? { kind: "failing", value: `${c.fn} (not source-mapped)` } : { kind: "failing", missing: true, ask: NO_SOURCE_MAPS };
    }
    case "none":
      return c.hasFrames ? { kind: "failing", missing: true, ask: "No frame in the app's own code: upload source maps for this build to see the file and line." } : { kind: "failing", value: errorLine() };
  }
}

function sourceHop(ev: ErrorEvent, c: Culprit): Hop {
  switch (c.kind) {
    case "call": {
      const response = exchangeOf(ev)?.response;
      // Unnamed in Settings: the host itself, which is what its logs are filed under.
      const service = c.call.service ?? (c.host || "the backend");
      const trace = traceOf(response?.headers, response?.body, c.call);
      if (trace) return { kind: "source", value: `${service} · ${trace.from} ${trace.id}` };
      const code = c.call.backendCode ?? idsInBody(response?.body).code;
      if (code) return { kind: "source", value: `${service} · code ${code}` };
      return { kind: "source", missing: true, ask: `No trace id in this response: search the ${service} logs for ${callLine(c.call, false)} at ${utcTime(ev.ts)}.` };
    }
    case "code":
      return c.mapped ? { kind: "source", value: c.frame.file } : { kind: "source", missing: true, ask: NO_SOURCE_MAPS };
    case "none":
      return { kind: "source", missing: true, ask: "No app frame in the stack: the error came from a library or the runtime. Look at the customer's step just before it." };
  }
}

/* ---------- Putting it together */

export function whereOf(ev: ErrorEvent, opts: WhereOptions = {}): Where {
  const hosts = opts.hosts ?? [];
  // At or before the error. A breadcrumb in the same millisecond is taken as before it: the SDK
  // records the failing call's breadcrumb as it fails, so that one belongs.
  const errorAt = Date.parse(ev.ts);
  const trail = timelineOf(ev.breadcrumbs, hosts).filter((t) => !(Date.parse(t.ts) > errorAt));
  const nav = lastWhere(trail, (t) => t.category === "navigation");
  const screen = nav ? screenIn(nav.message) : undefined;
  const tap = lastWhere(trail, (t) => !!tapOf(t));
  const journey = ev.flow ?? (screen ? opts.journeyOf?.(screen) : undefined);
  const culprit = culpritOf(ev, trail, hosts);

  const hops: Hop[] = [
    journey ? { kind: "journey", value: journey } : { kind: "journey", missing: true, ask: "No journey: the app sent no flow, and this screen isn't mapped to a journey yet." },
    screen ? { kind: "screen", value: screen } : { kind: "screen", missing: true, ask: "No screen recorded before the error: the trail has no navigation (an SDK before 0.8, or the error came before the first screen)." },
    tap ? { kind: "action", value: tapOf(tap)! } : { kind: "action", missing: true, ask: "No tap recorded before the error." },
    failingHop(ev, culprit, hosts),
    sourceHop(ev, culprit),
  ];
  const line = hops
    .filter((h) => h.kind !== "source")
    .flatMap((h) => (h.missing ? [] : [h.value]))
    .join(" › ");
  return { hops, line };
}
