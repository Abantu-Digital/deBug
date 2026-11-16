import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { OutcomeBadge, clock, joined } from "~/components/timeline";
import { Card, timeAgo } from "~/components/ui";
import { findCustomer } from "~/server/fns";

type Search = { app?: string; q?: string };

export const Route = createFileRoute("/_authed/customers")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    app: typeof s.app === "string" ? s.app : undefined,
    q: typeof s.q === "string" && s.q.trim() ? s.q : undefined,
  }),
  loaderDeps: ({ search }) => ({ app: search.app, q: search.q }),
  loader: ({ deps }) => findCustomer({ data: { app: deps.app, q: deps.q ?? "" } }),
  component: CustomersPage,
});

/** "No errors", "3 errors, all caught", "3 errors, 1 caught". */
function errorCount(errors: number, handled: number) {
  if (!errors) return "No errors";
  const n = `${errors} error${errors === 1 ? "" : "s"}`;
  return handled === errors ? `${n}, ${errors === 1 ? "caught" : "all caught"}` : handled ? `${n}, ${handled} caught` : n;
}

const MATCHED = { id: "customer number", anonymousId: "install id" } as const;

function CustomersPage() {
  const { apps, app, store, lookup, missingIndex } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const [q, setQ] = useState(search.q ?? "");
  // Back and forward change the query in the URL: keep the box in step.
  useEffect(() => setQ(search.q ?? ""), [search.q]);
  const where = app ?? (apps.length > 1 ? "any app" : apps[0]);

  return (
    <main className="mx-auto max-w-5xl space-y-5 px-4 py-6 sm:px-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Find a customer</h1>
        <p className="mt-1 text-sm text-muted">A customer number in any format (0841234567, 27841234567, +27 84 123 4567) or an install id. Their sessions are listed newest first.</p>
      </div>

      <form
        role="search"
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          navigate({ search: (s) => ({ ...s, q: q.trim() || undefined }) });
        }}
      >
        <input
          type="search"
          aria-label="Customer number or install id"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Customer number or install id"
          autoFocus
          className="min-w-0 flex-1 rounded-md border border-line bg-panel px-3 py-2 font-mono text-sm text-ink sm:max-w-md"
        />
        {apps.length > 1 && (
          <select aria-label="App" value={app ?? ""} onChange={(e) => navigate({ search: (s) => ({ ...s, app: e.target.value || undefined }) })} className="rounded-md border border-line bg-panel px-2 py-2 text-sm">
            <option value="">All apps</option>
            {apps.map((a) => <option key={a}>{a}</option>)}
          </select>
        )}
        <button type="submit" className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-white hover:opacity-90">Find</button>
      </form>

      {missingIndex && (
        <p className="text-sm text-muted">
          Firestore needs deBug's new indexes on events (user.id, ts) and (user.anonymousId, ts). Deploy them with: firebase deploy --only firestore:indexes, using deBug's firestore.indexes.json. They take a few minutes to build.
        </p>
      )}
      {!apps.length && <p className="text-sm text-muted">No apps have sent events yet.</p>}

      {lookup && (
        lookup.sessions.length === 0 ? (
          <p className="text-sm text-muted">
            No sessions found for <span className="font-mono text-ink">{lookup.query}</span> in {where}. Events are kept for the retention period only, and a customer number is only known once the app sets it.
            {store === "dynamodb" && " On DynamoDB, only events stored since deBug started keeping them by customer can be found."}
          </p>
        ) : (
          <Card
            title={`${lookup.sessions.length} session${lookup.sessions.length === 1 ? "" : "s"}`}
            subtitle={`Matched by ${lookup.matched.map((m) => MATCHED[m]).join(" and ")}. Only sessions with a stored error or flow event are listed.`}
          >
            <ul className="divide-y divide-line">
              {lookup.sessions.map((s) => (
                <li key={s.sessionId}>
                  <Link to="/sessions/$sessionId" params={{ sessionId: s.sessionId }} search={{ app: s.app }} className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 px-1 py-2.5 hover:bg-panel-2 sm:grid-cols-[11rem_6.5rem_1fr_auto]">
                    <span className="text-sm" title={`First stored event ${s.start}, last ${s.end}`}>
                      {clock(s.end)}
                      <span className="block text-xs text-muted">{timeAgo(s.end)}</span>
                    </span>
                    <span className="justify-self-end sm:justify-self-start"><OutcomeBadge outcome={s.outcome} /></span>
                    <span className="min-w-0 text-sm">
                      <span className="text-muted">App </span>{joined([s.context.app.version, s.context.app.build && `(${s.context.app.build})`]) ?? "—"}
                      <span className="text-muted"> · </span>{joined([s.context.device.brand, s.context.device.model]) ?? joined([s.context.os.name, s.context.os.version]) ?? "—"}
                      {!app && apps.length > 1 && <span className="text-muted"> · {s.app}</span>}
                      {s.user.id && s.user.id !== lookup.query && <span className="ml-2 font-mono text-xs text-muted">{s.user.id}</span>}
                    </span>
                    <span className="text-xs text-muted sm:text-right">
                      {errorCount(s.errors, s.handled)}
                      {s.failedFlows > 0 && <span className="block font-medium text-sev-high">{s.failedFlows} failed flow{s.failedFlows === 1 ? "" : "s"}</span>}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            {lookup.truncated && <p className="mt-3 text-xs text-muted">This customer has more stored events than one lookup reads: older sessions are left out, and the oldest one listed may be only partly read.</p>}
          </Card>
        )
      )}
    </main>
  );
}
