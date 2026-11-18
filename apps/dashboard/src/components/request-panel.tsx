import type { ReactNode } from "react";
import { CopyButton } from "./copy-button";
import { joined } from "./timeline";
import type { ApiCall } from "~/server/event";
import type { Exchange, ExchangeSide } from "~/server/exchange";
import { bodyView, curlOf, size, uncut } from "~/lib/exchange-view";

/**
 * A failed call, as the app made it and as the server answered: the facts first (status, the
 * backend's code and message, how long it took, the trace), then the request and the response
 * side by side. Shown the same way on the issue page and on each occurrence's page.
 */
export function RequestPanel({ call, exchange }: { call: ApiCall; exchange?: Exchange }) {
  return (
    <div className="space-y-4">
      <CallFacts call={call} />
      {exchange ? (
        <div className="grid gap-4 xl:grid-cols-2">
          <section aria-label="Request" className="min-w-0 rounded-lg border border-line p-3">
            <h3 className="mb-2 text-sm font-semibold">What the app sent</h3>
            <RequestSide exchange={exchange} />
          </section>
          <section aria-label="Response" className="min-w-0 rounded-lg border border-line p-3">
            <h3 className="mb-2 text-sm font-semibold">What the server answered</h3>
            {exchange.response ? <Side side={exchange.response} first={["Status", String(exchange.response.status)]} /> : <NoAnswer call={call} />}
          </section>
        </div>
      ) : (
        <p className="rounded-md bg-panel-2 px-3 py-2 text-sm text-muted">
          {call.status === undefined ? <NoAnswer call={call} /> : null}
          The app didn't capture this call's request and response. Turn on the SDK's <code>network.bodies</code> (headers and bodies are redacted on the phone) to see them here.
        </p>
      )}
    </div>
  );
}

/** Why there's no response: the call never got one. The app names the outcome in its own words. */
function NoAnswer({ call }: { call: ApiCall }) {
  const said = `${call.outcome ?? ""} ${call.errorKind ?? ""}`;
  const why = /time/i.test(said)
    ? "The call timed out: the server didn't answer in time."
    : /never|offline|no.?connection/i.test(said)
      ? "The call never left the phone: there was no connection."
      : "No answer came back: the server couldn't be reached, or the connection dropped.";
  return <span className="block text-sm">{why} </span>;
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
        <h4 className="mb-1.5 text-xs font-medium text-muted">Body{body?.json ? " (JSON)" : ""}</h4>
        {body?.note && <p className="mb-1.5 rounded-md bg-sev-medium/10 px-2 py-1 text-xs">{body.note}</p>}
        {body?.text ? (
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-md border border-line bg-panel-2 p-2 font-mono text-[11px] leading-relaxed">{body.text}</pre>
        ) : (
          !body?.note && <p className="text-sm text-muted">None.</p>
        )}
      </div>
      <details>
        <summary className="cursor-pointer text-xs font-medium text-muted hover:text-ink">Headers ({headers.length})</summary>
        <div className="mt-1.5">{headers.length ? <Facts mono rows={headers} /> : <p className="text-sm text-muted">None captured.</p>}</div>
      </details>
    </div>
  );
}

/** The call in one block: what it was, what came back, and how to trace it. */
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
export function Facts({ rows, mono }: { rows: [string, ReactNode | undefined][]; mono?: boolean }) {
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
