# @debug/sdk

Log errors and events from your app into **your own** cloud. This is the client half of
[deBug](https://github.com/Abantu-Digital/deBug): events go to an ingest function you deploy
in Firebase or AWS, and a dashboard you run yourself tells you what is failing and why.

- About 3 KB gzipped, with no runtime dependencies in your bundle.
- Works with React, React Native (bare and Expo), Expo Router, TanStack Start/Router, Next.js
  and plain Node.
- Captures crashes, unhandled rejections and render errors automatically. Batches, retries,
  and queues events while offline.

## Install

```bash
npm install @debug/sdk
```

Pick the entry point for your platform. Each one adds the right device context and error
hooks, and they all share the same `deBug` client.

| You have | Import from | Also install |
|---|---|---|
| Expo | `@debug/sdk/expo` | `npx expo install expo-device expo-application` |
| Expo Router | `@debug/sdk/expo-router`, plus the above | |
| Bare React Native | `@debug/sdk/react-native` | `react-native-device-info` (optional, for model and app version) |
| React on the web (Vite and others) | `@debug/sdk/react` | |
| TanStack Start / Router | `@debug/sdk/react` for the browser, `@debug/sdk/node` for the server | |
| Next.js, Remix, Express, any Node server | `@debug/sdk/node` | |
| Anything else (workers, edge, vanilla JS) | `@debug/sdk` | |

Your ingest endpoint and key come from your deBug deployment. During development, point at a
dashboard running in demo mode: `http://localhost:4400/api/ingest` with key `pk_local`.

## Expo

```tsx
// src/debug.ts
import { initExpo } from "@debug/sdk/expo";

initExpo({
  endpoint: "https://<your-ingest-url>",
  ingestKey: "pk_live_yourapp",
  app: { id: "your-app" }, // version and build are read from expo-application
});
```

```tsx
// src/app/_layout.tsx
import "@/debug";
import { DebugErrorBoundary } from "@debug/sdk/expo";
import { useDebugExpoRouter } from "@debug/sdk/expo-router";

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
import { initReactNative, DebugErrorBoundary, trackReactNavigation } from "@debug/sdk/react-native";

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
import { deBug, DebugErrorBoundary } from "@debug/sdk/react";

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
import { deBug, trackTanStackRouter } from "@debug/sdk/react";

if (typeof window !== "undefined") deBug.init({ endpoint, ingestKey, app: { id: "web" } });

export function getRouter() {
  const router = createRouter({ routeTree });
  if (typeof window !== "undefined") trackTanStackRouter(router);
  return router;
}
```

```ts
// src/server/debug.ts: server only
import { deBug, initNode } from "@debug/sdk/node";

export const serverDebug = () =>
  deBug.initialized ? deBug : initNode({ endpoint, ingestKey, app: { id: "web", environment: "server" } });
```

```ts
// src/server/fns.ts
import { createServerFn } from "@tanstack/react-start";
import { withDebug } from "@debug/sdk/node";
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
