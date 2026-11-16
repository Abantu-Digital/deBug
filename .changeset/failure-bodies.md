---
"@debugkit/schema": minor
"@debugkit/sdk": minor
"@debugkit/ingest": minor
---

The full request and response of a failed call. With `network.bodies: { onFailure: true }` (on by default with `initReactNative`), a failed call's error carries its method, URL with query string, headers and body, and the response's status, headers and body. Secrets are redacted on the device first: auth and cookie headers and any header named for a token, key or secret; password, PIN, one-time-code, card, token and API-key fields at any depth; JWTs and Luhn-valid card numbers anywhere. Each body is cut at 16 KB, binary bodies are recorded by size and type, and ingest cuts oversized bodies rather than reject the event. Uploads are now also limited by size, so queued failures with bodies never exceed ingest's 512 KB limit.
