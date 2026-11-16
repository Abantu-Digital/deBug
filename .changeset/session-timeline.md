---
"@debugkit/adapters": minor
"@debugkit/dashboard": minor
"@debugkit/cli": patch
---

Session timeline: a page per session with its errors, flow events and their breadcrumbs merged in order (each breadcrumb once, each linking to the error it led to), the customer, install, device, app version, the span recorded, and whether it crashed. Reached from an event page's "Whole session". Stores gain `listSessionEvents` (the newest events of a session, oldest first). Firestore needs the new events (sessionId, ts desc) index: rerun the CLI's deploy, or `firebase deploy --only firestore:indexes`. DynamoDB writes each event once more, under `APP#{app}#SESSEV#{sessionId}`, from this version on, so older sessions don't show there.
