---
"@debugkit/dashboard": minor
---

Every failed call's issue page now shows the call up front: what the app sent and what the server answered, side by side, under the headline numbers. It uses the newest occurrence that captured them, preferring one with a response, and links to that occurrence. The status, the backend's code and message, the duration and the trace come first. The response body is shown open, and the headers fold away (secrets redacted on the phone). When there was no answer, it says why (timed out, never left the phone, or couldn't reach the server). When the app didn't capture the bodies, it says how to turn that on (`network.bodies`). Each occurrence's page shows the same panel, now full width above its timeline.
