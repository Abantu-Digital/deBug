---
"@debugkit/dashboard": patch
---

The dashboard is fast to move around. Each server instance keeps what it reads from Firestore or DynamoDB for 30 seconds. The same read asked for twice at once is made once. A read up to 2 minutes old is shown at once while a fresh one loads in the background. A change made from the dashboard (an issue's status, settings) clears what that instance kept, and a new **Refresh** button in the top bar does the same on demand. Team and sign-in reads are never kept. The server starts reading the home page when the store is first opened (the login page or the first signed-in page). A page loaded in the last 30 seconds opens without asking the server again, and a bar along the top shows a page is loading. On preview data, Health went from 8 s to under 0.1 s once warm, and Endpoints and a service page from 4–5 s to under 0.1 s. With several instances, another one can show data up to 2 minutes old after a change.
