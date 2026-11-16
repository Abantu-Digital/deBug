---
"@debugkit/ingest": patch
"@debugkit/dashboard": minor
---

The issue page has a new "What the trail shows" section: rule-based advice from patterns in what customers did before the error (a call sent twice, a repeat that failed, calls before login, a 401 after a long time in the background, a request that hung in the background, a 4xx an endpoint always gives), each with the evidence it read. Advice says what the app should change, or where to search the backend's logs; never what the backend should change. The template advice is now "General advice".
