import { createFileRoute, getRouteApi, useNavigate, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { normaliseHostMatch, OWNER_INFO, OWNERS, type HostName, type Owner } from "@debugkit/schema";
import { Card, timeAgo } from "~/components/ui";
import { CopyButton } from "~/components/copy-button";
import { partText } from "~/lib/version-text";
import type { VersionStatus } from "~/server/versions";
import { getSettings, restampExisting, saveAppSettings, saveRetention, sendTestAlert } from "~/server/fns";

export const Route = createFileRoute("/_authed/settings")({
  validateSearch: (s: Record<string, unknown>): { app?: string } => ({ app: typeof s.app === "string" ? s.app : undefined }),
  loaderDeps: ({ search }) => ({ app: search.app }),
  loader: ({ deps }) => getSettings({ data: deps }),
  component: SettingsPage,
});

const CHOICES = [30, 60, 90, 180, 365];
const authed = getRouteApi("/_authed");

function SettingsPage() {
  const { apps, settings, seenHosts } = Route.useLoaderData();
  const versions = authed.useLoaderData();
  const navigate = useNavigate({ from: Route.fullPath });
  const router = useRouter();
  const [days, setDays] = useState(String(settings?.retentionDays ?? 60));
  const [status, setStatus] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  if (!settings) {
    return <main className="mx-auto max-w-3xl px-4 py-16 text-center text-muted">No apps yet. Settings appear once an app sends its first event.</main>;
  }
  const canEdit = settings.writer !== "none";
  const n = Number(days);
  const changed = Number.isInteger(n) && n !== settings.retentionDays;

  const save = async () => {
    setBusy(true);
    setStatus(null);
    const out = await saveRetention({ data: { app: settings.app, retentionDays: n } }).catch((e: Error) => ({ ok: false as const, error: e.message }));
    setBusy(false);
    if (!out.ok) return setStatus({ tone: "error", text: out.error });
    setStatus({ tone: "ok", text: `Saved. New events are kept for ${n} days, starting within about a minute.` });
    await router.invalidate();
  };

  const restamp = async () => {
    setBusy(true);
    let cursor: string | undefined;
    let total = 0;
    try {
      do {
        const out = await restampExisting({ data: { app: settings.app, cursor } });
        if (!out.ok) throw new Error(out.error);
        total += out.updated;
        cursor = out.cursor;
        setStatus({ tone: "info", text: `Updating existing events… ${total.toLocaleString()} so far` });
      } while (cursor);
      setStatus({ tone: "ok", text: `Done: ${total.toLocaleString()} existing events now expire ${settings.retentionDays} days after they arrived.` });
    } catch (err) {
      setStatus({ tone: "error", text: `Stopped after ${total.toLocaleString()} events: ${(err as Error).message}` });
    }
    setBusy(false);
  };

  return (
    <main className="mx-auto max-w-3xl space-y-5 px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted">Settings</p>
          <h1 className="text-2xl font-semibold tracking-tight">{settings.app}</h1>
        </div>
        {apps.length > 1 && (
          <select aria-label="App" value={settings.app} onChange={(e) => navigate({ search: { app: e.target.value } })} className="rounded-md border border-line bg-panel px-2 py-1.5 text-sm">
            {apps.map((a) => <option key={a}>{a}</option>)}
          </select>
        )}
      </div>

      {versions && <VersionsCard status={versions} />}

      <Card title="Data retention" subtitle="Your data lives in your own database, so you decide how long to keep it.">
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div className="rounded-lg border border-line p-3">
            <dt className="text-xs text-muted">Raw events (stack traces, breadcrumbs, context)</dt>
            <dd className="mt-1 text-lg font-semibold">{settings.retentionDays ? `${settings.retentionDays} days` : "Unknown"}</dd>
            <dd className="text-xs text-muted">{settings.source === "setting" ? `Set here${settings.updatedAt ? ` on ${new Date(settings.updatedAt).toLocaleDateString("en-GB")}` : ""}` : settings.source === "default" ? "The default chosen at setup" : "Not reported by this deployment"}</dd>
          </div>
          <div className="rounded-lg border border-line p-3">
            <dt className="text-xs text-muted">Counts, issues and release health</dt>
            <dd className="mt-1 text-lg font-semibold">Forever</dd>
            <dd className="text-xs text-muted">Charts and trends cover any date range</dd>
          </div>
        </dl>

        {canEdit ? (
          <form
            className="mt-4 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (changed) void save();
            }}
          >
            <label className="block text-sm font-medium" htmlFor="days">Keep raw events for</label>
            <div className="flex flex-wrap items-center gap-2">
              {CHOICES.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setDays(String(c))}
                  className={`rounded-md border px-3 py-1.5 text-sm ${Number(days) === c ? "border-accent bg-accent-soft text-accent" : "border-line hover:bg-panel-2"}`}
                >
                  {c} days
                </button>
              ))}
              <input id="days" type="number" min={1} max={3650} value={days} onChange={(e) => setDays(e.target.value)} className="w-24 rounded-md border border-line bg-panel px-2 py-1.5 text-sm" aria-label="Days" />
              <button type="submit" disabled={!changed || busy} className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40">Save</button>
            </div>
            <p className="text-xs text-muted">
              Applies to events that arrive from now on. When you shorten it, older events are removed by your database's own clean-up: within about a day on Firestore, up to two days on DynamoDB.
            </p>
          </form>
        ) : (
          <p className="mt-4 text-sm text-muted">{settings.note}</p>
        )}
        {settings.note && canEdit && <p className="mt-2 text-xs text-sev-high">{settings.note}</p>}
      </Card>

      {canEdit && (
        <Card title="Existing events" subtitle="Events already stored keep the expiry they arrived with.">
          <p className="text-sm">Give every stored event an expiry based on the current setting ({settings.retentionDays} days after it arrived). This costs one database write per event.</p>
          <button type="button" onClick={() => void restamp()} disabled={busy} className="mt-3 rounded-md border border-line px-3 py-1.5 text-sm hover:bg-panel-2 disabled:opacity-40">
            Apply to existing events
          </button>
        </Card>
      )}

      {canEdit && <FlowsAndAlerts key={settings.app + JSON.stringify([settings.criticalFlows, settings.alerts])} settings={settings} onStatus={setStatus} />}

      {canEdit && <HostNames key={settings.app + JSON.stringify(settings.hosts)} app={settings.app} hosts={settings.hosts} seen={seenHosts} onStatus={setStatus} />}

      {status && (
        <p role="status" className={`rounded-lg border px-3 py-2 text-sm ${status.tone === "error" ? "border-sev-critical text-sev-critical" : status.tone === "ok" ? "border-line bg-panel-2" : "border-line text-muted"}`}>
          {status.text}
        </p>
      )}
    </main>
  );
}

