# deBug

Observability you own: an SDK for your app, an ingest function that runs in **your**
cloud (Firebase or AWS), and a dashboard you run yourself. Nothing is hosted by deBug.

See [SPEC.md](SPEC.md) for the design.

## Try it in 30 seconds (demo data, no cloud)

```bash
pnpm install
pnpm --filter @debug/dashboard dev     # http://localhost:4400
```

Sign in with `demo@debug.local` / `demo-debug`.

## 1. Instrument the app

```ts
import { deBug, expoContext } from "@debug/sdk";
import * as Device from "expo-device";
import * as Application from "expo-application";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";

deBug.init({
  endpoint: "https://<region>-<project>.cloudfunctions.net/debugIngest", // or your Lambda URL
  ingestKey: "pk_live_megaton",            // public, write-only
  app: { id: "megaton-native", version: Application.nativeApplicationVersion ?? undefined },
  context: expoContext({ Device, Application, Platform }),
  storage: AsyncStorage,                   // keeps events across restarts/offline
  beforeSend: (e) => e,                    // scrub PII here
});

// Where you want it:
deBug.breadcrumb("navigation", "Login → OtpScreen");
await deBug.track("auth.login", "submit_otp", () => api.verifyOtp(code)); // logs success/failure + error
deBug.error(err, { flow: "checkout.payment", step: "create_intent" });
deBug.event("signup_abandoned", { flow: "onboarding.signup", outcome: "abandoned" });
```

`flow` is the part of the app (dotted lowercase). It's the main axis of the dashboard,
so use it consistently.

## 2. Deploy ingest in your cloud

**Firebase:** in your functions codebase:

```ts
import { onRequest } from "firebase-functions/v2/https";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { FirestoreStore } from "@debug/adapters/firestore";
import { firebaseHandler } from "@debug/ingest/firebase";
import { parseIngestKeys } from "@debug/ingest";

initializeApp();
export const debugIngest = onRequest(
  firebaseHandler({ store: new FirestoreStore(getFirestore()), keys: parseIngestKeys(process.env.DEBUG_INGEST_KEYS) }),
);
```

Then deploy `packages/adapters/firestore.indexes.json` (it includes the TTL policy on `events.expireAt`).

**AWS:** a DynamoDB table with `pk`/`sk` string keys and TTL on `ttl`, plus a Lambda:

```ts
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoStore } from "@debug/adapters/dynamodb";
import { lambdaHandler } from "@debug/ingest/lambda";
import { parseIngestKeys } from "@debug/ingest";

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
export const handler = lambdaHandler({ store: new DynamoStore(doc, { table: process.env.DEBUG_TABLE! }), keys: parseIngestKeys(process.env.DEBUG_INGEST_KEYS) });
```

`DEBUG_INGEST_KEYS="pk_live_megaton:megaton-native"`: each key can only write to its own app.

## 3. Run the dashboard against your data

```bash
cp apps/dashboard/.env.example apps/dashboard/.env   # set DEBUG_STORE, credentials, secret
pnpm --filter @debug/dashboard hash-password you@company.com
pnpm --filter @debug/dashboard build
pnpm --filter @debug/dashboard start                 # http://127.0.0.1:4400
```

Give the dashboard **read-only** database credentials. It binds to `127.0.0.1` by default.
To serve it to your team, set `HOST=0.0.0.0` and put it behind HTTPS. Over plain HTTP on a
non-localhost address, set `DEBUG_INSECURE_COOKIES=1`.

Agents and scripts: `curl -H "Authorization: Bearer $DEBUG_API_TOKEN" localhost:4400/api/summary`.

## Develop

```bash
pnpm test        # vitest across packages
pnpm typecheck
```
