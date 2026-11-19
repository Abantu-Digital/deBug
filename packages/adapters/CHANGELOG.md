# @debugkit/adapters

## 0.10.0

### Minor Changes

- a3a03c2: Apps can have a display name. Settings → App name sets what people see the app as ("Megatron Native" for `megatron-native`): in Health's heading, on Settings, on Find a customer, in every app picker and in Slack alerts. The app id doesn't change: the SDK, links and ingest keys keep using it. Leave the name empty to show the id. On cloud setups the ingest function saves it, so upgrade it too (`npx debugkit upgrade`).

### Patch Changes

- Updated dependencies [a3a03c2]
- Updated dependencies [cbf5e0e]
- Updated dependencies [0574b2a]
- Updated dependencies [cf601b5]
- Updated dependencies [474e2a0]
- Updated dependencies [a7bd969]
- Updated dependencies [3a151bf]
  - @debugkit/schema@0.10.0

## 0.9.0

### Minor Changes

- 86ac969: Version tracking: ingest records the newest SDK version each app sends from (by semver) and its own version, at most once a day per instance unless the SDK moves on, backing off ten minutes when the store fails, and never failing an envelope over it. Stores gain `recordVersions` and `getVersions`. Every ingest response, accepted, rejected or admin, carries `x-debugkit-version: <ingest version>`, exposed to browsers through `Access-Control-Expose-Headers`. DynamoDB keeps it under `APP#{app}#VERSIONS`; Firestore on the app's own document.

### Patch Changes

- @debugkit/schema@0.9.0

## 0.8.0

### Minor Changes

- 4ed7eb7: Customer lookup: a Customers page that finds a customer's sessions, newest first, by customer number in any format (0…, 27…, +27…, with spaces or dashes) or by install id, each opening the session timeline. The session page links back to all of that customer's sessions. Stores gain `listUserEvents`. Firestore needs two new events indexes, (user.id, ts desc) and (user.anonymousId, ts desc): rerun the CLI's deploy, or `firebase deploy --only firestore:indexes`. DynamoDB writes each event up to twice more, under `APP#{app}#USEREV#id#{userId}` and `APP#{app}#USEREV#anonymousId#{installId}`, from this version on, so older sessions aren't found there.
- 9015841: Friendly names for API hosts. In Settings, name a host or host and path prefix ("Balance service") and say who looks after it. Names replace raw hosts in issue titles, failing endpoints, response times and explanations; the owner is used for that host's server errors and the failures the rules can't place.
- 95d7bbb: Session timeline: a page per session with its errors, flow events and their breadcrumbs merged in order (each breadcrumb once, each linking to the error it led to), the customer, install, device, app version, the span recorded, and whether it crashed. Reached from an event page's "Whole session". Stores gain `listSessionEvents` (the newest events of a session, oldest first). Firestore needs the new events (sessionId, ts desc) index: rerun the CLI's deploy, or `firebase deploy --only firestore:indexes`. DynamoDB writes each event once more, under `APP#{app}#SESSEV#{sessionId}`, from this version on, so older sessions don't show there.

### Patch Changes

- Updated dependencies [465fb44]
- Updated dependencies [11be9b3]
- Updated dependencies [9e9ee72]
- Updated dependencies [15ffb48]
- Updated dependencies [9015841]
- Updated dependencies [ebe215d]
  - @debugkit/schema@0.8.0

## 0.7.0

### Patch Changes

- @debugkit/schema@0.7.0

## 0.6.1

### Patch Changes

- @debugkit/schema@0.6.1

## 0.6.0

### Minor Changes

- 83ede28: Invite your team. The dashboard has a Team page where owners and admins create single-use invite links (7 days, optionally locked to one email), set roles (owner, admin, member) and remove people, who are signed out at once. Team logins are stored in your own database as scrypt hashes; invite tokens only as SHA-256 hashes. The ingest function gains /admin/team routes, and the stores gain member and invite methods. Settings changes now need an owner or admin, and sign-in is rate-limited.

### Patch Changes

- @debugkit/schema@0.6.0

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

### Patch Changes

- Updated dependencies [b4453dd]
- Updated dependencies [9c7cc90]
  - @debugkit/schema@0.5.0

## 0.4.0

### Patch Changes

- @debugkit/schema@0.4.0

## 0.3.1

### Patch Changes

- @debugkit/schema@0.3.1

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

### Patch Changes

- Updated dependencies [68c73bc]
  - @debugkit/schema@0.3.0

## 0.2.0

### Minor Changes

- 01edca0: Automatic capture: `init()` now records much more without any extra code.

  - **Network:** every fetch and XMLHttpRequest becomes a breadcrumb. Requests that fail, time out or return 5xx are reported as errors with the endpoint, status, duration and the code that made the call. On Node, `node:http` requests and the 5xx responses your server sends are covered too. Query strings never leave the device, and ids in paths become `:id`.
  - **Sessions and release health:** each session sends a "started" marker, then "errored" and "crashed" at most once each. The dashboard shows crash-free and error-free rates per app version.
  - **More breadcrumbs:** console warnings and errors, page navigation through the History API, clicks by their label, foreground and background, and online and offline.
  - **Noise control:** per-minute rate limits (`maxErrorsPerMinute`), `sampleRate`, and repeated breadcrumbs collapse into one.
  - **Configuration:** use `autoCapture` to switch any part off, and `network.flows` to tag requests with a flow by URL. `captureGlobalErrors` is deprecated in favour of `autoCapture: { errors: false }`.

  **Upgrading:** deploy the new `@debugkit/ingest` along with the new SDK to get sessions and endpoint details. If the app ships first, the SDK detects the older ingest (it rejects the new fields with a 400), falls back to sending what that ingest understands, and errors and events keep arriving.

### Patch Changes

- Updated dependencies [01edca0]
  - @debugkit/schema@0.2.0
