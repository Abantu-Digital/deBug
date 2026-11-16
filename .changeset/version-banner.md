---
"@debugkit/dashboard": minor
---

Version banner: when the project's ingest or this dashboard is a minor version or more behind the newest SDK its apps send from (or ingest predates version tracking), every page shows a banner naming what's behind and the command that fixes it, `npx debugkit upgrade` (with `--env <name>` when `DEBUG_ENVIRONMENT` is set). Dismissed per browser until the versions change. Settings lists all three versions; a patch behind, or an app on an older SDK, is a note there only. No calls leave your infrastructure.
