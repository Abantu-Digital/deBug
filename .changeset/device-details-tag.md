---
"@debugkit/sdk": patch
---

React Native and Expo: errors and events carry a `device.details` tag, `full` when react-native-device-info is linked and `limited` when it isn't (Expo Go, or an app not rebuilt), so a release build missing it shows on the dashboard instead of failing silently. Leave it out with `collect: { details: false }`; `deviceInfo: null` (bare React Native) sends no tag either.
