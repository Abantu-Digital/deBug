---
"@debugkit/sdk": patch
---

`close()` now really stops the client: after sending what is queued, errors, events, sessions and breadcrumbs are ignored until the next `init()`, so a remote kill switch that calls `close()` needs no guard of its own. `breadcrumb()`, `navigated()` and the router hooks (`useDebugExpoRouter`, `useDebugNavigation`) never throw into the app.
