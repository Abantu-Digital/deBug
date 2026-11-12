# deBug — MVP Spec

deBug is self-hosted observability for apps. The customer's data lives in the
customer's own cloud (Firebase or AWS to start). deBug provides:

1. **An SDK** (`@debug/sdk`) that apps use to log errors and events.
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
  + auto device/OS/app context   • validate against @debug/schema
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

## 2. Event model (`@debug/schema`)

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
  | ErrorEvent  { type: "error",  id, ts, flow?, step?, severity?, error: { name, message, stack?, frames? }, handled, tags?, breadcrumbs? }
  | CustomEvent { type: "event",  id, ts, flow?, step?, name, outcome?, props?, tags? }
```

- `flow` is the **part of the app**, e.g. `auth.login` or `checkout.payment`. This
  is the main axis of the dashboard.
- `step` is a point inside a flow, e.g. `submit_otp`.
- `outcome` (`success | failure | abandoned`) on custom events lets us compute
  **failure rate per flow**, not just raw counts.
- `breadcrumbs` holds the last N navigation, network, and log entries before an
  error.

## 3. Grouping and severity

- **Fingerprint** = hash of `error.name` + the normalised top in-app stack frame
  + `flow`. Numbers, IDs, and URLs are removed from messages before hashing, so
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

Rollup dimensions: `flow`, `issue`, `os`, `appVersion`, `deviceModel`, and the
`flow+outcome` pair.

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
  1. **Overview:** a plain-language narrative, KPI tiles, errors by flow (coloured
     by severity, click to filter), a 14-day trend, issues ranked by severity, and
     OS, app version, and device breakdowns.
  2. **Issue:** severity, the culprit frame, 48h hourly occurrences, where it
     happens (OS, version, device, network), the stack trace with in-app frames
     highlighted, breadcrumbs leading to the error, recent occurrences, and
     rule-based "what to look at" hints.
- **Readable by agents:** `GET /api/summary?app=` and `GET /api/issues/:fp?app=`
  return the same data as JSON, with field descriptions (`_fields`). Every chart
  also has a "View data" table.
- **Severity window:** exact trailing 24h, from the hourly `issueHour` rollups.

## 6. Roadmap

- **MVP:** schema, SDK (React Native/Expo and web), ingest with Firestore and
  DynamoDB adapters, overview, flow, and issue pages.
- **Phase 2:** MCP server, AI "probable cause and fix" per issue, alerts
  (Slack/email), source maps, and severity weighted by user impact.
- **Phase 3:** Mongo adapter, performance traces, session replay lite.

## 7. Repo layout

```
packages/schema     shared event schema (zod) + types
packages/sdk        the npm package the app installs
packages/ingest     platform-agnostic ingest core (validate, fingerprint, rollups)
packages/adapters   storage adapters: memory, firestore, dynamodb
packages/ingest     also exports ./firebase and ./lambda deploy handlers
apps/dashboard      self-hosted TanStack Start dashboard (Recharts)
```
