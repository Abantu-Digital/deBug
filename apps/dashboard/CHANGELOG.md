# @debugkit/dashboard

## 0.6.0

### Minor Changes

- aa30345: Host the dashboard for your team. `npx debugkit init` now offers to put the dashboard online in the same Firebase project (its own Hosting site, a read-only service account) or AWS account (a Lambda with a Function URL and a read-only role), and `npx debugkit deploy-dashboard` does it any time. The dashboard exports `@debugkit/dashboard/handler` and `@debugkit/dashboard/lambda` for other hosts, and the cookie name is configurable (`DEBUG_COOKIE_NAME`). firebase-admin and the AWS SDK are now optional dependencies of the dashboard.
- 83ede28: Invite your team. The dashboard has a Team page where owners and admins create single-use invite links (7 days, optionally locked to one email), set roles (owner, admin, member) and remove people, who are signed out at once. Team logins are stored in your own database as scrypt hashes; invite tokens only as SHA-256 hashes. The ingest function gains /admin/team routes, and the stores gain member and invite methods. Settings changes now need an owner or admin, and sign-in is rate-limited.

## 0.5.0

### Minor Changes

- 6ce7aca: You choose how long raw events are kept, and every view takes a date range.

  - **Retention:**
    - `npx debugkit init` asks how long to keep raw events: 30, 60 (default), 90, 180, 365 days, or any number. It shows a rough storage cost.
    - The dashboard's new Settings page shows the current period, changes it per app, and can apply it to events already stored.
    - The setting is stored in your own database (a settings record per app). Ingest reads it, cached for a minute, and falls back to `DEBUG_RETENTION_DAYS`.
    - Counts, issues and release health are still kept forever.
  - **Admin routes on ingest:** `GET/PUT /admin/settings` and `POST /admin/restamp`, protected by `DEBUG_ADMIN_TOKEN`. The dashboard calls them, so its database credentials stay read-only.
  - **Date ranges:**
    - The overview and issue pages take 24h, 7, 14, 30 or 90 days, or a custom range, with a comparison against the previous period.
    - Charts are hourly for 24h, daily up to 90 days and weekly beyond.
    - The range is in the URL and in `/api/summary` and `/api/issues/:fp` (`range`, `from`, `to`).
    - Summary fields now say "Range" instead of "14d": `errorsRange`, `eventsRange`, `sessionsRange`, `failuresRange`.
  - **Adapters:**
    - `getSettings`, `putSettings`, `restampExpiry`, and `writeEvents(events, { retentionDays })`.
    - Hourly counters expire after 7 days. Firestore needs the TTL rule on `rollups.expireAt` from the updated `firestore.indexes.json`.

- b4453dd: Where it fails, and how much it matters.

  - **Steps that fail:** the failure rate per `track(flow, step)` step, for example "auth.login · submit_otp fails 62%".
  - **Response times:**
    - The SDK times every request and sends one `metric` event per endpoint about once a minute: count, failures, and a 13-bucket histogram.
    - The dashboard shows p50/p95 and the error rate for the busiest endpoints.
    - If an older ingest rejects metric events, the SDK stops sending them and keeps everything else.
  - **Network and country:**
    - Errors are broken down by network type, and by country.
    - Country comes from the device's timezone, then its locale. IP addresses are never used.
    - The summary calls out when most errors happen on cellular.
  - **Slack alerts:**
    - Ingest posts to a Slack incoming webhook when an issue first appears or regresses: at most once an hour per issue, optionally only for critical flows.
    - Set it up on the Settings page, which includes a "Send a test alert" button. The webhook is stored in your database and shown masked.
    - Only `hooks.slack.com` URLs are accepted.
  - **Critical flows:** flows marked critical in Settings rank their issues one severity level higher.
  - **Adapters:** `upsertIssues` returns which issues were created or regressed. Settings gain `criticalFlows` and `alerts`.

- 9c7cc90: Who is affected, and when it started.

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

## 0.4.0

## 0.3.1

## 0.3.0

### Minor Changes

- 68c73bc: New `debugkit` CLI: `npx debugkit init` sets deBug up end to end.

  - Detects the app and installs the SDK.
  - Asks for a provider: Firebase, AWS, or just this machine.
  - Signs you in through each provider's own browser flow, then provisions ingest in your own account: a Cloud Function and Firestore, or a Lambda with a Function URL and DynamoDB.
  - Writes the endpoint, the ingest key and `debug.ts` into the app.
  - Opens the empty dashboard and walks you through it, with a test event sent through the real ingest.

  Also adds `npx debugkit dashboard`, `test` and `guide`.

  The dashboard is now published as `@debugkit/dashboard`, so it runs with `npx`. It has two new things:

  - a `memory` store for trying deBug with no cloud;
  - a guided empty state that explains what each part will show and refreshes by itself until the first event arrives.
