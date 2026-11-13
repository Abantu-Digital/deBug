import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { isIndexError } from "./server/errors";


function ErrorPage({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
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
    defaultErrorComponent: ErrorPage,
    defaultNotFoundComponent: () => <div className="p-8 text-muted">Not found.</div>,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