function FlowsAndAlerts({
  settings,
  onStatus,
}: {
  settings: { app: string; criticalFlows: string[]; alerts: { slackWebhookUrl?: string; newIssues?: boolean; regressions?: boolean; onlyCriticalFlows?: boolean; dashboardUrl?: string }; writer: string };
  onStatus: (s: { tone: "ok" | "error" | "info"; text: string } | null) => void;
}) {
  const router = useRouter();
  const [flows, setFlows] = useState(settings.criticalFlows.join(", "));
  const [hook, setHook] = useState(settings.alerts.slackWebhookUrl ?? "");
  const [newIssues, setNewIssues] = useState(settings.alerts.newIssues !== false);
  const [regressions, setRegressions] = useState(settings.alerts.regressions !== false);
  const [onlyCritical, setOnlyCritical] = useState(settings.alerts.onlyCriticalFlows === true);
  const [dashboardUrl, setDashboardUrl] = useState(settings.alerts.dashboardUrl ?? (typeof window !== "undefined" ? window.location.origin : ""));
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    onStatus(null);
    const out = await saveAppSettings({
      data: {
        app: settings.app,
        criticalFlows: flows.split(/[\s,]+/).filter(Boolean),
        alerts: { slackWebhookUrl: hook, newIssues, regressions, onlyCriticalFlows: onlyCritical, dashboardUrl },
      },
    }).catch((e: Error) => ({ ok: false as const, error: e.message }));
    setBusy(false);
    if (!out.ok) return onStatus({ tone: "error", text: out.error });
    onStatus({ tone: "ok", text: "Saved. Alerts and critical flows apply within about a minute." });
    await router.invalidate();
  };
  const test = async () => {
    setBusy(true);
    const out = await sendTestAlert({ data: { app: settings.app } }).catch((e: Error) => ({ ok: false as const, error: e.message }));
    setBusy(false);
    onStatus(out.ok ? { tone: "ok", text: "Test message sent. Check your Slack channel." } : { tone: "error", text: out.error });
  };
  const box = "rounded-md border border-line bg-panel px-2 py-1.5 text-sm";
  return (
    <>
      <Card title="Critical flows" subtitle="Issues in these flows rank one severity level higher, and can be the only ones that alert.">
        <label className="block text-sm font-medium" htmlFor="flows">Flows, separated by commas</label>
        <input id="flows" value={flows} onChange={(e) => setFlows(e.target.value)} placeholder="checkout.payment, auth.login" className={`mt-2 w-full ${box}`} />
      </Card>
      <Card title="Slack alerts" subtitle="Your ingest function posts to Slack when an issue first appears or comes back after being resolved.">
        <div className="space-y-3 text-sm">
          <div>
            <label className="block font-medium" htmlFor="hook">Incoming webhook URL</label>
            <input id="hook" value={hook} onChange={(e) => setHook(e.target.value)} placeholder="https://hooks.slack.com/services/…" className={`mt-2 w-full font-mono ${box}`} />
            <p className="mt-1 text-xs text-muted">Create one under your Slack app's Incoming Webhooks. Leave empty to turn alerts off.</p>
          </div>
          <label className="flex items-center gap-2"><input type="checkbox" checked={newIssues} onChange={(e) => setNewIssues(e.target.checked)} /> New issues</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={regressions} onChange={(e) => setRegressions(e.target.checked)} /> Regressions</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={onlyCritical} onChange={(e) => setOnlyCritical(e.target.checked)} /> Only for critical flows</label>
          <div>
            <label className="block font-medium" htmlFor="dash-url">Dashboard address, for links in alerts</label>
            <input id="dash-url" value={dashboardUrl} onChange={(e) => setDashboardUrl(e.target.value)} className={`mt-2 w-full ${box}`} />
          </div>
        </div>
      </Card>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => void save()} disabled={busy} className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40">Save flows and alerts</button>
        {settings.alerts.slackWebhookUrl && settings.writer === "admin" && (
          <button type="button" onClick={() => void test()} disabled={busy} className="rounded-md border border-line px-3 py-1.5 text-sm hover:bg-panel-2 disabled:opacity-40">Send a test alert</button>
        )}
      </div>
    </>
  );
}

