import type { ReactNode } from "react";
import { createFileRoute, Link, Outlet, redirect, useRouter, useRouterState } from "@tanstack/react-router";
import { Logo } from "~/components/ui";
import type { PageSearch } from "~/components/range-picker";
import { VersionBanner } from "~/components/version-banner";
import { getSessionUser, logout, refreshData } from "~/server/fns";

export const Route = createFileRoute("/_authed")({
  beforeLoad: async () => {
    const user = await getSessionUser();
    if (!user) throw redirect({ to: "/login" });
    return { user };
  },
  component: Layout,
});

/** The pages under Health (drilled down from a box), so the menu keeps Health lit on them. */
const UNDER_HEALTH = /^\/(app-code|services\/|issues\/)/;

/**
 * A main-menu link. The page you're on is filled in and underlined, so it's clear where you are;
 * Health stays lit on the pages drilled down from it. Keeps the app and period.
 */
function NavLink({ to, children }: { to: "/" | "/endpoints" | "/customers" | "/settings" | "/team"; children: ReactNode }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const on = to === "/" ? path === "/" || UNDER_HEALTH.test(path) : path === to || path.startsWith(`${to}/`);
  return (
    <Link
      to={to}
      // Keep the app and period; drop page-specific filters.
      search={(s: PageSearch) => ({ app: s.app, range: s.range, from: s.from, to: s.to })}
      aria-current={on ? "page" : undefined}
      className={`rounded-md border-b-2 px-2.5 py-1.5 hover:bg-panel-2 hover:text-ink ${on ? "border-accent bg-panel-2 font-semibold text-ink" : "border-transparent text-muted"}`}
    >
      {children}
    </Link>
  );
}

function Layout() {
  const { user } = Route.useRouteContext();
  const router = useRouter();
  // A click always answers at once: a bar runs along the top while the next page loads.
  const loading = useRouterState({ select: (s) => s.status === "pending" });
  return (
    <div className="min-h-screen">
      <div role="progressbar" aria-label="Loading" aria-hidden={!loading} className={`fixed inset-x-0 top-0 z-50 h-0.5 overflow-hidden ${loading ? "" : "invisible"}`}>
        <div className="loading-bar h-full w-1/3 bg-accent" />
      </div>
      <header className="sticky top-0 z-10 border-b border-line bg-bg/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2">
            <Link to="/" search={{}} className="shrink-0"><Logo /></Link>
            <nav className="flex flex-wrap items-center gap-1 text-sm" aria-label="Main">
              <NavLink to="/">Health</NavLink>
              <NavLink to="/endpoints">Endpoints</NavLink>
              <NavLink to="/customers">Customers</NavLink>
              <NavLink to="/settings">Settings</NavLink>
              <NavLink to="/team">Team</NavLink>
            </nav>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="hidden text-muted sm:inline">{user.email} · {user.role}</span>
            <button
              type="button"
              title="Pages show data up to 2 minutes old while newer data loads. Refresh reads everything now."
              className="rounded-md border border-line px-2.5 py-1 hover:bg-panel-2"
              onClick={async () => {
                await refreshData();
                await router.invalidate();
              }}
            >
              Refresh
            </button>
            <button
              className="rounded-md border border-line px-2.5 py-1 hover:bg-panel-2"
              onClick={async () => {
                await logout();
                await router.invalidate();
                await router.navigate({ to: "/login" });
              }}
            >
              Sign out
            </button>
          </div>
        </div>
      </header>
      <VersionBanner />
      <Outlet />
    </div>
  );
}
