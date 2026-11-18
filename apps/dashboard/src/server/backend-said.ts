import { maskPersonal, type HostName, type StoredEvent } from "@debugkit/schema";
import { failedRequest, timelineOf } from "./event";

/**
 * What the backend said when a call failed (ABA-161): its own code, message and trace id, from the
 * app's breadcrumb for the call (backendCode, backendTitle, traceId) or else from the JSON
 * response body (code, title or message, traceId). Problem Details (RFC 9457) bodies and most
 * gateways' error bodies use these names.
 */
export interface BackendSaid {
  /** The HTTP status of that answer. */
  status?: number;
  /** The backend's own error code: "30007". */
  code?: string;
  /** The backend's own message, with phone numbers and email addresses masked: "Balance lookup unsuccessful". */
  message?: string;
  /** The id to find this call in the backend's logs. */
  traceId?: string;
  /** The service, as Settings or the app names it. */
  service?: string;
  /** The backend's codes across the occurrences read, most first: "30007 × 14". */
  codes: { key: string; count: number }[];
}

/** A code or id from a JSON field: text or a number, kept to plain characters, else nothing. */
const token = (v: unknown): string | undefined => {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
  return /^[\w.:-]{1,100}$/.test(s) ? s : undefined;
};

/**
 * What a gateway or framework says for any failure: not the service's own reason, so it doesn't
 * replace the explanation's diagnosis.
 */
const GENERIC = /^(internal server error|not found|bad request|forbidden|unauthori[sz]ed|missing authentication token|service unavailable|bad gateway|gateway time-?out|endpoint request timed out|too many requests|error|an error occurred)\.?$/i;

/**
 * A message from the backend, safe to quote in a ticket or Slack: text only, phone numbers and
 * email addresses masked, no quotes or Markdown characters, at most 200 characters.
 */
const message = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined;
  const s = maskPersonal(v).replace(/[`*_<>[\]]/g, "").replace(/"/g, "'").replace(/\s+/g, " ").trim().slice(0, 200);
  return s && !GENERIC.test(s) ? s : undefined;
};

/** One occurrence's answer from the backend, or undefined when it gave none of its own. */
export function saidBy(se: StoredEvent, hosts: readonly HostName[] = []): Omit<BackendSaid, "codes"> | undefined {
  if (se.event.type !== "error") return undefined;
  const call = failedRequest(se.event.request, timelineOf(se.event.breadcrumbs, hosts), hosts);
  let body: Record<string, unknown> = {};
  try {
    const parsed = se.event.response?.body ? JSON.parse(se.event.response.body) : undefined;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    // Not JSON: nothing of the backend's own to read.
  }
  const code = token(call?.backendCode) ?? token(body.code) ?? token(body.errorCode);
  const said = message(call?.backendTitle) ?? message(body.title) ?? message(body.message) ?? message(body.error);
  if (!code && !said) return undefined;
  return {
    status: se.event.response?.status ?? call?.status ?? se.event.request?.status,
    code,
    message: said,
    traceId: token(call?.traceId) ?? token(body.traceId) ?? token(body.trace_id),
    service: call?.service,
  };
}

/**
 * What the backend said across an issue's occurrences (newest first): the newest answer that had
 * its own code or message, and every code with how often it came back. undefined when it never
 * gave one.
 */
export function backendSaid(events: readonly StoredEvent[], hosts: readonly HostName[] = []): BackendSaid | undefined {
  const said = events.flatMap((e) => saidBy(e, hosts) ?? []);
  if (!said.length) return undefined;
  const counts = new Map<string, number>();
  for (const s of said) if (s.code) counts.set(s.code, (counts.get(s.code) ?? 0) + 1);
  return { ...said[0]!, codes: [...counts].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count) };
}
