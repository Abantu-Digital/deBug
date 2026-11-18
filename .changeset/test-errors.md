---
"@debugkit/schema": minor
"@debugkit/sdk": minor
"@debugkit/ingest": minor
"@debugkit/dashboard": minor
"@debugkit/cli": patch
---

Test errors: mark errors you make on purpose with `deBug.error(err, { test: true })`, or throw or reject with `deBug.testError("…")` so a test crash or unhandled rejection is caught as a test by any handler. They get their own issues, never count toward totals, flows, endpoints, labels, customers or crash-free rates, never alert, and the dashboard hides them until you press "Show test errors" (`?tests=1` on `/api/summary`). Ingest also ignores a session crash marker that only test errors caused. `npx debugkit test` sends test events, so its guide now asks for them. Errors already stored aren't relabelled.
