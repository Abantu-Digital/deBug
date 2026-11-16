---
"@debugkit/dashboard": minor
---

Request and response tabs: when the SDK captured a failed call's request and response (ABA-117, `network.bodies`), the event page's Request panel shows them in tabs of their own: headers, the body pretty-printed when it's JSON, a note when it was cut or binary, and "Copy as cURL" (redacted, as captured). Events without them look as before.
