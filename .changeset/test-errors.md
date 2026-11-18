---
"@debugkit/schema": minor
"@debugkit/sdk": minor
"@debugkit/ingest": minor
"@debugkit/dashboard": minor
"@debugkit/cli": patch
---

Test errors: mark errors you make on purpose with `deBug.error(err, { test: true })`, or `deBug.setTags({ test: "true" })` before a test crash. They get their own issues, never count toward totals, flows, endpoints, labels or crash-free rates, never alert, and the dashboard hides them until you press "Show test errors" (`?tests=1` on `/api/summary`). `npx debugkit test` sends test errors, so its guide now asks for them. Errors already stored aren't relabelled.
