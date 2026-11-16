# @debugkit/sdk

## 0.8.0

### Minor Changes

- 15ffb48: The full request and response of a failed call. With `network.bodies: { onFailure: true }` (on by default with `initReactNative`), a failed call's error carries its method, URL with query string, headers and body, and the response's status, headers and body. Secrets are redacted on the device first: auth and cookie headers and any header named for a token, key or secret; password, PIN, one-time-code, card, token and API-key fields at any depth (including JSON cut short, JSON or forms inside a string, `user[password]` form keys and plain text); JWTs and Luhn-valid card numbers anywhere, also as JSON numbers. Each body is cut at 16 KB, binary bodies are recorded by size and type, and ingest cuts oversized bodies rather than reject the event. Uploads are now also limited by size, so queued failures with bodies never exceed ingest's 512 KB limit.
- 8efbb16: React Native and Expo defaults: `initReactNative` now counts a 4xx response as a failure (`network.isFailure`: 400 and above) and keeps 50 breadcrumbs instead of 30. Pass `network.isFailure` or `maxBreadcrumbs` to keep the old behaviour.
- b052b63: Named API calls and backend error details. Set `network.baseUrls` and each request's breadcrumb is named by service (the first path segment after the base, so services behind one gateway each get a name) with its path, method, status, duration and outcome. When a call fails, what the backend said in its problem-details body (`title`, `code`, `traceId`, `errors`) is added to the breadcrumb, with phone numbers and emails masked, for fetch and XHR (axios on React Native, including `arraybuffer` responses). A fetch failure is reported once its body is read, at most 3 seconds later. Error messages, and so issue grouping, are unchanged. An `isFailure` that throws now counts the call as not failed, instead of throwing inside the request's listener.
- f1bf94b: Taps on React Native and Expo. Wrap the app's root in `<DebugTouchBoundary>` and each short tap becomes a `ui` breadcrumb, `Tapped "Buy now"`, named by the nearest `accessibilityLabel` or `testID`, with the screen it was on (`deBug.screen`). It never takes the touch responder, ignores scrolls, drags and long presses, and never reads text input values.

### Patch Changes

- 465fb44: React Native: the culprit is now the app's own code, not a library's. Hermes keeps function names, so known axios, React, React Native runtime and TanStack Query functions are marked as not in-app (`markLibraryFrames`, applied by `parseStack` and again at ingest for older SDKs). Hermes async names like `?anon_0_attemptApiRequest` show as `attemptApiRequest`.

  Names that could just as well be an app's own (`request`, `fetchQuery`, `settle`, TanStack's `run` and `fetch`) count as library code only directly under a known library frame at the top of the stack; lower down they're left as app code.

  Errors that aren't failed requests are grouped by their top in-app frame, and Hermes names are now cleaned in the grouping key too, so some of them start a new issue once after upgrading ingest. Failed requests still group by endpoint and aren't affected; their culprit updates on the next occurrence.

- 62bf2f4: React Native and Expo: errors and events carry a `device.details` tag, `full` when react-native-device-info is linked and `limited` when it isn't (Expo Go, or an app not rebuilt), so a release build missing it shows on the dashboard instead of failing silently. Leave it out with `collect: { details: false }`; `deviceInfo: null` (bare React Native) sends no tag either.
- 4aacee5: `close()` now really stops the client: after sending what is queued, errors, events, sessions and breadcrumbs are ignored until the next `init()`, so a remote kill switch that calls `close()` needs no guard of its own. `breadcrumb()`, `navigated()` and the router hooks (`useDebugExpoRouter`, `useDebugNavigation`) never throw into the app.
- Updated dependencies [465fb44]
- Updated dependencies [11be9b3]
- Updated dependencies [9e9ee72]
- Updated dependencies [15ffb48]
- Updated dependencies [9015841]
- Updated dependencies [ebe215d]
  - @debugkit/schema@0.8.0

## 0.7.0

