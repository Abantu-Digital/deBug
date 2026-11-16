import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { CopyButton } from "~/components/copy-button";
import { rangeSearch, type RangeSearch } from "~/components/range-picker";
import { Card } from "~/components/ui";
import { getEventDetail } from "~/server/fns";
import type { ApiCall, EventDetail, TimelineItem } from "~/server/event";

export const Route = createFileRoute("/_authed/events/$eventId")({
  // The range is kept only to take it back to the issue page.
  validateSearch: (s: Record<string, unknown>): { app: string; issue: string } & RangeSearch => ({
    app: typeof s.app === "string" ? s.app : "",
    issue: typeof s.issue === "string" ? s.issue : "",
    ...rangeSearch(s),
  }),
  loaderDeps: ({ search }) => ({ app: search.app, issue: search.issue }),
  loader: async ({ params, deps }) => {
    const d = await getEventDetail({ data: { app: deps.app, fingerprint: deps.issue, eventId: params.eventId } });
    if (!d) throw notFound();
    return d;
  },
  component: EventPage,
});

function EventPage() {
  const d = Route.useLoaderData();
  const { range, from, to } = Route.useSearch();
  const issueSearch = { app: d.app, range, from, to };
  const step = (id: string) => ({ to: "/events/$eventId" as const, params: { eventId: id }, search: { ...issueSearch, issue: d.issue.fingerprint } });
  const stepClass = "rounded-md border border-line px-2 py-1 text-xs hover:bg-panel-2";

  return (
    <main className="mx-auto max-w-7xl space-y-5 px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <Link to="/issues/$fingerprint" params={{ fingerprint: d.issue.fingerprint }} search={issueSearch} className="text-muted hover:text-ink">
          ← {d.issue.title}
        </Link>
        <nav aria-label="Other occurrences" className="flex gap-2">
          {d.newer ? <Link {...step(d.newer)} className={stepClass}>← Newer</Link> : null}
          {d.older ? <Link {...step(d.older)} className={stepClass}>Older →</Link> : null}
        </nav>
      </div>

      <div>
        <p className="text-xs uppercase tracking-wide text-muted">
          Occurrence · {clock(d.ts)} · {d.handled ? "caught by the app" : "uncaught"}
          {d.flow ? ` · ${d.flow}${d.step ? ` · ${d.step}` : ""}` : ""}
        </p>
        <h1 className="mt-1 break-words text-xl font-semibold tracking-tight">
          {d.error.name}: {d.error.message}
        </h1>
      </div>

      <Who d={d} />

      <div className="grid gap-5 lg:grid-cols-5">
        <div className="min-w-0 lg:col-span-3">
          <Card title="Timeline" subtitle="What happened before the error, in order. Times are from the device, relative to the error.">
            <Timeline items={d.timeline} errorTs={d.ts} errorText={`${d.error.name}: ${d.error.message}`} />
          </Card>
        </div>
        <div className="min-w-0 space-y-5 lg:col-span-2">
          {d.request && (
            <Card title="Request" subtitle="The call that failed.">
              <RequestPanel call={d.request} />
            </Card>
          )}
          <Card title="Device and app">
            <Facts
              rows={[
                ["OS", joined([d.context.os.name, d.context.os.version])],
                ["Device", joined([d.context.device.brand, d.context.device.model])],
                ["App", joined([d.context.app.version, d.context.app.build && `(${d.context.app.build})`])],
                ["Update", d.context.app.update],
                ["Environment", d.context.app.environment],
                ["Runtime", joined([d.context.runtime.name, d.context.runtime.version, d.context.runtime.engine])],
                ["Network", joined([d.context.network?.type, d.context.network?.effectiveType])],
                ["Locale", joined([d.context.locale, d.context.timezone], " · ")],
              ]}
            />
            <h3 className="mb-2 mt-4 text-xs font-medium text-muted">Tags</h3>
            {d.tags.length ? (
              <Facts mono rows={d.tags.map((t) => [t.key, t.value])} />
            ) : (
              <p className="text-sm text-muted">No tags on this event.</p>
            )}
          </Card>
        </div>
      </div>

      <Card title="Stack trace" subtitle="The app's own code first, then libraries and the runtime.">
        {d.frames.length ? (
          <ol className="space-y-1 font-mono text-xs">
            {d.frames.map((f, i) => (
              <li key={i} className={`rounded px-2 py-1 ${f.inApp ? "bg-accent-soft text-ink" : "text-muted"}`}>
                <span className="font-semibold">{f.fn ?? "<anonymous>"}</span> <span className="break-all">{f.file}:{f.line}:{f.col}</span>
                {!f.inApp && <span className="ml-2 text-[10px] uppercase tracking-wide">library</span>}
              </li>
            ))}
          </ol>
        ) : (
          <pre className="overflow-auto whitespace-pre-wrap text-xs text-muted">{d.stack ?? "No stack trace captured."}</pre>
        )}
      </Card>
    </main>
  );
}

/** Who it happened to, and the ids that lead to their session and their other sessions. */
function Who({ d }: { d: EventDetail }) {
  const customer = d.user.id;
  return (
    <section aria-label="Customer and session" className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-line bg-panel px-4 py-3 text-sm">
      <span>
        <span className="text-muted">Customer </span>
        {customer ? <span className="break-all font-mono">{customer}</span> : <span className="text-muted">not signed in</span>}
        {customer && <span className="ml-2"><CopyButton text={customer} label="Copy" ariaLabel="Copy customer id" /></span>}
      </span>
      {d.user.anonymousId && (
        <span>
          <span className="text-muted">Install </span>
          <span className="break-all font-mono text-xs">{d.user.anonymousId}</span>
        </span>
      )}
      <span>
        <span className="text-muted">Session </span>
        <span className="break-all font-mono text-xs">{d.sessionId}</span>
        <span className="ml-2"><CopyButton text={d.sessionId} label="Copy" ariaLabel="Copy session id" /></span>
      </span>
      <span className="text-xs text-muted">Pages for this session's timeline and the customer's other sessions are coming next; until then, copy the ids.</span>
    </section>
  );
}

