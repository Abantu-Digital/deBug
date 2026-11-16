/**
 * Automatic instrumentation installed by `init()`: network requests, console, navigation,
 * clicks and page lifecycle. Every installer is a no-op on platforms that lack the global it
 * patches, and returns a function that undoes the patch.
 */

export interface RequestInfo {
  method: string;
  url: string;
  status?: number;
  error?: unknown;
  aborted?: boolean;
  timedOut?: boolean;
  durationMs: number;
  /** Stack captured where the request was made, so a failure points at the calling code. */
  stack?: string;
  /** The response body as text, read only when `wantsBody` said so (a failure). */
  responseBody?: string;
  /** A failure's response that isn't text: its size and type, never its bytes. */
  responseBinary?: BinaryInfo;
  /** Kept only when the client captures bodies (`capturesBodies`), and sent only for a failure. */
  requestHeaders?: Record<string, string>;
  requestBody?: string;
  requestBinary?: BinaryInfo;
  responseHeaders?: Record<string, string>;
  /** The body is still being read (fetch): the failure is reported when it arrives. */
  bodyPending?: boolean;
}

/** A body that isn't text, described by its size and type. */
export interface BinaryInfo {
  bytes?: number;
  type?: string;
}

/** What the instrumentation needs from the client. */
export interface AutoSink {
  /** Returns, for a failure, a function that adds the response body once it has been read. */
  request(info: RequestInfo): ((responseBody: string) => void) | void;
  crumb(category: "navigation" | "network" | "ui" | "log", message: string, level?: "debug" | "info" | "warning" | "error", data?: Record<string, string | number | boolean | null>): void;
  navigated(to: string): void;
  lifecycle(state: "foreground" | "background"): void;
  ignored(url: string): boolean;
  /** Whether a response with this status is a failure worth reading the body of. */
  wantsBody(status: number, url: string): boolean;
  /** Whether to keep each request's headers and body, for a failure's request and response. */
  capturesBodies(): boolean;
}

type Restore = () => void;
const g = globalThis as Record<string, any>;

/* ------------------------------- URLs ------------------------------- */

const ID_SEGMENT = /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|(?=[^/]*\d)[\w-]{20,})$/i;
/** Personal data in a path segment: a run of 7+ digits (phone numbers, ids: +27821234567, msisdn-0821234567) or an email. */
const PERSONAL_SEGMENT = /\d(?:[\s().-]?\d){6,}|@|%40/;

/**
 * "https://api.x.com/v1/orders/8812?token=abc" → "api.x.com/v1/orders/:id". Query strings and
 * fragments never leave the device (they often carry tokens and personal data), and ids are
 * replaced so requests group by endpoint. Same-origin URLs keep only the path.
 */
