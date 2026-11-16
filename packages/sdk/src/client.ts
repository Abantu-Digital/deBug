import type { Breadcrumb, ContextInput, EnvelopeInput, EventInput, Severity } from "@debugkit/schema/core";
import { latencyBucket, LATENCY_BUCKETS_MS, markLibraryFrames, parseStack } from "@debugkit/schema/core";
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
import { nameRequest, readProblemDetails } from "./network";

export const SDK_NAME = "@debugkit/sdk";
declare const __DEBUGKIT_SDK_VERSION__: string | undefined;
/** This package's version, stamped in at build time from package.json. */
export const SDK_VERSION = typeof __DEBUGKIT_SDK_VERSION__ === "string" ? __DEBUGKIT_SDK_VERSION__ : "0.0.0-dev";

/** Optional persistence so events survive app restarts / offline. e.g. AsyncStorage. */
export interface QueueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  /**
   * Optional synchronous write, used on a fatal crash: the app is killed straight after, so an
   * async write may never land. MMKV can do this (`(k, v) => mmkv.set(k, v)`); AsyncStorage can't,
   * and then the crash is saved on a best-effort basis.
   */
  setItemSync?(key: string, value: string): void;
}

export interface InitOptions {
  /**
   * Turn deBug off for this build: nothing is patched, recorded or sent, and every call
   * (error, track, event...) quietly does nothing. track() still runs and returns your function.
   * Typically `enabled: !__DEV__` or a check of your app's environment. Default true.
   */
  enabled?: boolean;
  /** URL of the ingest function deployed in your cloud. */
  endpoint: string;
  /** Public, write-only key. Safe to ship in the app. */
  ingestKey: string;
  app: {
    id: string;
    version?: string;
    build?: string;
    /** Over-the-air update on top of the store version, e.g. `HotUpdater.getBundleId()` or expo-updates' `updateId`. */
    update?: string;
    environment?: string;
  };
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
  /** Tags on every error and event, such as `{ plan: "prepaid" }`. Change them later with `deBug.setTags()`. */
  tags?: Record<string, string>;
  /**
   * More tags for one error or event, worked out when it happens (say, the screen's feature
   * flag). They add to deBug's own and the global tags; the event's own tags win.
   */
  enrich?: (e: EventInput) => Record<string, string> | undefined | void;
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
  /**
   * Your backends' base URLs, to name each call in the trail. The longest base a URL starts
   * with is stripped and the first path segment left names the service:
   * `baseUrls: ["https://api.x.com/v1"]` turns "https://api.x.com/v1/orders/42" into service
   * "orders", path "/orders/:id". Calls to other hosts are named by their host.
   */
  baseUrls?: string[];
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
/** One id per install, so "users affected" counts people rather than app launches. */
const ANON_KEY = "@debugkit/anonymousId";

function webStorage(): { getItem(k: string): string | null; setItem(k: string, v: string): void } | undefined {
  try {
    const ls = (globalThis as { localStorage?: { getItem(k: string): string | null; setItem(k: string, v: string): void } }).localStorage;
    if (!ls) return undefined;
    ls.getItem(ANON_KEY); // throws in some private modes
    return ls;
  } catch {
    return undefined;
  }
}
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
  /** Tags on every error and event: deBug's own sources (device facts), then the app's. */
  private tagSources: (() => Record<string, string> | undefined)[] = [];
  private globalTags: Record<string, string> = {};
  /** The batch being uploaded: still saved, so a crash mid-upload doesn't lose it. */
  private inflight: EventInput[] = [];
  /** Saved events from the last run, read once; saves wait for it so they don't overwrite them. */
  private restoring: Promise<void> | undefined;
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
    this.globalTags = { ...options.tags };
    if (options.enabled === false) {
      // Switched off: stay inert. Handlers from an earlier init() check `ready` and do nothing.
      this.ready = false;
      this.queue = [];
      this.log("disabled for this build (enabled: false)");
      return this;
    }
    if (!this.opts.context && typeof window !== "undefined") this.opts.context = browserContext();
    this.auto = resolveAuto(options);
    this.rawFetch = typeof globalThis.fetch === "function" ? (((globalThis.fetch as { __raw?: typeof fetch }).__raw ?? globalThis.fetch) as typeof fetch) : undefined;
    this.ready = true;
    this.loadAnonymousId();
    this.restoring = this.restore();
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

