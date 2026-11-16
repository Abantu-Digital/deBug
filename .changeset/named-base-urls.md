---
"@debugkit/sdk": minor
---

`network.baseUrls` takes named bases: `{ url, name }`. Every call under a named base is that service ("Balances · POST /cellc/getBalances"), in the trail, on the issue and on Endpoints. This replaces the first path segment, which on one-backend-per-host APIs was just the endpoint again. Plain URL strings work as before, and the two kinds mix in one list. (ABA-131)
