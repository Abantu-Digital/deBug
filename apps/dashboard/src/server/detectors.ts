import { hostOf, type ErrorEvent, type HostName } from "@debugkit/schema";
import { exchangeOf } from "./exchange";
import { failedRequest, timelineOf, type ApiCall, type TimelineItem } from "./event";
import { callLine, traceOf, utcTime } from "./hops";

/**
 * Specific fix advice from patterns in the customer's trail (ABA-146): rule-based, no AI. Each
 * finding says what happened, what to do, and the evidence it read, so it can be checked.
 *
 * No backend changes (ABA-137): a fix may tell the app team what to change, or say where to look
 * in the backend's logs (time, call, trace id). It never tells anyone to change their backend.
 */
export type FindingId = "success_then_failure" | "duplicate_call" | "called_before_login" | "no_refresh_before_401" | "hung_in_background" | "expected_answer";

export interface Finding {
  id: FindingId;
  /** What the trail shows, in plain words. */
  why: string;
  /** What to do about it. */
  fix: string;
  /** The breadcrumbs or calls it read, so a person can check it. */
  evidence: string[];
  /** How many of the occurrences read show it, and how many were read. */
  seen: number;
  of: number;
}

/** Two calls closer than this are one action sending it twice. */
const DUPLICATE_WINDOW_MS = 5_000;
/** Longer than this in the background and a session token has usually expired. */
const LONG_BACKGROUND_MS = 30 * 60_000;
/** At least this many calls, all with one status, before it looks like the endpoint's normal answer. */
const EXPECTED_MIN_CALLS = 3;
/** Occurrences read, newest first. */
export const DETECTOR_LOOKBACK = 20;

const ORDER: FindingId[] = ["success_then_failure", "duplicate_call", "called_before_login", "no_refresh_before_401", "hung_in_background", "expected_answer"];

const ms = (ts: string) => Date.parse(ts);
const secs = (n: number) => (n < 1000 ? "under a second" : `${Math.round(n / 1000)} s`);
const mins = (n: number) => `${Math.round(n / 60_000)} min`;
const isOk = (s?: number) => s !== undefined && s >= 200 && s < 300;
const clock = (ts: string) => new Date(ts).toISOString().slice(11, 23);

