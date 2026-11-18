---
"@debugkit/dashboard": minor
---

Every failed call's issue page now shows the call up front: what the app sent and what the server answered, side by side, under the headline numbers. It uses the newest occurrence in the period (one that captured them, when the newest didn't) and links to it. When that call got no answer, as in an outage, the last time the server did answer is shown below it. Each failing endpoint on a service page also shows what the server answered last. The status, the backend's code and message, the duration and the trace come first. The response body is shown open, and the headers fold away (secrets redacted on the phone). When there was no answer, it says why (timed out, never left the phone, or couldn't reach the server). When the app didn't capture them, it says so (apps built with the SDK's `network.bodies` capture them). Each occurrence's page shows the same panel, now full width above its timeline.
