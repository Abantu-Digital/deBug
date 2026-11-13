import { timingSafeEqual } from "node:crypto";
import { MAX_RETENTION_DAYS, MIN_RETENTION_DAYS, type AppSettings, type WriteStore } from "@debugkit/adapters";

/** Used when neither the app's settings nor the deployment set a retention period. */
export const DEFAULT_RETENTION_DAYS = 30;

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; settings: AppSettings | null }>();

/**
 * The retention period for an app: its stored setting, else the deployment's default. Settings
 * are cached for a minute per function instance, so a change from the dashboard applies to new
 * events within about a minute, without a read on every request.
 */
export async function effectiveRetention(store: WriteStore, app: string, fallback?: number): Promise<number> {
  const hit = cache.get(app);
  let settings = hit && Date.now() - hit.at < CACHE_MS ? hit.settings : undefined;
  if (settings === undefined) {
    try {
      settings = await store.getSettings(app);
    } catch {
      settings = null; // never fail ingest because settings couldn't be read
    }
    cache.set(app, { at: Date.now(), settings });
  }
  return settings?.retentionDays ?? fallback ?? DEFAULT_RETENTION_DAYS;
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
 *   PUT  /admin/settings   { app, retentionDays }
 *   POST /admin/restamp    { app, cursor? }  re-stamp existing events' expiry, one page per call
 *   PUT  /admin/issue      { app, fingerprint, status: open|resolved|ignored, resolvedIn? }
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
  const app = String((req.method === "GET" ? req.query?.app : body.app) ?? "");
  if (!APP_ID.test(app)) return { status: 400, body: { ok: false, error: "app is required" } };
  const route = req.path.replace(/\/+$/, "").replace(/^.*\/admin/, "");

  if (route === "/settings" && req.method === "GET") {
    const settings = await opts.store.getSettings(app);
    return { status: 200, body: { ok: true, settings, retentionDays: settings?.retentionDays ?? opts.retentionDays ?? DEFAULT_RETENTION_DAYS } };
  }
  if (route === "/settings" && (req.method === "PUT" || req.method === "POST")) {
    const days = Number(body.retentionDays);
    if (!Number.isInteger(days) || days < MIN_RETENTION_DAYS || days > MAX_RETENTION_DAYS)
      return { status: 400, body: { ok: false, error: `retentionDays must be a whole number from ${MIN_RETENTION_DAYS} to ${MAX_RETENTION_DAYS}` } };
    const settings = await opts.store.putSettings(app, { retentionDays: days });
    cache.delete(app);
    return { status: 200, body: { ok: true, settings, retentionDays: days } };
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
