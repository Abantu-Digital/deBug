import { hostOf, type ErrorEvent, type HostName } from "@debugkit/schema";
import { BACKGROUND, FOREGROUND } from "@debugkit/ingest";
import { exchangeOf } from "./exchange";
import { failedRequest, timelineOf, type ApiCall, type TimelineItem } from "./event";
import { seconds } from "./explain";
import { callLine, traceOf, utcTime } from "./hops";

/**
 * Specific fix advice from patterns in the customer's trail (ABA-146): rule-based, no AI. Each
 * finding says what happened, what to do, and the evidence it read, so it can be checked.
 *
 * No backend changes (ABA-137): a fix may tell the app team what to change, or say where to look
 * in the backend's logs (time, call, trace id). It never tells anyone to change their backend.
 *
 * Not detected: a call still running when the app crashed. Breadcrumbs are written when a call
 * ends, so one that never answered isn't in the trail (needs the SDK to record request starts).
 */
export const FINDING_IDS = ["repeat_failed", "duplicate_call", "called_before_login", "no_refresh_before_401", "hung_in_background", "expected_answer"] as const;
export type FindingId = (typeof FINDING_IDS)[number];

export interface Finding {
  id: FindingId;
  /** What the trail shows, in plain words. */
  why: string;
  /** What to do about it. */
  fix: string;
  /** The breadcrumbs or calls it read (times in UTC), so a person can check it. */
  evidence: string[];
  /** How many of the occurrences read show it, and how many were read. */
  seen: number;
  of: number;
}

/** A finding before it's counted across occurrences. */
type Draft = Omit<Finding, "id" | "seen" | "of">;

/** Two sends of one call this close together are one action sending it twice. */
const DUPLICATE_WINDOW_MS = 5_000;
/** A success this recent, then a failure of the same call, is "the repeat failed". */
const REPEAT_WINDOW_MS = 60_000;
/** Longer than this in the background and a session token has usually expired. */
const LONG_BACKGROUND_MS = 30 * 60_000;
/** A timeout this short isn't a request left hanging. */
const HUNG_MIN_MS = 5_000;
/** At least this many calls, all with one status, before it looks like the endpoint's normal answer. */
const EXPECTED_MIN_CALLS = 3;
/** Occurrences read, newest first. */
export const DETECTOR_LOOKBACK = 20;

const ms = (ts: string) => Date.parse(ts);
const isOk = (s?: number) => s !== undefined && s >= 200 && s < 300;
/** "08:31:42.729 UTC", like the log search times (hops.ts utcTime). */
const clock = (t: number) => (Number.isNaN(t) ? "?" : `${new Date(t).toISOString().slice(11, 23)} UTC`);

/* ---------- Calls in the trail */