### Minor Changes

- ac64d76: The SDK reads device details itself on React Native and Expo. Nothing to pass.

  - `react-native-device-info` is a peer dependency, and `npx debugkit init` installs it into the app (React Native only links native modules the app lists). The SDK loads it itself. Without its native half (Expo Go, or not rebuilt yet), it keeps working with what React Native exposes and never crashes the app.
  - Collected automatically: screen size and pixel ratio (device context); `device.fontScale`, `device.mobileServices` (gms, hms or none), `device.lowRam`, `android.apiLevel`, `device.freeDisk` (as a band), `network.carrier`, `app.installer`; and `network.airplaneMode` per event. No identifiers.
  - New: `tags` and `enrich` init options, `deBug.setTags()`, `deBug.addTagSource()`, and `collect` to leave facts out.
  - New: `mmkvStorage(instance)`, which saves crashes synchronously before the app closes.
  - `deviceInfo` is now optional (an override for tests, or `null` to read nothing).

### Patch Changes

- @debugkit/schema@0.7.0

## 0.6.1

### Patch Changes

- d0109e2: Fixes from the first pilot on a real React Native app.

  - **SDK:** fatal crashes on React Native release builds are saved to storage before React Native closes the app, then sent on the next launch. Give `storage` a synchronous `setItemSync` (MMKV can) for a guaranteed save; with AsyncStorage it's best effort. A batch that was uploading when the app died is kept too. Phone numbers (7+ digits, with `+`, spaces or a prefix) and emails in URL paths are now masked. `SDK_VERSION` reports the real version. A throwing `beforeSend` no longer breaks capture, a partial `deviceInfo` no longer throws at init, and `enabled: false` no longer reads the device.
  - **CLI:** EAS variables are set with `npx eas-cli@latest` when the global `eas` is too old for `env:set`. Endpoints and keys are printed as plain lines, so copying them doesn't pick up box borders. When Hosting can't reach the dashboard function's region, the retry offers us-central1 first. The Google account is kept in the gitignored `dashboard.env`, not `config.json`.
  - **Dashboard:** while Firestore builds or lacks an index, the page says so and how to fix it, instead of showing the raw error.
  - @debugkit/schema@0.6.1

## 0.6.0

### Patch Changes

- @debugkit/schema@0.6.0

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

### Patch Changes

- Updated dependencies [b4453dd]
- Updated dependencies [9c7cc90]
  - @debugkit/schema@0.5.0

## 0.4.0

### Minor Changes

- e4d3263: Turn deBug on or off per build, and set it up per environment.

  - **SDK:** `init({ enabled: false })` (and `initExpo`, `initReactNative`, `initNode`) leaves deBug inert. Nothing is patched or sent, and every call quietly does nothing. `track()` still runs and returns or throws as usual. `deBug.enabled` reports which way it went.
  - **CLI:**
    - `npx debugkit init --env <name>` sets up one environment. Each gets its own provider, project, endpoint, key and dashboard login. Other commands take `--env` too.
    - For Expo apps with EAS, it can write the endpoint, key and environment name into that EAS environment with `eas env:set`. With `--env` it never writes `.env`.
    - The generated `debug.ts` turns itself off when a build has no endpoint. With environments, it's also off in development builds (`!__DEV__ && !!endpoint`).
    - Before deploying to a Firebase project, the CLI lists exactly what it will add and asks first.

### Patch Changes

- @debugkit/schema@0.4.0

## 0.3.1

### Patch Changes

- 3a31593: The setup CLI is published as `@debugkit/cli`. npm won't take the name `debugkit` because it's too close to an existing package. Run `npx @debugkit/cli init` anywhere.

  `@debugkit/sdk` now includes a `debugkit` command. In an app with the SDK installed, `npx debugkit init` (and `dashboard`, `test`, `guide`, `password`) runs `@debugkit/cli` at the same version. The command never ends up in the app's bundle.

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
