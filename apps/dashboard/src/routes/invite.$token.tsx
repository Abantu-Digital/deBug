import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Logo } from "~/components/ui";
import { getInvite, joinTeam } from "~/server/fns";

export const Route = createFileRoute("/invite/$token")({
  loader: ({ params }) => getInvite({ data: { token: params.token } }),
  component: InvitePage,
});

const input = "mt-1 w-full rounded-md border border-line bg-bg px-3 py-2 text-sm outline-none focus:border-accent";

function InvitePage() {
  const invite = Route.useLoaderData();
  const { token } = Route.useParams();
  const router = useRouter();
  const [email, setEmail] = useState(invite.valid ? (invite.email ?? "") : "");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!invite.valid) {
    return (
      <main className="flex min-h-screen items-center justify-center px-4">
        <div className="w-full max-w-sm rounded-xl border border-line bg-panel p-6 shadow-sm">
          <Logo />
          <h1 className="mt-6 text-xl font-semibold">This invite link doesn't work</h1>
          <p className="mt-2 text-sm text-muted">It may have been used already, cancelled, or expired (links last 7 days). Ask whoever sent it for a new one.</p>
          <Link to="/login" className="mt-5 inline-block text-sm underline">Sign in instead</Link>
        </div>
      </main>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await joinTeam({ data: { token, email, name, password } });
      if (!res.ok) return setError(res.error);
      await router.invalidate();
      await router.navigate({ to: "/" });
    } catch {
      setError("Could not reach the dashboard server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-xl border border-line bg-panel p-6 shadow-sm">
        <Logo />
        <h1 className="mt-6 text-xl font-semibold">Join the team</h1>
        <p className="mt-1 text-sm text-muted">{invite.invitedBy} invited you as <b>{invite.role}</b>. Choose how you'll sign in.</p>
        <label className="mt-5 block text-sm font-medium" htmlFor="email">Email</label>
        <input id="email" type="email" autoComplete="username" required readOnly={!!invite.email} value={email} onChange={(e) => setEmail(e.target.value)} className={input} />
        <label className="mt-4 block text-sm font-medium" htmlFor="name">Name (optional)</label>
        <input id="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} className={input} />
        <label className="mt-4 block text-sm font-medium" htmlFor="password">Password (10+ characters)</label>
        <input id="password" type="password" autoComplete="new-password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} className={input} />
        {error && <p role="alert" className="mt-3 text-sm text-sev-critical">{error}</p>}
        <button disabled={busy} className="mt-5 w-full rounded-md bg-ink px-3 py-2 text-sm font-medium text-bg disabled:opacity-60">
          {busy ? "Joining…" : "Join and sign in"}
        </button>
      </form>
    </main>
  );
}
