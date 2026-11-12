import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  return createRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: "intent",
    defaultErrorComponent: ({ error }) => (
      <div className="mx-auto max-w-xl p-8">
        <h1 className="text-lg font-semibold">Something went wrong</h1>
        <pre className="mt-3 overflow-auto rounded-md bg-panel-2 p-3 text-xs">{error instanceof Error ? error.message : String(error)}</pre>
      </div>
    ),
    defaultNotFoundComponent: () => <div className="p-8 text-muted">Not found.</div>,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
