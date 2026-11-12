import type { Breadcrumb, ContextInput, EnvelopeInput, EventInput, Severity } from "@debug/schema";
import { parseStack } from "@debug/schema";
import type { ContextPatch } from "./context";

export const SDK_NAME = "@debug/sdk";
export const SDK_VERSION = "0.1.0";

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
  /** Platform context, e.g. expoContext({...}) or browserContext(). */
  context?: ContextPatch;
  /** Capture uncaught errors and unhandled promise rejections. Default true. */
  captureGlobalErrors?: boolean;
  storage?: QueueStorage;
  flushIntervalMs?: number;
  maxBatch?: number;
  maxBreadcrumbs?: number;
  /** Drop or edit events before they are sent (PII scrubbing). Return null to drop. */
  beforeSend?: (e: EventInput) => EventInput | null;
  fetch?: typeof fetch;
  debug?: boolean;
}

export interface EventMeta {
  flow?: string;
  step?: string;
  tags?: Record<string, string>;
}

const QUEUE_KEY = "@debug/queue";
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

  init(options: InitOptions): this {
    this.opts = { flushIntervalMs: 5000, maxBatch: 50, maxBreadcrumbs: 30, captureGlobalErrors: true, ...options };
    this.ready = true;
    void this.restore();
    if (this.opts.captureGlobalErrors) this.installGlobalHandlers();
    this.timer = setInterval(() => void this.flush(), this.opts.flushIntervalMs);
    (this.timer as { unref?: () => void }).unref?.();
    return this;
  }

  setUser(id: string | undefined) {
    this.user = { ...this.user, id };
  }

  breadcrumb(category: Breadcrumb["category"], message: string, data?: Record<string, string | number | boolean | null>, level: Breadcrumb["level"] = "info") {
    this.crumbs.push({ ts: now(), category, message: message.slice(0, 500), data, level });
    if (this.crumbs.length > (this.opts?.maxBreadcrumbs ?? 30)) this.crumbs.shift();
  }

  /** Log an error. `flow` is the part of the app it belongs to, e.g. "auth.login". */
  error(err: unknown, meta: EventMeta & { severity?: Severity; handled?: boolean } = {}) {
    const e = normaliseError(err);
    this.enqueue({
      type: "error",
      id: uid(),
      ts: now(),
      flow: meta.flow,
      step: meta.step,
      tags: meta.tags,
      severity: meta.severity,
      handled: meta.handled ?? true,
      error: { name: e.name, message: e.message, stack: e.stack, frames: parseStack(e.stack) },
      breadcrumbs: [...this.crumbs],
    });
  }

  /** Log a custom event. Use outcome to let deBug compute failure rates per flow. */
  event(name: string, meta: EventMeta & { outcome?: "success" | "failure" | "abandoned"; props?: Record<string, string | number | boolean | null> } = {}) {
    this.breadcrumb("event", name, meta.props);
    this.enqueue({ type: "event", id: uid(), ts: now(), name, flow: meta.flow, step: meta.step, tags: meta.tags, outcome: meta.outcome, props: meta.props });
  }

  /** Wraps an async step: logs success, or failure + the error, against a flow. */
  async track<T>(flow: string, step: string, fn: () => Promise<T>): Promise<T> {
    try {
      const out = await fn();
      this.event(`${flow}.${step}`, { flow, step, outcome: "success" });
      return out;
    } catch (err) {
      this.event(`${flow}.${step}`, { flow, step, outcome: "failure" });
      this.error(err, { flow, step });
      throw err;
    }
  }

  async flush(): Promise<void> {
    if (!this.ready || this.flushing || this.queue.length === 0 || Date.now() < this.backoffUntil) return this.flushing;
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

  close() {
    if (this.timer) clearInterval(this.timer);
    return this.flush();
  }

  /* ---------------- internals ---------------- */

  private enqueue(e: EventInput) {
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

  private async send(events: EventInput[]) {
    const body: EnvelopeInput = {
      sdk: { name: SDK_NAME, version: SDK_VERSION },
      context: this.buildContext(),
      user: this.user,
      session: this.session,
      events,
    };
    const f = this.opts.fetch ?? fetch;
    const res = await f(this.opts.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-debug-key": this.opts.ingestKey },
      body: JSON.stringify(body),
    });
    // 4xx (other than 429) means the payload will never be accepted: drop it instead of retrying forever.
    if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      this.log(`ingest rejected batch (${res.status})`, await res.text().catch(() => ""));
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
    const g = globalThis as Record<string, any>;
    // React Native
    if (g.ErrorUtils?.setGlobalHandler) {
      const prev = g.ErrorUtils.getGlobalHandler?.();
      g.ErrorUtils.setGlobalHandler((err: unknown, isFatal?: boolean) => {
        this.error(err, { handled: false, severity: isFatal ? "critical" : undefined });
        void this.flush();
        prev?.(err, isFatal);
      });
    }
    // Browser
    if (typeof g.addEventListener === "function") {
      g.addEventListener("error", (ev: { error?: unknown; message?: string }) => this.error(ev.error ?? ev.message, { handled: false }));
      g.addEventListener("unhandledrejection", (ev: { reason?: unknown }) => this.error(ev.reason, { handled: false }));
    }
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
