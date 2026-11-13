import { Envelope, parseStack, type Context, type Event, type RollupIncrement, type StoredEvent } from "@debugkit/schema";
import type { IssueUpsert, WriteStore } from "@debugkit/adapters";
import { effectiveRetention } from "./admin";
import { culpritOf, fingerprint, titleOf } from "./fingerprint";

export * from "./fingerprint";
export { handleAdmin, effectiveRetention, type AdminOptions } from "./admin";

export interface IngestOptions {
  store: WriteStore;
  /**
   * Map of public ingest key → app id it may write to. A key can't write to another app.
   * The app id "*" lets a key write to any app (local development only).
   * Parse from env with `parseIngestKeys(process.env.DEBUG_INGEST_KEYS)`.
   */
  keys: Record<string, string>;
  /** Hard cap on accepted payload size in bytes. Default 512 KB. */
  maxBytes?: number;
  /**
   * How long raw events are kept when the app has no retention setting yet (set at `init`,
   * usually from DEBUG_RETENTION_DAYS). The dashboard's Settings page overrides it per app.
   */
  retentionDays?: number;
  now?: () => Date;
}

export interface IngestResult {
  status: number;
  body: { ok: boolean; accepted?: number; error?: string; issues?: unknown };
}

/** "pk_abc:megaton-native,pk_def:other-app" → { pk_abc: "megaton-native", ... } */
export function parseIngestKeys(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [key, app] = pair.split(":");
    if (key && app) out[key] = app;
  }
  return out;
}

const dayOf = (iso: string) => iso.slice(0, 10);

/** Clamp client clocks: events claiming to be from the future or very old are pinned to receipt time. */
function sanitiseTs(ts: string, now: Date): string {
  const t = Date.parse(ts);
  const n = now.getTime();
  if (Number.isNaN(t) || t > n + 5 * 60_000 || t < n - 7 * 86_400_000) return now.toISOString();
  return new Date(t).toISOString();
}

function enrich(ctx: Context): Context {
  return {
    ...ctx,
    os: { ...ctx.os, name: ctx.os.name.toLowerCase() },
    runtime: { ...ctx.runtime, name: ctx.runtime.name.toLowerCase() },
  };
}

/** Platform-agnostic ingest. Wrap with ./firebase or ./lambda to deploy. */
export async function ingest(rawBody: string, ingestKey: string | undefined, opts: IngestOptions): Promise<IngestResult> {
  const now = opts.now?.() ?? new Date();
  if (!ingestKey || !opts.keys[ingestKey]) return { status: 401, body: { ok: false, error: "invalid ingest key" } };
  if (Buffer.byteLength(rawBody) > (opts.maxBytes ?? 512 * 1024)) return { status: 413, body: { ok: false, error: "payload too large" } };

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { ok: false, error: "invalid json" } };
  }
  const parsed = Envelope.safeParse(json);
  if (!parsed.success) return { status: 400, body: { ok: false, error: "invalid envelope", issues: parsed.error.flatten() } };

  const env = parsed.data;
  const app = env.context.app.id;
  if (opts.keys[ingestKey] !== app && opts.keys[ingestKey] !== "*") return { status: 403, body: { ok: false, error: `key not allowed for app ${app}` } };

  const context = enrich(env.context);
  const receivedAt = now.toISOString();
  const stored: StoredEvent[] = [];
  const rollups: RollupIncrement[] = [];
  const issues = new Map<string, IssueUpsert>();

  for (const raw of env.events) {
    const event = { ...raw, ts: sanitiseTs(raw.ts, now) } as Event;
    // Clients that don't parse stacks (curl, other SDKs) still get grouped by code location.
    if (event.type === "error" && !event.error.frames?.length && event.error.stack) event.error.frames = parseStack(event.error.stack);
    const day = dayOf(event.ts);
    // Session health only feeds the crash-free rollup; storing each one would cost a write per session.
    if (event.type === "session") {
      rollups.push({ app, day, dimension: "session", key: `${context.app.version || "unknown"}|${event.status}`, kind: "event", by: 1 });
      continue;
    }
    const kind = event.type === "error" ? "error" : "event";
    const inc = (dimension: RollupIncrement["dimension"], key: string | undefined) =>
      rollups.push({ app, day, dimension, key: key || "unknown", kind, by: 1 });

    let fp: string | undefined;
    if (event.type === "error") {
      fp = fingerprint(event);
      const cur = issues.get(fp);
      const se: StoredEvent = { app, day, fingerprint: fp, event, context, user: env.user, sessionId: env.session.id, receivedAt };
      issues.set(fp, {
        app,
        fingerprint: fp,
        title: titleOf(event),
        culprit: culpritOf(event),
        flow: event.flow,
        by: (cur?.by ?? 0) + 1,
        ts: cur && cur.ts > event.ts ? cur.ts : event.ts,
        firstTs: cur && cur.firstTs < event.ts ? cur.firstTs : event.ts,
        lastEvent: cur && cur.ts > event.ts ? cur.lastEvent : se,
      });
      inc("issue", fp);
      if (event.request) inc("endpoint", `${event.request.method.toUpperCase()} ${event.request.url}`);
      rollups.push({ app, day: event.ts.slice(0, 13), dimension: "issueHour", key: fp, kind, by: 1 });
    }

    inc("total", "all");
    inc("flow", event.flow ?? "untagged");
    inc("os", `${context.os.name} ${context.os.version ?? ""}`.trim());
    inc("appVersion", context.app.version);
    inc("deviceModel", context.device.model);
    if (event.type === "event" && event.outcome && event.flow) inc("flowOutcome", `${event.flow}|${event.outcome}`);

    stored.push({ app, day, fingerprint: fp, event, context, user: env.user, sessionId: env.session.id, receivedAt });
  }

  await opts.store.registerApp(app);
  const retentionDays = stored.length ? await effectiveRetention(opts.store, app, opts.retentionDays) : undefined;
  await Promise.all([
    stored.length ? opts.store.writeEvents(stored, { retentionDays }) : undefined,
    opts.store.upsertIssues([...issues.values()]),
    opts.store.incrementRollups(rollups),
  ]);

  return { status: 202, body: { ok: true, accepted: env.events.length } };
}

export const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-debug-key",
  "access-control-max-age": "86400",
};
