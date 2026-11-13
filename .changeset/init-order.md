---
"@debugkit/cli": minor
---

`npx debugkit init` runs start to finish. Hosting the dashboard is offered straight after ingest is set up, in the same cloud, after the login is chosen. You can skip it, but there's no "Stop here", and a failed hosting deploy offers retry or skip, never an end to setup. Then the app is wired, and the walkthrough runs on the hosted dashboard when it's up (otherwise locally). The walkthrough's steps have one way forward.

`init --env <name>` refuses a Firebase project, or a DynamoDB table in the same account and region, that another environment of the app already uses, and asks again. Every command hint the CLI prints now carries `--env`.
