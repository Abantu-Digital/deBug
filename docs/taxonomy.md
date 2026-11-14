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

**Decided per error, from what came before it.** The classifier labels each error when it
arrives, using the error, its context and its breadcrumbs. Breadcrumbs only hold what happened
*earlier*, so nothing here depends on later events. Anything that needs hindsight belongs to
incidents, which group related errors after the fact. Examples: "a retry succeeded", or "this was
the first of five failures".

**Signals the SDK doesn't send yet.** Rules marked *later* need data the SDK doesn't send yet.
Until it does, the label can't be given, or a nearby signal stands in, as the table says:

- whether the phone was online;
- the exact time since the app came to the foreground;
- an explicit `fatal` flag.

## What the SDK sends today

These are the facts the rules below are built on:

- **Failed requests:**
  - error `name`: `NetworkError` (no status) or `HttpError` (has a status);
  - `request`: method, path, status, duration;
  - `tags.source`: `network`;
  - the message ends in `timed out` when the request timed out;
  - aborted requests are never reported.
- **Which statuses count as failures:** by default only 5xx. A 4xx becomes an error only when the
  app sets `network.isFailure`, and Node's `http-server` capture only reports 5xx. So `auth` and
  `client_request` only appear in apps that opt in.
- **Uncaught errors:**
  - `handled: false`, and `tags.source` says where it came from:
    - `global-handler` (React Native), `window.onerror` (web) or `uncaughtException` (Node);
    - `error-boundary` for a screen that failed to draw;
    - `unhandled-rejection`, `unhandledrejection` or `unhandledRejection` for promises.
  - `withDebug` on the server sends `handled: false` with no source.
- **Fatal errors:** the SDK doesn't store a `fatal` flag. It sets `severity: "critical"` on a fatal
  error unless the app gave its own severity. The session's `crashed` marker is the reliable
  signal.
- **App lifecycle:** a `ui` breadcrumb with the message `App came to the foreground` or
  `App went to the background`.
- **Slow requests:** network breadcrumbs at level `warning`, i.e. slower than the app's `slowMs`
  (3 s by default).

## Category

The classifier checks the rules in this order and takes the first match. The order is the same
as `CATEGORIES`.

| Id | Plain label | Rule |
|---|---|---|
| `network.offline` | Phone offline | `request` with no `status`, and the phone was offline. *Later*: needs the network state, so nothing gets this label yet. |
| `network.timeout` | Request timed out | `request` with no `status`, and the message ends in `timed out`. |
| `network.never_sent` | Request never sent | `request` with no `status`, and `durationMs` < 100 ms: too fast to have reached a server. |
| `network.failed` | Connection failed | `request` with no `status`, anything else: DNS, TLS or a refused connection. |
| `auth` | Sign-in problem | `request.status` is 401 or 403. Opt-in, see above. |
| `server` | Server error | `request.status` is 500–599. |
| `client_request` | Request rejected | any other `request.status` from 400–499. Opt-in, see above. |
| `crash` | App crash | `handled: false`, `tags.source` is `global-handler` or `uncaughtException`, and `severity` is `critical`. *Later*: the SDK sends `fatal`, so an app-set severity can't hide a crash. |
| `screen_crash` | Screen crash | `tags.source` is `error-boundary`. |
| `unhandled_rejection` | Unhandled background error | `tags.source` is `unhandled-rejection`, `unhandledrejection` or `unhandledRejection`. |
| `uncaught` | Uncaught error | any other `handled: false`: a non-fatal global error, a web `window.onerror`, or `withDebug` on the server. |
| `app_reported` | Reported by the app | `handled: true` and no `request`: the app called `deBug.error()`. |
| `other` | Other | Nothing above matched. It should be rare; a growing `other` means a rule is missing. |

## Owner

| Id | Rule |
|---|---|
| `app` | Categories `network.never_sent`, `client_request`, `crash`, `screen_crash`, `unhandled_rejection`, `uncaught` and `app_reported`. Also `auth` with the cause `auth_expired`: the app should refresh the sign-in. |
| `backend` | `server`. Once hosts can be named in Settings, the team set for that host wins. |
| `infrastructure` | `network.timeout` or `network.failed` with the cause `burst`, when the failed requests went to more than one host. |
| `third_party` | A failed request to a host marked as third party in Settings. *Later*: needs named hosts. |
| `unknown` | Everything else: `network.offline`, a single `network.timeout` or `network.failed` (the network or the server), `auth` without `auth_expired`, and `other`. |

## Impact

Take the first row that applies.

| Id | Rule |
|---|---|
| `blocked` | The category is `crash`; or the error's flow is listed as critical in Settings (`criticalFlows`). |
| `silent` | The last lifecycle breadcrumb is `App went to the background`, so the user wasn't looking; or the category is `app_reported` with no flow. |
| `degraded` | Everything else: a screen crash, a failed request in the foreground, an unhandled error. |

"Recovered" (a retry succeeded, so the user never noticed) needs hindsight. It's worked out for
incidents, not for single errors.

## Cause patterns

Each pattern is checked against the error's breadcrumbs and its issue. An error can have none, or
several.

| Id | Plain label | Rule |
|---|---|---|
| `resumed_from_background` | Right after reopening the app | The last lifecycle breadcrumb is `App came to the foreground`, at most 10 s before the error, and no request has succeeded since. On Cell C staging the failures went on for 6 s after reopening, so a short window misses most of them. *Later*: the SDK sends the exact time since foreground. |
| `burst` | Several failures at once | At least one other failed-request breadcrumb in the 5 s before the error. The first failure of a burst doesn't get it; incidents group the whole burst. |
| `slow_network` | Slow network | At least 2 of the last 5 network breadcrumbs are slow (level `warning`). |
| `auth_expired` | Sign-in expired | Category `auth`, and an earlier request in the breadcrumbs to the same host succeeded. |
| `new_in_release` | New in this version | The issue's `firstVersion` is the latest version seen for the app. |
| `regressed` | Came back | The issue's status is `regressed`. |
| `single_device` | One device model | At least 5 occurrences, all on the same `device.model`. |

## Worked example: Cell C staging, 14 Nov

The app came back to the foreground on an iPhone at 12:59:55.45. Seconds earlier, the same
endpoints had returned 200. Over the next 6 s, six requests failed, each within 3–49 ms of being
sent, and none succeeded. One of them, 5.9 s after reopening:

`POST …/balance/getBalances → failed (16ms)`

| Label | Value | Why |
|---|---|---|
| Category | `network.never_sent` | no status, 16 ms |
| Owner | `app` | the app sent the request before the phone had reconnected |
| Impact | `degraded` | the app was in the foreground |
| Causes | `resumed_from_background`, `burst` | reopened 5.9 s before, nothing has worked since; 2 other failures in the 5 s before |

All six get the same category, owner and impact, and all get `resumed_from_background`. The first
one doesn't get `burst`. Incidents fold all six into one: "Requests failed on app resume (iOS)".

Plain version: "Balance didn't load right after reopening the app; the phone hadn't reconnected.
Not a server outage. Pass to: app team."
