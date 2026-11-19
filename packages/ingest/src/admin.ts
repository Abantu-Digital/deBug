import { timingSafeEqual } from "node:crypto";
import { teamAction } from "./team";
import { MAX_RETENTION_DAYS, MIN_RETENTION_DAYS, type AlertSettings, type AppSettings, type WriteStore } from "@debugkit/adapters";
import { appLabel, validAppName, validHostNames } from "@debugkit/schema";
import { SLACK_WEBHOOK } from "./alerts";

/** Used when neither the app's settings nor the deployment set a retention period. */
export const DEFAULT_RETENTION_DAYS = 30;

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; settings: AppSettings | null }>();

/**
 * The retention period for an app: its stored setting, else the deployment's default. Settings
 * are cached for a minute per function instance, so a change from the dashboard applies to new
 * events within about a minute, without a read on every request.
 */
export async function cachedSettings(store: WriteStore, app: string): Promise<AppSettings | null> {
  const hit = cache.get(app);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.settings;
  let settings: AppSettings | null;
  try {
    settings = await store.getSettings(app);
  } catch {
    settings = null; // never fail ingest because settings couldn't be read
  }
  cache.set(app, { at: Date.now(), settings });
  return settings;
}

export async function effectiveRetention(store: WriteStore, app: string, fallback?: number): Promise<number> {
  return (await cachedSettings(store, app))?.retentionDays ?? fallback ?? DEFAULT_RETENTION_DAYS;
}

/** Settings as the dashboard sees them: the Slack webhook is a secret, so only its end is shown. */
function masked(s: AppSettings | null): AppSettings | null {
  if (!s?.alerts?.slackWebhookUrl) return s;
  return { ...s, alerts: { ...s.alerts, slackWebhookUrl: `https://hooks.slack.com/…${s.alerts.slackWebhookUrl.slice(-4)}` } };
}

const FLOW = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/;

/** Validate the fields a PUT /admin/settings may change. Returns the patch, or an error message. */
function settingsPatch(body: Record<string, unknown>, current: AppSettings | null): AppSettings | string {
  const patch: AppSettings = {};
  if (body.retentionDays !== undefined) {
    const days = Number(body.retentionDays);
    if (!Number.isInteger(days) || days < MIN_RETENTION_DAYS || days > MAX_RETENTION_DAYS) return `retentionDays must be a whole number from ${MIN_RETENTION_DAYS} to ${MAX_RETENTION_DAYS}`;
    patch.retentionDays = days;
  }
  if (body.criticalFlows !== undefined) {
    if (!Array.isArray(body.criticalFlows) || body.criticalFlows.length > 30 || !body.criticalFlows.every((f) => typeof f === "string" && f.length <= 64 && FLOW.test(f)))
      return "criticalFlows must be up to 30 dotted lowercase flow names, like checkout.payment";
    patch.criticalFlows = [...new Set(body.criticalFlows as string[])];
  }
  if (body.alerts !== undefined) {
    const a = body.alerts as Record<string, unknown>;
    if (!a || typeof a !== "object") return "alerts must be an object";
    const next: AlertSettings = {};
    const url = a.slackWebhookUrl;
    if (typeof url === "string" && url.includes("…")) next.slackWebhookUrl = current?.alerts?.slackWebhookUrl; // the masked value: keep it
    else if (url === "" || url === null || url === undefined) next.slackWebhookUrl = undefined;
    else if (typeof url === "string" && SLACK_WEBHOOK.test(url)) next.slackWebhookUrl = url;
    else return "slackWebhookUrl must be a Slack incoming-webhook URL (https://hooks.slack.com/services/…)";
    for (const k of ["newIssues", "regressions", "onlyCriticalFlows"] as const) if (typeof a[k] === "boolean") next[k] = a[k] as boolean;
    if (typeof a.dashboardUrl === "string" && a.dashboardUrl) {
      if (!/^https?:\/\/[^\s]{3,300}$/.test(a.dashboardUrl)) return "dashboardUrl must be an http(s) URL";
      next.dashboardUrl = a.dashboardUrl;
    }
    patch.alerts = next;
  }
  if (body.displayName !== undefined) {
    const name = validAppName(body.displayName);
    if (typeof name === "string") return name;
    // Kept as "" rather than removed: Firestore's merge would leave the old name.
    patch.displayName = name.name;
  }
  if (body.hosts !== undefined) {
    const hosts = validHostNames(body.hosts);
    if (typeof hosts === "string") return hosts;
    patch.hosts = hosts;
  }
  return Object.keys(patch).length ? patch : "nothing to change";
}

export interface AdminOptions {
  store: WriteStore;
  /** Shared secret for the dashboard (DEBUG_ADMIN_TOKEN). Without it, the admin routes are off. */
  adminToken?: string;
  retentionDays?: number;
}

interface AdminResult {
  status: number;
  body: Record<string, unknown>;
}

