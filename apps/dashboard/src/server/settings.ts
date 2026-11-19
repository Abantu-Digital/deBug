import type { AlertSettings, AppSettings, RestampResult } from "@debugkit/adapters";
import { normaliseHostMatch, validAppName, validHostNames, type HostName } from "@debugkit/schema";
import { MAX_RETENTION_DAYS, MIN_RETENTION_DAYS } from "@debugkit/adapters";
import { config } from "./config";
import { clearStoreCache, getLocalWriteStore, getStore } from "./store";

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
  // A change (status, settings) has landed: drop what this server kept from before it.
  if (method === "PUT") clearStoreCache();
  return json;
}

export interface SettingsView {
  app: string;
  /** What people see the app as; "" shows the id. */
  displayName: string;
  retentionDays: number | null;
  criticalFlows: string[];
  /** The Slack webhook is shown masked ("https://hooks.slack.com/…abcd"). */
  alerts: AlertSettings;
  hosts: HostName[];
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
        displayName: out.settings?.displayName ?? "",
        retentionDays: out.retentionDays,
        criticalFlows: out.settings?.criticalFlows ?? [],
        alerts: out.settings?.alerts ?? {},
        hosts: out.settings?.hosts ?? [],
        source: out.settings?.retentionDays ? "setting" : "default",
        updatedAt: out.settings?.updatedAt,
        writer,
      };
    } catch (err) {
      return { app, displayName: "", retentionDays: c.retentionDays ?? null, criticalFlows: [], alerts: {}, hosts: [], source: c.retentionDays ? "default" : "unknown", writer, note: `Couldn't reach the ingest function: ${(err as Error).message}` };
    }
  }
  const s = await (await getStore()).getSettings(app).catch(() => null);
  const hook = s?.alerts?.slackWebhookUrl;
  return {
    app,
    displayName: s?.displayName ?? "",
    retentionDays: s?.retentionDays ?? c.retentionDays ?? (writer === "local" ? 30 : null),
    criticalFlows: s?.criticalFlows ?? [],
    alerts: { ...s?.alerts, slackWebhookUrl: hook ? `https://hooks.slack.com/…${hook.slice(-4)}` : undefined },
    hosts: s?.hosts ?? [],
    source: s?.retentionDays ? "setting" : c.retentionDays || writer === "local" ? "default" : "unknown",
    updatedAt: s?.updatedAt,
    writer,
    note: writer === "none" ? "Changing settings needs DEBUG_ADMIN_URL and DEBUG_ADMIN_TOKEN (npx debugkit init sets them)." : undefined,
  };
}

/** Every app's display name, by id: those with none set are left out (show the id). */
export async function appNames(apps: readonly string[]): Promise<Record<string, string>> {
  const store = await getStore();
  const names = await Promise.all(apps.map((a) => store.getSettings(a).then((s) => s?.displayName?.trim() ?? "", () => "")));
  return Object.fromEntries(apps.map((a, i) => [a, names[i]!]).filter(([, n]) => n));
}

/** Hosts the app called in the last 30 days, busiest first: suggestions for naming them. */
export async function seenHosts(app: string, now = Date.now()): Promise<string[]> {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const store = await getStore();
  const [from, to] = [day(now - 30 * 86_400_000), day(now)];
  // Timed requests and failed ones: keys are "<METHOD> <host/path>" in both.
  const [timed, failed] = await Promise.all([store.getRollups(app, "requests", from, to).catch(() => []), store.getRollups(app, "endpoint", from, to).catch(() => [])]);
  const counts = new Map<string, number>();
  for (const r of [...timed, ...failed]) {
    const host = normaliseHostMatch(r.key.split(" ")[1] ?? "").split("/")[0];
    if (host) counts.set(host, (counts.get(host) ?? 0) + r.events + r.errors);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([h]) => h);
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

/** Change the display name, critical flows, alert settings and/or host names. Validation happens in the ingest function (or here, locally). */
export async function writeSettings(app: string, patch: { displayName?: string; criticalFlows?: string[]; alerts?: AlertSettings; hosts?: HostName[] }): Promise<SettingsView> {
  const writer = settingsWriter();
  if (writer === "admin") {
    await admin("PUT", "/settings", { app, ...patch }).catch((err: Error) => {
      // An ingest function from before display names ignores the field, then finds nothing to change.
      if (patch.displayName !== undefined && /nothing to change/i.test(err.message))
        throw new Error("Your ingest function is older than app names: upgrade it with npx debugkit upgrade, then save again.");
      throw err;
    });
  } else if (writer === "local") {
    const store = (await getLocalWriteStore())!;
    const cur = await store.getSettings(app);
    const url = patch.alerts?.slackWebhookUrl;
    if (patch.alerts && url && !url.includes("…") && !/^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{10,200}$/.test(url))
      throw new Error("Use a Slack incoming-webhook URL (https://hooks.slack.com/services/…).");
    const hosts = patch.hosts ? validHostNames(patch.hosts) : undefined;
    if (typeof hosts === "string") throw new Error(hosts);
    const name = patch.displayName === undefined ? undefined : validAppName(patch.displayName);
    if (typeof name === "string") throw new Error(name);
    const alerts = patch.alerts ? { ...patch.alerts, slackWebhookUrl: url?.includes("…") ? cur?.alerts?.slackWebhookUrl : url || undefined } : undefined;
    await store.putSettings(app, { ...(name !== undefined ? { displayName: name.name } : {}), ...(patch.criticalFlows ? { criticalFlows: patch.criticalFlows } : {}), ...(alerts ? { alerts } : {}), ...(hosts ? { hosts } : {}) });
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
