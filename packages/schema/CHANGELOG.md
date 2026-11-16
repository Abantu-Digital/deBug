# @debugkit/schema

## 0.9.0

## 0.8.0

### Minor Changes

- 465fb44: React Native: the culprit is now the app's own code, not a library's. Hermes keeps function names, so known axios, React, React Native runtime and TanStack Query functions are marked as not in-app (`markLibraryFrames`, applied by `parseStack` and again at ingest for older SDKs). Hermes async names like `?anon_0_attemptApiRequest` show as `attemptApiRequest`.

  Names that could just as well be an app's own (`request`, `fetchQuery`, `settle`, TanStack's `run` and `fetch`) count as library code only directly under a known library frame at the top of the stack; lower down they're left as app code.

  Errors that aren't failed requests are grouped by their top in-app frame, and Hermes names are now cleaned in the grouping key too, so some of them start a new issue once after upgrading ingest. Failed requests still group by endpoint and aren't affected; their culprit updates on the next occurrence.

- 11be9b3: Errors are labelled at ingest with a category, a likely owner, a user impact and causes (docs/taxonomy.md). The labels are stored with each error event and rolled up as new `category`, `owner` and `impact` dimensions. `/api/summary` adds `issues[].labels` and `breakdowns.category|owner|impact`, and the issue page has `issue.labels`. Issues stored before this release get their labels worked out when read. Also on the issue page: severity now ranks one level higher in critical flows, as it already did in the list, so the two pages agree.
- 9e9ee72: Error taxonomy: `CATEGORIES` (in rule order), `OWNERS`, `IMPACTS` and `CAUSES` with plain-language names and descriptions (`CATEGORY_INFO` and so on) and a `Classification` type, on the zod-free entry. The rules behind each label are in docs/taxonomy.md. Nothing sets them yet; the ingest classifier comes next.
- 15ffb48: The full request and response of a failed call. With `network.bodies: { onFailure: true }` (on by default with `initReactNative`), a failed call's error carries its method, URL with query string, headers and body, and the response's status, headers and body. Secrets are redacted on the device first: auth and cookie headers and any header named for a token, key or secret; password, PIN, one-time-code, card, token and API-key fields at any depth (including JSON cut short, JSON or forms inside a string, `user[password]` form keys and plain text); JWTs and Luhn-valid card numbers anywhere, also as JSON numbers. Each body is cut at 16 KB, binary bodies are recorded by size and type, and ingest cuts oversized bodies rather than reject the event. Uploads are now also limited by size, so queued failures with bodies never exceed ingest's 512 KB limit.
- 9015841: Friendly names for API hosts. In Settings, name a host or host and path prefix ("Balance service") and say who looks after it. Names replace raw hosts in issue titles, failing endpoints, response times and explanations; the owner is used for that host's server errors and the failures the rules can't place.
- ebe215d: Incidents: issues that fail together for the same reason are folded into one problem, keyed by cause, category and OS (e.g. "Requests failed on app resume (iOS)"). Ingest stores each error's incident and rolls up errors per incident, per issue in it, and per user. An incident is a recurring problem across users and days, with its episodes (separate times it happened), users and first and last day. The overview lists active incidents with their issues above the issue table, each issue page names its incident, and `/api/summary` adds `incidents[]` and `issues[].incident`. Counts start from this release.

## 0.7.0

## 0.6.1

## 0.6.0

## 0.5.0

### Minor Changes

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

## 0.2.0

### Minor Changes

- 01edca0: Automatic capture: `init()` now records much more without any extra code.

  - **Network:** every fetch and XMLHttpRequest becomes a breadcrumb. Requests that fail, time out or return 5xx are reported as errors with the endpoint, status, duration and the code that made the call. On Node, `node:http` requests and the 5xx responses your server sends are covered too. Query strings never leave the device, and ids in paths become `:id`.
  - **Sessions and release health:** each session sends a "started" marker, then "errored" and "crashed" at most once each. The dashboard shows crash-free and error-free rates per app version.
  - **More breadcrumbs:** console warnings and errors, page navigation through the History API, clicks by their label, foreground and background, and online and offline.
  - **Noise control:** per-minute rate limits (`maxErrorsPerMinute`), `sampleRate`, and repeated breadcrumbs collapse into one.
  - **Configuration:** use `autoCapture` to switch any part off, and `network.flows` to tag requests with a flow by URL. `captureGlobalErrors` is deprecated in favour of `autoCapture: { errors: false }`.

  **Upgrading:** deploy the new `@debugkit/ingest` along with the new SDK to get sessions and endpoint details. If the app ships first, the SDK detects the older ingest (it rejects the new fields with a 400), falls back to sending what that ingest understands, and errors and events keep arriving.
