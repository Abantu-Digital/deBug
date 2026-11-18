---
"@debugkit/schema": patch
"@debugkit/sdk": patch
"@debugkit/dashboard": patch
---

The dashboard can work out where an error comes from: journey › screen › last action › failing call or code › source.

- **Backend errors:** the source is the trace id the backend already sends. That's a response header (`traceparent`, `x-cloud-trace-context`, `x-amzn-trace-id`, `x-request-id` and similar), else a `traceId` or error `code` in the JSON body. When there's none, it gives the host, call and UTC time to search the logs by.
- **Taps** are named by their label or testID.
- **Frames still in the built bundle** are reported as "not source-mapped" rather than shown as a file.
- **A hop it can't fill** says why and how to find it another way, and never asks for a backend change.

Not on any page yet: the ranked list and the case file will show it. `@debugkit/schema` now exports `hostOf`, `RN_BUNDLE` and `REDACTED`, and the SDK takes its redaction marker from there.
