---
"@debugkit/dashboard": patch
---

The dashboard is fast to move around. Reads from Firestore or DynamoDB are kept for 30 seconds, and the same read asked for twice at once is made once. A read up to 10 minutes old is shown at once while a fresh one loads in the background. Anything the dashboard changes (an issue's status, settings, the team) clears them. Team and sign-in reads are never kept. The server starts reading the home page as soon as the store is opened, and a page loaded in the last 30 seconds opens without asking the server again. On preview data, Health went from 8 s to under 0.1 s, and Endpoints and a service page from 4–5 s to under 0.1 s.
