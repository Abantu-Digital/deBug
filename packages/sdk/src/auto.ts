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
  /** The body is still being read (fetch): the failure is reported when it arrives. */
  bodyPending?: boolean;
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
        try {
          clone = sink.wantsBody(res.status, url) ? res.clone() : undefined;
        } catch {
          clone = undefined;
        }
        const addBody = sink.request({ method, url, status: res.status, durationMs: Date.now() - start, stack, bodyPending: !!clone });
        if (clone && addBody) {
          let done = false;
          const finish = (body: string) => {
            if (done) return;
            done = true;
            addBody(body);
          };
          setTimeout(() => finish(""), BODY_WAIT_MS);
          clone.text().then(
            (body) => finish(body.slice(0, MAX_BODY_CHARS)),
            () => finish(""),
          );
        }
        return res;
      },
      (error) => {
        const aborted = (error as { name?: string })?.name === "AbortError";
        sink.request({ method, url, error, aborted, durationMs: Date.now() - start, stack });
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
  __debug?: { method: string; url: string } | null;
  status: number;
  responseType?: string;
  responseText?: string;
  response?: unknown;
  addEventListener(type: string, fn: () => void): void;
}

/** The body of a finished XHR as text, whatever its responseType; undefined for binary. */
function readXhrBody(x: TrackedXhr): string | undefined {
  try {
    const type = x.responseType ?? "";
    if (type === "" || type === "text") return x.responseText?.slice(0, MAX_BODY_CHARS);
    if (type === "json" && x.response != null) return JSON.stringify(x.response).slice(0, MAX_BODY_CHARS);
  } catch {
    // Reading a body must never affect the app.
  }
  return undefined;
}

export function instrumentXhr(sink: AutoSink): Restore | undefined {
  const X = g.XMLHttpRequest as { prototype: Record<string, any> } | undefined;
  const proto = X?.prototype;
  if (!proto || proto.open.__debug) return;
  const open = proto.open as (...a: unknown[]) => void;
  const send = proto.send as (...a: unknown[]) => void;

  const wrappedOpen = function (this: TrackedXhr, method: string, url: string | URL, ...rest: unknown[]) {
    const u = String(url);
    this.__debug = insideFetch > 0 || sink.ignored(u) ? null : { method: String(method).toUpperCase(), url: u };
    return open.call(this, method, url, ...rest);
  };
  const wrappedSend = function (this: TrackedXhr, ...args: unknown[]) {
    const d = this.__debug;
    if (d) {
      const start = Date.now();
      const stack = new Error().stack;
      let aborted = false;
      let timedOut = false;
      this.addEventListener("abort", () => (aborted = true));
      this.addEventListener("timeout", () => (timedOut = true));
      this.addEventListener("loadend", () => {
        const status = this.status || undefined;
        const responseBody = status !== undefined && sink.wantsBody(status, d.url) ? readXhrBody(this) : undefined;
        sink.request({ ...d, status, aborted, timedOut, durationMs: Date.now() - start, stack, responseBody });
      });
    }
    return send.apply(this, args);
  };
  (wrappedOpen as { __debug?: boolean }).__debug = true;
  proto.open = wrappedOpen;
  proto.send = wrappedSend;
  return () => {
    proto.open = open;
    proto.send = send;
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
