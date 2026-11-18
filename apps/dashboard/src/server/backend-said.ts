import type { HostName, StoredEvent } from "@debugkit/schema";
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
  code?: string;
  message?: string;
  traceId?: string;
  /** The service, as Settings or the app names it. */
  service?: string;
  /** The backend's codes across the occurrences read, most first: "30007 × 14". */
  codes: { key: string; count: number }[];
}

/** A short string from a JSON field: text or a number, else nothing. */
const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : typeof v === "number" ? String(v) : undefined);

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
  const code = call?.backendCode ?? text(body.code) ?? text(body.errorCode);
  const message = call?.backendTitle ?? text(body.title) ?? text(body.message) ?? text(body.error);
  if (!code && !message) return undefined;
  return {
    status: se.event.response?.status ?? call?.status,
    code,
    message,
    traceId: call?.traceId ?? text(body.traceId) ?? text(body.trace_id),
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
