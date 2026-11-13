# deBug — MVP Spec

deBug is self-hosted observability for apps. The customer's data lives in the
customer's own cloud (Firebase or AWS to start). deBug provides:

1. **An SDK** (`@debugkit/sdk`) that apps use to log errors and events.
2. **An ingest function** deployed *into the customer's cloud* (Cloud Function or
   Lambda) that validates, enriches, groups, and stores events.
3. **A dashboard** (TanStack Start) that reads the customer's data and tells the
   story: what is failing, where, how often, and for whom.

What we sell is the *data story*, not storage.

---

## 1. Architecture

```
App (SDK)                      Customer's cloud
─────────                      ─────────────────────────────────────────
deBug.error(err, {flow})  ──►  Ingest function (Cloud Function / Lambda)
deBug.event(name, {flow})        • check ingest key
  + auto device/OS/app context   • validate against @debugkit/schema
  + breadcrumbs                  • fingerprint errors → issues
  + offline queue, batching      • write raw events
                                 • update rollups (counts per issue/flow/day)
                                       │
                                       ▼
                                 Firestore  or  DynamoDB
                                       ▲
                               Dashboard + JSON API (read-only)
```

### Why ingest runs in the customer's cloud
- deBug never holds database credentials for any customer.
- Data never leaves the customer's account, which helps with POPIA/GDPR.
- No vendor lock-in: if they stop using deBug, their data and function stay.

### Credentials
| Where           | Credential                                    | Power                       |
|-----------------|-----------------------------------------------|-----------------------------|
| App / SDK       | **Ingest key** (public, per app/environment)  | Can only POST events        |
| Ingest function | Runtime identity (service account / IAM role) | Write to deBug tables only  |
| Dashboard       | Read-only identity                            | Read deBug tables only      |

- **Firebase:** a service account with `roles/datastore.user`. The function uses
  its default runtime identity. The dashboard uses a read-only service account
  or Google OAuth.
- **AWS:** a CloudFormation stack creates the Lambda, the DynamoDB tables, and a
  read-only IAM role with an external ID that the dashboard assumes.

The ingest key is not a secret, since it ships in app binaries. Abuse is limited
by rate limits per key and by rotating keys.

---

## 2. Event model (`@debugkit/schema`)

Every payload is an **envelope**: one batch of events, sent with shared context.

```ts
Envelope {
  sdk:     { name, version }
  context: { app, device, os, runtime, network?, locale?, timezone? }
  user?:   { id?, anonymousId }            // id is optional and set by the developer
  session: { id, startedAt }
  events:  Event[]                          // 1..100
}

Event =
  | ErrorEvent   { type: "error",   id, ts, flow?, step?, severity?, error: { name, message, stack?, frames? }, handled, tags?, breadcrumbs?,
                   request?: { method, url, status?, durationMs? } }   // set for failed HTTP requests
  | CustomEvent  { type: "event",   id, ts, flow?, step?, name, outcome?, props?, tags? }
  | SessionEvent { type: "session", id, ts, status: "started" | "errored" | "crashed" }
```

- `flow` is the **part of the app**, e.g. `auth.login` or `checkout.payment`. This
  is the main axis of the dashboard.
- `step` is a point inside a flow, e.g. `submit_otp`.
- `outcome` (`success | failure | abandoned`) on custom events lets us compute
  **failure rate per flow**, not just raw counts.
- `breadcrumbs` holds the last N navigation, network, click, console, and lifecycle
  entries before an error.
- `request` marks an error the SDK's network capture produced. `url` is the path
  only (query strings and fragments never leave the device) with ids replaced by
  `:id`.
- `SessionEvent` is sent automatically: `started` once per session, then `errored`
  (first unhandled error) and `crashed` (fatal error) at most once each. Ingest only
  rolls these up; it doesn't store them as events.

### What the SDK captures by itself (0.2)

`init()` turns on all of this; `autoCapture` switches parts off.

- **Errors:** uncaught errors and unhandled rejections (browser, React Native,
  Node), with React Native fatal crashes and Node `uncaughtException` marked fatal.