function authorized(header: string | undefined, token: string): boolean {
  const given = Buffer.from((header ?? "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

const APP_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/**
 * Settings routes the dashboard calls, so the dashboard itself never needs write access to the
 * data. Mounted under /admin on the ingest function:
 *
 *   GET  /admin/settings?app=…              { settings, retentionDays }
 *   PUT  /admin/settings   { app, displayName?, retentionDays?, criticalFlows?, alerts?, hosts? }
 *   POST /admin/alert-test { app }           send a test message to the app's Slack webhook
 *   POST /admin/restamp    { app, cursor? }  re-stamp existing events' expiry, one page per call
 *   PUT  /admin/issue      { app, fingerprint, status: open|resolved|ignored, resolvedIn? }
 *   POST /admin/team/invite { role, email?, invitedBy }      { token, invite } (the token only here)
 *   POST /admin/team/accept { token, email, name?, passwordHash }
 *   POST /admin/team/role   { email, role }
 *   POST /admin/team/remove { email }
 *   POST /admin/team/revoke { id }
 */
export async function handleAdmin(
  req: { method: string; path: string; query?: Record<string, string | undefined>; body: string; authorization?: string },
  opts: AdminOptions,
): Promise<AdminResult> {
  if (!opts.adminToken || opts.adminToken.length < 16) return { status: 404, body: { ok: false, error: "admin routes are off (set DEBUG_ADMIN_TOKEN)" } };
  if (!authorized(req.authorization, opts.adminToken)) return { status: 401, body: { ok: false, error: "unauthorized" } };

  let body: Record<string, unknown> = {};
  if (req.method !== "GET" && req.body) {
    try {
      body = JSON.parse(req.body) as Record<string, unknown>;
    } catch {
      return { status: 400, body: { ok: false, error: "invalid json" } };
    }
  }
  const route = req.path.replace(/\/+$/, "").replace(/^.*\/admin/, "");
  // The team is the whole deployment's, not one app's.
  if (route.startsWith("/team/")) {
    if (req.method !== "POST") return { status: 405, body: { ok: false, error: "use POST" } };
    return teamAction(opts.store, route.slice("/team/".length), body);
  }
  const app = String((req.method === "GET" ? req.query?.app : body.app) ?? "");
  if (!APP_ID.test(app)) return { status: 400, body: { ok: false, error: "app is required" } };

  if (route === "/settings" && req.method === "GET") {
    const settings = await opts.store.getSettings(app);
    return { status: 200, body: { ok: true, settings: masked(settings), retentionDays: settings?.retentionDays ?? opts.retentionDays ?? DEFAULT_RETENTION_DAYS } };
  }
  if (route === "/settings" && (req.method === "PUT" || req.method === "POST")) {
    const current = await opts.store.getSettings(app);
    const patch = settingsPatch(body, current);
    if (typeof patch === "string") return { status: 400, body: { ok: false, error: patch } };
    const settings = await opts.store.putSettings(app, patch);
    cache.delete(app);
    return { status: 200, body: { ok: true, settings: masked(settings), retentionDays: settings.retentionDays ?? opts.retentionDays ?? DEFAULT_RETENTION_DAYS } };
  }
  if (route === "/alert-test" && req.method === "POST") {
    const current = await opts.store.getSettings(app);
    const url = current?.alerts?.slackWebhookUrl;
    if (!url || !SLACK_WEBHOOK.test(url)) return { status: 400, body: { ok: false, error: "No Slack webhook is set for this app" } };
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: `:white_check_mark: deBug alerts for *${appLabel(app, current?.displayName)}* are working.` }), signal: AbortSignal.timeout(5000) }).catch((e: Error) => e);
    if (res instanceof Error || !res.ok) return { status: 502, body: { ok: false, error: `Slack didn't accept it: ${res instanceof Error ? res.message : res.status}` } };
    return { status: 200, body: { ok: true } };
  }
  if (route === "/restamp" && req.method === "POST") {
    const days = await effectiveRetention(opts.store, app, opts.retentionDays);
    const out = await opts.store.restampExpiry(app, days, { cursor: typeof body.cursor === "string" ? body.cursor : undefined });
    return { status: 200, body: { ok: true, retentionDays: days, ...out } };
  }
  if (route === "/issue" && (req.method === "PUT" || req.method === "POST")) {
    const fingerprint = String(body.fingerprint ?? "");
    const status = String(body.status ?? "");
    if (!/^[a-f0-9]{8,64}$/.test(fingerprint)) return { status: 400, body: { ok: false, error: "fingerprint is required" } };
    if (status !== "open" && status !== "resolved" && status !== "ignored") return { status: 400, body: { ok: false, error: "status must be open, resolved or ignored" } };
    const resolvedIn = typeof body.resolvedIn === "string" && body.resolvedIn.trim() ? body.resolvedIn.trim().slice(0, 100) : undefined;
    const issue = await opts.store.setIssueStatus(app, fingerprint, { status, resolvedIn: status === "resolved" ? resolvedIn : undefined });
    if (!issue) return { status: 404, body: { ok: false, error: "no such issue" } };
    return { status: 200, body: { ok: true, status: issue.status, resolvedIn: issue.resolvedIn ?? null } };
  }
  return { status: 404, body: { ok: false, error: "not found" } };
}

/** For tests: forget cached settings. */
export function clearSettingsCache() {
  cache.clear();
}
