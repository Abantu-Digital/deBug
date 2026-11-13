---
"@debugkit/sdk": minor
"@debugkit/cli": minor
---

Turn deBug on or off per build, and set it up per environment.

- **SDK:** `init({ enabled: false })` (and `initExpo`, `initReactNative`, `initNode`) leaves deBug inert. Nothing is patched or sent, and every call quietly does nothing. `track()` still runs and returns or throws as usual. `deBug.enabled` reports which way it went.
- **CLI:**
  - `npx debugkit init --env <name>` sets up one environment. Each gets its own provider, project, endpoint, key and dashboard login. Other commands take `--env` too.
  - For Expo apps with EAS, it can write the endpoint, key and environment name into that EAS environment with `eas env:set`. With `--env` it never writes `.env`.
  - The generated `debug.ts` turns itself off when a build has no endpoint. With environments, it's also off in development builds (`!__DEV__ && !!endpoint`).
  - Before deploying to a Firebase project, the CLI lists exactly what it will add and asks first.
