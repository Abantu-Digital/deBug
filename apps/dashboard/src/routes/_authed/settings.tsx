import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Card } from "~/components/ui";
import { getSettings, restampExisting, saveRetention } from "~/server/fns";

export const Route = createFileRoute("/_authed/settings")({
  validateSearch: (s: Record<string, unknown>): { app?: string } => ({ app: typeof s.app === "string" ? s.app : undefined }),
  loaderDeps: ({ search }) => ({ app: search.app }),
  loader: ({ deps }) => getSettings({ data: deps }),
  component: SettingsPage,
});

const CHOICES = [30, 60, 90, 180, 365];

function SettingsPage() {
  const { apps, settings } = Route.useLoaderData();
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

      {status && (
        <p role="status" className={`rounded-lg border px-3 py-2 text-sm ${status.tone === "error" ? "border-sev-critical text-sev-critical" : status.tone === "ok" ? "border-line bg-panel-2" : "border-line text-muted"}`}>
          {status.text}
        </p>
      )}
    </main>
  );
}
