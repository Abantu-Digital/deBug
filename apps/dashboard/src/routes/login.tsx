import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Logo } from "~/components/ui";
import { getLoginInfo, getSessionUser, login } from "~/server/fns";

export const Route = createFileRoute("/login")({
  beforeLoad: async () => {
    if (await getSessionUser()) throw redirect({ to: "/" });
  },
  loader: () => getLoginInfo(),
  component: LoginPage,
});

function LoginPage() {
  const info = Route.useLoaderData();
  const router = useRouter();
  const [email, setEmail] = useState(info.demo?.email ?? "");
  const [password, setPassword] = useState(info.demo?.password ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await login({ data: { email, password } });
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
        <h1 className="mt-6 text-xl font-semibold">Sign in</h1>
        <p className="mt-1 text-sm text-muted">
          This dashboard runs on your infrastructure and reads from your{" "}
          {info.store === "demo" ? "demo dataset" : info.store === "memory" ? "in-memory store on this machine" : info.store === "firestore" ? "Firestore" : "DynamoDB"}.
        </p>
        {info.demo && (
          <p className="mt-4 rounded-md bg-accent-soft px-3 py-2 text-xs text-ink">
            Demo mode: sign in with <b>{info.demo.email}</b> / <b>{info.demo.password}</b>. Set <code>DEBUG_DASHBOARD_USERS</code> to require real accounts.
          </p>
        )}
        <label className="mt-5 block text-sm font-medium" htmlFor="email">Email</label>
        <input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)}
          className="mt-1 w-full rounded-md border border-line bg-bg px-3 py-2 text-sm outline-none focus:border-accent" />
        <label className="mt-4 block text-sm font-medium" htmlFor="password">Password</label>
        <input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)}
          className="mt-1 w-full rounded-md border border-line bg-bg px-3 py-2 text-sm outline-none focus:border-accent" />
        {error && <p role="alert" className="mt-3 text-sm text-sev-critical">{error}</p>}
        <button disabled={busy} className="mt-5 w-full rounded-md bg-ink px-3 py-2 text-sm font-medium text-bg disabled:opacity-60">
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
