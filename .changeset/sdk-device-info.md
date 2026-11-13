---
"@debugkit/sdk": minor
"@debugkit/cli": minor
---

The SDK reads device details itself on React Native and Expo. Nothing to pass.

- `react-native-device-info` is a peer dependency, and `npx debugkit init` installs it into the app (React Native only links native modules the app lists). The SDK loads it itself. Without its native half (Expo Go, or not rebuilt yet), it keeps working with what React Native exposes and never crashes the app.
- Collected automatically: screen size and pixel ratio (device context); `device.fontScale`, `device.mobileServices` (gms, hms or none), `device.lowRam`, `android.apiLevel`, `device.freeDisk` (as a band), `network.carrier`, `app.installer`; and `network.airplaneMode` per event. No identifiers.
- New: `tags` and `enrich` init options, `deBug.setTags()`, `deBug.addTagSource()`, and `collect` to leave facts out.
- New: `mmkvStorage(instance)`, which saves crashes synchronously before the app closes.
- `deviceInfo` is now optional (an override for tests, or `null` to read nothing).
