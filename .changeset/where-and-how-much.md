---
"@debugkit/schema": minor
"@debugkit/sdk": minor
"@debugkit/adapters": minor
"@debugkit/ingest": minor
"@debugkit/dashboard": minor
---

Where it fails, and how much it matters.

- **Steps that fail:** the failure rate per `track(flow, step)` step, for example "auth.login · submit_otp fails 62%".
- **Response times:**
  - The SDK times every request and sends one `metric` event per endpoint about once a minute: count, failures, and a 13-bucket histogram.
  - The dashboard shows p50/p95 and the error rate for the busiest endpoints.
  - If an older ingest rejects metric events, the SDK stops sending them and keeps everything else.
- **Network and country:**
  - Errors are broken down by network type, and by country.
  - Country comes from the device's timezone, then its locale. IP addresses are never used.
  - The summary calls out when most errors happen on cellular.
- **Slack alerts:**
  - Ingest posts to a Slack incoming webhook when an issue first appears or regresses: at most once an hour per issue, optionally only for critical flows.
  - Set it up on the Settings page, which includes a "Send a test alert" button. The webhook is stored in your database and shown masked.
  - Only `hooks.slack.com` URLs are accepted.
- **Critical flows:** flows marked critical in Settings rank their issues one severity level higher.
- **Adapters:** `upsertIssues` returns which issues were created or regressed. Settings gain `criticalFlows` and `alerts`.
