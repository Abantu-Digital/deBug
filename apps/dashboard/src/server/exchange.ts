import type { Breadcrumb, ErrorEvent } from "@debugkit/schema";

/**
 * What the SDK captured of a failed call's request and response (ABA-117, `network.bodies`),
 * redacted on the phone before it was sent: the query, headers and bodies (at most 16 KB a side).
 */
export interface Exchange {
  request: ExchangeSide & {
    method: string;
    /** As the SDK names the call: "api.x.com/v1/orders/:id", or "/v1/orders/:id" for its own origin. */
    url: string;
    /** "https://api.x.com/v1/orders/:id" when the URL names its host; undefined when it's a path only. */
    fullUrl?: string;
    /** The query string, redacted, without the "?". */
    query?: string;
  };
  /** Absent when the call got no answer. */
  response?: ExchangeSide & { status: number };
}

/** One side of the call, as the schema's CapturedBody and CapturedHeaders hold it. */
export interface ExchangeSide {
  /** Lowercased names; secrets are "[redacted]". Values over 2000 characters were cut by ingest. */
  headers?: Record<string, string>;
  /** Redacted text, cut at 16 KB ("…[truncated, N KB total]", or ingest's "…[truncated]"), or "[binary N KB, type]". */
  body?: string;
  /** The whole body's size before any cut: characters for text, bytes for a binary body. */
  bodySize?: number;
  truncated?: boolean;
}

type Request = NonNullable<ErrorEvent["request"]>;

function sideOf(s: { headers?: Record<string, string>; body?: string; bodySize?: number; truncated?: boolean }): ExchangeSide {
  return { headers: s.headers && Object.keys(s.headers).length ? s.headers : undefined, body: s.body, bodySize: s.bodySize, truncated: s.truncated || undefined };
}

/** Whether the SDK captured anything beyond the call itself: only with network.bodies on. */
function captured(r: Request, crumbs: readonly Breadcrumb[]): boolean {
  return r.query !== undefined || !!r.headers || r.body !== undefined || r.bodySize !== undefined || crumbs.some((b) => b.category === "network" && b.data?.hasBodies === true);
}

/** The request and response the SDK captured on an error, or undefined when it captured none. */
export function exchangeOf(ev: ErrorEvent): Exchange | undefined {
  const r = ev.request;
  if (!r || !(captured(r, ev.breadcrumbs ?? []) || ev.response)) return undefined;
  // normaliseUrl keeps the host ("api.x.com/v1/pay") unless the call was to the app's own origin.
  const fullUrl = r.url && !r.url.startsWith("/") ? `https://${r.url}` : undefined;
  return {
    request: { method: r.method.toUpperCase(), url: r.url, fullUrl, query: r.query?.replace(/^\?/, "") || undefined, ...sideOf(r) },
    response: ev.response ? { status: ev.response.status, ...sideOf(ev.response) } : undefined,
  };
}
