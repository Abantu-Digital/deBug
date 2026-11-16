---
"@debugkit/sdk": minor
---

React Native and Expo defaults: `initReactNative` now counts a 4xx response as a failure (`network.isFailure`: 400 and above) and keeps 50 breadcrumbs instead of 30. Pass `network.isFailure` or `maxBreadcrumbs` to keep the old behaviour.
