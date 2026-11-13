# debugkit

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
