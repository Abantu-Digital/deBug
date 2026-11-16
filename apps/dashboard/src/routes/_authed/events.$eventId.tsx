import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { CopyButton } from "~/components/copy-button";
import { rangeSearch, type RangeSearch } from "~/components/range-picker";
import { CrumbBody, ICON, clock, joined, offset } from "~/components/timeline";
import { Card } from "~/components/ui";
import { getEventDetail } from "~/server/fns";
import { shownOf, supportSummary, ticketText, ticketTime } from "~/lib/support-summary";
import type { ApiCall, EventDetail, TimelineItem } from "~/server/event";
import type { Exchange, ExchangeSide } from "~/server/exchange";
import { bodyView, curlOf, size, uncut } from "~/lib/exchange-view";

export const Route = createFileRoute("/_authed/events/$eventId")({
  // The range is kept only to take it back to the issue page.
  validateSearch: (s: Record<string, unknown>): { app: string; issue: string; view?: "support" } & RangeSearch => ({
    app: typeof s.app === "string" ? s.app : "",
    issue: typeof s.issue === "string" ? s.issue : "",
    view: s.view === "support" ? "support" : undefined,
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
  const { range, from, to, view } = Route.useSearch();
  const issueSearch = { app: d.app, range, from, to };
  const step = (id: string) => ({ to: "/events/$eventId" as const, params: { eventId: id }, search: { ...issueSearch, issue: d.issue.fingerprint, view } });
  const support = view === "support";
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

      <Summary d={d} support={support} search={{ ...issueSearch, issue: d.issue.fingerprint, view }} />

      {support ? (
        <Card title="What they did" subtitle="Screens, taps and failed calls before the error, and after it when the session went on.">
          <Timeline items={d.timeline.filter(forSupport)} after={d.after.filter(forSupport)} errorTs={d.ts} errorText="The error" />
        </Card>
      ) : (
      <>
      <div className="grid gap-5 lg:grid-cols-5">
        <div className="min-w-0 lg:col-span-3">
          <Card title="Timeline" subtitle="What happened before the error, in order. Times are from the device, relative to the error.">
            <Timeline items={d.timeline} errorTs={d.ts} errorText={`${d.error.name}: ${d.error.message}`} />
          </Card>
        </div>
        <div className="min-w-0 space-y-5 lg:col-span-2">
          {d.request && (
            <Card title="Request" subtitle="The call that failed.">
              <RequestPanel call={d.request} exchange={d.exchange} />
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
      </>
      )}
    </main>
  );
}

/** The support summary, the Support / Developer switch, and "Copy for ticket". */
function Summary({ d, support, search }: { d: EventDetail; support: boolean; search: ReturnType<typeof Route.useSearch> }) {
  const summary = supportSummary(d, (iso) => ticketTime(iso, d.context.timezone));
  // The page's own address is only known in the browser.
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  const link = `${origin}/events/${encodeURIComponent(d.id)}?app=${encodeURIComponent(d.app)}&issue=${encodeURIComponent(d.issue.fingerprint)}${support ? "&view=support" : ""}`;
  const tab = (on: boolean) => `rounded-md px-2.5 py-1 text-xs ${on ? "bg-panel-2 font-medium text-ink" : "text-muted hover:text-ink"}`;
  return (
    <section aria-label="Support summary" className="rounded-xl border border-line bg-panel p-4 sm:p-5">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">What happened</h2>
        <div className="flex items-center gap-2">
          <span className="flex rounded-md border border-line p-0.5" role="group" aria-label="View">
            <Link to="/events/$eventId" params={{ eventId: d.id }} search={{ ...search, view: "support" }} replace aria-pressed={support} className={tab(support)}>Support</Link>
            <Link to="/events/$eventId" params={{ eventId: d.id }} search={{ ...search, view: undefined }} replace aria-pressed={!support} className={tab(!support)}>Developer</Link>
          </span>
          <CopyButton text={ticketText(summary, link, d.request?.traceId)} label="Copy for ticket" ariaLabel="Copy the summary, event link and trace id for a ticket" />
        </div>
      </div>
      <p className="text-[15px] leading-relaxed" suppressHydrationWarning>{summary.sentences.join(" ")}</p>
      {support && (summary.screens.length > 0 || summary.saw) && (
        <dl className="mt-3 grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-4 gap-y-1 text-sm">
          {summary.screens.length > 0 && (
            <>
              <dt className="text-muted">Screens</dt>
              <dd className="min-w-0 break-words">{summary.screens.join(" → ")}</dd>
            </>
          )}
          {summary.saw && (
            <>
              <dt className="text-muted">They saw</dt>
              <dd className="min-w-0 break-words">"{summary.saw}"</dd>
            </>
          )}
        </dl>
      )}
    </section>
  );
}

/** The steps support follows: screens, taps, what the app showed, and calls that failed. */
function forSupport(t: TimelineItem): boolean {
  return t.category === "navigation" || t.category === "ui" || !!t.api?.failed || !!shownOf(t);
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
      <Link to="/sessions/$sessionId" params={{ sessionId: d.sessionId }} search={{ app: d.app }} className="text-accent hover:underline">
        Whole session →
      </Link>
    </section>
  );
}

/** The trail up to the error, and with `after`, what came after it. */
function Timeline({ items, after = [], errorTs, errorText }: { items: TimelineItem[]; after?: TimelineItem[]; errorTs: string; errorText: string }) {
  if (!items.length && !after.length) {
    return <p className="text-sm text-muted">No breadcrumbs. The SDK records screens, taps and requests on its own once it's set up; see the README.</p>;
  }
  const row = (t: TimelineItem, key: string) => (
    <li key={key} className={`grid grid-cols-[4.5rem_1.25rem_1fr] gap-2 rounded-md px-2 py-1.5 text-sm ${t.failed ? "bg-sev-critical/10" : t.level === "warning" ? "bg-sev-medium/10" : ""}`}>
      <span className="tabular pt-0.5 text-right text-xs text-muted" title={t.ts}>{offset(t.ts, errorTs)}</span>
      <span aria-hidden className={`pt-0.5 text-center ${t.failed ? "text-sev-critical" : "text-muted"}`}>{ICON[t.category]}</span>
      <div className="min-w-0">
        <CrumbBody item={t} />
      </div>
    </li>
  );
  return (
    <ol className="space-y-2">
      {items.map((t, i) => row(t, `b${i}`))}
      <li className="grid grid-cols-[4.5rem_1.25rem_1fr] gap-2 rounded-md bg-sev-critical/15 px-2 py-1.5 text-sm font-medium text-sev-critical">
        <span className="tabular pt-0.5 text-right text-xs">0 s</span>
        <span aria-hidden className="pt-0.5 text-center">✕</span>
        <span className="break-words">{errorText}</span>
      </li>
      {after.map((t, i) => row(t, `a${i}`))}
    </ol>
  );
}

type RequestTab = "call" | "request" | "response";

/** The failed call; with what the SDK captured, its request and response in tabs of their own. */
function RequestPanel({ call, exchange }: { call: ApiCall; exchange?: Exchange }) {
  const [tab, setTab] = useState<RequestTab>("call");
  if (!exchange) return <CallFacts call={call} />;
  const tabs: [RequestTab, string][] = [["call", "Call"], ["request", "Request"], ...(exchange.response ? ([["response", "Response"]] as [RequestTab, string][]) : [])];
  const ids = tabs.map(([id]) => id);
  // Arrow keys, Home and End move between tabs; Tab leaves the tab list.
  const onKey = (e: React.KeyboardEvent) => {
    const i = ids.indexOf(tab);
    const next = e.key === "ArrowRight" ? ids[(i + 1) % ids.length] : e.key === "ArrowLeft" ? ids[(i - 1 + ids.length) % ids.length] : e.key === "Home" ? ids[0] : e.key === "End" ? ids[ids.length - 1] : undefined;
    if (!next) return;
    e.preventDefault();
    setTab(next);
    document.getElementById(`req-tab-${next}`)?.focus();
  };
  return (
    <div>
      <div role="tablist" aria-label="Request details" onKeyDown={onKey} className="mb-3 flex gap-1 border-b border-line">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`req-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`req-panel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            onClick={() => setTab(id)}
            className={`-mb-px border-b-2 px-2.5 py-1.5 text-sm ${tab === id ? "border-ink font-medium text-ink" : "border-transparent text-muted hover:text-ink"}`}
          >
            {label}
          </button>
        ))}
      </div>
      {tabs.map(([id]) => (
        <div key={id} role="tabpanel" id={`req-panel-${id}`} aria-labelledby={`req-tab-${id}`} hidden={tab !== id} tabIndex={0}>
          {id === "call" && <CallFacts call={call} />}
          {id === "request" && <RequestSide exchange={exchange} />}
          {id === "response" && exchange.response && <Side side={exchange.response} first={["Status", String(exchange.response.status)]} />}
        </div>
      ))}
    </div>
  );
}

