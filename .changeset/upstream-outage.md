---
"@debugkit/dashboard": minor
"@debugkit/schema": minor
---

Health says when an upstream service is down, apart from our own backend and the app. In Settings → Host names, each host (or a path on your own gateway, such as `/ppd/api/balance`) can be marked "Our backend" or "Upstream", with the upstream's name ("Cell C"). Unset, it follows the owner: a third party is upstream, the backend team or infrastructure is ours. Service boxes and service pages show the kind ("Cell C service", "Our backend"). When calls to a service got no answer or a 5xx for 3 or more people in the last 15 minutes, and at least 5% of today's calls to it failed (request summaries are kept per day, UTC; without them the people alone decide), its box turns critical, goes first and says so: "Cell C Balance is down: no answer or a 5xx for 7 people in the last 15 min". The client answer leads with it and says whose service it is ("It's Cell C's service, not our backend or the app."). On cloud setups, upgrade the ingest function too (`npx debugkit upgrade`): an older one drops the new fields when Settings are saved. The demo data has a Cell C balance outage that stays live while the dashboard runs.
