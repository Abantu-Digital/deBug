import type { Breadcrumb, ContextInput, EnvelopeInput, EventInput, Severity } from "@debugkit/schema/core";
import { parseStack } from "@debugkit/schema/core";
import { browserContext, mergeContext, type ContextPatch } from "./context";
import {
  instrumentClicks,
  instrumentConsole,
  instrumentFetch,
  instrumentHistory,
  instrumentWebLifecycle,
  instrumentXhr,
  normaliseUrl,
  type AutoSink,
  type RequestInfo,
} from "./auto";

export const SDK_NAME = "@debugkit/sdk";
export const SDK_VERSION = "0.2.0";

/** Optional persistence so events survive app restarts / offline. e.g. AsyncStorage. */
export interface QueueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export interface InitOptions {
  /** URL of the ingest function deployed in your cloud. */
  endpoint: string;
  /** Public, write-only key. Safe to ship in the app. */
  ingestKey: string;
  app: { id: string; version?: string; build?: string; environment?: string };
  /**
   * Platform context. Defaults to browserContext() in browsers. The framework entry points
   * (`/expo`, `/react-native`, `/node`) fill this in for you.
   */
  context?: ContextPatch;
  /**
   * What deBug records on its own once initialised. Everything is on by default; pass `false`
   * to turn it all off, or switch parts off: `autoCapture: { console: false }`.
   */
  autoCapture?: boolean | AutoCaptureOptions;
  /** Network capture settings. */
  network?: NetworkOptions;
  /** Fraction of errors and events to keep, 0 to 1. Sessions are never sampled. Default 1. */
  sampleRate?: number;
  /** At most this many errors are sent per minute, and at most a sixth of that for one repeating error. Default 60. */
  maxErrorsPerMinute?: number;
  /** @deprecated Use `autoCapture: { errors: false }`. */
  captureGlobalErrors?: boolean;
  storage?: QueueStorage;
  /** How often queued events are sent. 0 disables the timer (edge runtimes): call flush() yourself. Default 5000. */
  flushIntervalMs?: number;
  maxBatch?: number;
  maxBreadcrumbs?: number;
  /** Drop or edit events before they are sent (PII scrubbing). Return null to drop. */
  beforeSend?: (e: EventInput) => EventInput | null;
  fetch?: typeof fetch;
  debug?: boolean;
}

export interface AutoCaptureOptions {
  /** Uncaught errors and unhandled promise rejections. */
  errors?: boolean;
  /** fetch and XMLHttpRequest: a breadcrumb for every request, an error for each failed one. */
  network?: boolean;
  /** console.warn and console.error as breadcrumbs. */
  console?: boolean;
  /** Page changes in browsers (History API), so any router is covered. */
  navigation?: boolean;
  /** Clicks on buttons, links and other controls in browsers, by their label. */
  clicks?: boolean;
  /** Foreground/background and online/offline as breadcrumbs; flushes when the app is hidden. */
  lifecycle?: boolean;
  /** Session start, errored and crashed markers, for crash-free rates per release. */
  sessions?: boolean;
}

export interface NetworkOptions {
  /** URLs never recorded (substring or regex). The ingest endpoint is always skipped. */
  ignoreUrls?: (string | RegExp)[];
  /**
   * Tag requests with a flow by URL, first match wins:
   * `flows: [["/v2/auth/", "auth.login"], [/\/payments\//, "checkout.payment"]]`.
   */
  flows?: [string | RegExp, string][];
  /** Which HTTP statuses count as failures. Default: 500 and above. Network failures and timeouts always count. */
  isFailure?: (status: number, url: string) => boolean;
  /** Requests slower than this get a warning breadcrumb. Default 3000ms. */
  slowMs?: number;
}

export interface EventMeta {
  flow?: string;
  step?: string;
  tags?: Record<string, string>;
}

const QUEUE_KEY = "@debugkit/queue";
const MAX_QUEUE = 500;

