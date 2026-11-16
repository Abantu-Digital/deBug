---
"@debugkit/adapters": minor
"@debugkit/dashboard": minor
"@debugkit/cli": patch
---

Customer lookup: a Customers page that finds a customer's sessions, newest first, by customer number in any format (0…, 27…, +27…, with spaces or dashes) or by install id, each opening the session timeline. The session page links back to all of that customer's sessions. Stores gain `listUserEvents`. Firestore needs two new events indexes, (user.id, ts desc) and (user.anonymousId, ts desc): rerun the CLI's deploy, or `firebase deploy --only firestore:indexes`. DynamoDB writes each event up to twice more, under `APP#{app}#USEREV#id#{userId}` and `APP#{app}#USEREV#anonymousId#{installId}`, from this version on, so older sessions aren't found there.
