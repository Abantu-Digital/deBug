import { createHash } from "node:crypto";
import { Envelope, isTestEvent, markLibraryFrames, parseStack, releaseKey, type Context, type Event, type RollupIncrement, type StoredEvent } from "@debugkit/schema";
import { compareVersions, type IssueUpsert, type UserMark, type WriteStore } from "@debugkit/adapters";
import { cachedSettings, effectiveRetention } from "./admin";
import { sendAlerts } from "./alerts";
import { countryOf } from "./country";
import { classify } from "./classify";
import { assignIncidents, incidentIssueKey, type BatchError } from "./incidents";
import { culpritOf, fingerprint, titleOf } from "./fingerprint";
import { INGEST_VERSION, VERSION_HEADER } from "./version";

export * from "./fingerprint";
export { BACKGROUND, classify, evidenceOf, FOREGROUND, hostOwner, NO_EVIDENCE, issueCauses, withIssueCauses, type ClassifyOptions, type Evidence, type IssueFacts } from "./classify";
export { incidentKey, incidentIssueKey, isRequestCategory, parseIncidentIssueKey, parseIncidentKey, type IncidentKey } from "./incidents";
export { handleAdmin, effectiveRetention, cachedSettings, type AdminOptions } from "./admin";
export { countryOf } from "./country";
export { INGEST_VERSION, VERSION_HEADER } from "./version";
export { sendAlerts, SLACK_WEBHOOK } from "./alerts";
export { teamAction, hashInviteToken, publicMember, INVITE_DAYS, type TeamResult } from "./team";

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
  /** Where this envelope's user counts: "app", "crash", "issue:<fp>". */
  const scopes = new Set<string>();
  const storedEvent = (day: string, event: Event, fingerprint?: string, labels?: StoredEvent["labels"]): StoredEvent => ({
    app,
    day,
    fingerprint,
    labels,
    event,
    context,
    user: env.user,
    sessionId: env.session.id,
    receivedAt,
  });
  // Critical flows decide whether an error blocks the user. Cached, and only read when there are errors.
  const settings = env.events.some((e) => e.type === "error") ? await cachedSettings(opts.store, app) : null;
  const criticalFlows = settings?.criticalFlows ?? [];
  const hosts = settings?.hosts ?? [];
  /** This batch's errors, to group into incidents once they're all labelled. */
  const batchErrors: (BatchError & { se: StoredEvent; fp: string })[] = [];

  for (const raw of env.events) {
    const event = { ...raw, ts: sanitiseTs(raw.ts, now) } as Event;
    // Clients that don't parse stacks (curl, other SDKs) still get grouped by code location.
    if (event.type === "error") {
      if (!event.error.frames?.length && event.error.stack) event.error.frames = parseStack(event.error.stack);
      // Older SDKs marked every React Native bundle frame in-app: mark library code by name here too.
      else if (event.error.frames?.length) event.error.frames = markLibraryFrames(event.error.frames);
    }
    const day = dayOf(event.ts);
    // Session health only feeds the crash-free rollup; storing each one would cost a write per session.
    if (event.type === "session") {
      rollups.push({ app, day, dimension: "session", key: `${context.app.version || "unknown"}|${event.status}`, kind: "event", by: 1 });
      // Anyone with a session is an active user, errors or not: the denominator for crash-free users.
      scopes.add("app");
      if (event.status === "started") rollups.push({ app, day, dimension: "release", key: releaseKey(context.app), kind: "event", by: 1 });
      if (event.status === "crashed") scopes.add("crash");
      continue;
    }
    scopes.add("app");
    // Request timings: one compact event per endpoint per minute, only for the latency rollups.
    if (event.type === "metric") {
      rollups.push({ app, day, dimension: "requests", key: event.key, kind: "event", by: event.count });
      if (event.errors) rollups.push({ app, day, dimension: "requests", key: event.key, kind: "error", by: event.errors });
      event.buckets.forEach((n, i) => n && rollups.push({ app, day, dimension: "latency", key: `${event.key}|${i}`, kind: "event", by: n }));
      continue;
    }
    const kind = event.type === "error" ? "error" : "event";
    const inc = (dimension: RollupIncrement["dimension"], key: string | undefined) =>
      rollups.push({ app, day, dimension, key: key || "unknown", kind, by: 1 });

    let fp: string | undefined;
    let labels: StoredEvent["labels"];
    let se: StoredEvent | undefined;
    if (event.type === "error") {
      fp = fingerprint(event);
      // The device's own clock: breadcrumbs use it too, and sanitiseTs may have replaced event.ts.
      labels = classify({ ...event, ts: raw.ts }, { criticalFlows, hosts });
      const cur = issues.get(fp);
      se = storedEvent(day, event, fp, labels);
      const test = isTestEvent(event);
      // Test errors join no incident: they aren't a problem anyone has.
      if (!test) batchErrors.push({ ts: raw.ts, labels, se, fp });
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
        version: context.app.version,
      });
      scopes.add(`issue:${fp}`);
      inc("issue", fp);
      rollups.push({ app, day: event.ts.slice(0, 13), dimension: "issueHour", key: fp, kind, by: 1 });
      // A test error (ABA-133) counts only on its own issue: not in totals, flows, devices,
      // endpoints or labels, so the overview and failure rates don't move.
      if (test) {
        stored.push(se);
        continue;
      }
      if (event.request) inc("endpoint", `${event.request.method.toUpperCase()} ${event.request.url}`);
    }

    inc("total", "all");
    inc("flow", event.flow ?? "untagged");
    inc("os", `${context.os.name} ${context.os.version ?? ""}`.trim());
    inc("appVersion", context.app.version);
    inc("deviceModel", context.device.model);
    if (event.type === "event" && event.outcome && event.flow) {
      inc("flowOutcome", `${event.flow}|${event.outcome}`);
      if (event.step) inc("flowStep", `${event.flow}|${event.step}|${event.outcome}`);
    }
    if (event.type === "error") {
      inc("network", context.network?.type);
      inc("country", countryOf(context));
      if (labels) {
        inc("category", labels.category);
        inc("owner", labels.owner);
        inc("impact", labels.impact);
      }
    }

    stored.push(se ?? storedEvent(day, event, fp, labels));
  }

  // Incidents: one per cause, category and OS. Counted per error, per issue in it, per user, and
  // once per batch as an episode (how many separate times it happened, roughly).
  assignIncidents(batchErrors, context.os.name);
  const episodes = new Set<string>();
  for (const err of batchErrors) {
    if (!err.incident) continue;
    err.se.incident = err.incident;
    rollups.push({ app, day: err.se.day, dimension: "incident", key: err.incident, kind: "error", by: 1 });
    rollups.push({ app, day: err.se.day, dimension: "incidentIssue", key: incidentIssueKey(err.incident, err.fp), kind: "error", by: 1 });
    if (!episodes.has(err.incident)) {
      episodes.add(err.incident);
      rollups.push({ app, day: err.se.day, dimension: "incident", key: err.incident, kind: "event", by: 1 });
    }
    scopes.add(`incident:${err.incident}`);
  }

  await opts.store.registerApp(app);
  const retentionDays = stored.length ? await effectiveRetention(opts.store, app, opts.retentionDays) : undefined;
  const [, outcome] = await Promise.all([
    stored.length ? opts.store.writeEvents(stored, { retentionDays }) : undefined,
    opts.store.upsertIssues([...issues.values()]),
    opts.store.incrementRollups(rollups),
    markUsers(opts.store, app, env.user?.id ?? env.user?.anonymousId ?? env.session.id, scopes, dayOf(receivedAt)),
    noteVersions(opts.store, app, env.sdk.version, receivedAt),
  ]);

  // Test errors (ABA-133) never alert.
  const real = (fp: string) => !isTestEvent(issues.get(fp)?.lastEvent.event);
  const alerting = outcome && { ...outcome, created: outcome.created.filter(real), regressed: outcome.regressed.filter(real) };
  if (alerting && (alerting.created.length || alerting.regressed.length)) await sendAlerts(app, alerting, issues, settings);

  return { status: 202, body: { ok: true, accepted: env.events.length } };
}