const uid = () =>
  (globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`).replace(/-/g, "");
const now = () => new Date().toISOString();

export class DebugClient {
  private opts!: Required<Pick<InitOptions, "flushIntervalMs" | "maxBatch" | "maxBreadcrumbs">> & InitOptions;
  private queue: EventInput[] = [];
  private crumbs: Breadcrumb[] = [];
  private session = { id: uid(), startedAt: now() };
  private user: { id?: string; anonymousId: string } = { anonymousId: uid() };
  private timer: ReturnType<typeof setInterval> | undefined;
  private flushing: Promise<void> | undefined;
  private backoffUntil = 0;
  private failures = 0;
  private ready = false;
  private handlersInstalled = false;
  private auto: Required<AutoCaptureOptions> = { errors: false, network: false, console: false, navigation: false, clicks: false, lifecycle: false, sessions: false };
  private restores: (() => void)[] = [];
  private sessionState = { errored: false, crashed: false };
  private lastNav: string | undefined;
  private limits = new Map<string, { n: number; since: number }>();
  /** fetch as it was before instrumentation, so our own uploads are never recorded. */
  private rawFetch: typeof fetch | undefined;

  init(options: InitOptions): this {
    if (this.timer) clearInterval(this.timer);
    this.uninstrument();
    this.opts = { flushIntervalMs: 5000, maxBatch: 50, maxBreadcrumbs: 30, ...options };
    if (!this.opts.context && typeof window !== "undefined") this.opts.context = browserContext();
    this.auto = resolveAuto(options);
    this.rawFetch = typeof globalThis.fetch === "function" ? (((globalThis.fetch as { __raw?: typeof fetch }).__raw ?? globalThis.fetch) as typeof fetch) : undefined;
    this.ready = true;
    void this.restore();
    if (this.auto.errors && !this.handlersInstalled) this.installGlobalHandlers();
    this.instrument();
    if (this.auto.sessions) this.startSession();
    if (this.opts.flushIntervalMs > 0) {
      this.timer = setInterval(() => void this.flush(), this.opts.flushIntervalMs);
      (this.timer as { unref?: () => void }).unref?.();
    }
    return this;
  }

  /** Which automatic captures are on, after defaults. */
  get autoCapture(): Readonly<Required<AutoCaptureOptions>> {
    return this.auto;
  }

  /**
   * Begin a new session: a fresh id and a "started" marker. Called by `init()`, and by the
   * React Native entry when the app returns after 30 minutes in the background.
   */
  startSession() {
    if (!this.ready) return;
    void this.flush(); // events already queued belong to the old session
    this.session = { id: uid(), startedAt: now() };
    this.sessionState = { errored: false, crashed: false };
    if (this.auto.sessions) this.push({ type: "session", id: uid(), ts: now(), status: "started" });
  }

  /** Record a navigation breadcrumb ("from → to"). Repeated paths are ignored. */
  navigated(to: string) {
    if (!to || to === this.lastNav) return;
    this.breadcrumb("navigation", this.lastNav ? `${this.lastNav} → ${to}` : to);
    this.lastNav = to;
  }

  get initialized() {
    return this.ready;
  }

  /** Merge extra context (e.g. after an async device lookup). Applies to events sent from now on. */
  setContext(patch: ContextPatch) {
    if (this.opts) this.opts.context = mergeContext(this.opts.context ?? {}, patch);
  }

  setUser(id: string | undefined) {
    this.user = { ...this.user, id };
  }

  breadcrumb(category: Breadcrumb["category"], message: string, data?: Record<string, string | number | boolean | null>, level: Breadcrumb["level"] = "info") {
    const msg = message.slice(0, 500);
    const last = this.crumbs[this.crumbs.length - 1];
    if (last && last.category === category && last.message === msg && last.level === level) {
      last.ts = now();
      last.data = { ...data, repeated: Number(last.data?.repeated ?? 1) + 1 };
      return;
    }
    this.crumbs.push({ ts: now(), category, message: msg, data, level });
    if (this.crumbs.length > (this.opts?.maxBreadcrumbs ?? 30)) this.crumbs.shift();
  }

  /** Log an error. `flow` is the part of the app it belongs to, e.g. "auth.login". */
  error(err: unknown, meta: EventMeta & { severity?: Severity; handled?: boolean; fatal?: boolean } = {}) {
    this.captureError(normaliseError(err), meta);
  }

  /** Log a custom event. Use outcome to let deBug compute failure rates per flow. */
  event(name: string, meta: EventMeta & { outcome?: "success" | "failure" | "abandoned"; props?: Record<string, string | number | boolean | null> } = {}) {
    this.breadcrumb("event", name, meta.props);
    this.enqueue({ type: "event", id: uid(), ts: now(), name, flow: meta.flow, step: meta.step, tags: meta.tags, outcome: meta.outcome, props: meta.props });
  }

  /**
   * Wraps an async step: logs a success or failure outcome for the flow, plus the error.
   * Pass `{ captureError: false }` when the error is already reported elsewhere, e.g. a
   * server function wrapped in withDebug, so it isn't counted twice.
   */
  async track<T>(flow: string, step: string, fn: () => Promise<T>, opts: { captureError?: boolean } = {}): Promise<T> {
    try {
      const out = await fn();
      this.event(`${flow}.${step}`, { flow, step, outcome: "success" });
      return out;
    } catch (err) {
      this.event(`${flow}.${step}`, { flow, step, outcome: "failure" });
      if (opts.captureError !== false) this.error(err, { flow, step });
      throw err;
    }
  }

  async flush(): Promise<void> {
    // Wait for an upload in progress, then send whatever was queued meanwhile (a crash marker, say).
    if (this.flushing) await this.flushing.catch(() => {});
    if (this.flushing) return this.flushing;
    if (!this.ready || this.queue.length === 0 || Date.now() < this.backoffUntil) return;
    const batch = this.queue.splice(0, this.opts.maxBatch);
    this.flushing = this.send(batch)
      .then(() => {
        this.failures = 0;
      })
      .catch((err) => {
        this.queue.unshift(...batch);
        this.failures++;
        this.backoffUntil = Date.now() + Math.min(60_000, 1000 * 2 ** this.failures);
        this.log("flush failed", err);
      })
      .finally(() => {
        this.flushing = undefined;
        void this.persist();
      });
    return this.flushing;
  }

  /** Stop the flush timer, undo automatic instrumentation and send what is queued. */
  close() {
    if (this.timer) clearInterval(this.timer);
    this.uninstrument();
    return this.flush();
  }

  /* ---------------- internals ---------------- */

  /** @internal Used by the platform entry points for errors that have no thrown value. */
  captureError(
    e: { name: string; message: string; stack?: string; frames?: ReturnType<typeof parseStack> },
    meta: EventMeta & { severity?: Severity; handled?: boolean; fatal?: boolean },
    request?: { method: string; url: string; status?: number; durationMs?: number },
  ) {
    if (!this.ready) return;
    const handled = meta.handled ?? true;
    const frames = e.frames ?? parseStack(e.stack);
    if (!meta.fatal && !this.allowError(`${e.name}|${e.message.slice(0, 120)}|${frames[0]?.file ?? ""}:${frames[0]?.line ?? ""}`)) return;
    // Session markers go first so they ride in the same upload as the error.
    if (this.auto.sessions && (!handled || meta.fatal)) {
      if (!this.sessionState.errored) {
        this.sessionState.errored = true;
        this.push({ type: "session", id: uid(), ts: now(), status: "errored" });
      }
      if (meta.fatal && !this.sessionState.crashed) {
        this.sessionState.crashed = true;
        this.push({ type: "session", id: uid(), ts: now(), status: "crashed" });
      }
    }
    // Fatal errors skip sampling: a crash is always worth its one event.
    (meta.fatal ? this.push : this.enqueue).call(this, {
      type: "error",
      id: uid(),
      ts: now(),
      flow: meta.flow,
      step: meta.step,
      tags: meta.tags,
      severity: meta.severity ?? (meta.fatal ? "critical" : undefined),
      handled,
      error: { name: e.name, message: e.message, stack: e.stack, frames },
      breadcrumbs: [...this.crumbs],
      request,
    });
  }

  /** Per-minute limits: one runaway error can't flood the queue, the network or your database. */
  private allowError(signature: string): boolean {
    const max = this.opts.maxErrorsPerMinute ?? 60;
    const t = Date.now();
    const hit = (key: string, cap: number) => {
      let l = this.limits.get(key);
      if (!l || t - l.since > 60_000) this.limits.set(key, (l = { n: 0, since: t }));
      return ++l.n <= cap;
    };
    if (this.limits.size > 200) this.limits.clear();
    const ok = hit("*", max) && hit(signature, Math.max(1, Math.ceil(max / 6)));
    if (!ok) this.log("rate limited", signature);
    return ok;
  }

  private sampled(): boolean {
    const r = this.opts.sampleRate ?? 1;
    return r >= 1 || Math.random() < r;
  }

  private enqueue(e: EventInput) {
    if (!this.ready || !this.sampled()) return;
    this.push(e);
  }

  /** Queue without sampling (sessions must be complete for crash-free rates to be right). */
  private push(e: EventInput) {
    if (!this.ready) return;
    const out = this.opts.beforeSend ? this.opts.beforeSend(e) : e;
    if (!out) return;
    this.queue.push(out);
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
    if (out.type === "error" || this.queue.length >= this.opts.maxBatch) void this.flush();
    else void this.persist();
  }

  private buildContext(): ContextInput {
    const c = this.opts.context ?? {};
    return {
      ...c,
      app: { ...(c.app ?? {}), ...this.opts.app },
      os: { name: "unknown", ...(c.os ?? {}) },
      runtime: { name: "unknown", ...(c.runtime ?? {}) },
      device: c.device ?? {},
    } as ContextInput;
  }

  /** Set when the ingest rejects 0.2 fields: it predates them, so send what it understands. */
  private legacyIngest = false;

  private async send(events: EventInput[]): Promise<void> {
    if (this.legacyIngest) events = toLegacy(events);
    if (!events.length) return;
    const body: EnvelopeInput = {
      sdk: { name: SDK_NAME, version: SDK_VERSION },
      context: this.buildContext(),
      user: this.user,
      session: this.session,
      events,
    };
    const f = this.opts.fetch ?? this.rawFetch ?? fetch;
    const json = JSON.stringify(body);
    const res = await f(this.opts.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-debug-key": this.opts.ingestKey },
      body: json,
      // Lets the last batch finish when the page is closing. Browsers cap keepalive bodies at 64 KB.
      ...(typeof window !== "undefined" && json.length < 60_000 ? { keepalive: true } : {}),
    });
    // 4xx (other than 429) means the payload will never be accepted: drop it instead of retrying forever.
    if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      this.log(`ingest rejected batch (${res.status})`, await res.text().catch(() => ""));
      // An ingest older than this SDK rejects session markers and request details. Retry once
      // without them rather than lose the errors; upgrade @debugkit/ingest to keep them.
      if (res.status === 400 && !this.legacyIngest && hasNewFields(events)) {
        this.legacyIngest = true;
        return this.send(events);
      }
      return;
    }
    if (!res.ok) throw new Error(`ingest responded ${res.status}`);
  }

  private async persist() {
    try {
      await this.opts.storage?.setItem(QUEUE_KEY, JSON.stringify(this.queue));
    } catch {}
  }

  private async restore() {
    try {
      const raw = await this.opts.storage?.getItem(QUEUE_KEY);
      if (raw) this.queue.unshift(...(JSON.parse(raw) as EventInput[]));
    } catch {}
  }

  private installGlobalHandlers() {
    this.handlersInstalled = true;
    const g = globalThis as Record<string, any>;
    // React Native
    if (g.ErrorUtils?.setGlobalHandler) {
      const prev = g.ErrorUtils.getGlobalHandler?.();
      g.ErrorUtils.setGlobalHandler((err: unknown, isFatal?: boolean) => {
        this.error(err, { handled: false, fatal: !!isFatal, tags: { source: "global-handler" } });
        void this.flush();
        prev?.(err, isFatal);
      });
    }
    // Browser (not workers / edge runtimes, which also expose addEventListener)
    if (typeof window !== "undefined" && typeof g.addEventListener === "function") {
      g.addEventListener("error", (ev: { error?: unknown; message?: string }) => this.error(ev.error ?? ev.message, { handled: false, tags: { source: "window.onerror" } }));
      g.addEventListener("unhandledrejection", (ev: { reason?: unknown }) => this.error(ev.reason, { handled: false, tags: { source: "unhandledrejection" } }));
    }
  }

  private instrument() {
    const a = this.auto;
    const sink = this.sink();
    const add = (r: (() => void) | undefined) => r && this.restores.push(r);
    if (a.network) {
      const restoreFetch = instrumentFetch(sink);
      if (restoreFetch) (globalThis.fetch as { __raw?: typeof fetch }).__raw = this.rawFetch;
      add(restoreFetch);
      add(instrumentXhr(sink));
    }
    if (a.console) add(instrumentConsole(sink));
    if (a.navigation) add(instrumentHistory(sink));
    if (a.clicks) add(instrumentClicks(sink));
    if (a.lifecycle) add(instrumentWebLifecycle(sink));
  }

  private uninstrument() {
    while (this.restores.length) this.restores.pop()!();
  }

  /** The bridge the instrumentation (./auto, and the platform entry points) reports through. */
  sink(): AutoSink {
    return {
      request: (r) => this.recordRequest(r),
      crumb: (category, message, level = "info", data) => this.breadcrumb(category, message, data, level),
      navigated: (to) => this.navigated(to),
      lifecycle: (state) => {
        this.breadcrumb("ui", state === "background" ? "App went to the background" : "App came to the foreground");
        if (state === "background") void this.flush();
      },
      ignored: (url) => this.isIgnored(url),
    };
  }

  private isIgnored(url: string): boolean {
    if (!this.ready) return true;
    const ep = this.opts.endpoint.replace(/^https?:/, "");
    if (url.includes(ep) || /\/symbolicate\b|\/logs(?:\?|$)/.test(url)) return true; // ingest, Metro and Expo dev servers
    return (this.opts.network?.ignoreUrls ?? []).some((p) => (typeof p === "string" ? url.includes(p) : p.test(url)));
  }

  private recordRequest(r: RequestInfo) {
    if (!this.ready) return;
    const net = this.opts.network ?? {};
    const url = normaliseUrl(r.url);
    const ms = Math.round(r.durationMs);
    const failed = r.status === undefined ? !r.aborted : (net.isFailure ?? ((s: number) => s >= 500))(r.status, url);
    const slow = ms >= (net.slowMs ?? 3000);
    const outcome = r.aborted ? "aborted" : r.timedOut ? "timed out" : r.status !== undefined ? String(r.status) : "failed";
    this.breadcrumb("network", `${r.method} ${url} → ${outcome} (${ms}ms)`, { status: r.status ?? null, durationMs: ms }, failed ? "error" : slow ? "warning" : "info");
    if (!failed) return;

    const flow = net.flows?.find(([p]) => (typeof p === "string" ? url.includes(p) : p.test(url)))?.[1];
    const cause = r.error ? normaliseError(r.error) : undefined;
    const message =
      r.status !== undefined ? `${r.method} ${url} responded ${r.status}` : `${r.method} ${url} ${r.timedOut ? "timed out" : "failed"}${cause ? `: ${cause.message}` : ""}`;
    // The first frame is our own wrapper; the rest is the code that made the request.
    const frames = parseStack(r.stack).slice(1);
    this.captureError(
      { name: r.status !== undefined ? "HttpError" : "NetworkError", message, stack: r.stack, frames },
      { flow, handled: true, tags: { source: "network" } },
      { method: r.method, url, status: r.status, durationMs: ms },
    );
  }

  private log(...args: unknown[]) {
    if (this.opts?.debug) console.warn("[deBug]", ...args);
  }
}

function normaliseError(err: unknown): { name: string; message: string; stack?: string } {
  if (err instanceof Error) return { name: err.name || "Error", message: err.message, stack: err.stack };
  if (typeof err === "string") return { name: "Error", message: err };
  try {
    return { name: "NonError", message: JSON.stringify(err).slice(0, 2000) };
  } catch {
    return { name: "NonError", message: String(err) };
  }
}

function resolveAuto(o: InitOptions): Required<AutoCaptureOptions> {
  const all = o.autoCapture !== false;
  const sel: AutoCaptureOptions = typeof o.autoCapture === "object" ? o.autoCapture : {};
  const pick = (k: keyof AutoCaptureOptions, dflt = all) => sel[k] ?? dflt;
  return {
    errors: o.captureGlobalErrors ?? pick("errors"),
    network: pick("network"),
    console: pick("console"),
    navigation: pick("navigation"),
    clicks: pick("clicks"),
    lifecycle: pick("lifecycle"),
    sessions: pick("sessions"),
  };
}

const hasNewFields = (events: EventInput[]) => events.some((e) => e.type === "session" || (e.type === "error" && e.request));

/** Events as a 0.1 ingest accepts them: no session markers, no request details. */
function toLegacy(events: EventInput[]): EventInput[] {
  const out: EventInput[] = [];
  for (const e of events) {
    if (e.type === "session") continue;
    if (e.type === "error" && e.request) {
      const { request: _r, ...rest } = e;
      out.push(rest);
    } else out.push(e);
  }
  return out;
}
