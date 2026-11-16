# @debugkit/sdk

Log errors and events from your app into **your own** cloud. This is the client half of
[deBug](https://github.com/Abantu-Digital/deBug): events go to an ingest function you deploy
in Firebase or AWS, and a dashboard you run yourself tells you what is failing and why.

- About 6 KB gzipped, with no runtime dependencies in your bundle.
- Works with React, React Native (bare and Expo), Expo Router, TanStack Start/Router, Next.js
  and plain Node.
- **Works on its own once initialised:** crashes, failed requests, sessions and the steps
  leading up to each error are recorded without any extra code. See
  [What it records by itself](#what-it-records-by-itself).
- Batches, retries, rate-limits, and queues events while offline.

## Install

```bash
npm install @debugkit/sdk
```

Pick the entry point for your platform. Each one adds the right device context and error
hooks, and they all share the same `deBug` client.

| You have | Import from | Also install |
|---|---|---|
| Expo | `@debugkit/sdk/expo` | `npx expo install expo-device expo-application react-native-device-info` (`npx debugkit init` does this) |
| Expo Router | `@debugkit/sdk/expo-router`, plus the above | |
| Bare React Native | `@debugkit/sdk/react-native` | `react-native-device-info` (`npx debugkit init` does this) |
| React on the web (Vite and others) | `@debugkit/sdk/react` | |
| TanStack Start / Router | `@debugkit/sdk/react` for the browser, `@debugkit/sdk/node` for the server | |
| Next.js, Remix, Express, any Node server | `@debugkit/sdk/node` | |
| Anything else (workers, edge, vanilla JS) | `@debugkit/sdk` | |

The quickest setup is `npx debugkit init` in your app's folder, once the SDK is installed. It deploys ingest to your own Firebase or AWS account, writes the endpoint and key into your app, and walks you through the dashboard. See [@debugkit/cli](https://www.npmjs.com/package/@debugkit/cli).

Your ingest endpoint and key come from your deBug deployment. During development, point at a
dashboard running in demo mode: `http://localhost:4400/api/ingest` with key `pk_local`.

## What it records by itself

Calling `init()` (or `initExpo`, `initReactNative`, `initNode`) turns on everything in this
table. The manual API below is for what only you know: which part of the app a step belongs to,
and whether it succeeded.

| | Browser | React Native / Expo | Node |
|---|---|---|---|
| Uncaught errors and unhandled rejections | ✓ | ✓ (fatal crashes marked critical) | ✓ (flushes, then exits like Node) |
| Render errors | with `DebugErrorBoundary` | with `DebugErrorBoundary` | |
| **Failed requests** (5xx, timeouts, network failures) as errors, every request as a breadcrumb | fetch, XHR | fetch, XHR (axios too) | fetch, `node:http` (axios, SDKs), plus 5xx your server sends |
| **Sessions**: crash-free and error-free rates per release | one per page load | new session after 30 min in the background | one per process |
| Navigation breadcrumbs | any router (History API) | add `useDebugExpoRouter` or `trackReactNavigation` | |
| Clicks on buttons and links, by their label | ✓ | | |
| `console.warn` / `console.error` as breadcrumbs | ✓ | ✓ | off by default |
| Foreground/background, online/offline | ✓ | foreground/background | |
| Device, OS, app version, network type on every event | ✓ | ✓ | ✓ |

Every error carries the last 30 breadcrumbs, so the dashboard shows what happened just
before it: the screen, the click, the request that failed.

**Privacy.** Query strings and fragments are dropped from every URL before anything is
recorded, and ids in paths become `:id` (`/v1/orders/8812?token=…` becomes `/v1/orders/:id`).
Request and response bodies, headers and what users type are never read. Use `beforeSend` to
scrub anything else.

**Noise control.** At most 60 errors a minute are sent (`maxErrorsPerMinute`), and one repeating
error gets at most a sixth of that. Breadcrumbs that repeat are collapsed into one. `sampleRate`
keeps a fraction of errors and events. Sessions and fatal crashes are never sampled out, so
crash-free rates stay accurate.

### Tuning it

```ts
deBug.init({
  endpoint, ingestKey, app: { id: "your-app", version: "2.4.0" },
  autoCapture: { console: false, clicks: false }, // or `false` to turn everything off
  network: {
    flows: [["/v2/auth/", "auth.login"], [/\/payments\//, "checkout.payment"]], // tag requests by URL
    ignoreUrls: ["analytics.example.com"],
    isFailure: (status) => status >= 500 || status === 429, // default: 500 and above
    slowMs: 3000, // slower requests get a warning breadcrumb
  },
  sampleRate: 1,
  maxErrorsPerMinute: 60,
});
```

Requests to your ingest endpoint and to the Metro and Expo dev servers are never recorded.

## Response times

With network capture on, the SDK also times every request. It sends one small summary per endpoint about once a minute: a count, failures, and a histogram. It doesn't send one event per request. The dashboard turns these into p50/p95 response times per endpoint. Paths are normalised the same way as for failures (no query strings, ids replaced with `:id`).

## Network type and country

Errors are broken down by network type, from `context.network.type`, and by country.
- **Browsers** report the network type on their own.
- **React Native and Expo** need you to pass it, for example from `@react-native-community/netinfo`:

```ts
NetInfo.addEventListener((s) => deBug.setContext({ network: { type: s.type === "wifi" ? "wifi" : s.type === "cellular" ? "cellular" : "unknown", isConnected: !!s.isConnected } }));
```

Country is worked out by ingest from the device's timezone, then its locale. IP addresses are never used.

## Releases and over-the-air updates

deBug groups crash-free rates and "new in" labels by `app.version`. If you ship JavaScript updates without a store release (hot-updater, expo-updates), pass the update id too, so each update counts as its own release:

```ts
import { HotUpdater } from "@hot-updater/react-native";
initExpo({ …, app: { id: "your-app", update: HotUpdater.getBundleId() } }); // or expo-updates: Updates.updateId
```

## Users

"Users affected" counts `setUser(id)` when you call it. Otherwise it counts an anonymous id per install: the SDK keeps it in localStorage on the web, and in the `storage` you pass on React Native (for example AsyncStorage). Ingest stores only a hash of either.

## Turning it off for some builds

Pass `enabled: false` and deBug stays inert:
- nothing is patched (fetch, XHR, console, crash handlers);
- nothing is recorded or sent;
- every call (`error`, `event`, `breadcrumb`) quietly does nothing;
- `track()` still runs your function, and returns or throws exactly as it would.

So app code never needs an `if` around deBug.

```ts
initExpo({
  enabled: !__DEV__ && !!process.env.EXPO_PUBLIC_DEBUG_ENDPOINT, // off in development, on where an endpoint is set
  endpoint: process.env.EXPO_PUBLIC_DEBUG_ENDPOINT ?? "",
  ingestKey: process.env.EXPO_PUBLIC_DEBUG_KEY ?? "",
  app: { id: "your-app", environment: process.env.EXPO_PUBLIC_DEBUG_ENVIRONMENT },
});
```

Compute `enabled` however your app tells its builds apart. In Expo, `__DEV__` catches Metro and
dev-client runs. A variant from `app.config` (EAS build profile) catches development builds made in
release mode. `deBug.enabled` tells you which way it went.

## Expo

```tsx
// src/debug.ts
import { initExpo } from "@debugkit/sdk/expo";

initExpo({
  endpoint: "https://<your-ingest-url>",
  ingestKey: "pk_live_yourapp",
  app: { id: "your-app" }, // version and build are read from expo-application
});
```

```tsx
// src/app/_layout.tsx
import "@/debug";
import { DebugErrorBoundary } from "@debugkit/sdk/expo";
import { useDebugExpoRouter } from "@debugkit/sdk/expo-router";

export default function RootLayout() {
  useDebugExpoRouter(); // a breadcrumb for every screen change
  return (
    <DebugErrorBoundary flow="app.root" fallback={({ reset }) => <CrashScreen onRetry={reset} />}>
      <Stack />
    </DebugErrorBoundary>
  );
}
```

In Expo Go, the app version reported is Expo Go's own. Development and production builds
report yours.

## Device details on React Native and Expo

deBug reads these itself. There's nothing to pass: `react-native-device-info` is a native
module, so it has to be in your app's own dependencies (`npx debugkit init` adds it), and the
app needs a new native build once it's added.

| Where | What | When |
|---|---|---|
| Device context | model, brand, manufacturer, emulator, memory, phone or tablet, screen size and pixel ratio | at start-up |
| App context | version and build | at start-up |
| Tag `device.fontScale` | the user's text-size setting, e.g. `1.3` | first event |
| Tag `device.mobileServices` | `gms`, `hms` or `none` (Android) | first event |
| Tags `device.lowRam`, `android.apiLevel` | Android's low-RAM flag and API level | first event |
| Tag `device.freeDisk` | free storage as a band: `<500MB`, `500MB-2GB`, `2GB-8GB`, `8GB+` | first event |
| Tags `network.carrier`, `app.installer` | mobile operator; where the app was installed from | first event |
| Tag `network.airplaneMode` | airplane mode (Android; iOS can't read it) | every event |
| Tag `device.details` | `full`, or `limited` when react-native-device-info isn't linked (`collect: { details: false }` leaves it out) | first event |

- **Never collected:** unique ids, Android id, serial number, MAC or IP address, device name.
- **Without the native half** (Expo Go, or an app not rebuilt since it was added): deBug
  keeps working with what React Native exposes on its own: OS, screen, font scale, and the
  model and brand on Android. It never crashes the app over it, and tags errors and events
  `device.details: limited` so a build missing it shows on the dashboard.
- **Leave facts out** with `collect`: `initExpo({ …, collect: { carrier: false, installer: false } })`.
- **Add your own:**
  - `tags: { plan: "prepaid" }` at init, or `deBug.setTags({ plan: "prepaid" })` later (`undefined` removes one);
  - `enrich: (event) => ({ screen: currentScreen() })` for values worked out per event.

  The event's own tags win over yours, and yours win over deBug's.
- **Keep crashes across restarts:** pass storage. MMKV saves a crash before the app closes:

  ```ts
  import { MMKV } from "react-native-mmkv";
  import { mmkvStorage } from "@debugkit/sdk/expo"; // or /react-native
  initExpo({ …, storage: mmkvStorage(new MMKV({ id: "debugkit" })) });
  ```

## Bare React Native

```tsx
import { initReactNative, DebugErrorBoundary, trackReactNavigation } from "@debugkit/sdk/react-native";

initReactNative({ endpoint, ingestKey, app: { id: "your-app" } });

const nav = useNavigationContainerRef();
<NavigationContainer ref={nav} {...trackReactNavigation(nav)}>…</NavigationContainer>
```

React Native also gets:

- **Crashes** through React Native's global error handler.
- **Unhandled promise rejections** (Hermes). In production only by default, so the yellow-box
  warning still works in development. Pass `captureUnhandledRejections: true` to capture them
  in development too.
- **A flush when the app goes to the background.** Pass `storage` (see above) to keep unsent
  events and crashes across restarts.

## React (web)

```tsx
import { deBug, DebugErrorBoundary } from "@debugkit/sdk/react";

deBug.init({ endpoint, ingestKey, app: { id: "your-web-app", version: "1.4.0" } });

createRoot(el).render(
  <DebugErrorBoundary fallback={<p>Something went wrong.</p>}>
    <App />
  </DebugErrorBoundary>,
);
```

Uncaught errors and unhandled rejections are captured from `window`. The OS, browser, screen
and network type are detected automatically.

## TanStack Start / Router

```tsx
// src/router.tsx: the browser side
import { deBug, trackTanStackRouter } from "@debugkit/sdk/react";

if (typeof window !== "undefined") deBug.init({ endpoint, ingestKey, app: { id: "web" } });

export function getRouter() {
  const router = createRouter({ routeTree });
  if (typeof window !== "undefined") trackTanStackRouter(router);
  return router;
}
```

```ts
// src/server/debug.ts: server only
import { deBug, initNode } from "@debugkit/sdk/node";

export const serverDebug = () =>
  deBug.initialized ? deBug : initNode({ endpoint, ingestKey, app: { id: "web", environment: "server" } });
```

```ts
// src/server/fns.ts
import { createServerFn } from "@tanstack/react-start";
import { withDebug } from "@debugkit/sdk/node";
import { serverDebug } from "./debug";

export const charge = createServerFn({ method: "POST" }).handler(
  withDebug("checkout.payment", async ({ data }) => {
    serverDebug(); // initialise lazily, inside the handler, so none of this reaches the client bundle
    /* … */
  }),
);
```

When the browser calls a server function that is wrapped in `withDebug`, record only the
outcome there, so the error isn't counted twice:
`deBug.track("checkout.payment", "charge", () => charge(), { captureError: false })`.

## Node

`initNode()` captures uncaught exceptions and unhandled rejections. It flushes events and then
exits the way Node would. Pass `captureProcessErrors: false` to manage those hooks yourself,
for example inside a dev server.

On edge runtimes such as Cloudflare Workers, timers aren't allowed at startup. Use the base
entry with `flushIntervalMs: 0`, and `await deBug.flush()` before each response returns.

## The API

```ts
deBug.error(err, { flow: "checkout.payment", step: "create_intent" });
deBug.event("signup_abandoned", { flow: "onboarding.signup", outcome: "abandoned" });
await deBug.track("auth.login", "submit_otp", () => api.verifyOtp(code)); // success or failure, plus the error
deBug.breadcrumb("navigation", "Login → OtpScreen");
deBug.setUser("user_123");
deBug.setContext({ app: { environment: "staging" } });
await deBug.flush();
```

`flow` names the part of your app, in dotted lowercase like `auth.login`. It's the main axis
of the dashboard, so keep it consistent.

To scrub personal data before anything leaves the device, use `beforeSend`:

```ts
deBug.init({ …, beforeSend: (e) => (e.type === "event" && e.name === "secret" ? null : e) });
```
