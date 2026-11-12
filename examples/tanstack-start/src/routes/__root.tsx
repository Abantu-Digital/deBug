import { DebugErrorBoundary } from "@debug/sdk/react";
import { createRootRoute, HeadContent, Link, Outlet, Scripts } from "@tanstack/react-router";
import type { ReactNode } from "react";

export const Route = createRootRoute({
  head: () => ({ meta: [{ charSet: "utf-8" }, { name: "viewport", content: "width=device-width, initial-scale=1" }, { title: "deBug · TanStack Start example" }] }),
  shellComponent: ({ children }: { children: ReactNode }) => (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body style={{ fontFamily: "system-ui", maxWidth: 560, margin: "40px auto", padding: "0 16px" }}>
        {children}
        <Scripts />
      </body>
    </html>
  ),
  component: () => (
    <>
      <nav style={{ display: "flex", gap: 12, marginBottom: 16 }}>
        <Link to="/">Home</Link>
        <Link to="/about">About</Link>
      </nav>
      <DebugErrorBoundary
        flow="app.root"
        fallback={({ error, reset }) => (
          <div>
            <h1>Something went wrong</h1>
            <p>{error.message}</p>
            <button onClick={reset}>Try again</button>
          </div>
        )}
      >
        <Outlet />
      </DebugErrorBoundary>
    </>
  ),
});
