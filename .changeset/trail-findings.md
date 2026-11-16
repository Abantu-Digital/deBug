---
"@debugkit/dashboard": minor
---

The issue page has a new "What the trail shows" section. It gives specific advice from patterns deBug finds in what customers did before the error, with the evidence it read and how many recent occurrences show it. Rule-based, with no AI.

The patterns it finds:
- the same call sent twice within seconds;
- the first call works and the repeat fails;
- a call made before login, answered 401, and made again after login;
- a 401 after a long time in the background with no token refresh;
- a request still running when the app went to the background;
- a 4xx an endpoint gives every time (suggest marking it as expected).

Advice says what the app should change, or where to search the backend's logs (time, call, or the trace id it already sent). It never suggests changing the backend. The template's advice is now labelled "General advice". "Copy for a ticket" and the tracker links include the findings.
