import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { isIndexError } from "./server/errors";


/** A new version was deployed while the page was open: its old code files are gone. */
const STALE_CODE = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i;

function ErrorPage({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  // Reload once to pick up the new version; if that doesn't help, show the error.
  if (typeof window !== "undefined" && STALE_CODE.test(message)) {
    let reloaded = false;
    try {
      reloaded = sessionStorage.getItem("debug-reloaded") === location.href;
      sessionStorage.setItem("debug-reloaded", location.href);
    } catch {
      // No storage: reload anyway; the browser stops a loop by keeping the same error page.
    }
    if (!reloaded) {
      window.location.reload();
      return <div className="p-8 text-muted">A new version of the dashboard is out. Loading it…</div>;
    }
  }
  if (isIndexError(message)) {
    const building = /currently building/i.test(message);
    return (
      <div className="mx-auto max-w-xl p-8">
        <h1 className="text-lg font-semibold">{building ? "Firestore is still building deBug's indexes" : "Firestore is missing an index deBug needs"}</h1>
        <p className="mt-2 text-sm text-muted">
          {building
            ? "This takes a few minutes after setup or an upgrade. Reload the page shortly."
            : "Usually this means deBug was upgraded but its indexes weren't. Run npx debugkit deploy-dashboard (or npx debugkit init) to add them; your other indexes are left alone."}
        </p>
        <button className="mt-4 rounded-md border border-line px-3 py-1.5 text-sm hover:bg-panel-2" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-xl p-8">
      <h1 className="text-lg font-semibold">Something went wrong</h1>
      <pre className="mt-3 overflow-auto rounded-md bg-panel-2 p-3 text-xs">{message}</pre>
    </div>
  );
}

export function getRouter() {
  return createRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: "intent",
    // A page already loaded in the last 30 s opens at once, without asking the server again.
    defaultStaleTime: 30_000,
    defaultErrorComponent: ErrorPage,
    defaultNotFoundComponent: () => <div className="p-8 text-muted">Not found.</div>,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