const ICON: Record<TimelineItem["category"], string> = { navigation: "→", network: "⇅", ui: "◉", log: "≡", event: "◆", custom: "✱" };

function Timeline({ items, errorTs, errorText }: { items: TimelineItem[]; errorTs: string; errorText: string }) {
  if (!items.length) {
    return <p className="text-sm text-muted">No breadcrumbs. The SDK records screens, taps and requests on its own once it's set up; see the README.</p>;
  }
  return (
    <ol className="space-y-2">
      {items.map((t, i) => (
        <li key={i} className={`grid grid-cols-[4.5rem_1.25rem_1fr] gap-2 rounded-md px-2 py-1.5 text-sm ${t.failed ? "bg-sev-critical/10" : t.level === "warning" ? "bg-sev-medium/10" : ""}`}>
          <span className="tabular pt-0.5 text-right text-xs text-muted" title={t.ts}>{offset(t.ts, errorTs)}</span>
          <span aria-hidden className={`pt-0.5 text-center ${t.failed ? "text-sev-critical" : "text-muted"}`}>{ICON[t.category]}</span>
          <div className="min-w-0">
            <span className="mr-2 rounded bg-panel-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">{t.category}</span>
            {t.api ? <ApiLine call={t.api} /> : <span className="break-words">{t.message}</span>}
            {t.repeated && <span className="ml-2 text-xs text-muted">×{t.repeated}</span>}
            {t.data && (
              <div className="mt-0.5 break-words font-mono text-[11px] text-muted">
                {Object.entries(t.data).map(([k, v]) => `${k}=${String(v)}`).join(" · ")}
              </div>
            )}
          </div>
        </li>
      ))}
      <li className="grid grid-cols-[4.5rem_1.25rem_1fr] gap-2 rounded-md bg-sev-critical/15 px-2 py-1.5 text-sm font-medium text-sev-critical">
        <span className="tabular pt-0.5 text-right text-xs">0 s</span>
        <span aria-hidden className="pt-0.5 text-center">✕</span>
        <span className="break-words">{errorText}</span>
      </li>
    </ol>
  );
}

function ApiLine({ call }: { call: ApiCall }) {
  return (
    <span className="break-words">
      {call.service && <span className="font-medium">{call.service} </span>}
      <span className="font-mono text-xs">{joined([call.method, call.path])}</span>
      {" → "}
      <span className={call.failed ? "font-semibold text-sev-critical" : ""}>{call.status ?? call.outcome ?? "failed"}</span>
      {call.status !== undefined && call.outcome && call.outcome !== "answered" && <span className="text-muted"> ({call.outcome})</span>}
      {call.durationMs !== undefined && <span className="text-muted"> · {call.durationMs} ms</span>}
      {call.errorKind && <span className="text-muted"> · {call.errorKind}</span>}
      {call.backendCode && <span className="text-muted"> · {call.backendCode}</span>}
    </span>
  );
}

function RequestPanel({ call }: { call: ApiCall }) {
  return (
    <Facts
      rows={[
        ["Service", call.service],
        ["Endpoint", joined([call.method, call.path])],
        ["Status", call.status !== undefined ? String(call.status) : "no answer"],
        ["Outcome", call.outcome],
        ["Kind", call.errorKind],
        ["Backend", joined([call.backendCode, call.backendTitle], " · ")],
        ["Backend errors", call.backendErrors],
        ["Trace", call.traceId ? (
          <span className="flex flex-wrap items-center gap-2">
            <span className="break-all font-mono text-xs">{call.traceId}</span>
            <CopyButton text={call.traceId} label="Copy" ariaLabel="Copy trace id" />
          </span>
        ) : undefined],
        ["Duration", call.durationMs !== undefined ? `${call.durationMs} ms` : undefined],
        ["Retry", call.retry === undefined ? undefined : String(call.retry)],
      ]}
    />
  );
}

/** Label/value rows; empty values are left out. */
function Facts({ rows, mono }: { rows: [string, ReactNode | undefined][]; mono?: boolean }) {
  const shown = rows.filter(([, v]) => v !== undefined && v !== "");
  return (
    <dl className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-4 gap-y-1.5 text-sm">
      {shown.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className={`text-muted ${mono ? "break-all font-mono text-xs" : ""}`}>{k}</dt>
          <dd className={`min-w-0 break-words ${mono ? "font-mono text-xs" : ""}`}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The parts that are set, joined; undefined when none are. */
function joined(parts: (string | false | undefined)[], sep = " "): string | undefined {
  return parts.filter(Boolean).join(sep) || undefined;
}

/** "14 Nov, 12:59:55" in the viewer's time zone. */
function clock(iso: string) {
  return new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** How long before the error: "−5.9 s", "−2 min". */
function offset(ts: string, errorTs: string) {
  const s = (Date.parse(ts) - Date.parse(errorTs)) / 1000;
  if (!Number.isFinite(s)) return "";
  const a = Math.abs(s);
  if (a < 0.05) return "0 s";
  const sign = s < 0 ? "−" : "+";
  // Round first, then pick the unit, so 59.6 s reads "1 min", not "60 s".
  if (a < 9.95) return `${sign}${a.toFixed(1)} s`;
  if (Math.round(a) < 60) return `${sign}${Math.round(a)} s`;
  if (Math.round(a / 60) < 60) return `${sign}${Math.round(a / 60)} min`;
  return `${sign}${Math.round(a / 3600)} h`;
}
