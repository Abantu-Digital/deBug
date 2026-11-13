---
"@debugkit/schema": minor
"@debugkit/sdk": minor
"@debugkit/adapters": minor
"@debugkit/ingest": minor
"@debugkit/dashboard": minor
---

Who is affected, and when it started.

- **Users affected:**
  - Each issue shows how many distinct users hit it in the range.
  - The overview shows crash-free users next to crash-free sessions.
  - Ingest records a hashed id per user (or per install) in three scopes: the app, crashes, and each issue. That's at most one write per user per day.
  - The SDK now keeps its anonymous id across launches: in localStorage on the web, and in the `storage` option on React Native.
- **Releases:**
  - The trend chart marks the day each release first had sessions.
  - Issues first seen in the newest version get a "New in X" label.
  - `app.update` (for example a hot-updater bundle id) makes each OTA update count as its own release.
- **Issue status:**
  - Resolve an issue (with the version that has the fix), ignore it, or reopen it.
  - If it comes back in that version or later, it's marked Regressed.
  - Ignored and resolved issues drop out of the summary and counts. The overview has Open / Resolved / Ignored / All filters.
  - Status changes go through the ingest admin route `PUT /admin/issue`.
- **Create a ticket:** set `DEBUG_LINEAR_TEAM` or `DEBUG_LINEAR=1`, and/or `DEBUG_GITHUB_REPO`, to get "Create Linear issue" and "Create GitHub issue" buttons. They open the tracker with the issue's story filled in.
- **Adapters:** `markUsers`, `countUsers` and `setIssueStatus`. Issues gain `status`, `resolvedIn`, `firstVersion` and `lastVersion`. Firestore needs the new `users` index from `firestore.indexes.json`.
