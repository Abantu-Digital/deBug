---
"@debugkit/schema": minor
"@debugkit/sdk": minor
"@debugkit/ingest": minor
"@debugkit/dashboard": minor
---

A phone going offline is one problem now, not an issue per endpoint it couldn't reach. Requests that never left the phone, several at once, right after reopening, or with airplane mode on, go to one "Phone offline" issue. It's labelled `network.offline` with no owner, and stays out of endpoint failures, owners, incidents, alerts and the active issue count. The overview shows them on a Connectivity line ("phones went offline 3 times on 2 phones"), and the issue page lists each burst with the calls that never left the phone. The SDK's request timings count such calls as `unsent`, not as requests or failures, so endpoint failure rates leave them out. Data already stored isn't moved.
