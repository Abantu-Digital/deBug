import type { ReactNode } from "react";
import { createFileRoute, Link, Outlet, redirect, useRouter } from "@tanstack/react-router";
import { Logo } from "~/components/ui";
import { VersionBanner } from "~/components/version-banner";
import { getSessionUser, logout } from "~/server/fns";

export const Route = createFileRoute("/_authed")({
  beforeLoad: async () => {
    const user = await getSessionUser();
    if (!user) throw redirect({ to: "/login" });
    return { user };
  },
  component: Layout,
});

/** A main-menu link. The page you're on is filled in and underlined, so it's clear where you are. */
function NavLink({ to, exact, children }: { to: "/" | "/issues" | "/endpoints" | "/customers" | "/settings" | "/team"; exact?: boolean; children: ReactNode }) {
  return (
    <Link
      to={to}
      search={{}}
      className="rounded-md border-b-2 border-transparent px-2.5 py-1.5 text-muted hover:bg-panel-2 hover:text-ink"
      activeProps={{ className: "!border-accent bg-panel-2 font-semibold !text-ink", "aria-current": "page" }}
      activeOptions={{ exact: !!exact, includeSearch: false }}
    >
      {children}
    </Link>
  );
}

function Layout() {
  const { user } = Route.useRouteContext();
  const router = useRouter();
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-line bg-bg/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2">
            <Link to="/" search={{}} className="shrink-0"><Logo /></Link>
            <nav className="flex flex-wrap items-center gap-1 text-sm" aria-label="Main">
              <NavLink to="/" exact>Health</NavLink>
              <NavLink to="/issues">Issues</NavLink>
              <NavLink to="/endpoints">Endpoints</NavLink>
              <NavLink to="/customers">Customers</NavLink>
              <NavLink to="/settings">Settings</NavLink>
              <NavLink to="/team">Team</NavLink>
            </nav>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="hidden text-muted sm:inline">{user.email} · {user.role}</span>
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
