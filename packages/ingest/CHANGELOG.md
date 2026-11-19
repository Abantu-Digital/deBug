# @debugkit/ingest

## 0.10.0

### Minor Changes

- a3a03c2: Apps can have a display name. Settings → App name sets what people see the app as ("Megatron Native" for `megatron-native`): in Health's heading, on Settings, on Find a customer, in every app picker and in Slack alerts. The app id doesn't change: the SDK, links and ingest keys keep using it. Leave the name empty to show the id. On cloud setups the ingest function saves it, so upgrade it too (`npx debugkit upgrade`).
- cf601b5: A phone going offline is one problem now, not an issue per endpoint it couldn't reach. Every request that never left the phone (no status, faster than 100 ms, not a timeout) goes to one "Phone offline" issue, ranked Low, labelled `network.offline` with no owner. It stays out of endpoint failures, owners, flows, incidents, alerts and the active issue count. Health's Folded away line counts them ("Offline phones: 3 times on 3 phones, 18 calls never sent →") and opens the offline issue, whose page lists each burst per phone with the calls that never left it. The SDK's request timings leave such calls out, so endpoint failure rates no longer count them. Errors already stored, and request timings already sent, aren't corrected: only new data is.
- 474e2a0: Test errors: mark errors you make on purpose with `deBug.error(err, { test: true })`, or throw or reject with `deBug.testError("…")` so a test crash or unhandled rejection is caught as a test by any handler. They get their own issues, never count toward totals, flows, endpoints, labels, customers or crash-free rates, never alert, and the dashboard keeps them off every box: Health's "Folded away" line links to them, listed apart on the App code page (`/app-code?tests=1`, or `?tests=1` on `/api/summary`). Ingest also ignores a session crash marker that only test errors caused. `npx debugkit test` sends test events, so its guide now asks for them. Errors already stored aren't relabelled.

### Patch Changes

- ff2b705: The issue page has a new "What the trail shows" section: rule-based advice from patterns in what customers did before the error (a call sent twice, a repeat that failed, calls before login, a 401 after a long time in the background, a request that hung in the background, a 4xx an endpoint always gives), each with the evidence it read. Advice says what the app should change, or where to search the backend's logs; never what the backend should change. The template advice is now "General advice".
- Updated dependencies [a3a03c2]
- Updated dependencies [cbf5e0e]
- Updated dependencies [0574b2a]
- Updated dependencies [cf601b5]
- Updated dependencies [474e2a0]
- Updated dependencies [a7bd969]
- Updated dependencies [3a151bf]
  - @debugkit/schema@0.10.0
  - @debugkit/adapters@0.10.0

## 0.9.0

### Minor Changes

- 86ac969: Version tracking: ingest records the newest SDK version each app sends from (by semver) and its own version, at most once a day per instance unless the SDK moves on, backing off ten minutes when the store fails, and never failing an envelope over it. Stores gain `recordVersions` and `getVersions`. Every ingest response, accepted, rejected or admin, carries `x-debugkit-version: <ingest version>`, exposed to browsers through `Access-Control-Expose-Headers`. DynamoDB keeps it under `APP#{app}#VERSIONS`; Firestore on the app's own document.

### Patch Changes

- Updated dependencies [86ac969]
  - @debugkit/adapters@0.9.0
  - @debugkit/schema@0.9.0

## 0.8.0

### Minor Changes

- 465fb44: React Native: the culprit is now the app's own code, not a library's. Hermes keeps function names, so known axios, React, React Native runtime and TanStack Query functions are marked as not in-app (`markLibraryFrames`, applied by `parseStack` and again at ingest for older SDKs). Hermes async names like `?anon_0_attemptApiRequest` show as `attemptApiRequest`.

  Names that could just as well be an app's own (`request`, `fetchQuery`, `settle`, TanStack's `run` and `fetch`) count as library code only directly under a known library frame at the top of the stack; lower down they're left as app code.

  Errors that aren't failed requests are grouped by their top in-app frame, and Hermes names are now cleaned in the grouping key too, so some of them start a new issue once after upgrading ingest. Failed requests still group by endpoint and aren't affected; their culprit updates on the next occurrence.

