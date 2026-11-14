# How deBug labels errors

Every error gets four labels:

- a **category**: what kind of problem it is;
- a likely **owner**: who should fix it;
- an **impact**: how badly it hurts users;
- zero or more **cause patterns**: why it happened.

The ingest classifier sets them from data the SDK already sends. The dashboard, the issue
explanations and, later, automatic ticket rules all read them.

The types and the plain-language text are in [`packages/schema/src/taxonomy.ts`](../packages/schema/src/taxonomy.ts).
Ids are stable, because saved filters and ticket rules depend on them: add new ids, but never
rename one.

**Signals today vs later.** Some rules need data the SDK doesn't send yet:

- whether the phone was online;
- time since the app came to the foreground;
- the HTTP client's error code.

Until that data arrives, those rules use the closest signal the SDK has today, and the table
says which. "Phase B" is the later phase that adds the missing data.

## Category

The classifier checks the rules in this order and takes the first match.

| Id | Plain label | Rule |
|---|---|---|
| `network.offline` | Phone offline | `request` with no `status`, and the phone was offline. **Phase B**: needs the network state. Until then this falls through to the next two rules. |
| `network.never_sent` | Request never sent | `request` with no `status`, and `durationMs` < 100 ms: too fast to have reached a server. |
| `network.timeout` | Request timed out | `request` with no `status`, and `durationMs` ≥ 100 ms; or the error name is `TimeoutError` or `AbortError`. |
| `auth` | Sign-in problem | `request.status` is 401 or 403. |
| `server` | Server error | `request.status` is 500–599. |
| `client_request` | Request rejected | any other `request.status` from 400–499. |
| `crash` | App crash | `handled: false`, and the error was fatal (severity `critical`, set by the SDK) from the global handler (`source: global-handler`, `uncaughtException`). |
| `screen_crash` | Screen crash | `tags.source` is `error-boundary`. |
| `unhandled_rejection` | Unhandled background error | `tags.source` is any of `unhandled-rejection` (React Native), `unhandledrejection` (web) or `unhandledRejection` (Node). |
| `handled` | Reported by the app | `handled: true` and no `request`. |
| `other` | Other | Nothing above matched, e.g. a non-fatal error from the global handler. |

## Owner

| Id | Rule |
|---|---|
| `app` | The categories `network.never_sent`, `crash`, `screen_crash`, `unhandled_rejection` and `handled`. Also `client_request`, since the app sent a request the server refused. |
| `backend` | `server`. With friendly host names (ABA-109), the team set for that host wins. |
| `infrastructure` | `network.timeout` when several hosts fail at once, i.e. the `burst` cause across more than one host. |
| `third_party` | A failed request to a host marked as third party in Settings (ABA-109). |
| `unknown` | `network.offline`, `auth` (an expired sign-in is normal; a refusal straight after sign-in isn't) and `other`. |

## Impact

The classifier takes the worst one that applies.

| Id | Rule |
|---|---|
| `blocked` | The category is `crash`; or the error happened in a flow listed in Settings as critical (`criticalFlows`). |
| `degraded` | `screen_crash`; or a failed request in the foreground that wasn't retried successfully within 5 s. |
| `silent` | `handled` with no flow; or a failed request followed by a successful request to the same endpoint within 5 s. |

## Cause patterns

Each pattern is checked against the error's breadcrumbs and its issue. An error can have none, or
several.

| Id | Plain label | Rule |
|---|---|---|
| `resumed_from_background` | Right after reopening the app | The last lifecycle breadcrumb is "foreground", within 2 s before the error. **Phase B** adds the exact time since foreground. |
| `burst` | Several failures at once | At least 2 other failed-request breadcrumbs within 1 s of the error. |
| `slow_network` | Slow network | The median duration of the last 5 successful requests is over 2 s. |
| `auth_expired` | Sign-in expired | Category `auth`, and an earlier request in the breadcrumbs to the same host succeeded. |
| `new_in_release` | New in this version | The issue's `firstVersion` is the latest version seen for the app. |
| `regressed` | Came back | The issue's status is `regressed`. |
| `single_device` | One device model | At least 5 occurrences, all on the same `device.model`. |

## Worked example: Cell C staging, 14 Nov

Five requests failed 3–49 ms after the app came back to the foreground on an iPhone. Seconds
earlier, the same endpoints had returned 200.

The `getBalances` failure gets these labels:

| Label | Value | Why |
|---|---|---|
| Category | `network.never_sent` | no status, 16 ms |
| Owner | `app` | the app sent the request before the phone had reconnected |
| Impact | `degraded` | foreground request, no successful retry |
| Causes | `resumed_from_background`, `burst` | foreground 1 s before; 4 other failures within 1 s |

Plain version: "Balance didn't load right after reopening the app; the phone hadn't reconnected.
Not a server outage. Pass to: app team."
