---
"@debugkit/adapters": minor
"@debugkit/dashboard": minor
"@debugkit/cli": patch
---

Session timeline: a page per session with its errors, flow events and their breadcrumbs merged in order (each breadcrumb once), the customer, device, app version, start and end, and whether it crashed. Reached from an event page's "Whole session". Stores gain `listSessionEvents`. Firestore needs the new events (sessionId, ts) index: rerun the CLI's deploy, or `firebase deploy --only firestore:indexes`. DynamoDB keeps events by session from this version on, so older sessions don't show.
