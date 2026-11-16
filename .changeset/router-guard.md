---
"@debugkit/sdk": patch
---

Breadcrumbs and navigation are safe to call from anywhere: `breadcrumb()`, `navigated()` and the router hooks (`useDebugExpoRouter`, `useDebugNavigation`) never throw into the app, and record nothing after `close()` until the next `init()`. Apps with a kill switch that calls `close()` no longer need their own guard around the router hook.
