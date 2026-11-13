import { DebugClient } from "@debugkit/sdk";
import type { AppInfo, Platform } from "./detect";
import { PLATFORM_LABEL } from "./detect";
import { loginHint, summary } from "./dashboard";
import { openUrl } from "./exec";
import type { DebugkitConfig } from "./state";
import { bold, code, dim, next, p, pc } from "./ui";

/** What the SDK records on each platform without any code, as the walkthrough explains it. */
export function automaticFor(platform: Platform, app: Pick<AppInfo, "expoRouter" | "reactNavigation">): string[] {
  const common = [
    `${bold("Crashes")}: uncaught errors and unhandled promise rejections, with the stack trace`,
    `${bold("Failed requests")}: every request is a breadcrumb; timeouts, network failures and 5xx responses become errors that point at the line that made the call`,
    `${bold("Sessions")}: each launch is marked started, then errored or crashed, which gives the crash-free rate per release`,
    `${bold("Context")}: device, OS, app version and network on every event`,
  ];
  switch (platform) {
    case "expo":
    case "react-native":
      return [
        ...common,
        `${bold("Lifecycle")}: the app going to the background and back; a new session after 30 minutes away`,
        `${bold("Console")}: console.warn and console.error as breadcrumbs`,
        app.expoRouter || app.reactNavigation
          ? `${bold("Screens")}: every screen change, once you add the ${code(app.expoRouter ? "useDebugExpoRouter()" : "trackReactNavigation()")} line`
          : `${bold("Screens")}: add the router helper from the SDK for screen-change breadcrumbs`,
        `${bold("Offline")}: events wait in a queue and send when the connection is back`,
      ];
    case "node":
      return [...common.slice(0, 2), `${bold("Server errors")}: 5xx responses your server sends, and outgoing node:http requests (axios, SDKs)`, common[3]!, `${bold("Clean exit")}: on a crash, events are sent before the process exits`];
    default:
      return [
        ...common,
        `${bold("Navigation")}: every page change, with any router`,
        `${bold("Clicks")}: buttons and links, by their label (never what people type)`,
        `${bold("Console and lifecycle")}: console warnings, the tab hidden or shown, going offline`,
      ];
  }
}

function sdkImport(platform: Platform) {
  return platform === "expo" ? "@debugkit/sdk/expo" : platform === "react-native" ? "@debugkit/sdk/react-native" : platform === "node" ? "@debugkit/sdk/node" : "@debugkit/sdk/react";
}

const MANUAL = (platform: Platform) => `import { deBug } from "${sdkImport(platform)}";

// 1. In a try/catch you already have: report it, tagged with the part of the app
try {
  await chargeCard(order);
} catch (err) {
  deBug.error(err, { flow: "checkout.payment", step: "charge" });
  showPaymentError();
}

// 2. A step that can succeed or fail: deBug logs the outcome (and the error),
//    so the dashboard can say "18% of logins fail", not just "12 errors"
await deBug.track("auth.login", "submit_otp", () => api.verifyOtp(code));

// 3. Something that isn't an error but matters
deBug.event("signup_abandoned", { flow: "onboarding.signup", outcome: "abandoned" });

// 4. Who it happened to (an id, not personal data), once they sign in
deBug.setUser(user.id);`;

