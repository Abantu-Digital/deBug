---
"@debugkit/dashboard": minor
---

An issue's explanation leads with what the backend said, when it said anything of its own: "The balance service answered 404 "Balance lookup unsuccessful" (code 30007)". It no longer guesses "the server refused what the app sent as invalid". The code, message and trace come from the app's breadcrumb for the call, or else the JSON response body (`code`, `title` or `message`, `traceId`, as in Problem Details). The developer evidence lists the backend's codes across recent occurrences ("30007 × 14"). The advice becomes "Search the balance logs for code 30007 or trace …". Without a backend reason, the wording is as before.