function RequestSide({ exchange }: { exchange: Exchange }) {
  const r = exchange.request;
  const curl = curlOf(exchange);
  const query = r.query !== undefined ? uncut(r.query) : undefined;
  return (
    <div className="space-y-3">
      <Side
        side={r}
        first={["Call", <span className="break-all font-mono text-xs">{r.method} {r.fullUrl ?? r.url}{query?.text ? `?${query.text}` : ""}{query?.cut ? " (query cut)" : ""}</span>]}
      />
      <div className="flex flex-wrap items-center gap-2">
        <CopyButton text={curl.command} label="Copy as cURL" ariaLabel="Copy the request as a cURL command" />
        <span className="text-xs text-muted">Redacted as captured: secrets show as [redacted]{curl.complete ? "" : ", and the command's first line says what to fill in"}.</span>
      </div>
    </div>
  );
}

/** Headers and body of one side of the call. */
function Side({ side, first }: { side: ExchangeSide; first: [string, ReactNode | undefined] }) {
  const body = bodyView(side);
  const headers = Object.entries(side.headers ?? {}).sort(([a], [b]) => a.localeCompare(b));
  // bodySize counts characters for text, bytes for a binary body.
  const sized = side.bodySize === undefined ? undefined : body?.binary ? size(side.bodySize) : `${side.bodySize.toLocaleString("en")} characters`;
  return (
    <div className="space-y-3">
      <Facts rows={[first, ["Body size", sized]]} />
      <div>
        <h3 className="mb-1.5 text-xs font-medium text-muted">Headers</h3>
        {headers.length ? <Facts mono rows={headers} /> : <p className="text-sm text-muted">None captured.</p>}
      </div>
      <div>
        <h3 className="mb-1.5 text-xs font-medium text-muted">Body{body?.json ? " (JSON)" : ""}</h3>
        {body?.note && <p className="mb-1.5 rounded-md bg-sev-medium/10 px-2 py-1 text-xs">{body.note}</p>}
        {body?.text ? (
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-md border border-line bg-panel-2 p-2 font-mono text-[11px] leading-relaxed">{body.text}</pre>
        ) : (
          !body?.note && <p className="text-sm text-muted">None captured.</p>
        )}
      </div>
    </div>
  );
}

function CallFacts({ call }: { call: ApiCall }) {
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

