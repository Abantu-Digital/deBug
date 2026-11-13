import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Card, timeAgo } from "~/components/ui";
import { cancelInvite, getTeam, inviteToTeam, removeFromTeam, setMemberRole } from "~/server/fns";

export const Route = createFileRoute("/_authed/team")({
  loader: () => getTeam(),
  component: TeamPage,
});

type Role = "owner" | "admin" | "member";
const ROLE_HELP: Record<Role, string> = {
  owner: "everything, including owners",
  admin: "settings and the team, except owners",
  member: "sees everything, changes issue status",
};

function TeamPage() {
  const team = Route.useLoaderData();
  const router = useRouter();
  const [role, setRole] = useState<Role>("member");
  const [email, setEmail] = useState("");
  const [link, setLink] = useState<{ url: string; expiresAt: string; email?: string } | null>(null);
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const canInvite = team.canManage && team.canWrite;

  const act = async (fn: () => Promise<{ ok: boolean; error?: string }>, done: string) => {
    setBusy(true);
    setStatus(null);
    const out = await fn().catch((e: Error) => ({ ok: false, error: e.message }));
    setBusy(false);
    if (!out.ok) return setStatus({ tone: "error", text: out.error ?? "That didn't work." });
    setStatus({ tone: "ok", text: done });
    await router.invalidate();
  };

  const invite = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setStatus(null);
    setLink(null);
    const out = await inviteToTeam({ data: { role, email: email.trim() || undefined } }).catch((err: Error) => ({ ok: false as const, error: err.message }));
    setBusy(false);
    if (!out.ok) return setStatus({ tone: "error", text: out.error });
    setLink({ url: `${window.location.origin}/invite/${out.token}`, expiresAt: out.expiresAt, email: email.trim() || undefined });
    setEmail("");
    await router.invalidate();
  };

  return (
    <main className="mx-auto max-w-3xl space-y-5 px-4 py-6 sm:px-6">
      <div>
        <h1 className="text-xl font-semibold">Team</h1>
        <p className="mt-1 text-sm text-muted">Everyone who can sign in to this dashboard. Invite people with a link; nothing is emailed.</p>
      </div>

      {canInvite && (
        <Card title="Invite someone" subtitle="The link works once and expires in 7 days.">
          <form onSubmit={invite} className="flex flex-wrap items-end gap-3">
            <label className="min-w-0 flex-1 text-sm">
              <span className="font-medium">Email (optional)</span>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Only this person can use the link"
                className="mt-1 w-full rounded-md border border-line bg-bg px-3 py-2 text-sm outline-none focus:border-accent" />
            </label>
            <label className="text-sm">
              <span className="font-medium">Role</span>
              <select value={role} onChange={(e) => setRole(e.target.value as Role)} className="mt-1 block rounded-md border border-line bg-bg px-3 py-2 text-sm">
                {(team.me.role === "owner" ? (["member", "admin", "owner"] as Role[]) : (["member", "admin"] as Role[])).map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </label>
            <button disabled={busy} className="rounded-md bg-ink px-3 py-2 text-sm font-medium text-bg disabled:opacity-60">Create invite link</button>
          </form>
          <p className="mt-2 text-xs text-muted">{role}: {ROLE_HELP[role]}.</p>
          {link && (
            <div className="mt-4 rounded-md border border-accent bg-accent-soft p-3 text-sm">
              <p className="font-medium">Send this link{link.email ? ` to ${link.email}` : ""}. It's shown only now.</p>
              <div className="mt-2 flex min-w-0 gap-2">
                <input readOnly value={link.url} aria-label="Invite link" onFocus={(e) => e.currentTarget.select()} className="min-w-0 flex-1 rounded-md border border-line bg-bg px-2 py-1.5 font-mono text-xs" />
                <button type="button" className="rounded-md border border-line bg-bg px-2.5 py-1 text-xs hover:bg-panel-2" onClick={() => navigator.clipboard?.writeText(link.url).then(() => setStatus({ tone: "ok", text: "Link copied." }))}>
                  Copy
                </button>
              </div>
            </div>
          )}
        </Card>
      )}
      {team.note && <p className="text-sm text-muted">{team.note}</p>}
      {status && <p role={status.tone === "error" ? "alert" : "status"} className={`text-sm ${status.tone === "error" ? "text-sev-critical" : "text-ink"}`}>{status.text}</p>}

      <Card title="Members" subtitle={`${team.members.length} ${team.members.length === 1 ? "person" : "people"}`}>
        <ul className="divide-y divide-line">
          {team.members.map((m) => {
            const me = m.email === team.me.email;
            const editable = canInvite && m.source === "team" && !me && (team.me.role === "owner" || m.role !== "owner");
            return (
              <li key={m.email} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{m.name ? `${m.name} · ` : ""}{m.email}{me ? " (you)" : ""}</p>
                  <p className="text-xs text-muted">
                    {m.source === "env" ? "Set up with npx debugkit init" : `Joined ${m.createdAt ? timeAgo(m.createdAt) : ""}${m.invitedBy ? `, invited by ${m.invitedBy}` : ""}`}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {editable ? (
                    <select aria-label={`Role for ${m.email}`} value={m.role} disabled={busy} className="rounded-md border border-line bg-bg px-2 py-1 text-sm"
                      onChange={(e) => act(() => setMemberRole({ data: { email: m.email, role: e.target.value } }), `${m.email} is now ${e.target.value}.`)}>
                      {(team.me.role === "owner" ? ["member", "admin", "owner"] : ["member", "admin"]).map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  ) : (
                    <span className="rounded-full border border-line px-2 py-0.5 text-xs">{m.role}</span>
                  )}
                  {editable && (
                    <button disabled={busy} className="rounded-md border border-line px-2.5 py-1 text-xs text-sev-critical hover:bg-panel-2"
                      onClick={() => confirm(`Remove ${m.email}? They're signed out right away.`) && act(() => removeFromTeam({ data: { email: m.email } }), `${m.email} no longer has access.`)}>
                      Remove
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </Card>

      {team.invites.length > 0 && (
        <Card title="Pending invites">
          <ul className="divide-y divide-line">
            {team.invites.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                <span className="min-w-0">
                  <b>{i.role}</b> {i.email ? `for ${i.email}` : "for anyone with the link"} · by {i.invitedBy} · expires {new Date(i.expiresAt).toLocaleDateString()}
                </span>
                {canInvite && (team.me.role === "owner" || i.role !== "owner") && (
                  <button disabled={busy} className="rounded-md border border-line px-2.5 py-1 text-xs hover:bg-panel-2" onClick={() => act(() => cancelInvite({ data: { id: i.id } }), "Invite cancelled.")}>
                    Cancel
                  </button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </main>
  );
}
