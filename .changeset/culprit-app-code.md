---
"@debugkit/schema": minor
"@debugkit/ingest": minor
---

React Native: the culprit is now the app's own code, not a library's. Hermes keeps function names, so known axios, React, React Native runtime and TanStack Query functions are marked as not in-app (`markLibraryFrames`, applied by `parseStack` and again at ingest for older SDKs). Hermes async names like `?anon_0_attemptApiRequest` show as `attemptApiRequest`.

Errors that aren't failed requests are grouped by their top in-app frame, so some of them start a new issue once after upgrading ingest. Failed requests still group by endpoint and aren't affected; their culprit updates on the next occurrence.