/** The path of a stored URL, without host, port, query or hash: "host:443/ppd/x?y" → "/ppd/x". */
function pathOf(url: string): string {
  const bare = url.split(/[?#]/)[0]!.replace(/^[a-z]+:\/\//i, "");
  const host = hostOf(bare);
  const rest = host ? bare.slice(bare.indexOf("/") < 0 ? bare.length : bare.indexOf("/")) : bare;
  return rest.startsWith("/") ? rest : `/${rest}`;
}

/**
 * Whether a breadcrumb's call is the error's endpoint. Same method; same host when the breadcrumb
 * names one; and the same path, or the app's path relative to its base URL ("/notifications/x"
 * under "/ppd/api") ending the request's path on whole segments, at least two of them.
 */
function sameEndpoint(api: ApiCall | undefined, req: NonNullable<ErrorEvent["request"]>): api is ApiCall {
  if (!api?.path || api.method !== req.method.toUpperCase()) return false;
  const host = hostOf(api.path);
  if (host && host !== hostOf(req.url)) return false;
  const want = pathOf(req.url);
  const have = pathOf(api.path);
  if (have === want) return true;
  return !host && have.split("/").length >= 3 && want.endsWith(have);
}

/** When the call was sent: its end minus its duration (from the data, or the SDK's "(120ms)"). */
function sentAt(t: TimelineItem): number {
  const took = t.api?.durationMs ?? Number(/\((\d+) ?ms\)/.exec(t.message)?.[1] ?? 0);
  return ms(t.ts) - took;
}

/** A login that finished: the app's "Login Completed" or "Logged in", or a 2xx from a login call. */
const isLogin = (t: TimelineItem) =>
  (t.category === "event" && /^(log ?in (completed|succeeded|success)|logged in)$/i.test(t.message.trim())) ||
  (!!t.api && isOk(t.api.status) && /\/(login|sign-?in)$/i.test(pathOf(t.api.path ?? "")));

/** A token refresh that worked. */
const isRefresh = (t: TimelineItem) => !!t.api && isOk(t.api.status) && /\/(refresh|refresh-token|token\/refresh|oauth\/token)$/i.test(pathOf(t.api.path ?? ""));

const isRetry = (c: ApiCall | undefined) => c?.retry === true || (typeof c?.retry === "number" && c.retry > 0) || (typeof c?.retry === "string" && /^[1-9]/.test(c.retry));

interface Read {
  ev: ErrorEvent;
  /** Breadcrumbs at or before the error. */
  trail: TimelineItem[];
  /** The failed call, named; undefined for errors that aren't a request. */
  call?: ApiCall;
  /** The error's own call in the trail, when it's there. */
  own?: TimelineItem;
  /** Calls to the same endpoint before the failing one, oldest first. */
  earlier: TimelineItem[];
  /** When the failing call was sent. */
  sent: number;
}

function read(ev: ErrorEvent, hosts: readonly HostName[]): Read {
  const at = ms(ev.ts);
  const trail = timelineOf(ev.breadcrumbs, hosts).filter((t) => !(ms(t.ts) > at));
  const sent = at - (ev.request?.durationMs ?? 0);
  if (!ev.request) return { ev, trail, earlier: [], sent };
  const req = ev.request;
  const same = trail.filter((t) => sameEndpoint(t.api, req));
  // The last matching failed breadcrumb is this error's own call.
  let i = same.length - 1;
  while (i >= 0 && !same[i]!.api!.failed) i--;
  return { ev, trail, call: failedRequest(req, trail, hosts), own: same[i], earlier: i < 0 ? same : same.slice(0, i), sent };
}

const statusOf = (t: TimelineItem) => t.api!.status ?? t.api!.outcome ?? "no answer";

/* ---------- The detectors, best first */

/** Whether one action sent the error's call more than once: the send before it is close, and it isn't the app's own retry. */
function sentTwice(r: Read): TimelineItem[] {
  if (isRetry(r.own?.api)) return [];
  return r.earlier.filter((t) => r.sent - sentAt(t) <= DUPLICATE_WINDOW_MS && !isRetry(t.api));
}

const DETECTORS: Record<Exclude<FindingId, "expected_answer">, (r: Read) => Draft | undefined> = {
  repeat_failed: (r) => {
    const failed = r.ev.request?.status;
    if (!r.call || failed === undefined || !(failed >= 500 || failed === 409)) return undefined;
    const ok = [...r.earlier].reverse().find((t) => isOk(t.api!.status) && r.sent - sentAt(t) <= REPEAT_WINDOW_MS);
    if (!ok) return undefined;
    const response = exchangeOf(r.ev)?.response;
    const trace = traceOf(response?.headers, response?.body, r.call);
    const service = r.call.service ?? (hostOf(r.ev.request!.url) || "backend");
    const where = trace ? `trace id ${trace.id} (${trace.from})` : `${callLine(r.call, false)} sent at ${utcTime(new Date(r.sent).toISOString())}`;
    const overlapped = r.sent < ms(ok.ts);
    const twice = sentTwice(r).length > 0;
    return {
      why: overlapped
        ? `The app sent it again before the first call answered; the first worked (${ok.api!.status}), the repeat failed (${failed}).`
        : `The first call worked (${ok.api!.status}); the repeat ${seconds(r.sent - sentAt(ok))} later failed (${failed}).`,
      fix: `${twice ? "App: send it once per action. " : ""}To see why the repeat failed, search the ${service} logs for ${where}.`,
      evidence: [`${clock(sentAt(ok))} sent, ${clock(ms(ok.ts))} → ${ok.api!.status}`, `${clock(r.sent)} sent, ${clock(ms(r.ev.ts))} → ${failed}`],
    };
  },

  duplicate_call: (r) => {
    const close = sentTwice(r);
    if (!r.call || !close.length) return undefined;
    return {
      why: `The app sends ${callLine(r.call)} ${close.length + 1} times in ${seconds(r.sent - sentAt(close[0]!))}.`,
      fix: "App: send it once per action. Look for two screens or effects that both trigger it.",
      evidence: [...close.map((t) => `${clock(sentAt(t))} sent → ${statusOf(t)}`), `${clock(r.sent)} sent → ${r.ev.request!.status ?? "no answer"}`],
    };
  },

  called_before_login: (r) => {
    if (!r.call) return undefined;
    const denied = r.earlier.filter((t) => t.api!.status === 401 || t.api!.status === 403);
    if (!denied.length) return undefined;
    const lastDenied = ms(denied[denied.length - 1]!.ts);
    const login = r.trail.find((t) => ms(t.ts) > lastDenied && ms(t.ts) <= r.sent && isLogin(t));
    if (!login) return undefined;
    const codes = [...new Set(denied.map((t) => t.api!.status))].join(" or ");
    return {
      why: `${callLine(r.call)} ran ${denied.length} time${denied.length === 1 ? "" : "s"} before login and got ${codes}.`,
      fix: "App: wait until login has finished before making this call.",
      evidence: [...denied.map((t) => `${clock(ms(t.ts))} → ${t.api!.status}`), `${clock(ms(login.ts))} ${login.message}`],
    };
  },

  no_refresh_before_401: (r) => {
    if (!r.call || r.ev.request?.status !== 401) return undefined;
    const lifecycle = r.trail.filter((t) => t.message === FOREGROUND || t.message === BACKGROUND);
    const fore = lifecycle[lifecycle.length - 1];
    const back = lifecycle[lifecycle.length - 2];
    // The app must be in the foreground now, having come back from a long time away.
    if (fore?.message !== FOREGROUND || back?.message !== BACKGROUND || ms(fore.ts) - ms(back.ts) < LONG_BACKGROUND_MS) return undefined;
    if (r.trail.some((t) => ms(t.ts) >= ms(fore.ts) && isRefresh(t))) return undefined;
    return {
      why: `The app came back after ${Math.round((ms(fore.ts) - ms(back.ts)) / 60_000)} min in the background and called ${callLine(r.call)} without refreshing its token.`,
      fix: "App: refresh the session token when the app comes back, before other calls.",
      evidence: [`${clock(ms(back.ts))} ${back.message}`, `${clock(ms(fore.ts))} ${fore.message}`, `${clock(ms(r.ev.ts))} → 401`],
    };
  },

  hung_in_background: (r) => {
    const req = r.ev.request;
    if (!r.call || !req || req.status !== undefined || req.durationMs === undefined || req.durationMs < HUNG_MIN_MS) return undefined;
    if (!/timed out/i.test(r.ev.error.message)) return undefined;
    const bg = r.trail.find((t) => t.message === BACKGROUND && ms(t.ts) >= r.sent && ms(t.ts) <= ms(r.ev.ts));
    if (!bg) return undefined;
    return {
      why: `${callLine(r.call)} was still running when the app went to the background, and gave up after ${seconds(req.durationMs)}.`,
      fix: "App: send it before the app goes to the background, or retry it when the app comes back.",
      evidence: [`${clock(r.sent)} sent (from its duration)`, `${clock(ms(bg.ts))} ${bg.message}`, `${clock(ms(r.ev.ts))} → no answer`],
    };
  },
};

/**
 * A 4xx an endpoint gives on every call can be its normal answer ("no update", "not found"). A
 * 5xx every time is an outage, and 401, 403 and 429 mean something to act on: never "expected".
 */
const MAYBE_EXPECTED = (s: number) => s >= 400 && s < 500 && s !== 401 && s !== 403 && s !== 429;

/** Every call to the newest occurrence's endpoint, across these trails, answered the same 4xx. */
function expectedAnswer(reads: readonly Read[]): { draft: Draft; seen: number } | undefined {
  const head = reads.find((r) => r.call && r.ev.request?.status !== undefined);
  const status = head?.ev.request?.status;
  if (!head || status === undefined || !MAYBE_EXPECTED(status)) return undefined;
  // Trails from one session overlap: count each call once.
  const calls = new Map<string, TimelineItem>();
  let seen = 0;
  for (const r of reads) {
    const mine = r.trail.filter((t) => sameEndpoint(t.api, head.ev.request!));
    if (mine.length) seen++;
    for (const t of mine) calls.set(`${t.ts}|${t.api!.status}`, t);
  }
  const all = [...calls.values()];
  if (all.length < EXPECTED_MIN_CALLS || !all.every((t) => t.api!.status === status)) return undefined;
  return {
    seen,
    draft: {
      why: `Every call to ${callLine(head.call!)} in these trails answered ${status} (${all.length} of ${all.length}).`,
      fix: `If ${status} is this endpoint's normal answer, mark it as expected so it stops counting.`,
      evidence: all.slice(-5).map((t) => `${clock(ms(t.ts))} → ${t.api!.status}`),
    },
  };
}

/**
 * What the trails of an issue's recent occurrences show, best first. Reads the newest
 * DETECTOR_LOOKBACK error events; each finding keeps the newest occurrence's wording and evidence
 * and counts how many of them show it. When the repeat-failed finding already says "send it
 * once", the duplicate-call finding isn't listed again.
 */
export function findingsOf(events: readonly ErrorEvent[], hosts: readonly HostName[] = []): Finding[] {
  const reads = [...events].sort((a, b) => ms(b.ts) - ms(a.ts)).slice(0, DETECTOR_LOOKBACK).map((ev) => read(ev, hosts));
  const found = new Map<FindingId, Finding>();
  for (const r of reads) {
    for (const [id, detect] of Object.entries(DETECTORS) as [Exclude<FindingId, "expected_answer">, (r: Read) => Draft | undefined][]) {
      const draft = detect(r);
      if (!draft) continue;
      const had = found.get(id);
      if (had) had.seen++;
      else found.set(id, { id, ...draft, seen: 1, of: reads.length });
    }
  }
  if (found.get("repeat_failed")?.fix.startsWith("App: send it once")) found.delete("duplicate_call");
  const expected = expectedAnswer(reads);
  if (expected) found.set("expected_answer", { id: "expected_answer", ...expected.draft, seen: expected.seen, of: reads.length });
  return FINDING_IDS.flatMap((id) => (found.has(id) ? [found.get(id)!] : []));
}