interface HostRow {
  id: number;
  match: string;
  name: string;
  owner: Owner | "";
}

/** Owners a host can be given; leaving it unset lets the classifier decide. */
const HOST_OWNERS = OWNERS.filter((o) => o !== "unknown");

function HostNames({
  app,
  hosts,
  seen,
  onStatus,
}: {
  app: string;
  hosts: HostName[];
  seen: string[];
  onStatus: (s: { tone: "ok" | "error" | "info"; text: string } | null) => void;
}) {
  const router = useRouter();
  const [nextId, setNextId] = useState(hosts.length + 1);
  const [rows, setRows] = useState<HostRow[]>(() =>
    hosts.length ? hosts.map((h, i) => ({ id: i, match: h.match, name: h.name, owner: h.owner ?? "" })) : [{ id: 0, match: "", name: "", owner: "" }],
  );
  const [busy, setBusy] = useState(false);
  const named = new Set(rows.map((r) => normaliseHostMatch(r.match)));
  const unnamed = seen.filter((h) => !named.has(h));

  const update = (id: number, patch: Partial<HostRow>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const add = (match = "") => {
    setRows((rs) => [...rs.filter((r) => r.match || r.name), { id: nextId, match, name: "", owner: "" }]);
    setNextId((n) => n + 1);
  };
  const save = async () => {
    setBusy(true);
    onStatus(null);
    const out = await saveAppSettings({
      data: { app, hosts: rows.map((r) => ({ match: r.match, name: r.name, ...(r.owner ? { owner: r.owner } : {}) })) },
    }).catch((e: Error) => ({ ok: false as const, error: e.message }));
    setBusy(false);
    if (!out.ok) return onStatus({ tone: "error", text: out.error });
    onStatus({ tone: "ok", text: "Saved. Names show straight away; owners apply to new errors within about a minute, and to existing issues now." });
    await router.invalidate();
  };
  const box = "rounded-md border border-line bg-panel px-2 py-1.5 text-sm";
  return (
    <Card title="Host names" subtitle="Give the servers your app calls a name people recognise, and say who looks after each one.">
      <div className="space-y-3">
        {rows.map((r, i) => (
          <div key={r.id} role="group" aria-label={`Host ${i + 1}`} className="grid gap-2 rounded-lg border border-line p-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto_auto] sm:items-end sm:border-0 sm:p-0">
            <label className="min-w-0 text-xs text-muted">
              Host, or host and path
              <input value={r.match} onChange={(e) => update(r.id, { match: e.target.value })} list="seen-hosts" placeholder="api.example.com/payments" className={`mt-1 w-full font-mono text-xs text-ink ${box}`} />
            </label>
            <label className="min-w-0 text-xs text-muted">
              Name
              <input value={r.name} onChange={(e) => update(r.id, { name: e.target.value })} placeholder="Balance service" maxLength={60} className={`mt-1 w-full text-ink ${box}`} />
            </label>
            <label className="text-xs text-muted">
              Looked after by
              <select value={r.owner} onChange={(e) => update(r.id, { owner: e.target.value as Owner | "" })} className={`mt-1 w-full text-ink ${box}`}>
                <option value="">Work it out</option>
                {HOST_OWNERS.map((o) => (
                  <option key={o} value={o}>{OWNER_INFO[o].name}</option>
                ))}
              </select>
            </label>
            <button type="button" onClick={() => setRows((rs) => rs.filter((x) => x.id !== r.id))} aria-label={`Remove ${r.match || "this host"}`} className="justify-self-start rounded-md border border-line px-2.5 py-1.5 text-sm hover:bg-panel-2">
              Remove
            </button>
          </div>
        ))}
        <datalist id="seen-hosts">
          {unnamed.map((h) => <option key={h} value={h} />)}
        </datalist>
        {unnamed.length > 0 && (
          <div className="text-xs text-muted">
            <p>Called in the last 30 days and not named yet:</p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {unnamed.slice(0, 8).map((h) => (
                <button key={h} type="button" onClick={() => add(h)} className="max-w-full truncate rounded-md border border-line px-2 py-0.5 font-mono hover:bg-panel-2" title={`Name ${h}`}>
                  + {h}
                </button>
              ))}
            </div>
          </div>
        )}
        <p className="text-xs text-muted">
          A path names part of a host: api.example.com/payments covers /payments/… only; the longest match wins. The owner decides who server errors from that host are passed to.
        </p>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => add()} className="rounded-md border border-line px-3 py-1.5 text-sm hover:bg-panel-2">Add a host</button>
          <button type="button" onClick={() => void save()} disabled={busy} className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40">Save host names</button>
        </div>
      </div>
    </Card>
  );
}

