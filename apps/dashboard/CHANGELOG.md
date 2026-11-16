# @debugkit/dashboard

## 0.9.0

### Minor Changes

- 84f1a9f: Version banner: when the project's ingest or this dashboard is a minor version or more behind the newest SDK its apps send from (or ingest predates version tracking), every page shows a banner naming what's behind and the command that fixes it, `npx debugkit upgrade` (with `--env <name>` when `DEBUG_ENVIRONMENT` is set). Dismissed per browser until the versions change. Settings lists all three versions; a patch behind, or an app on an older SDK, is a note there only. No calls leave your infrastructure.

## 0.8.0

### Minor Changes

- 4ed7eb7: Customer lookup: a Customers page that finds a customer's sessions, newest first, by customer number in any format (0…, 27…, +27…, with spaces or dashes) or by install id, each opening the session timeline. The session page links back to all of that customer's sessions. Stores gain `listUserEvents`. Firestore needs two new events indexes, (user.id, ts desc) and (user.anonymousId, ts desc): rerun the CLI's deploy, or `firebase deploy --only firestore:indexes`. DynamoDB writes each event up to twice more, under `APP#{app}#USEREV#id#{userId}` and `APP#{app}#USEREV#anonymousId#{installId}`, from this version on, so older sessions aren't found there.
- a38844b: Endpoint health: an Endpoints page with one row per API endpoint over a chosen period: calls, failure rate and p50/p95 (from the SDK's request summaries), and the top statuses and backend codes of its stored failures (from the API breadcrumb of each failed call). Endpoints add up per backend service, and sort by most failures, slowest or busiest. Click an endpoint to list its recent failures, each opening the event page. An API call the app cancelled (outcome "aborted") no longer counts as failed. No store or index changes.
- 11be9b3: Errors are labelled at ingest with a category, a likely owner, a user impact and causes (docs/taxonomy.md). The labels are stored with each error event and rolled up as new `category`, `owner` and `impact` dimensions. `/api/summary` adds `issues[].labels` and `breakdowns.category|owner|impact`, and the issue page has `issue.labels`. Issues stored before this release get their labels worked out when read. Also on the issue page: severity now ranks one level higher in critical flows, as it already did in the list, so the two pages agree.
- 81ba91c: Event page: open any recent occurrence of an issue to see its timeline in order up to the failure (API calls with service, status, duration, outcome, backend code and trace id; failures highlighted), the failed request, the device, app and every tag, the stack with the app's own frames first, and the customer and session ids.
- b009f0f: Explanations: every issue gets a plain summary for support (what the user saw in plain words, e.g. "Balances didn't load", where, for how many people, after which action, a sentence per cause, whether it's still happening, who to pass it to) and technical detail for developers (category, owner and impact, evidence, where in the code and what started it, a suggested fix). One template per category, no LLM. They're on the issue page, which can copy them as Markdown for a ticket, in `/api/summary` as `issues[].explanation`, and in the prefilled Linear and GitHub links. `evidenceOf()` in `@debugkit/ingest` exposes the facts behind the labels. For request failures the generic network, auth and server hints are replaced by the explanation; other hints stay under "Also worth checking".
- 9015841: Friendly names for API hosts. In Settings, name a host or host and path prefix ("Balance service") and say who looks after it. Names replace raw hosts in issue titles, failing endpoints, response times and explanations; the owner is used for that host's server errors and the failures the rules can't place.
- ebe215d: Incidents: issues that fail together for the same reason are folded into one problem, keyed by cause, category and OS (e.g. "Requests failed on app resume (iOS)"). Ingest stores each error's incident and rolls up errors per incident, per issue in it, and per user. An incident is a recurring problem across users and days, with its episodes (separate times it happened), users and first and last day. The overview lists active incidents with their issues above the issue table, each issue page names its incident, and `/api/summary` adds `incidents[]` and `issues[].incident`. Counts start from this release.
- 8660214: Overview: badges for each issue's impact, category and owner; a breakdown of errors by impact, owner and category; and filters for each, which `/api/summary` also takes.
- 6775f67: Request and response tabs: when the SDK captured a failed call's request and response (ABA-117, `network.bodies`), the event page's Request panel shows them in tabs of their own: headers, the body pretty-printed when it's JSON, a note when it was cut or binary, and "Copy as cURL" (redacted, as captured). Events without them look as before.
- 95d7bbb: Session timeline: a page per session with its errors, flow events and their breadcrumbs merged in order (each breadcrumb once, each linking to the error it led to), the customer, install, device, app version, the span recorded, and whether it crashed. Reached from an event page's "Whole session". Stores gain `listSessionEvents` (the newest events of a session, oldest first). Firestore needs the new events (sessionId, ts desc) index: rerun the CLI's deploy, or `firebase deploy --only firestore:indexes`. DynamoDB writes each event once more, under `APP#{app}#SESSEV#{sessionId}`, from this version on, so older sessions don't show there.
- 583d67b: Support summary: the event page opens with a plain-language account of the failure (when, who with the customer number masked, the screens they went through, what they tapped, what the backend answered, what they saw and where they went next), a Support / Developer switch, and "Copy for ticket", which copies the summary with the event link and the trace id. What they did next comes from the session's later errors.

## 0.7.0

## 0.6.1

### Patch Changes

- d0109e2: Fixes from the first pilot on a real React Native app.

  - **SDK:** fatal crashes on React Native release builds are saved to storage before React Native closes the app, then sent on the next launch. Give `storage` a synchronous `setItemSync` (MMKV can) for a guaranteed save; with AsyncStorage it's best effort. A batch that was uploading when the app died is kept too. Phone numbers (7+ digits, with `+`, spaces or a prefix) and emails in URL paths are now masked. `SDK_VERSION` reports the real version. A throwing `beforeSend` no longer breaks capture, a partial `deviceInfo` no longer throws at init, and `enabled: false` no longer reads the device.
  - **CLI:** EAS variables are set with `npx eas-cli@latest` when the global `eas` is too old for `env:set`. Endpoints and keys are printed as plain lines, so copying them doesn't pick up box borders. When Hosting can't reach the dashboard function's region, the retry offers us-central1 first. The Google account is kept in the gitignored `dashboard.env`, not `config.json`.
  - **Dashboard:** while Firestore builds or lacks an index, the page says so and how to fix it, instead of showing the raw error.

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