- 11be9b3: Errors are labelled at ingest with a category, a likely owner, a user impact and causes (docs/taxonomy.md). The labels are stored with each error event and rolled up as new `category`, `owner` and `impact` dimensions. `/api/summary` adds `issues[].labels` and `breakdowns.category|owner|impact`, and the issue page has `issue.labels`. Issues stored before this release get their labels worked out when read. Also on the issue page: severity now ranks one level higher in critical flows, as it already did in the list, so the two pages agree.
- b009f0f: Explanations: every issue gets a plain summary for support (what the user saw in plain words, e.g. "Balances didn't load", where, for how many people, after which action, a sentence per cause, whether it's still happening, who to pass it to) and technical detail for developers (category, owner and impact, evidence, where in the code and what started it, a suggested fix). One template per category, no LLM. They're on the issue page, which can copy them as Markdown for a ticket, in `/api/summary` as `issues[].explanation`, and in the prefilled Linear and GitHub links. `evidenceOf()` in `@debugkit/ingest` exposes the facts behind the labels. For request failures the generic network, auth and server hints are replaced by the explanation; other hints stay under "Also worth checking".
- 9015841: Friendly names for API hosts. In Settings, name a host or host and path prefix ("Balance service") and say who looks after it. Names replace raw hosts in issue titles, failing endpoints, response times and explanations; the owner is used for that host's server errors and the failures the rules can't place.
- ebe215d: Incidents: issues that fail together for the same reason are folded into one problem, keyed by cause, category and OS (e.g. "Requests failed on app resume (iOS)"). Ingest stores each error's incident and rolls up errors per incident, per issue in it, and per user. An incident is a recurring problem across users and days, with its episodes (separate times it happened), users and first and last day. The overview lists active incidents with their issues above the issue table, each issue page names its incident, and `/api/summary` adds `incidents[]` and `issues[].incident`. Counts start from this release.

### Patch Changes

- Updated dependencies [465fb44]
- Updated dependencies [4ed7eb7]
- Updated dependencies [11be9b3]
- Updated dependencies [9e9ee72]
- Updated dependencies [15ffb48]
- Updated dependencies [9015841]
- Updated dependencies [ebe215d]
- Updated dependencies [95d7bbb]
  - @debugkit/schema@0.8.0
  - @debugkit/adapters@0.8.0

## 0.7.0

### Patch Changes

- @debugkit/schema@0.7.0
- @debugkit/adapters@0.7.0

## 0.6.1

### Patch Changes

- @debugkit/schema@0.6.1
- @debugkit/adapters@0.6.1

## 0.6.0

### Minor Changes

- 83ede28: Invite your team. The dashboard has a Team page where owners and admins create single-use invite links (7 days, optionally locked to one email), set roles (owner, admin, member) and remove people, who are signed out at once. Team logins are stored in your own database as scrypt hashes; invite tokens only as SHA-256 hashes. The ingest function gains /admin/team routes, and the stores gain member and invite methods. Settings changes now need an owner or admin, and sign-in is rate-limited.

### Patch Changes

- Updated dependencies [83ede28]
  - @debugkit/adapters@0.6.0
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

- Updated dependencies [6ce7aca]
- Updated dependencies [b4453dd]
- Updated dependencies [9c7cc90]
  - @debugkit/adapters@0.5.0
  - @debugkit/schema@0.5.0

## 0.4.0

### Patch Changes

- @debugkit/schema@0.4.0
- @debugkit/adapters@0.4.0

## 0.3.1

### Patch Changes

- @debugkit/schema@0.3.1
- @debugkit/adapters@0.3.1

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
  - @debugkit/adapters@0.3.0

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
  - @debugkit/adapters@0.2.0