- **Network:** fetch and XHR in browsers and React Native; fetch, `node:http`, and
  5xx responses the server sends on Node. Every request becomes a breadcrumb.
  Failures, timeouts, and 5xx responses become errors with the calling code's stack.
- **Sessions:** one per page load, React Native app launch (or return after 30 min
  in the background), or Node process.
- **Breadcrumbs:** console warnings and errors, History API navigation, clicks by
  label, foreground/background, online/offline.
- **Noise control:** `maxErrorsPerMinute` (default 60, a sixth of that for one
  repeating error), `sampleRate`, and collapsed repeated breadcrumbs. Sessions
  and fatal crashes are never sampled out.
- **Older ingest:** if an ingest rejects the new fields with a 400, the SDK retries
  without them and keeps sending that way, so errors still arrive.

## 3. Grouping and severity

- **Fingerprint** = hash of `error.name` + the normalised top in-app stack frame
  + `flow`. Failed requests use the method, path, and status class instead
  (`GET /v1/feed 5xx`), so one failing endpoint is one issue whichever screen
  called it. Numbers, IDs, and URLs are removed from messages before hashing, so
  "User 123 not found" and "User 456 not found" are one issue.
- **Issue** = one fingerprint. It stores `firstSeen`, `lastSeen`, `count`,
  `sampleEvent`, and `title`.
- **Severity** (MVP) comes from the number of occurrences in the last 24 hours:

  | Level    | Occurrences / 24h |
  |----------|-------------------|
  | critical | ≥ 100             |
  | high     | ≥ 25              |
  | medium   | ≥ 5               |
  | low      | < 5               |

  The thresholds are configurable. Phase 2 also weights by distinct affected
  users and by the flow's importance.

## 4. Storage layout (adapter interface)

| Collection / table | Key                         | Purpose                         |
|--------------------|-----------------------------|---------------------------------|
| `events`           | `app#date` / `ts#id`        | Raw events (TTL, default 30d)   |
| `issues`           | `app` / `fingerprint`       | One row per grouped error       |
| `rollups`          | `app` / `day#dimension#key` | Pre-aggregated counts (`issueHour` uses an hour bucket) |

Firestore and DynamoDB are both poor at "group by and count" queries, so ingest
increments the **rollups at write time**. The dashboard only reads rollups and
issues, which keeps it fast and cheap.

Rollup dimensions: `flow`, `issue`, `os`, `appVersion`, `deviceModel`, the
`flow+outcome` pair, `session` (`version|started|errored|crashed`, for crash-free
rates), and `endpoint` (failed requests per `METHOD path`).

## 5. Dashboard (MVP) — self-hosted

The dashboard is a **TanStack Start app that the customer runs** — on a laptop
(`pnpm dev`) or on their own server/container (`pnpm build && pnpm start`).
deBug hosts nothing.

- **Data source:** `DEBUG_STORE=firestore|dynamodb|demo`. It connects with
  **read-only** credentials (a Firestore `roles/datastore.viewer` service account,
  or an AWS profile/role with read-only access to the deBug table). Demo mode seeds
  realistic data through the real ingest pipeline.
- **Login:** accounts come from `DEBUG_DASHBOARD_USERS` (`email=scrypt-hash` pairs,
  generated with `pnpm hash-password`). Sessions are HMAC-signed, HTTP-only cookies
  (`DEBUG_SESSION_SECRET`) that last 12h. Every page and `/api/*` route needs a
  session; agents can use `Authorization: Bearer $DEBUG_API_TOKEN` instead.
  Phase 2: Google / Cognito SSO.
- **Pages:**
  1. **Overview:** a plain-language narrative, KPI tiles (including crash-free
     sessions), errors by flow (coloured by severity, click to filter), a 14-day
     trend, release health (crash-free and error-free rates per version), failing
     endpoints, issues ranked by severity, and OS, app version, and device
     breakdowns.
  2. **Issue:** severity, the culprit frame, 48h hourly occurrences, where it
     happens (OS, version, device, network), the stack trace with in-app frames
     highlighted, breadcrumbs leading to the error, recent occurrences, and
     rule-based "what to look at" hints.
