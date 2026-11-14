---
"@debugkit/schema": minor
"@debugkit/ingest": minor
"@debugkit/dashboard": minor
---

Incidents: issues that fail together for the same reason are folded into one problem, keyed by cause, category and OS (e.g. "Requests failed on app resume (iOS)"). Ingest stores each error's incident and rolls up errors per incident, per issue in it, and per user. An incident is a recurring problem across users and days, with its episodes (separate times it happened), users and first and last day. The overview lists active incidents with their issues above the issue table, each issue page names its incident, and `/api/summary` adds `incidents[]` and `issues[].incident`. Counts start from this release.
