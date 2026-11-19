# debugkit

## 0.10.0

### Patch Changes

- 474e2a0: Test errors: mark errors you make on purpose with `deBug.error(err, { test: true })`, or throw or reject with `deBug.testError("…")` so a test crash or unhandled rejection is caught as a test by any handler. They get their own issues, never count toward totals, flows, endpoints, labels, customers or crash-free rates, never alert, and the dashboard keeps them off every box: Health's "Folded away" line links to them, listed apart on the App code page (`/app-code?tests=1`, or `?tests=1` on `/api/summary`). Ingest also ignores a session crash marker that only test errors caused. `npx debugkit test` sends test events, so its guide now asks for them. Errors already stored aren't relabelled.

## 0.9.0

### Patch Changes

- 35fd8c7: `npx debugkit upgrade`: one command to bring a project's deBug to the CLI's version after updating `@debugkit/sdk`. It redeploys ingest in the same place with the same URL, keys, retention and admin token, adds the Firestore indexes the new version needs, redeploys the hosted dashboard if there is one, and ends with the dashboard link and one line per version skipped. `--dry-run` shows the plan only; it stops when something deployed is newer than the CLI. Ingest and the hosted dashboard now install exactly the CLI's version (not a caret range), and `init` and `deploy-dashboard` save the deployed versions in `.debugkit/config.json` (older Firebase setups are read from `.debugkit/firebase`).

## 0.8.0

### Patch Changes

- 4ed7eb7: Customer lookup: a Customers page that finds a customer's sessions, newest first, by customer number in any format (0…, 27…, +27…, with spaces or dashes) or by install id, each opening the session timeline. The session page links back to all of that customer's sessions. Stores gain `listUserEvents`. Firestore needs two new events indexes, (user.id, ts desc) and (user.anonymousId, ts desc): rerun the CLI's deploy, or `firebase deploy --only firestore:indexes`. DynamoDB writes each event up to twice more, under `APP#{app}#USEREV#id#{userId}` and `APP#{app}#USEREV#anonymousId#{installId}`, from this version on, so older sessions aren't found there.
- 95d7bbb: Session timeline: a page per session with its errors, flow events and their breadcrumbs merged in order (each breadcrumb once, each linking to the error it led to), the customer, install, device, app version, the span recorded, and whether it crashed. Reached from an event page's "Whole session". Stores gain `listSessionEvents` (the newest events of a session, oldest first). Firestore needs the new events (sessionId, ts desc) index: rerun the CLI's deploy, or `firebase deploy --only firestore:indexes`. DynamoDB writes each event once more, under `APP#{app}#SESSEV#{sessionId}`, from this version on, so older sessions don't show there.

## 0.7.0

### Minor Changes

- c823532: `npx debugkit init` runs start to finish. Hosting the dashboard is offered straight after ingest is set up, in the same cloud, after the login is chosen. You can skip it, but there's no "Stop here", and a failed hosting deploy offers retry or skip, never an end to setup. Then the app is wired, and the walkthrough runs on the hosted dashboard when it's up (otherwise locally). The walkthrough's steps have one way forward.

  `init --env <name>` refuses a Firebase project, or a DynamoDB table in the same account and region, that another environment of the app already uses, and asks again. Every command hint the CLI prints now carries `--env`.

- ac64d76: The SDK reads device details itself on React Native and Expo. Nothing to pass.

  - `react-native-device-info` is a peer dependency, and `npx debugkit init` installs it into the app (React Native only links native modules the app lists). The SDK loads it itself. Without its native half (Expo Go, or not rebuilt yet), it keeps working with what React Native exposes and never crashes the app.
  - Collected automatically: screen size and pixel ratio (device context); `device.fontScale`, `device.mobileServices` (gms, hms or none), `device.lowRam`, `android.apiLevel`, `device.freeDisk` (as a band), `network.carrier`, `app.installer`; and `network.airplaneMode` per event. No identifiers.
  - New: `tags` and `enrich` init options, `deBug.setTags()`, `deBug.addTagSource()`, and `collect` to leave facts out.
  - New: `mmkvStorage(instance)`, which saves crashes synchronously before the app closes.
  - `deviceInfo` is now optional (an override for tests, or `null` to read nothing).

## 0.6.1

### Patch Changes

- d0109e2: Fixes from the first pilot on a real React Native app.

  - **SDK:** fatal crashes on React Native release builds are saved to storage before React Native closes the app, then sent on the next launch. Give `storage` a synchronous `setItemSync` (MMKV can) for a guaranteed save; with AsyncStorage it's best effort. A batch that was uploading when the app died is kept too. Phone numbers (7+ digits, with `+`, spaces or a prefix) and emails in URL paths are now masked. `SDK_VERSION` reports the real version. A throwing `beforeSend` no longer breaks capture, a partial `deviceInfo` no longer throws at init, and `enabled: false` no longer reads the device.
  - **CLI:** EAS variables are set with `npx eas-cli@latest` when the global `eas` is too old for `env:set`. Endpoints and keys are printed as plain lines, so copying them doesn't pick up box borders. When Hosting can't reach the dashboard function's region, the retry offers us-central1 first. The Google account is kept in the gitignored `dashboard.env`, not `config.json`.
  - **Dashboard:** while Firestore builds or lacks an index, the page says so and how to fix it, instead of showing the raw error.

## 0.6.0

### Minor Changes

- aa30345: Host the dashboard for your team. `npx debugkit init` now offers to put the dashboard online in the same Firebase project (its own Hosting site, a read-only service account) or AWS account (a Lambda with a Function URL and a read-only role), and `npx debugkit deploy-dashboard` does it any time. The dashboard exports `@debugkit/dashboard/handler` and `@debugkit/dashboard/lambda` for other hosts, and the cookie name is configurable (`DEBUG_COOKIE_NAME`). firebase-admin and the AWS SDK are now optional dependencies of the dashboard.

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

## 0.4.0

### Minor Changes

- e4d3263: Turn deBug on or off per build, and set it up per environment.

  - **SDK:** `init({ enabled: false })` (and `initExpo`, `initReactNative`, `initNode`) leaves deBug inert. Nothing is patched or sent, and every call quietly does nothing. `track()` still runs and returns or throws as usual. `deBug.enabled` reports which way it went.
  - **CLI:**
    - `npx debugkit init --env <name>` sets up one environment. Each gets its own provider, project, endpoint, key and dashboard login. Other commands take `--env` too.
    - For Expo apps with EAS, it can write the endpoint, key and environment name into that EAS environment with `eas env:set`. With `--env` it never writes `.env`.
    - The generated `debug.ts` turns itself off when a build has no endpoint. With environments, it's also off in development builds (`!__DEV__ && !!endpoint`).
    - Before deploying to a Firebase project, the CLI lists exactly what it will add and asks first.

## 0.3.1

### Patch Changes

- 3a31593: The setup CLI is published as `@debugkit/cli`. npm won't take the name `debugkit` because it's too close to an existing package. Run `npx @debugkit/cli init` anywhere.

  `@debugkit/sdk` now includes a `debugkit` command. In an app with the SDK installed, `npx debugkit init` (and `dashboard`, `test`, `guide`, `password`) runs `@debugkit/cli` at the same version. The command never ends up in the app's bundle.

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