/** The path part of a stored URL: "host/ppd/api/x" → "/ppd/api/x"; "/x" stays. */
const pathOf = (url: string) => {
  const bare = url.split(/[?#]/)[0]!.replace(/^[a-z]+:\/\//i, "");
  const host = hostOf(bare);
  return host ? bare.slice(bare.toLowerCase().indexOf(host) + host.length).replace(/^:\d+/, "") || "/" : bare;
};

/** Whether a breadcrumb's call is the same endpoint as the error's request (method and path). */
function sameCall(api: ApiCall | undefined, req: NonNullable<ErrorEvent["request"]>): api is ApiCall {
  if (!api?.path || api.method !== req.method.toUpperCase()) return false;
  const want = pathOf(req.url);
  const have = pathOf(api.path);
  return have === want || want.endsWith(have) || have.endsWith(want);
}

/** A login that worked: the app's "Login Completed" event, or a 2xx from a login call. */
const isLogin = (t: TimelineItem) => (t.category === "event" && /log ?in/i.test(t.message) && !/fail/i.test(t.message)) || (!!t.api && isOk(t.api.status) && /\/login(\/login)?$|\/sign-?in$/i.test(pathOf(t.api.path ?? "")));

interface Read {
  ev: ErrorEvent;
  /** Breadcrumbs at or before the error. */
  trail: TimelineItem[];
  /** The failed call, named; undefined for errors that aren't a request. */
  call?: ApiCall;
  /** Calls to the same endpoint before the failing one, oldest first. */
  earlier: TimelineItem[];
}

function read(ev: ErrorEvent, hosts: readonly HostName[]): Read {
  const at = ms(ev.ts);
  const trail = timelineOf(ev.breadcrumbs, hosts).filter((t) => !(ms(t.ts) > at));
  if (!ev.request) return { ev, trail, earlier: [] };
  const req = ev.request;
  const same = trail.filter((t) => sameCall(t.api, req));
  // The last matching failed breadcrumb is this error's own call.
  let own = -1;
  for (let i = same.length - 1; i >= 0; i--) if (same[i]!.api!.failed) { own = i; break; }
  return { ev, trail, call: failedRequest(req, trail, hosts), earlier: own < 0 ? same : same.slice(0, own) };
}

type Detect = (r: Read) => Omit<Finding, "seen" | "of" | "id"> | undefined;

const DETECTORS: Record<Exclude<FindingId, "expected_answer">, Detect> = {
  success_then_failure: ({ ev, call, earlier }) => {
    const failed = ev.request?.status;
    if (!call || failed === undefined || !(failed >= 500 || failed === 409)) return undefined;
    const ok = [...earlier].reverse().find((t) => isOk(t.api!.status) && ms(ev.ts) - ms(t.ts) <= DUPLICATE_WINDOW_MS);
    if (!ok) return undefined;
    const response = exchangeOf(ev)?.response;
    const trace = traceOf(response?.headers, response?.body, call);
    const where = trace ? `trace id ${trace.id} (${trace.from})` : `${callLine(call, false)} at ${utcTime(ev.ts)}`;
    return {
      why: `The first call worked (${ok.api!.status}); the repeat ${secs(ms(ev.ts) - ms(ok.ts))} later failed (${failed}).`,
      fix: `To see why the repeat failed, search the ${call.service ?? (hostOf(ev.request!.url) || "backend")} logs for ${where}.`,
      evidence: [`${clock(ok.ts)} ${callLine(call)} → ${ok.api!.status}`, `${clock(ev.ts)} ${callLine(call)} → ${failed}`],
    };
  },

  duplicate_call: ({ ev, call, earlier }) => {
    const close = earlier.filter((t) => ms(ev.ts) - ms(t.ts) <= DUPLICATE_WINDOW_MS);
    if (!call || !close.length) return undefined;
    return {
      why: `The app sends ${callLine(call)} ${close.length + 1} times in ${secs(ms(ev.ts) - ms(close[0]!.ts))}.`,
      fix: "App: send it once per action. Look for two screens or effects that both trigger it.",
      evidence: [...close.map((t) => `${clock(t.ts)} → ${t.api!.status ?? t.api!.outcome ?? "no answer"}`), `${clock(ev.ts)} → ${ev.request!.status ?? "no answer"}`],
    };
  },

  called_before_login: ({ ev, call, earlier, trail }) => {
    if (!call) return undefined;
    const denied = earlier.filter((t) => t.api!.status === 401 || t.api!.status === 403);
    if (!denied.length) return undefined;
    const lastDenied = ms(denied[denied.length - 1]!.ts);
    const login = trail.find((t) => ms(t.ts) > lastDenied && ms(t.ts) <= ms(ev.ts) && isLogin(t));
    if (!login) return undefined;
    return {
      why: `${callLine(call)} ran ${denied.length} time${denied.length === 1 ? "" : "s"} before login and got ${denied[0]!.api!.status}.`,
      fix: "App: wait until login has finished before making this call.",
      evidence: [...denied.map((t) => `${clock(t.ts)} → ${t.api!.status}`), `${clock(login.ts)} ${login.message}`],
    };
  },

  no_refresh_before_401: ({ ev, call, trail }) => {
    if (!call || ev.request?.status !== 401) return undefined;
    let back: TimelineItem | undefined;
    let fore: TimelineItem | undefined;
    for (let i = trail.length - 1; i >= 0 && !back; i--) {
      const t = trail[i]!;
      if (!fore && /came to the foreground/i.test(t.message)) fore = t;
      else if (fore && /went to the background/i.test(t.message)) back = t;
    }
    if (!fore || !back || ms(fore.ts) - ms(back.ts) < LONG_BACKGROUND_MS) return undefined;
    const refreshed = trail.some((t) => ms(t.ts) >= ms(fore!.ts) && /refresh|token/i.test(t.api?.path ?? ""));
    if (refreshed) return undefined;
    return {
      why: `The app came back after ${mins(ms(fore.ts) - ms(back.ts))} in the background and called ${callLine(call)} without refreshing its token.`,
      fix: "App: refresh the session token when the app comes back, before other calls.",
      evidence: [`${clock(back.ts)} ${back.message}`, `${clock(fore.ts)} ${fore.message}`, `${clock(ev.ts)} → 401`],
    };
  },

  hung_in_background: ({ ev, call, trail }) => {
    const r = ev.request;
    if (!call || !r || r.status !== undefined || r.durationMs === undefined) return undefined;
    const start = ms(ev.ts) - r.durationMs;
    const bg = trail.find((t) => /went to the background/i.test(t.message) && ms(t.ts) >= start && ms(t.ts) <= ms(ev.ts));
    if (!bg) return undefined;
    return {
      why: `${callLine(call)} was still running when the app went to the background, and gave up after ${secs(r.durationMs)}.`,
      fix: "App: send it before the app goes to the background, or retry it when the app comes back.",
      evidence: [`${clock(new Date(start).toISOString())} sent`, `${clock(bg.ts)} ${bg.message}`, `${clock(ev.ts)} → no answer after ${secs(r.durationMs)}`],
    };
  },
};

/**
 * A 4xx an endpoint gives on every call can be its normal answer ("no update", "not found"). A
 * 5xx every time is an outage, and 401, 403 and 429 mean something to act on: never "expected".
 */
const MAYBE_EXPECTED = (s: number) => s >= 400 && s < 500 && s !== 401 && s !== 403 && s !== 429;

/** Every call to the failing endpoint in these trails answered the same 4xx. */
function expectedAnswer(reads: readonly Read[]): Omit<Finding, "id" | "seen" | "of"> | undefined {
  const head = reads.find((r) => r.call && r.ev.request?.status !== undefined);
  const status = head?.ev.request?.status;
  if (!head || status === undefined || !MAYBE_EXPECTED(status)) return undefined;
  const calls = reads.flatMap((r) => r.trail.filter((t) => sameCall(t.api, head.ev.request!)));
  if (calls.length < EXPECTED_MIN_CALLS || !calls.every((t) => t.api!.status === status)) return undefined;
  return {
    why: `Every call to ${callLine(head.call!)} in these trails answered ${status} (${calls.length} of ${calls.length}).`,
    fix: `If ${status} is this endpoint's normal answer, mark it as expected so it stops counting.`,
    evidence: calls.slice(-5).map((t) => `${clock(t.ts)} → ${t.api!.status}`),
  };
}

/**
 * What the trails of an issue's recent occurrences show, best first. Reads the newest
 * DETECTOR_LOOKBACK error events; each finding keeps the newest occurrence's wording and evidence
 * and counts how many of them show it.
 */
export function findingsOf(events: readonly ErrorEvent[], hosts: readonly HostName[] = []): Finding[] {
  const reads = [...events].sort((a, b) => ms(b.ts) - ms(a.ts)).slice(0, DETECTOR_LOOKBACK).map((ev) => read(ev, hosts));
  const found = new Map<FindingId, Finding>();
  for (const r of reads) {
    for (const [id, detect] of Object.entries(DETECTORS) as [FindingId, Detect][]) {
      const f = detect(r);
      if (!f) continue;
      const had = found.get(id);
      if (had) had.seen++;
      else found.set(id, { id, ...f, seen: 1, of: reads.length });
    }
  }
  const expected = expectedAnswer(reads);
  if (expected) found.set("expected_answer", { id: "expected_answer", ...expected, seen: reads.length, of: reads.length });
  return ORDER.flatMap((id) => (found.has(id) ? [found.get(id)!] : []));
}
