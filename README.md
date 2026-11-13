# deBug

Observability you own: an SDK for your app, an ingest function that runs in **your**
cloud (Firebase or AWS), and a dashboard you run yourself. Nothing is hosted by deBug.

See [SPEC.md](SPEC.md) for the design.

## Try it in 30 seconds (demo data, no cloud)

```bash
pnpm install
pnpm --filter @debugkit/dashboard dev     # http://localhost:4400
```

Sign in with `demo@debug.local` / `demo-debug`.

## Set it up with one command

```bash
npx @debugkit/cli init
```

Run it in your app's folder. Once `@debugkit/sdk` is installed, `npx debugkit init` works too.
When preview and production have separate backends, run it once per environment
(`npx debugkit init --env preview`, then `--env production`). The SDK's `enabled` option keeps deBug
off in development builds; see [packages/cli](packages/cli/README.md#several-environments-preview-production). It sets up Firebase or AWS in your own account, wires the SDK into your app, opens your (still empty) dashboard, sends a test event so you can watch it arrive, and walks you through what deBug records on its own and what you add. See [packages/cli](packages/cli/README.md).

The rest of this page describes the same setup done by hand.

## 1. Instrument the app

```bash
npm install @debugkit/sdk
```

```ts
// Expo
import { initExpo } from "@debugkit/sdk/expo";
initExpo({ endpoint: "https://<your-ingest-url>", ingestKey: "pk_live_megaton", app: { id: "megaton-native" } });

// Where it matters:
await deBug.track("auth.login", "submit_otp", () => api.verifyOtp(code)); // success or failure, plus the error
deBug.error(err, { flow: "checkout.payment", step: "create_intent" });
```

Once initialised, deBug works on its own. It records crashes, failed requests (with the code
that made them), sessions and crash-free rates per release, and the breadcrumbs leading up to
each error: navigation, clicks, console warnings, failed requests. The manual calls above add
what only you know: which flow a step belongs to, and whether it succeeded.

There are separate entry points for Expo, Expo Router, bare React Native, React, TanStack
Start/Router and Node. See **[packages/sdk/README.md](packages/sdk/README.md)** for each one,
and for what each platform records by itself.

`flow` names the part of the app, in dotted lowercase. It's the main axis of the dashboard,
so use it consistently.

### Try it locally, with no cloud

In demo mode the dashboard also accepts events at `POST /api/ingest` with key `pk_local`.
Point any app at `http://localhost:4400/api/ingest` (or `http://10.0.2.2:4400/...` from an
Android emulator) and watch its errors appear.

## 2. Deploy ingest in your cloud

**Firebase:** in your functions codebase:

```ts
import { onRequest } from "firebase-functions/v2/https";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { FirestoreStore } from "@debugkit/adapters/firestore";
import { firebaseHandler } from "@debugkit/ingest/firebase";
import { parseIngestKeys } from "@debugkit/ingest";

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
import { DynamoStore } from "@debugkit/adapters/dynamodb";
import { lambdaHandler } from "@debugkit/ingest/lambda";
import { parseIngestKeys } from "@debugkit/ingest";

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
export const handler = lambdaHandler({ store: new DynamoStore(doc, { table: process.env.DEBUG_TABLE! }), keys: parseIngestKeys(process.env.DEBUG_INGEST_KEYS) });
```

`DEBUG_INGEST_KEYS="pk_live_megaton:megaton-native"`: each key can only write to its own app.

## 3. Run the dashboard against your data

`npx debugkit dashboard` runs it with the settings `init` saved. To run it yourself:

```bash
cp apps/dashboard/.env.example apps/dashboard/.env   # set DEBUG_STORE, credentials, secret
pnpm --filter @debugkit/dashboard hash-password you@company.com
pnpm --filter @debugkit/dashboard build
pnpm --filter @debugkit/dashboard start                 # http://127.0.0.1:4400
```

Give the dashboard **read-only** database credentials. It binds to `127.0.0.1` by default.
To serve it to your team, set `HOST=0.0.0.0` and put it behind HTTPS. Over plain HTTP on a
non-localhost address, set `DEBUG_INSECURE_COOKIES=1`.

Agents and scripts: `curl -H "Authorization: Bearer $DEBUG_API_TOKEN" localhost:4400/api/summary`.

## Example apps

`examples/` holds one app per platform. Each one installs the SDK from **packed tarballs**,
exactly what npm would serve, not from the workspace:

```bash
pnpm pack:local                 # build + pack every package into .packs/
cd examples/<app> && npm install
```

| Example | What it shows | Verified |
|---|---|---|
| `vite-react` | React web: error boundary, window errors, rejections, `track()`, and a request captured with no deBug code | Run in the browser; all events reached the dashboard, including the automatic network error, clicks, console and navigation breadcrumbs (0.2) |
| `tanstack-start` | Browser plus server functions (`withDebug`), router breadcrumbs | Run in the browser; client and server events reached the dashboard |
| `expo-app` | Expo SDK 58: `initExpo`, error boundary, Expo Router breadcrumbs, Hermes rejections | Run in Expo Go on the iOS simulator; crash, rejection, breadcrumbs and device context arrived. The `track()` login button wasn't confirmed on the device |
| `bare-react-native` | React Native 0.88 with `react-native-device-info` | Metro release bundles build for iOS and Android. **Not yet run on a device** |

## Publishing

Six packages are versioned together with [changesets](.changeset/README.md): `@debugkit/schema`,
`@debugkit/sdk`, `@debugkit/ingest`, `@debugkit/adapters`, `@debugkit/cli` and `@debugkit/dashboard`.

1. Add a changeset to each change (`pnpm changeset`).
2. To release:
   ```bash
   pnpm changeset version   # bump versions, write changelogs
   pnpm release             # build everything, then publish what isn't on npm yet
   ```
   npm asks you to approve each publish in the browser. `pnpm release` also creates git tags;
   push them with `git push origin --tags`.
3. The Release workflow (`.github/workflows/release.yml`) automates this from GitHub once
   Actions runs on the organisation. It currently doesn't, because of a GitHub billing block.

In the repo, each package resolves to its TypeScript source. On publish, `publishConfig`
switches the entry points to the built `dist/` files (ESM, CommonJS and `.d.ts`).

## Develop

```bash
pnpm test        # vitest across packages
pnpm typecheck
pnpm build       # build every package with tsup
```
