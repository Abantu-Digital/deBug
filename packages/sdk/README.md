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
| Expo | `@debugkit/sdk/expo` | `npx expo install expo-device expo-application` |
| Expo Router | `@debugkit/sdk/expo-router`, plus the above | |
| Bare React Native | `@debugkit/sdk/react-native` | `react-native-device-info` (optional, for model and app version) |
| React on the web (Vite and others) | `@debugkit/sdk/react` | |
| TanStack Start / Router | `@debugkit/sdk/react` for the browser, `@debugkit/sdk/node` for the server | |
| Next.js, Remix, Express, any Node server | `@debugkit/sdk/node` | |
| Anything else (workers, edge, vanilla JS) | `@debugkit/sdk` | |

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

## Bare React Native

```tsx
import DeviceInfo from "react-native-device-info";
import { initReactNative, DebugErrorBoundary, trackReactNavigation } from "@debugkit/sdk/react-native";

initReactNative({ endpoint, ingestKey, app: { id: "your-app" }, deviceInfo: DeviceInfo });

const nav = useNavigationContainerRef();
<NavigationContainer ref={nav} {...trackReactNavigation(nav)}>…</NavigationContainer>
```

Without `react-native-device-info` you still get the OS, OS version and JS engine. On Android
you also get the model and brand.

React Native also gets:

- **Crashes** through React Native's global error handler.
- **Unhandled promise rejections** (Hermes). In production only by default, so the yellow-box
  warning still works in development. Pass `captureUnhandledRejections: true` to capture them
  in development too.
- **A flush when the app goes to the background.** Pass AsyncStorage as `storage` to keep
  unsent events across restarts.

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
