---
"@debugkit/dashboard": minor
---

Endpoint health: an Endpoints page with one row per API endpoint over a chosen period: calls, failure rate and p50/p95 (from the SDK's request summaries), and the top statuses and backend codes of its stored failures (from the API breadcrumb of each failed call). Endpoints add up per backend service, and sort by most failures, slowest or busiest. Click an endpoint to list its recent failures, each opening the event page. An API call the app cancelled (outcome "aborted") no longer counts as failed. No store or index changes.
