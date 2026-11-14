---
"@debugkit/schema": minor
"@debugkit/ingest": minor
"@debugkit/sdk": patch
---

React Native: the culprit is now the app's own code, not a library's. Hermes keeps function names, so known axios, React, React Native runtime and TanStack Query functions are marked as not in-app (`markLibraryFrames`, applied by `parseStack` and again at ingest for older SDKs). Hermes async names like `?anon_0_attemptApiRequest` show as `attemptApiRequest`.

Names that could just as well be an app's own (`request`, `fetchQuery`, `settle`, TanStack's `run` and `fetch`) count as library code only directly under a known library frame at the top of the stack; lower down they're left as app code.

Errors that aren't failed requests are grouped by their top in-app frame, and Hermes names are now cleaned in the grouping key too, so some of them start a new issue once after upgrading ingest. Failed requests still group by endpoint and aren't affected; their culprit updates on the next occurrence.