  /** False when init() was called with `enabled: false` (or not called yet). */
  get enabled(): boolean {
    return this.ready;
  }

  /** Events waiting to be sent. */
  get pending(): number {
    return this.queue.length;
  }

  /** Merge extra context (e.g. after an async device lookup). Applies to events sent from now on. */
  setContext(patch: ContextPatch) {
    if (this.opts) this.opts.context = mergeContext(this.opts.context ?? {}, patch);
  }

  /** Add or change tags on every later error and event. A value of undefined removes the tag. */
  setTags(tags: Record<string, string | undefined>) {
    for (const [k, v] of Object.entries(tags)) {
      if (v === undefined) delete this.globalTags[k];
      else this.globalTags[k] = String(v);
    }
  }

  /**
   * A function whose tags go on every error and event (the React Native entry adds device
   * facts this way). Read when each event happens; a source that throws is skipped.
   */
  addTagSource(source: () => Record<string, string> | undefined) {
    this.tagSources.push(source);
    return () => {
      this.tagSources = this.tagSources.filter((s) => s !== source);
    };
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

  /** Response times per endpoint, sent as one metric event each about once a minute. */
  private timings = new Map<string, { count: number; errors: number; buckets: number[] }>();
  private timingsSince = Date.now();
  /** Set when the ingest rejects metric events (older than 0.7): stop sending them, keep the rest. */
  private noMetrics = false;

  private timeRequest(key: string, ms: number, failed: boolean) {
    if (this.noMetrics) return;
    let t = this.timings.get(key);
    if (!t) {
      if (this.timings.size >= 50) return; // cap the endpoints tracked per minute
      this.timings.set(key, (t = { count: 0, errors: 0, buckets: new Array(LATENCY_BUCKETS_MS.length + 1).fill(0) }));
    }
    t.count++;
    if (failed) t.errors++;
    t.buckets[latencyBucket(ms)]!++;
  }

  /** Turn the collected timings into metric events (every minute, or now when `force`). */
  private queueTimings(force = false) {
    if (!this.timings.size || this.noMetrics || (!force && Date.now() - this.timingsSince < 60_000)) return;
    for (const [key, t] of this.timings) this.push({ type: "metric", id: uid(), ts: now(), name: "http", key: key.slice(0, 300), count: t.count, errors: t.errors, buckets: t.buckets });
    this.timings.clear();
    this.timingsSince = Date.now();
  }

  async flush(): Promise<void> {
    this.queueTimings(this.closing);
    // Wait for an upload in progress, then send whatever was queued meanwhile (a crash marker, say).
    if (this.flushing) await this.flushing.catch(() => {});
    if (this.flushing) return this.flushing;
    if (!this.ready || this.queue.length === 0 || Date.now() < this.backoffUntil) return;
    const batch = this.queue.splice(0, this.opts.maxBatch);
    this.inflight = batch;
    this.flushing = this.send(batch)
      .then(() => {
        this.failures = 0;
        this.inflight = [];
      })
      .catch((err) => {
        this.inflight = [];
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
  private closing = false;

  close() {
    if (this.timer) clearInterval(this.timer);
    this.uninstrument();
    this.closing = true;
    return this.flush().finally(() => (this.closing = false));
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
    let out: EventInput | null | undefined = e.type === "error" || e.type === "event" ? this.withTags(e) : e;
    if (this.opts.beforeSend) {
      try {
        out = this.opts.beforeSend(out);
      } catch (err) {
        this.log("beforeSend threw; sending the event unchanged", err);
      }
    }
    if (!out) return;
    this.queue.push(out);
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
    if (out.type === "error" || this.queue.length >= this.opts.maxBatch) void this.flush();
    else void this.persist();
  }

  /** deBug's tag sources, then the app's global tags, then enrich(), then the event's own tags. */
  private withTags(e: EventInput): EventInput {
    const tags: Record<string, string> = {};
    const add = (t: Record<string, string> | undefined | void) => {
      if (!t) return;
      for (const [k, v] of Object.entries(t)) if (v !== undefined && v !== null) tags[k.slice(0, 100)] = String(v).slice(0, 200);
    };
    for (const source of this.tagSources) {
      try {
        add(source());
      } catch {}
    }
    add(this.globalTags);
    if (this.opts.enrich) {
      try {
        add(this.opts.enrich(e));
      } catch (err) {
        this.log("enrich threw; skipped", err);
      }
    }
    add(e.tags);
    return Object.keys(tags).length ? { ...e, tags } : e;
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
    if (this.noMetrics) events = events.filter((e) => e.type !== "metric");
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
      // Step down one format at a time: first drop metric events (0.5/0.6 ingests), then
      // session markers and request details (0.1).
      if (res.status === 400 && !this.noMetrics && events.some((e) => e.type === "metric")) {
        this.noMetrics = true;
        this.timings.clear();
        return this.send(events);
      }
      if (res.status === 400 && !this.legacyIngest && hasNewFields(events)) {
        this.legacyIngest = true;
        return this.send(events);
      }
      return;
    }
    if (!res.ok) throw new Error(`ingest responded ${res.status}`);
  }

  /** What must survive a restart: the batch being uploaded, then the queue. */
  private snapshot() {
    return JSON.stringify([...this.inflight, ...this.queue]);
  }

  private async persist() {
    const storage = this.opts.storage;
    if (!storage) return;
    try {
      await this.restoring;
      await storage.setItem(QUEUE_KEY, this.snapshot());
    } catch {}
  }

  /** Save now, synchronously where the storage can: the app is about to die. */
  private persistNow() {
    const storage = this.opts.storage;
    if (!storage) return;
    try {
      if (storage.setItemSync) storage.setItemSync(QUEUE_KEY, this.snapshot());
      else void storage.setItem(QUEUE_KEY, this.snapshot()).catch(() => {});
    } catch {}
  }

  /**
   * Reuse the install's anonymous id: from localStorage in browsers straight away, or from the
   * `storage` option (AsyncStorage in React Native) once it loads. Events queued before then
   * carry the new id, which only matters for the very first launch.
   */
  private loadAnonymousId() {
    const ws = webStorage();
    if (ws) {
      try {
        const saved = ws.getItem(ANON_KEY);
        if (saved) this.user = { ...this.user, anonymousId: saved };
        else ws.setItem(ANON_KEY, this.user.anonymousId);
      } catch {}
      return;
    }
    const storage = this.opts.storage;
    if (!storage) return;
    void (async () => {
      try {
        const saved = await storage.getItem(ANON_KEY);
        if (saved) this.user = { ...this.user, anonymousId: saved };
        else await storage.setItem(ANON_KEY, this.user.anonymousId);
      } catch {}
    })();
  }

  private async restore() {
    try {
      const raw = await this.opts.storage?.getItem(QUEUE_KEY);
      const saved = raw ? (JSON.parse(raw) as EventInput[]) : [];
      if (!Array.isArray(saved) || !saved.length) return;
      // Skip anything already queued in this run (the same event saved twice).
      const have = new Set([...this.inflight, ...this.queue].map((e) => e.id));
      this.queue.unshift(...saved.filter((e) => e && typeof e === "object" && !have.has(e.id)));
      if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
    } catch {}
  }

  private installGlobalHandlers() {
    this.handlersInstalled = true;
    const g = globalThis as Record<string, any>;
    // React Native
    if (g.ErrorUtils?.setGlobalHandler) {
      const prev = g.ErrorUtils.getGlobalHandler?.();
      g.ErrorUtils.setGlobalHandler((err: unknown, isFatal?: boolean) => {
        try {
          this.error(err, { handled: false, fatal: !!isFatal, tags: { source: "global-handler" } });
          // In release builds React Native's handler kills the app right after this, so the
          // upload below may never finish: save the crash first, and send it on the next launch.
          if (isFatal) this.persistNow();
          void this.flush();
          if (isFatal) this.persistNow(); // the crash may now be in the batch being uploaded
        } catch {}
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
        if (state === "background") {
          this.queueTimings(true);
          void this.flush();
        }
      },
      ignored: (url) => this.isIgnored(url),
      wantsBody: (status, url) => this.isFailedStatus(status, url),
    };
  }

  private isIgnored(url: string): boolean {
    if (!this.ready) return true;
    const ep = this.opts.endpoint.replace(/^https?:/, "");
    if (url.includes(ep) || /\/symbolicate\b|\/logs(?:\?|$)/.test(url)) return true; // ingest, Metro and Expo dev servers
    return (this.opts.network?.ignoreUrls ?? []).some((p) => (typeof p === "string" ? url.includes(p) : p.test(url)));
  }

  private isFailedStatus(status: number, rawUrl: string): boolean {
    try {
      return (this.opts.network?.isFailure ?? ((s: number) => s >= 500))(status, normaliseUrl(rawUrl));
    } catch {
      return false;
    }
  }

  /**
   * Records one request: a breadcrumb now, in call order, and an error for a failure. When the
   * body is still being read (fetch), returns a function that adds what the backend said to the
   * breadcrumb and then reports the error, since an error is sent as soon as it is queued.
   */
  private recordRequest(r: RequestInfo): ((responseBody: string) => void) | void {
    if (!this.ready) return;
    const net = this.opts.network ?? {};
    const url = normaliseUrl(r.url);
    const ms = Math.round(r.durationMs);
    const failed = r.status === undefined ? !r.aborted : this.isFailedStatus(r.status, r.url);
    const slow = ms >= (net.slowMs ?? 3000);
    const outcome = r.aborted ? "aborted" : r.timedOut ? "timed out" : r.status !== undefined ? String(r.status) : "failed";
    // Named by service (ABA-119), with what the backend said when it failed. The message keeps
    // the full URL unless the call matched a base URL, so existing trails read the same.
    const name = nameRequest(r.url, net.baseUrls);
    const data: Record<string, string | number | boolean | null> = {
      service: name.service,
      path: name.path,
      method: r.method,
      status: r.status ?? null,
      durationMs: ms,
      outcome: r.aborted ? "aborted" : r.status !== undefined ? "answered" : "unreachable",
      ...(failed && readProblemDetails(r.responseBody)),
    };
    this.breadcrumb("network", `${r.method} ${name.matched ? name.path : url} → ${outcome} (${ms}ms)`, data, failed ? "error" : slow ? "warning" : "info");
    if (!r.aborted) this.timeRequest(`${r.method} ${url}`, ms, failed);
    if (!failed) return;

    const flow = net.flows?.find(([p]) => (typeof p === "string" ? url.includes(p) : p.test(url)))?.[1];
    const cause = r.error ? normaliseError(r.error) : undefined;
    const message =
      r.status !== undefined ? `${r.method} ${url} responded ${r.status}` : `${r.method} ${url} ${r.timedOut ? "timed out" : "failed"}${cause ? `: ${cause.message}` : ""}`;
    // The first frame is our own wrapper; the rest is the code that made the request. Mark library
    // frames again without it: the wrapper on top hides the library run below it.
    const frames = markLibraryFrames(parseStack(r.stack).slice(1));
    const report = () =>
      this.captureError(
        { name: r.status !== undefined ? "HttpError" : "NetworkError", message, stack: r.stack, frames },
        { flow, handled: true, tags: { source: "network" } },
        { method: r.method, url, status: r.status, durationMs: ms },
      );
    if (!r.bodyPending) return report();
    return (responseBody: string) => {
      const backend = readProblemDetails(responseBody);
      if (backend) Object.assign(data, backend);
      report();
    };
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
    if (e.type === "session" || e.type === "metric") continue;
    if (e.type === "error" && e.request) {
      const { request: _r, ...rest } = e;
      out.push(rest);
    } else out.push(e);
  }
  return out;
}