/**
 * What this instance last recorded (or tried to) per store and app, so a steady app costs one
 * versions write a day, not one per batch, and a store that's down isn't retried on every batch.
 */
const recordedVersions = new WeakMap<WriteStore, Map<string, { sdk?: string; at: number }>>();
const VERSIONS_REFRESH_MS = 86_400_000;
const VERSIONS_RETRY_MS = 600_000;

/**
 * Record the app's SDK version and this ingest's, when the SDK is newer than what this instance last
 * recorded, or a day has passed. A failure here never fails the envelope; it's tried again in ten minutes.
 */
async function noteVersions(store: WriteStore, app: string, sdk: string, at: string) {
  let byApp = recordedVersions.get(store);
  if (!byApp) recordedVersions.set(store, (byApp = new Map()));
  const had = byApp.get(app);
  const now = Date.parse(at);
  if (had && compareVersions(sdk, had.sdk) <= 0 && now - had.at < VERSIONS_REFRESH_MS) return;
  const newest = compareVersions(sdk, had?.sdk) > 0 ? sdk : had?.sdk;
  try {
    await store.recordVersions(app, { sdk, ingest: INGEST_VERSION, at });
    byApp.set(app, { sdk: newest, at: now });
  } catch (err) {
    // Back off: counted as written a day ago less ten minutes, so it's tried again then.
    byApp.set(app, { sdk: newest, at: now - VERSIONS_REFRESH_MS + VERSIONS_RETRY_MS });
    console.warn("[deBug] couldn't record versions", err);
  }
}

/** Recently written (scope, member, day) marks, so a busy user costs one write per day, not per batch. */
const seenMarks = new Set<string>();

/**
 * Count the envelope's user in each scope. The id is hashed, so the store never holds user ids,
 * and each (scope, user, day) is written at most once per function instance.
 */
async function markUsers(store: WriteStore, app: string, who: string, scopes: Set<string>, day: string) {
  if (!scopes.size) return;
  const member = createHash("sha256").update(`${app}\u0000${who}`).digest("hex").slice(0, 24);
  const marks: UserMark[] = [];
  for (const scope of scopes) {
    const k = `${app}|${scope}|${member}|${day}`;
    if (seenMarks.has(k)) continue;
    seenMarks.add(k);
    marks.push({ scope, member, day });
  }
  if (seenMarks.size > 50_000) seenMarks.clear();
  if (marks.length) await store.markUsers(app, marks);
}

/** On every ingest response: CORS for browser SDKs, and this ingest's version, readable from the browser too. */
export const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-debug-key",
  "access-control-expose-headers": VERSION_HEADER,
  "access-control-max-age": "86400",
  [VERSION_HEADER]: INGEST_VERSION,
};
