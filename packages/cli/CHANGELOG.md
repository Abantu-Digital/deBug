# debugkit

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
