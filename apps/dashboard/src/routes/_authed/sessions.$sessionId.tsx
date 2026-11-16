import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { CopyButton } from "~/components/copy-button";
import { CrumbBody, ICON, OutcomeBadge, clock, joined, roundedSpan } from "~/components/timeline";
import { Card } from "~/components/ui";
import { getSessionDetail } from "~/server/fns";
import type { SessionRow, Source } from "~/server/session";

export const Route = createFileRoute("/_authed/sessions/$sessionId")({
  validateSearch: (s: Record<string, unknown>): { app: string } => ({ app: typeof s.app === "string" ? s.app : "" }),
  loaderDeps: ({ search }) => ({ app: search.app }),
  loader: async ({ params, deps }) => {
    const out = await getSessionDetail({ data: { app: deps.app, sessionId: params.sessionId } });
    if (!out.session && !out.missingIndex) throw notFound();
    return out;
  },
  component: SessionPage,
});

function SessionPage() {
  const { session: s, missingIndex } = Route.useLoaderData();
  if (!s) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
        <h1 className="text-xl font-semibold">This session can't be read yet</h1>
        <p className="mt-2 text-sm text-muted">
          {missingIndex && "Firestore needs deBug's new index on events (sessionId, ts). Deploy it with: firebase deploy --only firestore:indexes, using deBug's firestore.indexes.json. It takes a few minutes to build."}
        </p>
      </main>
    );
  }
  const customer = s.user.id;
  return (
    <main className="mx-auto max-w-5xl space-y-5 px-4 py-6 sm:px-6">
      <div>
        <p className="text-xs uppercase tracking-wide text-muted" title="From the earliest step recorded to the last stored event. The session may have started earlier and gone on after.">
          Session · recorded {clock(s.start)} to {clock(s.end)} · {duration(s.start, s.end)}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{customer ? <span className="break-all font-mono">{customer}</span> : "Not signed in"}</h1>
          <OutcomeBadge outcome={s.outcome} />
          {(customer || s.user.anonymousId) && (
            <Link to="/customers" search={{ app: s.app, q: customer ?? s.user.anonymousId }} className="text-sm text-accent hover:underline">
              All their sessions →
            </Link>
          )}
        </div>
      </div>

      <section aria-label="Device and app" className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-line bg-panel px-4 py-3 text-sm">
        <span><span className="text-muted">Device </span>{joined([s.context.device.brand, s.context.device.model]) ?? "—"}</span>
        <span><span className="text-muted">OS </span>{joined([s.context.os.name, s.context.os.version]) ?? "—"}</span>
        <span><span className="text-muted">App </span>{joined([s.context.app.version, s.context.app.build && `(${s.context.app.build})`]) ?? "—"}</span>
        <span>
          <span className="text-muted">Errors </span>
          {s.counts.errors}
          {s.counts.handled > 0 && <span className="text-muted"> ({s.counts.handled} caught by the app)</span>}
        </span>
        <span>
          <span className="text-muted">Session </span>
          <span className="break-all font-mono text-xs">{s.sessionId}</span>
          <span className="ml-2"><CopyButton text={s.sessionId} label="Copy" ariaLabel="Copy session id" /></span>
        </span>
        {s.user.anonymousId && (
          <span>
            <span className="text-muted">Install </span>
            <span className="break-all font-mono text-xs">{s.user.anonymousId}</span>
          </span>
        )}
        {customer && <span className="ml-auto"><CopyButton text={customer} label="Copy customer" ariaLabel="Copy customer id" /></span>}
      </section>

      <Card title="Timeline" subtitle="Screens, taps, API calls, flow steps and errors in this session, in order. Times are from the device, from the session's start.">
        <ol className="space-y-1.5">
          {s.rows.map((r, i) => <Row key={r.kind === "crumb" ? `c${i}` : r.eventId} row={r} app={s.app} start={s.start} />)}
        </ol>
        {s.truncated && <p className="mt-3 text-xs text-muted">Showing the newest {s.read} events of this session; older ones are left out.</p>}
        <p className="mt-3 text-xs text-muted">Screens, taps and API calls come from the trail each error carries, so what happened after the last error isn't shown, and the trail before an error goes back as far as the SDK's breadcrumb limit.</p>
      </Card>
    </main>
  );
}

function Row({ row, app, start }: { row: SessionRow; app: string; start: string }) {
  const at = <span className="tabular pt-0.5 text-right text-xs text-muted" title={row.ts}>{since(row.ts, start)}</span>;
  const cls = "grid grid-cols-[4.5rem_1.25rem_1fr] gap-2 rounded-md px-2 py-1.5 text-sm";
  if (row.kind === "crumb") {
    const t = row.item;
    return (
      <li className={`${cls} ${t.failed ? "bg-sev-critical/10" : t.level === "warning" ? "bg-sev-medium/10" : ""}`}>
        {at}
        <span aria-hidden className={`pt-0.5 text-center ${t.failed ? "text-sev-critical" : "text-muted"}`}>{ICON[t.category]}</span>
        <div className="min-w-0">
          <CrumbBody item={t} />
          <SourceLink source={row.source} app={app} />
        </div>
      </li>
    );
  }
  if (row.kind === "event") {
    return (
      <li className={`${cls} ${row.failed ? "bg-sev-medium/10" : ""}`}>
        {at}
        <span aria-hidden className={`pt-0.5 text-center ${row.failed ? "text-sev-high" : "text-muted"}`}>◆</span>
        <div className="min-w-0">
          <span className="mr-2 rounded bg-panel-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">flow</span>
          <span className={`break-words ${row.failed ? "font-medium" : ""}`}>{row.detail}</span>
          <SourceLink source={row.source} app={app} />
        </div>
      </li>
    );
  }
  return (
    <li className={`${cls} ${row.handled ? "bg-sev-critical/10" : "bg-sev-critical/20"} font-medium text-sev-critical`}>
      {at}
      <span aria-hidden className="pt-0.5 text-center">✕</span>
      <div className="min-w-0">
        <span className="mr-2 rounded bg-sev-critical px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-white">{row.crash ? "crash" : row.handled ? "error" : "uncaught"}</span>
        {row.fingerprint ? (
          <Link to="/events/$eventId" params={{ eventId: row.eventId }} search={{ app, issue: row.fingerprint }} className="break-words hover:underline">
            {row.title}
          </Link>
        ) : (
          <span className="break-words">{row.title}</span>
        )}
      </div>
    </li>
  );
}

/** Opens the error whose trail holds this row, where the steps around it are shown. */
function SourceLink({ source, app }: { source?: Source; app: string }) {
  if (!source) return null;
  return (
    <Link to="/events/$eventId" params={{ eventId: source.eventId }} search={{ app, issue: source.fingerprint }} className="ml-2 whitespace-nowrap text-xs text-muted hover:text-ink hover:underline" title="Open the error this step led to">
      in error →
    </Link>
  );
}

/** "+1:05" from the session's start; the first row is "+0:00". */
function since(ts: string, start: string) {
  const s = Math.max(0, Math.round((Date.parse(ts) - Date.parse(start)) / 1000));
  return s >= 3600 ? `+${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `+${Math.floor(s / 60)}:${pad(s % 60)}`;
}

function duration(start: string, end: string) {
  const s = Math.max(0, (Date.parse(end) - Date.parse(start)) / 1000);
  return s < 0.05 ? "0 s" : roundedSpan(s);
}

const pad = (n: number) => String(n).padStart(2, "0");

