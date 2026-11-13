---
"@debugkit/sdk": patch
"@debugkit/cli": patch
"@debugkit/dashboard": patch
---

Fixes from the first pilot on a real React Native app.

- **SDK:** fatal crashes on React Native release builds are saved to storage before React Native closes the app, then sent on the next launch. Give `storage` a synchronous `setItemSync` (MMKV can) for a guaranteed save; with AsyncStorage it's best effort. A batch that was uploading when the app died is kept too. Phone numbers (7+ digits, with `+`, spaces or a prefix) and emails in URL paths are now masked. `SDK_VERSION` reports the real version. A throwing `beforeSend` no longer breaks capture, a partial `deviceInfo` no longer throws at init, and `enabled: false` no longer reads the device.
- **CLI:** EAS variables are set with `npx eas-cli@latest` when the global `eas` is too old for `env:set`. Endpoints and keys are printed as plain lines, so copying them doesn't pick up box borders. When Hosting can't reach the dashboard function's region, the retry offers us-central1 first. The Google account is kept in the gitignored `dashboard.env`, not `config.json`.
- **Dashboard:** while Firestore builds or lacks an index, the page says so and how to fix it, instead of showing the raw error.