export function normaliseUrl(raw: string): string {
  const m = /^(?:([a-z][a-z0-9+.-]*:)?\/\/([^/?#]*))?([^?#]*)/i.exec(raw.trim());
  let host = m?.[2] ?? "";
  const path = (m?.[3] || "/").split("/").map((s) => (ID_SEGMENT.test(s) || PERSONAL_SEGMENT.test(safeDecode(s)) ? ":id" : s)).join("/");
  if (host.includes("@")) host = host.slice(host.lastIndexOf("@") + 1); // drop user:pass@
  const here = typeof location !== "undefined" ? location.host : undefined;
  return !host || host === here ? path : `${host}${path.startsWith("/") ? "" : "/"}${path}`;
}

function safeDecode(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/* ------------------------------ network ----------------------------- */

/** Bodies past this are not read: an error body is small, and a big one isn't problem details. */
const MAX_BODY_CHARS = 64 * 1024;
/** How long a failure waits for its body before it is reported without it. */
const BODY_WAIT_MS = 3000;
/** Content types read as text; anything else is recorded by size and type only. */
const TEXT_TYPE = /^(?:text\/|application\/(?:[\w.+-]*json|[\w.+-]*xml|x-www-form-urlencoded|problem\+json|javascript))/i;

type Body = { text?: string; binary?: BinaryInfo };

/** A request body as the app passed it to fetch or XHR. */
function describeBody(body: unknown, type?: string): Body {
  if (body === undefined || body === null || body === "") return {};
  if (typeof body === "string") return { text: body.slice(0, MAX_BODY_CHARS) };
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) return { text: body.toString().slice(0, MAX_BODY_CHARS) };
  if (typeof ArrayBuffer !== "undefined" && (body instanceof ArrayBuffer || ArrayBuffer.isView(body))) return { binary: { bytes: (body as ArrayBuffer).byteLength, type } };
  const blob = body as { size?: unknown; type?: unknown };
  if (typeof blob.size === "number") return { binary: { bytes: blob.size, type: typeof blob.type === "string" && blob.type ? blob.type : type } };
  return { binary: { type: type ?? "multipart/form-data" } }; // FormData and streams
}

/** Headers as a plain object, from a Headers instance, an array of pairs or a record. */
function headerRecord(h: unknown): Record<string, string> | undefined {
  if (!h) return undefined;
  const out: Record<string, string> = {};
  const pairs = h as { forEach?: (fn: (v: string, k: string) => void) => void };
  if (typeof pairs.forEach === "function" && !Array.isArray(h)) pairs.forEach((v, k) => (out[k] = String(v)));
  else if (Array.isArray(h)) for (const [k, v] of h as [string, string][]) out[k] = String(v);
  else for (const [k, v] of Object.entries(h as Record<string, unknown>)) out[k] = String(v);
  return out;
}

/** "a: 1\r\nb: 2" as returned by XHR's getAllResponseHeaders. */
function parseRawHeaders(raw: string | null | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

/** > 0 while the original fetch runs synchronously, so the XHR it uses (React Native) isn't counted twice. */
let insideFetch = 0;

export function instrumentFetch(sink: AutoSink): Restore | undefined {
  const orig = g.fetch as typeof fetch | undefined;
  if (typeof orig !== "function" || (orig as { __debug?: boolean }).__debug) return;
  const wrapped = function (this: unknown, input: any, init?: any): Promise<Response> {
    const url = typeof input === "string" ? input : (input?.href ?? input?.url ?? String(input));
    if (sink.ignored(url)) return orig.call(this, input, init);
    const method = String(init?.method ?? input?.method ?? "GET").toUpperCase();
    const start = Date.now();
    const stack = new Error().stack;
    let sent: Pick<RequestInfo, "requestHeaders" | "requestBody" | "requestBinary"> = {};
    if (sink.capturesBodies()) {
      try {
        const requestHeaders = headerRecord(init?.headers ?? input?.headers);
        const body = describeBody(init?.body, requestHeaders?.["content-type"] ?? requestHeaders?.["Content-Type"]);
        sent = { requestHeaders, requestBody: body.text, requestBinary: body.binary };
      } catch {
        // Describing the request must never affect it.
      }
    }
    let p: Promise<Response>;
    insideFetch++;
    try {
      p = orig.call(this, input, init);
    } finally {
      insideFetch--;
    }
    return p.then(
      (res) => {
        // Recorded now, in call order. A failure's body is read from a clone afterwards, so the
        // app still reads the response itself, and what the backend said is added when it lands.
        let clone: Response | undefined;
        let failure: Pick<RequestInfo, "responseHeaders" | "responseBinary"> = {};
        try {
          if (sink.wantsBody(res.status, url)) {
            const type = res.headers?.get?.("content-type") ?? undefined;
            if (sink.capturesBodies()) failure.responseHeaders = headerRecord(res.headers);
            // Only text is read; a file's bytes never are.
            if (!type || TEXT_TYPE.test(type)) clone = res.clone();
            else {
              const length = Number(res.headers.get("content-length"));
              failure = { ...failure, responseBinary: { bytes: Number.isFinite(length) && length > 0 ? length : undefined, type } };
            }
          }
        } catch {
          clone = undefined;
        }
        const addBody = sink.request({ method, url, status: res.status, durationMs: Date.now() - start, stack, bodyPending: !!clone, ...sent, ...failure });
        if (clone && addBody) {
          let done = false;
          const finish = (body: string) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            addBody(body);
          };
          const timer = setTimeout(() => finish(""), BODY_WAIT_MS);
          clone.text().then(
            (body) => finish(body.slice(0, MAX_BODY_CHARS)),
            () => finish(""),
          );
        }
        return res;
      },
      (error) => {
        const aborted = (error as { name?: string })?.name === "AbortError";
        sink.request({ method, url, error, aborted, durationMs: Date.now() - start, stack, ...sent });
        throw error;
      },
    );
  };
  (wrapped as { __debug?: boolean }).__debug = true;
  g.fetch = wrapped;
  return () => {
    if (g.fetch === wrapped) g.fetch = orig;
  };
}

interface TrackedXhr {
  __debug?: { method: string; url: string; headers?: Record<string, string> } | null;
  status: number;
  getAllResponseHeaders?(): string | null;
  getResponseHeader?(name: string): string | null;
  responseType?: string;
  responseText?: string;
  response?: unknown;
  addEventListener(type: string, fn: () => void): void;
}

/**
 * Bytes as UTF-8 text. Hermes (React Native) has no TextDecoder, so it falls back to
 * percent-decoding, which throws on bytes that aren't UTF-8: those are binary, not an error body.
 */
function decodeUtf8(buf: ArrayBuffer): string | undefined {
  if (buf.byteLength > MAX_BODY_CHARS) return undefined;
  const bytes = new Uint8Array(buf);
  if (typeof TextDecoder !== "undefined") return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let escaped = "";
  for (const b of bytes) escaped += `%${b.toString(16).padStart(2, "0")}`;
  return decodeURIComponent(escaped);
}

/**
 * The body of a finished XHR: text and json responses as text, and arraybuffer ones when they
 * decode as text (apps that download files ask for bytes, and their errors come back as bytes
 * too). Anything else is described by its size and type.
 */
function readXhrBody(x: TrackedXhr): Body {
  let type: string | undefined;
  try {
    type = x.getResponseHeader?.("content-type") ?? undefined;
    const kind = x.responseType ?? "";
    if (kind === "" || kind === "text") return { text: x.responseText?.slice(0, MAX_BODY_CHARS) };
    if (kind === "json" && x.response != null) return { text: JSON.stringify(x.response).slice(0, MAX_BODY_CHARS) };
    if (kind === "arraybuffer" && x.response instanceof ArrayBuffer) {
      const text = decodeUtf8(x.response);
      return text !== undefined ? { text } : { binary: { bytes: x.response.byteLength, type } };
    }
    const blob = x.response as { size?: unknown } | null;
    return { binary: { bytes: typeof blob?.size === "number" ? blob.size : undefined, type } };
  } catch {
    // Reading a body must never affect the app; bytes that aren't text are recorded by size.
    return x.response instanceof ArrayBuffer ? { binary: { bytes: x.response.byteLength, type } } : {};
  }
}

export function instrumentXhr(sink: AutoSink): Restore | undefined {
  const X = g.XMLHttpRequest as { prototype: Record<string, any> } | undefined;
  const proto = X?.prototype;
  if (!proto || proto.open.__debug) return;
  const open = proto.open as (...a: unknown[]) => void;
  const send = proto.send as (...a: unknown[]) => void;
  const setRequestHeader = proto.setRequestHeader as ((name: string, value: string) => void) | undefined;

  const wrappedOpen = function (this: TrackedXhr, method: string, url: string | URL, ...rest: unknown[]) {
    const u = String(url);
    this.__debug = insideFetch > 0 || sink.ignored(u) ? null : { method: String(method).toUpperCase(), url: u };
    return open.call(this, method, url, ...rest);
  };
  const wrappedSetRequestHeader = function (this: TrackedXhr, name: string, value: string) {
    const d = this.__debug;
    if (d && sink.capturesBodies()) (d.headers ??= {})[String(name)] = String(value);
    return setRequestHeader?.call(this, name, value);
  };
  const wrappedSend = function (this: TrackedXhr, ...args: unknown[]) {
    const d = this.__debug;
    if (d) {
      let sent: Pick<RequestInfo, "requestHeaders" | "requestBody" | "requestBinary"> = {};
      if (sink.capturesBodies()) {
        try {
          const body = describeBody(args[0], d.headers?.["Content-Type"] ?? d.headers?.["content-type"]);
          sent = { requestHeaders: d.headers, requestBody: body.text, requestBinary: body.binary };
        } catch {
          // Describing the request must never affect it.
        }
      }
      const start = Date.now();
      const stack = new Error().stack;
      let aborted = false;
      let timedOut = false;
      this.addEventListener("abort", () => (aborted = true));
      this.addEventListener("timeout", () => (timedOut = true));
      this.addEventListener("loadend", () => {
        const status = this.status || undefined;
        const failed = status !== undefined && sink.wantsBody(status, d.url);
        const body = failed ? readXhrBody(this) : {};
        let responseHeaders: Record<string, string> | undefined;
        if (failed && sink.capturesBodies()) {
          try {
            responseHeaders = parseRawHeaders(this.getAllResponseHeaders?.());
          } catch {
            responseHeaders = undefined;
          }
        }
        sink.request({
          method: d.method,
          url: d.url,
          status,
          aborted,
          timedOut,
          durationMs: Date.now() - start,
          stack,
          responseBody: body.text,
          responseBinary: body.binary,
          responseHeaders,
          ...sent,
        });
      });
    }
    return send.apply(this, args);
  };
  (wrappedOpen as { __debug?: boolean }).__debug = true;
  proto.open = wrappedOpen;
  proto.send = wrappedSend;
  if (setRequestHeader) proto.setRequestHeader = wrappedSetRequestHeader;
  return () => {
    proto.open = open;
    proto.send = send;
    if (setRequestHeader) proto.setRequestHeader = setRequestHeader;
  };
}

/* ------------------------------ console ----------------------------- */

function format(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch {
    return String(arg);
  }
}

export function instrumentConsole(sink: AutoSink): Restore | undefined {
  const c = g.console as Record<string, (...a: unknown[]) => void> | undefined;
  if (!c) return;
  const restores: Restore[] = [];
  for (const [method, level] of [["warn", "warning"], ["error", "error"]] as const) {
    const orig = c[method];
    if (typeof orig !== "function") continue;
    c[method] = function (this: unknown, ...args: unknown[]) {
      if (args[0] !== "[deBug]") sink.crumb("log", args.map(format).join(" ").slice(0, 500), level);
      return orig.apply(this, args);
    };
    restores.push(() => (c[method] = orig));
  }
  return () => restores.forEach((r) => r());
}

/* --------------------------- web: navigation -------------------------- */

const path = () => (typeof location !== "undefined" ? location.pathname : "");

export function instrumentHistory(sink: AutoSink): Restore | undefined {
  const h = g.history as Record<string, (...a: unknown[]) => void> | undefined;
  if (typeof window === "undefined" || !h?.pushState || typeof g.addEventListener !== "function") return;
  const orig = { pushState: h.pushState, replaceState: h.replaceState };
  for (const k of ["pushState", "replaceState"] as const) {
    h[k] = function (this: unknown, ...args: unknown[]) {
      const out = orig[k]!.apply(this, args);
      sink.navigated(path());
      return out;
    };
  }
  const onPop = () => sink.navigated(path());
  g.addEventListener("popstate", onPop);
  sink.navigated(path());
  return () => {
    Object.assign(h, orig);
    g.removeEventListener("popstate", onPop);
  };
}

/* ----------------------------- web: clicks ---------------------------- */

const CLICKABLE = 'button,a,[role="button"],[role="link"],[role="tab"],[role="menuitem"],input[type="submit"],input[type="button"],input[type="checkbox"],input[type="radio"],summary,label,[data-testid]';

/** Describes the element by its label, never by anything the user typed. */
export function describeElement(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const label =
    el.getAttribute("aria-label") ||
    el.getAttribute("data-testid") ||
    el.getAttribute("title") ||
    (tag === "input" ? el.getAttribute("name") || (el as HTMLInputElement).type : (el as HTMLElement).innerText || el.textContent || "");
  const id = el.id ? `#${el.id}` : "";
  const text = label.replace(/\s+/g, " ").trim().slice(0, 60);
  return `${tag}${id}${text ? ` "${text}"` : ""}`;
}

export function instrumentClicks(sink: AutoSink): Restore | undefined {
  const d = g.document as Document | undefined;
  if (!d?.addEventListener) return;
  const onClick = (ev: Event) => {
    const t = ev.target as Element | null;
    const el = t?.closest?.(CLICKABLE);
    if (el) sink.crumb("ui", `Clicked ${describeElement(el)}`);
  };
  d.addEventListener("click", onClick, true);
  return () => d.removeEventListener("click", onClick, true);
}

/* --------------------------- web: lifecycle --------------------------- */

export function instrumentWebLifecycle(sink: AutoSink): Restore | undefined {
  const d = g.document as Document | undefined;
  if (typeof window === "undefined" || !d?.addEventListener) return;
  const onVis = () => sink.lifecycle(d.visibilityState === "hidden" ? "background" : "foreground");
  const onOnline = () => sink.crumb("network", "Device went online");
  const onOffline = () => sink.crumb("network", "Device went offline", "warning");
  d.addEventListener("visibilitychange", onVis);
  g.addEventListener("online", onOnline);
  g.addEventListener("offline", onOffline);
  return () => {
    d.removeEventListener("visibilitychange", onVis);
    g.removeEventListener("online", onOnline);
    g.removeEventListener("offline", onOffline);
  };
}