/** Send a handful of realistic test events through the real ingest. */
export async function sendTestEvents(cfg: DebugkitConfig, app: AppInfo): Promise<{ sent: number; error?: string }> {
  // Every upload's outcome: one rejected batch is a failure even if a later one succeeds.
  const failures: string[] = [];
  let sent = 0;
  const client = new DebugClient().init({
    endpoint: cfg.endpoint,
    ingestKey: cfg.ingestKey,
    app: { id: cfg.appId, version: app.version ?? "0.0.0", environment: "debugkit-test" },
    context: { os: { name: process.platform, version: process.version }, runtime: { name: "debugkit-cli" }, device: { type: "desktop", model: "debugkit test" } },
    autoCapture: { sessions: true, errors: false, network: false, console: false, navigation: false, clicks: false, lifecycle: false },
    flushIntervalMs: 0,
    fetch: async (url, init) => {
      let res: Response;
      try {
        res = await fetch(url, init);
      } catch (err) {
        failures.push(`couldn't reach it (${(err as Error).message})`);
        throw err;
      }
      if (res.ok) sent += (JSON.parse(String(init?.body ?? "{}")).events ?? []).length;
      else failures.push(`it answered ${res.status}: ${(await res.clone().text().catch(() => "")).slice(0, 200)}`);
      return res;
    },
  });
  // What the user did before things went wrong, as the SDK would record it.
  client.navigated("/cart");
  client.navigated("/checkout");
  client.breadcrumb("ui", 'Clicked button "Pay now"');
  // An automatic capture: a failed request.
  client.breadcrumb("network", "POST /v1/payments/intent → 503 (1840ms)", { status: 503, durationMs: 1840 }, "error");
  client.captureError(
    { name: "HttpError", message: "POST /v1/payments/intent responded 503 (test event from npx debugkit)", stack: new Error().stack },
    { flow: "onboarding.test", handled: true, tags: { source: "network", test: "true" } },
    { method: "POST", url: "/v1/payments/intent", status: 503, durationMs: 1840 },
  );
  // A manual report from a try/catch.
  try {
    JSON.parse("<html>502 Bad Gateway</html>");
  } catch (err) {
    client.error(err, { flow: "onboarding.test", step: "parse_receipt", tags: { test: "true" } });
  }
  // track(): one success, one failure.
  await client.track("onboarding.test", "submit", async () => true);
  await client.track("onboarding.test", "submit", async () => Promise.reject(new Error("Test failure from deBug.track()")), { captureError: false }).catch(() => {});
  // Drain the queue (a flush already in flight only sends its batch). Stop on a failure:
  // the SDK backs off and would otherwise keep the queue.
  for (let i = 0; i < 5 && client.pending && !failures.length; i++) await client.flush();
  await client.close();
  if (!failures.length && client.pending) failures.push(`${client.pending} events weren't sent`);
  return { sent, error: failures.length ? failures.join("; ") : undefined };
}

