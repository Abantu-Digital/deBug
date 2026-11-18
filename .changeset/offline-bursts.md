---
"@debugkit/schema": minor
"@debugkit/sdk": minor
"@debugkit/ingest": minor
"@debugkit/dashboard": minor
---

A phone going offline is one problem now, not an issue per endpoint it couldn't reach. Every request that never left the phone (no status, faster than 100 ms, not a timeout) goes to one "Phone offline" issue, ranked Low, labelled `network.offline` with no owner. It stays out of endpoint failures, owners, flows, incidents, alerts and the active issue count. The overview shows a Connectivity line ("phones went offline 3 times on 3 phones, 18 calls never left the phone"), and the issue page lists each burst per phone with the calls that never left it. The SDK's request timings leave such calls out, so endpoint failure rates no longer count them. Errors already stored, and request timings already sent, aren't corrected: only new data is.
