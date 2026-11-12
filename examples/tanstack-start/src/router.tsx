import "./debug-browser"; // guarded by typeof window, so it is safe to import from shared code
import { createRouter } from "@tanstack/react-router";
import { trackTanStackRouter } from "@debugkit/sdk/react";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  const router = createRouter({ routeTree, scrollRestoration: true, defaultNotFoundComponent: () => <p>Not found.</p> });
  if (typeof window !== "undefined") trackTanStackRouter(router); // a breadcrumb per navigation
  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
