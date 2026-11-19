---
"@debugkit/dashboard": minor
"@debugkit/schema": minor
"@debugkit/adapters": minor
"@debugkit/ingest": minor
---

Apps can have a display name. Settings → App name sets what people see the app as ("Megatron Native" for `megatron-native`): in Health's heading, on Settings, on Find a customer, in every app picker and in Slack alerts. The app id doesn't change: the SDK, links and ingest keys keep using it. Leave the name empty to show the id. On cloud setups the ingest function saves it, so upgrade it too (`npx debugkit upgrade`).
