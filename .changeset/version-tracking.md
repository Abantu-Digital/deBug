---
"@debugkit/adapters": minor
"@debugkit/ingest": minor
---

Version tracking: ingest records the newest SDK version each app sends from (by semver) and its own version, at most once a day per instance unless the SDK moves on, backing off ten minutes when the store fails, and never failing an envelope over it. Stores gain `recordVersions` and `getVersions`. Every ingest response, accepted, rejected or admin, carries `x-debugkit-version: <ingest version>`, exposed to browsers through `Access-Control-Expose-Headers`. DynamoDB keeps it under `APP#{app}#VERSIONS`; Firestore on the app's own document.
