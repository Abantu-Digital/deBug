import type { ApiCall, EventDetail, TimelineItem } from "~/server/event";

/**
 * A plain-language account of one failure, for support: who, where they went, what they tapped,
 * what the backend said, what they saw and what they did next. Built from the trail alone, so it
 * says only what was recorded. For example:
 *
 *   10:42 · Customer 084•••4567 on Android 15, app 10.1.28. Went Dashboard → Buy → Checkout,
 *   tapped "Pay". The payments service answered 402 "Insufficient funds" (trace 4f2c…). They saw
 *   "Payment failed" and went back to Buy.
 */
export interface SupportSummary {
  /** The sentences, in order. */
  sentences: string[];
  /** The screens they went through before the failure, oldest first (at most 5). */
  screens: string[];
  /** What the app showed them, when it was recorded. */
  saw?: string;
}

type Input = Pick<EventDetail, "ts" | "user" | "context" | "timeline" | "request" | "error" | "handled"> & { after?: TimelineItem[] };

const MAX_SCREENS = 5;

/** 084•••4567: enough to confirm with the caller, not enough to copy around. */
export function maskCustomer(id: string): string {
  if (/^[+\d\s\-()]+$/.test(id)) {
    const digits = id.replace(/\D/g, "");
    // As South Africans write it: 27841234567 is 0841234567.
    const local = /^27\d{9}$/.test(digits) ? `0${digits.slice(2)}` : digits;
    if (local.length >= 8) return `${local.slice(0, 3)}•••${local.slice(-4)}`;
  }
  return id.length > 8 ? `${id.slice(0, 3)}•••${id.slice(-3)}` : id;
}

/** "Dashboard → Buy" reads as moving to Buy; a single name is the screen itself. */
function screenOf(t: TimelineItem): { from?: string; to: string } | undefined {
  if (t.category !== "navigation") return undefined;
  const parts = t.message.split(/\s*(?:→|->)\s*/).filter(Boolean);
  if (!parts.length) return undefined;
  return parts.length > 1 ? { from: parts[parts.length - 2], to: parts[parts.length - 1]! } : { to: parts[0]! };
}

/** The screens visited, in order, each once in a row. */
export function screensOf(timeline: readonly TimelineItem[]): string[] {
  const out: string[] = [];
  for (const t of timeline) {
    const s = screenOf(t);
    if (!s) continue;
    if (s.from && !out.length) out.push(s.from);
    if (out[out.length - 1] !== s.to) out.push(s.to);
  }
  return out;
}

/** The label of a tap: data.label (the SDK's touch boundary), or the quoted name in "Tapped "Pay"". */
function tapLabel(t: TimelineItem): string | undefined {
  if (t.category !== "ui") return undefined;
  const label = t.data?.label;
  if (typeof label === "string" && label) return label;
  const m = /^tapped\s+["“]?(.+?)["”]?$/i.exec(t.message);
  return m?.[1];
}

/** What the app showed: data.shown, or a "Showed …" / "Alert: …" breadcrumb. */
function shownOf(t: TimelineItem): string | undefined {
  const shown = t.data?.shown;
  if (typeof shown === "string" && shown) return shown;
  if (t.category !== "ui" && t.category !== "log") return undefined;
  const m = /^(?:showed|shown|alert|toast)\s*:?\s*["“]?(.+?)["”]?$/i.exec(t.message);
  return m?.[1];
}

const quote = (s: string) => `"${s}"`;

/** "The payments service answered 402 "Insufficient funds" (trace 4f2c…)." */
function callSentence(call: ApiCall): string {
  const who = call.service ? `The ${call.service} service` : `The backend (${[call.method, call.path].filter(Boolean).join(" ")})`;
  const trace = call.traceId ? ` (trace ${call.traceId.slice(0, 4)}…)` : "";
  if (call.outcome === "sessionExpired" || call.status === 401) return `${who} said their session had expired${call.status ? ` (${call.status})` : ""}${trace}.`;
  if (call.status === undefined) {
    const why = call.outcome && call.outcome !== "answered" ? call.outcome : call.errorKind ?? "no answer";
    return `${who} didn't answer (${why})${trace}.`;
  }
  const said = call.backendTitle ? ` ${quote(call.backendTitle)}` : "";
  const code = call.backendCode ? `, code ${call.backendCode}` : "";
  return `${who} answered ${call.status}${said}${code}${trace}.`;
}

export function supportSummary(d: Input, formatTime: (iso: string) => string): SupportSummary {
  const sentences: string[] = [];
  const os = [d.context.os.name && cap(d.context.os.name), d.context.os.version].filter(Boolean).join(" ");
  const who = d.user.id ? `Customer ${maskCustomer(d.user.id)}` : "A signed-out customer";
  const app = d.context.app.version ? `app ${d.context.app.version}` : undefined;
  sentences.push(`${formatTime(d.ts)} · ${who}${os || app ? ` on ${[os, app].filter(Boolean).join(", ")}` : ""}.`);

  const screens = screensOf(d.timeline).slice(-MAX_SCREENS);
  const tap = [...d.timeline].reverse().map(tapLabel).find(Boolean);
  const went = screens.length > 1 ? `Went ${screens.join(" → ")}` : screens.length ? `Was on ${screens[0]}` : undefined;
  const steps = [went, tap && `tapped ${quote(tap)}`].filter(Boolean).join(", ");
  if (steps) sentences.push(`${upperFirst(steps)}.`);

  if (d.request) sentences.push(callSentence(d.request));
  else sentences.push(`The app ${d.handled ? "reported" : "hit"} an error: ${d.error.name}: ${d.error.message}.`);

  const after = d.after ?? [];
  const saw = [...d.timeline.slice(-3), ...after.slice(0, 3)].map(shownOf).find(Boolean);
  const next = after.map(screenOf).find(Boolean);
  const back = next && screens.includes(next.to) ? `went back to ${next.to}` : next ? `went to ${next.to}` : undefined;
  if (saw || back) sentences.push(`${saw ? `They saw ${quote(saw)}${back ? ` and ${back}` : ""}` : `They ${back}`}.`);

  return { sentences, screens, saw };
}

/** The summary for a ticket: the sentences, then the event link and the trace id. */
export function ticketText(summary: SupportSummary, link: string, traceId?: string): string {
  return [summary.sentences.join(" "), "", `Event: ${link}`, ...(traceId ? [`Trace: ${traceId}`] : [])].join("\n");
}

const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const cap = (s: string) => (s === "ios" ? "iOS" : s.charAt(0).toUpperCase() + s.slice(1));
