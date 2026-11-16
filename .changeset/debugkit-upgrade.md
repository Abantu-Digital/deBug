---
"@debugkit/cli": patch
---

`npx debugkit upgrade`: one command to bring a project's deBug to the CLI's version after updating `@debugkit/sdk`. It redeploys ingest in the same place with the same URL, keys, retention and admin token, adds the Firestore indexes the new version needs, redeploys the hosted dashboard if there is one, and ends with the dashboard link and one line per version skipped. `--dry-run` shows the plan only; it stops when something deployed is newer than the CLI. Ingest and the hosted dashboard now install exactly the CLI's version (not a caret range), and `init` and `deploy-dashboard` save the deployed versions in `.debugkit/config.json` (older Firebase setups are read from `.debugkit/firebase`).