const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const PART_LABEL = { sdk: "App SDK (newest seen)", ingest: "Ingest", dashboard: "This dashboard" } as const;

/** The project's deBug versions, and what to run when one is behind. */
function VersionsCard({ status }: { status: VersionStatus }) {
  const behind = new Set(status.behind.map((p) => p.part));
  return (
    <Card title="deBug versions" subtitle="Your app's SDK, your ingest and this dashboard are released together and work best on the same version.">
      <dl className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-4 gap-y-1.5 text-sm">
        {status.parts.map((p) => (
          <div key={p.part} className="contents">
            <dt className="text-muted">{PART_LABEL[p.part]}</dt>
            <dd className={behind.has(p.part) ? "font-medium text-sev-high" : ""}>
              {p.version ?? (p.part === "sdk" ? "not seen yet" : "predates version tracking")}
              {p.at && <span className="ml-2 text-xs text-muted" title={p.at}>{p.part === "sdk" ? "seen" : "recorded"} {timeAgo(p.at)}</span>}
            </dd>
          </div>
        ))}
      </dl>
      {status.level === "none" ? (
        <p className="mt-3 text-xs text-muted">All in step.</p>
      ) : (
        <div className="mt-3 space-y-2 text-sm">
          <p className={status.level === "banner" ? "" : "text-muted"}>
            {upperFirst(status.behind.filter((p) => p.part !== "sdk").map(partText).join(" and ")) || "Your app's SDK is behind"}
            {status.level === "note" ? ": a patch behind, so nothing's missing, but worth catching up." : `, behind ${status.newest}.`}
          </p>
          {status.behind.some((p) => p.part !== "sdk") ? (
            <div className="flex flex-wrap items-center gap-2">
              <code className="break-all rounded bg-panel-2 px-2 py-1 font-mono text-xs">{status.command}</code>
              <CopyButton text={status.command} label="Copy" ariaLabel="Copy the upgrade command" />
            </div>
          ) : (
            <p className="text-xs text-muted">Update @debugkit/sdk in your app to {status.newest}.</p>
          )}
        </div>
      )}
    </Card>
  );
}