/** Wait until the dashboard shows the test events. */
async function waitForArrival(cwd: string, url: string, appId: string, timeoutMs = 90_000) {
  const until = Date.now() + timeoutMs;
  let last: Awaited<ReturnType<typeof summary>> | undefined;
  while (Date.now() < until) {
    last = await summary(cwd, url, appId);
    if (last.ok && last.data?.app === appId && last.data?.issues?.length) return last;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return last;
}

/**
 * The walkthrough after setup: the empty dashboard, what will appear on it, a first test event,
 * then what the SDK does on its own and what the developer adds.
 */
export async function walkthrough(opts: { cwd: string; app: AppInfo; cfg: DebugkitConfig; dashboardUrl: string; remaining: string[] }) {
  const { cwd, app, cfg, dashboardUrl } = opts;

  /* 1. The empty dashboard */
  const before = await summary(cwd, dashboardUrl, cfg.appId);
  const empty = before.status === 404 || (before.ok && before.data?.app !== cfg.appId);
  p.note(
    [
      `${bold("Your dashboard is running")} at ${code(dashboardUrl)}`,
      loginHint(cwd),
      "",
      empty
        ? `It's connected to your ${cfg.provider === "local" ? "local" : cfg.provider === "aws" ? "DynamoDB" : "Firestore"} data and ${bold("empty")}: nothing has been sent yet.`
        : before.ok
          ? "It's connected, and already has data for this app."
          : `It couldn't read your data yet (${before.status || "no answer"}: ${before.error ?? "unknown"}). The test below will tell us more.`,
    ].join("\n"),
    "1 · The dashboard",
  );
  openUrl(dashboardUrl);
  await next("I'm signed in");

  /* 2. What will appear */
  p.note(
    [
      `${bold("A written summary")}: how many errors today, the worst part of the app, the top issue, the struggling release`,
      `${bold("Issues by severity")}: errors grouped by cause; open one for the stack trace and the steps that led to it`,
      `${bold("Release health")}: crash-free and error-free sessions per app version`,
      `${bold("Failing endpoints")}: requests that time out, fail or return 5xx`,
      `${bold("Where the app is failing")}: errors and failure rates per flow, like auth.login`,
      `${bold("Breakdowns")}: by OS, app version and device`,
    ].join("\n"),
    "2 · What you'll see there",
  );
  await next("Send a test event");

  /* 3. First events, end to end */
  const s = p.spinner();
  s.start(`Sending test events to ${cfg.endpoint}`);
  const sent = await sendTestEvents(cfg, app);
  if (sent.error) {
    s.error(`The ingest didn't accept them: ${sent.error}`);
    p.log.warn(cfg.provider === "firebase" ? "A brand-new Cloud Function can take a minute to answer. Try again with npx debugkit test." : "Check the endpoint and key in .debugkit/config.json, then run npx debugkit test.");
  } else {
    s.message("Sent. Waiting for the dashboard to show them");
    const after = await waitForArrival(cwd, dashboardUrl, cfg.appId);
    if (after?.ok && after.data?.issues?.length) {
      s.stop("They arrived");
      const d = after.data;
      p.note(
        [
          ...(d.narrative ?? []).map((l: string) => `“${l}”`),
          "",
          `${bold(String(d.issues.length))} issues · ${bold(String(d.health?.sessions14d ?? 0))} session · failing endpoint ${code(d.health?.endpoints?.[0]?.endpoint ?? "—")}`,
          "",
          `Refresh the dashboard. You'll see a ${pc.red("HttpError")} from a failed request (captured the way the SDK does it automatically),`,
          `a ${pc.red("SyntaxError")} reported from a try/catch, and the ${code("onboarding.test")} flow with a 50% failure rate from track().`,
          dim("They're tagged environment debugkit-test, version " + (app.version ?? "0.0.0") + ". Raw events expire after 30 days."),
        ].join("\n"),
        "3 · Your first events",
      );
    } else {
      s.error("Sent, but the dashboard doesn't show them yet");
      p.log.warn(`The dashboard said: ${after?.status ?? "?"} ${after?.error ?? ""}. Refresh it in a minute, or run npx debugkit test again.`);
    }
  }
  await next("What does the SDK do on its own?");

  /* 4. Automatic */
  p.note(
    [`Once ${code("debug." + (app.typescript ? "ts" : "js"))} runs, the SDK records this in the background, with no other code:`, "", ...automaticFor(app.platform, app).map((l) => `• ${l}`), "", dim("Every error carries the last 30 breadcrumbs: the screen, the tap, the request that failed. Query strings and request bodies never leave the device.")].join("\n"),
    `4 · Automatic in ${PLATFORM_LABEL[app.platform]}`,
  );
  await next("What do I add myself?");

  /* 5. Manual */
  p.note(
    [
      "Automatic capture says what broke. What it can't know is which part of your app a step belongs to, and whether it worked.",
      `That's what ${code("flow")} is for: a dotted name like ${code("auth.login")} that the dashboard groups everything by.`,
      "",
      MANUAL(app.platform),
    ].join("\n"),
    "5 · What you add in your own try/catches",
  );
  await next("Show me what's left to do");

  /* 6. Remaining */
  p.note(
    [
      ...opts.remaining.map((l, i) => `${i + 1}. ${l}`),
      `${opts.remaining.length + 1}. Run the app and watch the dashboard fill in`,
      "",
      `${code("npx debugkit dashboard")}  open the dashboard again`,
      `${code("npx debugkit test")}       send another test event`,
      `${code("npx debugkit guide")}      replay this walkthrough`,
    ].join("\n"),
    "6 · Finish wiring your app",
  );
}
