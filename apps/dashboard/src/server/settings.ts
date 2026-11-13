import type { AlertSettings, AppSettings, RestampResult } from "@debugkit/adapters";
import { MAX_RETENTION_DAYS, MIN_RETENTION_DAYS } from "@debugkit/adapters";
import { config } from "./config";
import { getLocalWriteStore, getStore } from "./store";

/**
 * Settings changes. The dashboard's database credentials are read-only, so on Firestore and
 * DynamoDB changes go through the ingest function's admin routes (DEBUG_ADMIN_URL with
 * DEBUG_ADMIN_TOKEN). In demo and memory mode the in-process store takes them directly.
 */
export type SettingsWriter = "admin" | "local" | "none";

export function settingsWriter(): SettingsWriter {
  const c = config();
  if (c.store === "demo" || c.store === "memory") return "local";
  return c.adminUrl && c.adminToken ? "admin" : "none";
}

async function admin<T>(method: "GET" | "PUT" | "POST", route: string, body?: unknown, query?: Record<string, string>): Promise<T> {
  const c = config();
  const url = new URL(`${c.adminUrl}${route}`);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${c.adminToken}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `The ingest function answered ${res.status}`);
  return json;
}

export interface SettingsView {
  app: string;
  retentionDays: number | null;
  criticalFlows: string[];
  /** The Slack webhook is shown masked ("https://hooks.slack.com/…abcd"). */
  alerts: AlertSettings;
  source: "setting" | "default" | "unknown";
  updatedAt?: string;
  writer: SettingsWriter;
  /** When changes can't be made, why. */
  note?: string;
}

export async function readSettings(app: string): Promise<SettingsView> {
  const writer = settingsWriter();
  const c = config();
  if (writer === "admin") {
    try {
      const out = await admin<{ settings: AppSettings | null; retentionDays: number }>("GET", "/settings", undefined, { app });
      return {
        app,
        retentionDays: out.retentionDays,
        criticalFlows: out.settings?.criticalFlows ?? [],
        alerts: out.settings?.alerts ?? {},
        source: out.settings?.retentionDays ? "setting" : "default",
        updatedAt: out.settings?.updatedAt,
        writer,
      };
    } catch (err) {
      return { app, retentionDays: c.retentionDays ?? null, criticalFlows: [], alerts: {}, source: c.retentionDays ? "default" : "unknown", writer, note: `Couldn't reach the ingest function: ${(err as Error).message}` };
    }
  }
  const s = await (await getStore()).getSettings(app).catch(() => null);
  const hook = s?.alerts?.slackWebhookUrl;
  return {
    app,
    retentionDays: s?.retentionDays ?? c.retentionDays ?? (writer === "local" ? 30 : null),
    criticalFlows: s?.criticalFlows ?? [],
    alerts: { ...s?.alerts, slackWebhookUrl: hook ? `https://hooks.slack.com/…${hook.slice(-4)}` : undefined },
    source: s?.retentionDays ? "setting" : c.retentionDays || writer === "local" ? "default" : "unknown",
    updatedAt: s?.updatedAt,
    writer,
    note: writer === "none" ? "Changing settings needs DEBUG_ADMIN_URL and DEBUG_ADMIN_TOKEN (npx debugkit init sets them)." : undefined,
  };
}

export function validRetention(days: unknown): number {
  const n = Number(days);
  if (!Number.isInteger(n) || n < MIN_RETENTION_DAYS || n > MAX_RETENTION_DAYS) throw new Error(`Retention must be a whole number of days from ${MIN_RETENTION_DAYS} to ${MAX_RETENTION_DAYS}.`);
  return n;
}

export async function writeRetention(app: string, days: number): Promise<SettingsView> {
  const writer = settingsWriter();
  if (writer === "admin") await admin("PUT", "/settings", { app, retentionDays: days });
  else if (writer === "local") await (await getLocalWriteStore())!.putSettings(app, { retentionDays: days });
  else throw new Error("Settings can't be changed from this dashboard: DEBUG_ADMIN_URL and DEBUG_ADMIN_TOKEN aren't set.");
  return readSettings(app);
}

/** Change critical flows and/or alert settings. Validation happens in the ingest function (or here, locally). */
export async function writeSettings(app: string, patch: { criticalFlows?: string[]; alerts?: AlertSettings }): Promise<SettingsView> {
  const writer = settingsWriter();
  if (writer === "admin") await admin("PUT", "/settings", { app, ...patch });
  else if (writer === "local") {
    const store = (await getLocalWriteStore())!;
    const cur = await store.getSettings(app);
    const url = patch.alerts?.slackWebhookUrl;
    if (patch.alerts && url && !url.includes("…") && !/^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{10,200}$/.test(url))
      throw new Error("Use a Slack incoming-webhook URL (https://hooks.slack.com/services/…).");
    const alerts = patch.alerts ? { ...patch.alerts, slackWebhookUrl: url?.includes("…") ? cur?.alerts?.slackWebhookUrl : url || undefined } : undefined;
    await store.putSettings(app, { ...(patch.criticalFlows ? { criticalFlows: patch.criticalFlows } : {}), ...(alerts ? { alerts } : {}) });
  } else throw new Error("Settings can't be changed from this dashboard: DEBUG_ADMIN_URL and DEBUG_ADMIN_TOKEN aren't set.");
  return readSettings(app);
}

export async function testAlert(app: string): Promise<void> {
  if (settingsWriter() !== "admin") throw new Error("Test alerts are sent by your ingest function, so they need a cloud setup (not demo or local mode).");
  await admin("POST", "/alert-test", { app });
}

/** Open, resolve (optionally "fixed in <version>") or ignore an issue. */
export async function writeIssueStatus(app: string, fingerprint: string, status: "open" | "resolved" | "ignored", resolvedIn?: string) {
  const writer = settingsWriter();
  if (writer === "admin") return admin<{ status: string; resolvedIn: string | null }>("PUT", "/issue", { app, fingerprint, status, resolvedIn });
  if (writer === "local") {
    const issue = await (await getLocalWriteStore())!.setIssueStatus(app, fingerprint, { status, resolvedIn });
    if (!issue) throw new Error("No such issue.");
    return { status: issue.status, resolvedIn: issue.resolvedIn ?? null };
  }
  throw new Error("Issue status can't be changed from this dashboard: DEBUG_ADMIN_URL and DEBUG_ADMIN_TOKEN aren't set.");
}

/** One page of re-stamping existing events with the current retention. */
export async function restampStep(app: string, cursor?: string): Promise<RestampResult> {
  const writer = settingsWriter();
  if (writer === "admin") return admin<RestampResult>("POST", "/restamp", { app, cursor });
  if (writer === "local") {
    const store = (await getLocalWriteStore())!;
    const days = (await store.getSettings(app))?.retentionDays ?? config().retentionDays ?? 30;
    return store.restampExpiry(app, days, { cursor });
  }
  throw new Error("Settings can't be changed from this dashboard.");
}
