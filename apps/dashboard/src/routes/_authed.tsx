import { createFileRoute, Link, Outlet, redirect, useRouter } from "@tanstack/react-router";
import { Logo } from "~/components/ui";
import { getSessionUser, logout } from "~/server/fns";

export const Route = createFileRoute("/_authed")({
  beforeLoad: async () => {
    const user = await getSessionUser();
    if (!user) throw redirect({ to: "/login" });
    return { user };
  },
  component: Layout,
});

function Layout() {
  const { user } = Route.useRouteContext();
  const router = useRouter();
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-line bg-bg/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-5">
            <Link to="/" search={{}} className="shrink-0"><Logo /></Link>
            <nav className="flex items-center gap-3 text-sm" aria-label="Main">
              <Link to="/" search={{}} className="text-muted hover:text-ink" activeProps={{ className: "font-medium text-ink" }} activeOptions={{ exact: true }}>Overview</Link>
              <Link to="/settings" search={{}} className="text-muted hover:text-ink" activeProps={{ className: "font-medium text-ink" }}>Settings</Link>
              <Link to="/team" className="text-muted hover:text-ink" activeProps={{ className: "font-medium text-ink" }}>Team</Link>
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
      <Outlet />
    </div>
  );
}