- **Readable by agents:** `GET /api/summary?app=` and `GET /api/issues/:fp?app=`
  return the same data as JSON, with field descriptions (`_fields`). Every chart
  also has a "View data" table.
- **Severity window:** exact trailing 24h, from the hourly `issueHour` rollups.

## 6. Roadmap

- **MVP (0.1):** schema, SDK (React Native/Expo and web), ingest with Firestore and
  DynamoDB adapters, overview, flow, and issue pages.
- **Automatic capture (0.2, released):** network capture, sessions and crash-free
  rates, automatic breadcrumbs, noise control.
- **Onboarding CLI (0.3, released):** `npx @debugkit/cli init`, or `npx debugkit init`
  once the SDK is installed. It provisions Firebase or AWS in the user's own account, wires the
  app, opens the empty dashboard, and walks through it with a test event. The dashboard is
  published as `@debugkit/dashboard`. Verified end to end on a real Firebase project; the AWS
  path is covered by unit tests only.
- **Per-build switch and environments (0.4, released):**
  - The SDK's `enabled` option leaves deBug inert in builds where it's off.
  - `npx debugkit init --env <name>` sets up each environment separately (its own provider, project,
    endpoint and dashboard login), with EAS variables for Expo.
  - Built for project-megatron-native, whose preview and production are separate apps on separate
    Firebase projects. The EAS step hasn't been run against a real project yet.
- **Retention and date ranges (0.5):**
  - Retention for raw events is chosen at `init` (default 60 days) and changed per app on the dashboard's Settings page. The setting lives in the customer's own database and is written through the ingest function's `/admin` routes, so the dashboard stays read-only.
  - Every view takes a date range: 24h (hourly), 7/14/30/90 days (daily), or custom (weekly past 90 days), compared with the previous period. The range is in the URL and in `/api/summary`.
  - Hourly counters expire after 7 days.
- **Who and when (0.6):**
  - Users affected per issue, and crash-free users. Hashed per-scope user marks (`app`, `crash`, `issue:<fp>`) are written at most once per user per day per function instance.
  - Release markers on the trend: the first sessions of each release, with OTA updates as `version+update`. "New in X" labels.
  - Issue status (open, resolved in a version, ignored), with automatic Regressed detection.
  - Prefilled "Create Linear/GitHub issue" links.
- **Next, automatic capture part 2:** freezes (JS thread stalls, long tasks,
  event-loop lag), performance (web vitals, cold start, slow screens), memory
  warnings, error spikes, rage clicks, and a Health page.
- **Then, automatic capture part 3:** source map upload and readable production
  stack traces; native iOS/Android crashes through an optional native module.
- **Phase 2:** MCP server, AI "probable cause and fix" per issue, alerts
  (Slack/email), source maps, and severity weighted by user impact.
- **Phase 3:** Mongo adapter, performance traces, session replay lite.

## 7. Repo layout

```
packages/schema     event schema (zod) + /core: types, severity, stack parsing (no zod)
packages/sdk        the npm package apps install: core + /react /react-native /expo
                    /expo-router /node entry points (~6 KB gzipped core)
packages/ingest     validate, fingerprint and roll up events; /firebase and /lambda handlers
packages/cli        @debugkit/cli: npx @debugkit/cli init (npx debugkit init via the SDK) (provision Firebase/AWS, wire the app, guided dashboard tour)
packages/adapters   storage adapters: memory, firestore, dynamodb (cloud SDKs are optional peers)
apps/dashboard      self-hosted TanStack Start dashboard (Recharts); demo mode accepts local ingest
examples/           vite-react, tanstack-start, expo-app, bare-react-native, installed from packed tarballs
```

Published packages are built with tsup (ESM, CommonJS and `.d.ts`). In the repo,
`exports` points to the source; `publishConfig` swaps in `dist/` on publish. Versioning and
releases use changesets and GitHub Actions.
