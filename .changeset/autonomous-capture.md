---
"@debugkit/schema": minor
"@debugkit/sdk": minor
"@debugkit/ingest": minor
"@debugkit/adapters": minor
---

Automatic capture: `init()` now records much more without any extra code.

- **Network:** every fetch and XMLHttpRequest becomes a breadcrumb. Requests that fail, time out or return 5xx are reported as errors with the endpoint, status, duration and the code that made the call. On Node, `node:http` requests and the 5xx responses your server sends are covered too. Query strings never leave the device, and ids in paths become `:id`.
- **Sessions and release health:** each session sends a "started" marker, then "errored" and "crashed" at most once each. The dashboard shows crash-free and error-free rates per app version.
- **More breadcrumbs:** console warnings and errors, page navigation through the History API, clicks by their label, foreground and background, and online and offline.
- **Noise control:** per-minute rate limits (`maxErrorsPerMinute`), `sampleRate`, and repeated breadcrumbs collapse into one.
- **Configuration:** use `autoCapture` to switch any part off, and `network.flows` to tag requests with a flow by URL. `captureGlobalErrors` is deprecated in favour of `autoCapture: { errors: false }`.

**Upgrading:** deploy the new `@debugkit/ingest` along with the new SDK to get sessions and endpoint details. If the app ships first, the SDK detects the older ingest (it rejects the new fields with a 400), falls back to sending what that ingest understands, and errors and events keep arriving.
