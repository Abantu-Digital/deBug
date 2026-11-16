---
"@debugkit/schema": patch
"@debugkit/dashboard": patch
---

The dashboard can work out where an error comes from: journey › screen › last action › failing call or code › source. For a backend error, the source is the trace id the backend already sends (`traceparent`, `x-cloud-trace-context`, `x-request-id` and similar). When there isn't one, it gives the time and endpoint to search the logs by. A hop it can't fill says why and how to find it another way, and never asks for a backend change. Frames still in the built bundle are reported as "not source-mapped" rather than shown as a file. Not on any page yet: the ranked list and the case file will show it. `@debugkit/schema` now exports `RN_BUNDLE`.
