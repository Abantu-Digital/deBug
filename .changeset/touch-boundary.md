---
"@debugkit/sdk": minor
---

Taps on React Native and Expo. Wrap the app's root in `<DebugTouchBoundary>` and each short tap becomes a `ui` breadcrumb, `Tapped "Buy now"`, named by the nearest `accessibilityLabel` or `testID`, with the screen it was on (`deBug.screen`). It never takes the touch responder, ignores scrolls, drags and long presses, and never reads text input values.
