import type { Breadcrumb, ErrorEvent } from "@debugkit/schema";

/**
 * What the SDK captured of a failed call's request and response (ABA-117), redacted by the SDK
 * before it left the phone: headers, bodies (at most 16 KB a side) and their full sizes.
 */
export interface Exchange {
  request: ExchangeSide & {
    method: string;
    /** The path, as the SDK names the call. */
    url: string;
    /** The whole URL, host included, when a breadcrumb for the call recorded it. */
    fullUrl?: string;
    /** The query string, redacted, without the "?". */
    query?: string;
  };
  /** Absent when the call got no answer. */
  response?: ExchangeSide & { status?: number };
}

export interface ExchangeSide {
  /** Lowercased names; secrets are "[redacted]". */
  headers?: Record<string, string>;
  /** Redacted text, cut at 16 KB ("…[truncated, N KB total]"), or "[binary N KB, type]". */
  body?: string;
  /** The whole body's size in bytes, before any cut. */
  bodySize?: number;
  truncated?: boolean;
}

/** The fields ABA-117 adds to an error, read loosely: stores keep events from before and after it. */
type Wire = { method: string; url: string; status?: number; query?: unknown; headers?: unknown; body?: unknown; bodySize?: unknown; truncated?: unknown };

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
function headers(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== "object") return undefined;
  const out = Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => typeof x === "string")) as Record<string, string>;
  return Object.keys(out).length ? out : undefined;
}
function side(w: Record<string, unknown>): ExchangeSide {
  return { headers: headers(w.headers), body: str(w.body), bodySize: num(w.bodySize), truncated: w.truncated === true ? true : undefined };
}

/** The SDK's own network breadcrumb carries the URL as it was called: "POST https://api.x/v1/pay → 503 (120ms)". */
const SDK_URL = /^[A-Z]+ (https?:\/\/\S+) → /;

/** The request and response the SDK captured on an error, or undefined when it captured no bodies or headers. */
export function exchangeOf(ev: ErrorEvent, crumbs: readonly Breadcrumb[] = ev.breadcrumbs ?? []): Exchange | undefined {
  const req = ev.request as Wire | undefined;
  const res = (ev as { response?: unknown }).response as Record<string, unknown> | undefined;
  if (!req) return undefined;
  const request = { method: req.method.toUpperCase(), url: req.url, query: str(req.query)?.replace(/^\?/, "") || undefined, ...side(req as Record<string, unknown>) };
  const response = res && typeof res === "object" ? { status: num(res.status) ?? req.status, ...side(res) } : undefined;
  const captured = [request, response].some((s) => s && (s.headers || s.body !== undefined));
  if (!captured) return undefined;
  const path = req.url.split(/[?#]/)[0]!;
  const fullUrl = [...crumbs]
    .reverse()
    .map((b) => (b.category === "network" ? SDK_URL.exec(b.message)?.[1] : undefined))
    .find((u) => u && u.split(/[?#]/)[0]!.endsWith(path));
  return { request: { ...request, fullUrl: fullUrl?.split(/[?#]/)[0] }, response };
}
