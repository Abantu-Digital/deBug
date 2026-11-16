/**
 * Naming API calls and reading what a backend said about a failure, for the network
 * breadcrumbs `init()` records. Pure functions: no globals, never throws.
 */

import { normaliseUrl } from "./auto";

export interface RequestName {
  /** "buy" for ".../ppd/api/buy/purchase-history" with that base; otherwise the host. */
  service: string;
  /** The endpoint path, ids masked, no query string or fragment: "/buy/purchase-history". */
  path: string;
  /** True when the call matched one of `network.baseUrls`. */
  matched: boolean;
}

export interface ProblemDetails {
  backendTitle: string | null;
  backendCode: string | number | null;
  traceId: string | null;
  backendErrors: string | null;
}

const MAX_TEXT = 200;
const MAX_ERRORS = 500;

/** Personal data in free text: a run of 7+ digits (phone numbers, ids) or an email address. */
const PERSONAL_TEXT = /[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+|\+?\d(?:[\s().-]?\d){6,}/g;

/**
 * The longest base the URL starts with, ending on a path-segment boundary. Scheme and host
 * compare without case, as URLs do.
 */
function findBase(url: string, baseUrls: readonly string[]): string | undefined {
  const lower = url.toLowerCase();
  return baseUrls
    .map((b) => b.replace(/\/+$/, ""))
    .filter((b) => b && lower.startsWith(b.toLowerCase()) && /^(?:[/?#]|$)/.test(url.slice(b.length)))
    .sort((a, b) => b.length - a.length)[0];
}

/**
 * Several services often share one base URL (one API gateway), so the base can't name them:
 * strip it, and the first path segment left is the service. A URL matching no base is named
 * by its host (or, same-origin, by its first path segment).
 */
export function nameRequest(url: string, baseUrls: readonly string[] = []): RequestName {
  const base = findBase(url, baseUrls);
  const masked = normaliseUrl(base ? url.slice(base.length) || "/" : url);
  const slash = masked.indexOf("/");
  const host = !base && slash > 0 ? masked.slice(0, slash) : "";
  const path = host ? masked.slice(slash) : masked.startsWith("/") ? masked : `/${masked}`;
  const first = path.split("/").find(Boolean);
  return { service: host || first || "/", path, matched: !!base };
}

function text(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, MAX_TEXT) : undefined;
}

/** Backend messages can quote the customer ("0821234567 not found"): mask that before it leaves. */
function masked(v: string | undefined): string | undefined {
  return v?.replace(PERSONAL_TEXT, "•••");
}

/** Validation errors as one line: ["a", "b"] or { Amount: ["too high"] } → "Amount: too high". */
function flattenErrors(v: unknown): string | undefined {
  const parts: string[] = [];
  if (Array.isArray(v)) {
    for (const e of v) {
      const s = typeof e === "string" ? e : text((e as { message?: unknown })?.message) ?? text((e as { detail?: unknown })?.detail);
      if (s) parts.push(s);
    }
  } else if (v && typeof v === "object") {
    for (const [field, msgs] of Object.entries(v as Record<string, unknown>)) {
      const list = (Array.isArray(msgs) ? msgs : [msgs]).filter((m): m is string => typeof m === "string");
      if (list.length) parts.push(`${field}: ${list.join(", ")}`);
    }
  }
  const joined = parts.join("; ").slice(0, MAX_ERRORS);
  return joined || undefined;
}

/**
 * What a backend said about a failed call, from a JSON error body: RFC 9457 (formerly 7807)
 * problem details (`title`, `code`, `traceId`, `errors`), as .NET and Spring backends send, with
 * common variants (`message`, `trace_id`, `correlationId`). Phone numbers and emails in the
 * text are masked. Undefined when the body says nothing useful.
 */
export function readProblemDetails(body: string | undefined): ProblemDetails | undefined {
  if (!body) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return undefined;
  const o = json as Record<string, unknown>;
  const title = masked(text(o.title) ?? text(o.message) ?? text(o.error));
  const code = typeof o.code === "number" || text(o.code) ? (o.code as string | number) : null;
  const traceId = text(o.traceId) ?? text(o.traceID) ?? text(o.trace_id) ?? text(o.correlationId) ?? null;
  const errors = masked(flattenErrors(o.errors)) ?? null;
  if (!title && code === null && !traceId && !errors) return undefined;
  return { backendTitle: title ?? null, backendCode: code, traceId, backendErrors: errors };
}
