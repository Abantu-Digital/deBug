import { cleanFnName, nameUrlsIn, RN_BUNDLE, type ErrorEvent, type HostName, type StackFrame } from "@debugkit/schema";
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
  hops: Hop[];
  /** One line for list rows: the hops that have a value, joined by " › ". */
  line: string;
}

export interface WhereOptions {
  hosts?: readonly HostName[];
  /** A screen's journey (ABA-135); without it, only the flow the app sent names the journey. */
  journeyOf?: (screen: string) => string | undefined;
}

/** Response headers that carry a trace or request id, best first. */
const TRACE_HEADERS = ["traceparent", "x-cloud-trace-context", "x-amzn-trace-id", "x-request-id", "x-amzn-requestid", "x-correlation-id", "request-id"] as const;

/** The trace id inside a header value: W3C traceparent's second field, Cloud Trace's part before "/". */
export function traceIdIn(header: string, value: string): string {
  if (header === "traceparent") return value.split("-")[1] || value;
  if (header === "x-cloud-trace-context") return value.split("/")[0] || value;
  return value;
}

/** The trace id the backend already sent, from the response headers or the app's breadcrumb. */
export function traceOf(headers: Readonly<Record<string, string>> | undefined, call: ApiCall | undefined): { header: string; id: string } | undefined {
  for (const h of TRACE_HEADERS) {
    const v = headers?.[h];
    if (v && v !== "[redacted]") return { header: h, id: traceIdIn(h, v) };
  }
  if (call?.traceId) return { header: "traceId", id: call.traceId };
  return undefined;
}

/** "A → B" → "B"; "/" → "/". */
const screenIn = (message: string) => message.split("→").pop()!.trim();

const before = (items: readonly TimelineItem[], ts: string) => items.filter((t) => Date.parse(t.ts) <= Date.parse(ts));

const lastScreen = (items: readonly TimelineItem[]) => [...items].reverse().find((t) => t.category === "navigation");

const lastTap = (items: readonly TimelineItem[]) => [...items].reverse().find((t) => t.category === "ui" && /^(Tapped|Clicked) /.test(t.message));

/** The first frame in the app's own code, which source maps turn into a file and line. */
const appFrame = (frames: readonly StackFrame[] = []) => frames.find((f) => f.inApp && f.file);

const fileOf = (f: StackFrame) => `${f.file!.split("/").pop()}${f.line ? `:${f.line}` : ""}`;

/** A frame still pointing into the built bundle (main.jsbundle:358444): source maps weren't applied. */
const unmapped = (f: StackFrame) => RN_BUNDLE.test(f.file!);

/** "?anon_0_fetchUpdateInfo" → "fetchUpdateInfo". */
const fnOf = (f: StackFrame) => cleanFnName(f.fn);

const NO_SOURCE_MAPS = "Not source-mapped: upload source maps for this build to see the file and line.";

/** "08:31:44 UTC" for the logs, which are rarely in the phone's timezone. */
const utcTime = (ts: string) => `${new Date(ts).toISOString().slice(11, 19)} UTC`;

const callLine = (c: ApiCall) => `${c.service ? `${c.service} · ` : ""}${c.method ?? ""} ${c.path ?? ""}`.replace(/\s+/g, " ").trim();

export function whereOf(ev: ErrorEvent, opts: WhereOptions = {}): Where {
  const hosts = opts.hosts ?? [];
  const trail = before(timelineOf(ev.breadcrumbs, hosts), ev.ts);
  const screen = lastScreen(trail);
  const screenName = screen ? screenIn(screen.message) : undefined;
  const call = ev.request ? failedRequest(ev.request, trail, hosts) : undefined;
  const frame = appFrame(ev.error.frames);

  const journey = ev.flow ?? (screenName ? opts.journeyOf?.(screenName) : undefined);
  const tap = lastTap(trail);
  const hops: Hop[] = [
    journey ? { kind: "journey", value: journey } : { kind: "journey", missing: true, ask: "No journey: the app sent no flow, and this screen isn't mapped to a journey yet." },
    screenName ? { kind: "screen", value: screenName } : { kind: "screen", missing: true, ask: "No screen recorded before the error: the trail has no navigation (an SDK before 0.8, or the error came before the first screen)." },
    tap ? { kind: "action", value: tap.message } : { kind: "action", missing: true, ask: "No tap recorded before the error." },
    failingHop(ev, call, frame, hosts),
    sourceHop(ev, call, frame),
  ];
  return { hops, line: hops.flatMap((h) => (h.missing ? [] : [h.value])).join(" › ") };
}

function failingHop(ev: ErrorEvent, call: ApiCall | undefined, frame: StackFrame | undefined, hosts: readonly HostName[]): Hop {
  if (call) return { kind: "failing", value: `${callLine(call)} → ${call.status ?? "no answer"}` };
  if (frame && unmapped(frame)) return { kind: "failing", value: fnOf(frame) ? `${fnOf(frame)} (in the built bundle)` : nameUrlsIn(`${ev.error.name}: ${ev.error.message}`, hosts) };
  if (frame) return { kind: "failing", value: `${fnOf(frame) ? `${fnOf(frame)} at ` : ""}${fileOf(frame)}` };
  if (ev.error.frames?.length) return { kind: "failing", missing: true, ask: "No frame in the app's own code: upload source maps for this build to see the file and line." };
  return { kind: "failing", value: nameUrlsIn(`${ev.error.name}: ${ev.error.message}`, hosts) };
}

function sourceHop(ev: ErrorEvent, call: ApiCall | undefined, frame: StackFrame | undefined): Hop {
  if (call) {
    const trace = traceOf(exchangeOf(ev)?.response?.headers, call);
    // Unnamed in Settings: the host itself, which is what its logs are filed under.
    const service = call.service ?? call.path?.match(/^[\w.-]+\.\w+(?=\/)/)?.[0] ?? "the backend";
    if (trace) return { kind: "source", value: `${service} · ${trace.header} ${trace.id}` };
    if (call.backendCode) return { kind: "source", value: `${service} · code ${call.backendCode}` };
    return { kind: "source", missing: true, ask: `No trace id in this response: search the ${service} logs for ${callLine({ ...call, service: undefined })} at ${utcTime(ev.ts)}.` };
  }
  if (frame && unmapped(frame)) return { kind: "source", missing: true, ask: NO_SOURCE_MAPS };
  if (frame) return { kind: "source", value: frame.file! };
  return { kind: "source", missing: true, ask: "No app frame in the stack: the error came from a library or the runtime. Follow the trail above to the step before it." };
}
