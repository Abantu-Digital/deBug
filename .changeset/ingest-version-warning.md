---
"@debugkit/sdk": minor
---

In debug mode, the SDK warns once per launch when the ingest it sends to is a minor or more behind it, naming both versions and `npx debugkit upgrade`. It reads the ingest's `x-debugkit-version` response header and says nothing when there is none. (ABA-127)
