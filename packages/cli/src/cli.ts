import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { hostDashboard } from "./hosting";
import { freePort, loginHint, prepareDashboardEnv, resetLogin, startDashboard, VERSION } from "./dashboard";
import { detectApp, PLATFORM_LABEL, type AppInfo } from "./detect";
import { sendTestEvents, walkthrough } from "./guide";
import { setupAws } from "./providers/aws";
import { setupFirebase } from "./providers/firebase";
import { setupLocal } from "./providers/local";
import type { ProviderResult } from "./providers/types";
import { cmdFor, environment, listEnvironments, paths, readConfig, readEnv, writeConfig, type DebugkitConfig, type ProviderId } from "./state";
import { ask, bail, bold, choose, code, dim, flags, p, pc, yes } from "./ui";
import { initFile, installSdk, printValues, wireApp } from "./wire";


const HELP = `${bold("debugkit")} ${VERSION}: set up deBug in your app
${dim("Run as npx debugkit <command> once @debugkit/sdk is installed, or npx @debugkit/cli <command> anywhere.")}

  ${code("npx debugkit init")}        choose a cloud, deploy ingest to your account, wire the SDK, walk through the dashboard
  ${code("npx debugkit dashboard")}   run the dashboard against your data, on this machine
  ${code("npx debugkit deploy-dashboard")}  host the dashboard in your Firebase or AWS account, at a link you can share
  ${code("npx debugkit test")}        send test events and check they arrive
  ${code("npx debugkit guide")}       replay the walkthrough
  ${code("npx debugkit password")}    reset the dashboard login

Options
  --env <name>                      one of several environments, like preview or production. Each has
                                    its own provider, project, endpoint and dashboard login
  --provider <firebase|aws|local>   skip the provider question
  --cwd <dir>                       the app's folder (default: current folder)
  --yes                             accept defaults (for scripts)
`;

function parseArgs(argv: string[]) {
  const out: { cmd?: string; provider?: ProviderId; env?: string; cwd: string; yes: boolean; help: boolean } = { cwd: process.cwd(), yes: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--provider") out.provider = argv[++i] as ProviderId;
    else if (a.startsWith("--provider=")) out.provider = a.split("=")[1] as ProviderId;
    else if (a === "--env") out.env = argv[++i];
    else if (a.startsWith("--env=")) out.env = a.split("=")[1];
    else if (a === "--cwd") out.cwd = resolve(argv[++i] ?? ".");
    else if (a === "--yes" || a === "-y") out.yes = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (!a.startsWith("-") && !out.cmd) out.cmd = a;
  }
  return out;
}

/** " (preview)" when working on a named environment. */
const envLabel = () => (environment.get() ? ` (${environment.get()})` : "");

/**
 * How long to keep raw events. Shown with a rough storage cost: about 2 KB per event, at
 * 10,000 events a day, priced per GB-month (Firestore ~$0.18, DynamoDB ~$0.25).
 */
async function askRetention(current: number | undefined, provider: ProviderId): Promise<number> {
  const perGb = provider === "aws" ? 0.25 : 0.18;
  const cost = (d: number) => {
    const gb = (10_000 * d * 2) / 1_000_000;
    return `${gb < 1 ? gb.toFixed(1) : Math.round(gb)} GB ≈ $${(gb * perGb).toFixed(2)}/month at 10k events a day`;
  };
  p.note(
    [
      "Raw events carry the stack trace, breadcrumbs and device details. They expire after the period you pick.",
      `${bold("Counts, issues and release health are kept forever")}, so charts cover any date range.`,
      "You can change this later on the dashboard's Settings page.",
    ].join("\n"),
    "Data retention",
  );
  const options = [30, 60, 90, 180, 365].map((d) => ({ value: String(d), label: `${d} days`, hint: cost(d) }));
  const picked = await choose("Keep raw events for how long?", [...options, { value: "custom", label: "Another number of days" }], String(current ?? 60));
  if (picked !== "custom") return Number(picked);
  const days = await ask("Days (1 to 3650)", {
    initial: String(current ?? 60),
    validate: (v) => (/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 3650 ? undefined : "A whole number from 1 to 3650"),
  });
  return Number(days);
}

function requireConfig(cwd: string): DebugkitConfig {
  let cfg = readConfig(cwd);
  if (!cfg && !environment.get()) {
    // No single setup, but environments: use the only one, or ask which.
    const envs = listEnvironments(cwd);
    if (envs.length === 1) environment.set(envs[0]);
    else if (envs.length > 1) bail(`This app has several environments: ${envs.join(", ")}. Pick one with --env, for example ${code(`npx debugkit ${flags.command} --env ${envs[0]}`)}.`);
    cfg = readConfig(cwd);
  }
  if (!cfg) bail(`deBug isn't set up${envLabel()} in ${cwd} yet. Run ${code(cmdFor("init"))} first.`);
  return cfg;
}

async function init(cwd: string, preset?: ProviderId) {
  p.intro(`${pc.bgRed(pc.white(" deBug "))} ${dim("observability you own")}${environment.get() ? ` · ${bold(environment.get()!)} environment` : ""}`);

  /* 1. The app */
  let app: AppInfo;
  try {
    app = detectApp(cwd);
  } catch (err) {
    bail((err as Error).message);
  }
  p.log.info(`Found ${bold(app.name)}: ${PLATFORM_LABEL[app.platform]}${app.expoRouter ? " with Expo Router" : ""}, using ${app.packageManager}. App id ${code(app.appId)}.`);
  const existing = readConfig(cwd);
  if (existing && !(await yes(`deBug is already set up${envLabel()} here (${existing.provider}, ${existing.endpoint}). Set it up again?`, false))) {
    p.outro(`Nothing changed. Try ${code(cmdFor("dashboard"))} or ${code(cmdFor("guide"))}.`);
    return;
  }
  await installSdk(app);

  /* 2. The provider */
  p.note(
    [
      "Your events are stored in your own cloud account, not ours.",
      `${bold("Firebase")}: a Cloud Function and Firestore. Good if the app already uses Firebase.`,
      `${bold("AWS")}: a Lambda with a public URL and DynamoDB.`,
      `${bold("Just this machine")}: no cloud. The dashboard keeps events in memory while it runs. Good for a first look.`,
    ].join("\n"),
    "Where should your data live?",
  );
  const provider =
    preset ??
    (await choose<ProviderId>(
      "Choose a provider",
      [
        { value: "firebase", label: "Firebase", hint: "Google sign-in" },
        { value: "aws", label: "AWS", hint: "AWS profile or SSO" },
        { value: "local", label: "Just this machine", hint: "no account needed" },
      ],
      "firebase",
    ));

  const dashboardPort = await freePort(4400);
  // Re-running on the same provider keeps the key: builds already shipped carry it.
  const ingestKey =
    existing?.provider === provider && existing.ingestKey ? existing.ingestKey : `pk_${provider === "local" ? "local" : "live"}_${randomBytes(12).toString("hex")}`;
  const retentionDays = provider === "local" ? 30 : await askRetention(existing?.retentionDays, provider);
  // Keep the admin token across re-runs, so a dashboard already set up keeps working.
  const adminToken = readEnv(paths(cwd).dashboardEnv).DEBUG_ADMIN_TOKEN ?? `adm_${randomBytes(24).toString("hex")}`;
  const ctx = { app, ingestKey, dashboardPort, retentionDays, adminToken };
  let result: ProviderResult;
  try {
    result = provider === "firebase" ? await setupFirebase(ctx) : provider === "aws" ? await setupAws(ctx) : await setupLocal(ctx);
  } catch (err) {
    p.log.error((err as Error).message);
    bail(`Setup stopped. Nothing else was changed in your app. Fix the error above and run ${cmdFor("init")} again.`);
  }
  const cfg: DebugkitConfig = { ...result.config, ...(existing?.provider === provider && existing.hosted ? { hosted: existing.hosted } : {}), appId: app.appId, dashboardPort, retentionDays, createdAt: new Date().toISOString() };
  writeConfig(cwd, cfg);
  p.note(result.created.map((l) => `• ${l}`).join("\n"), "Created");
  // The two values people copy, outside the box so no border characters come along.
  printValues("Your ingest endpoint and key (the key is public: it ships in your app):", { endpoint: cfg.endpoint, key: cfg.ingestKey });

  /* 3. The dashboard login, then (in the same cloud, straight after ingest) hosting it */
  await prepareDashboardEnv(cwd, result.dashboardEnv, dashboardPort);
  let hostedUrl = cfg.hosted?.url;
  let hostedLive = false;
  if (provider !== "local") {
    p.note(
      [
        `deBug can host the dashboard in your ${provider === "aws" ? "AWS account" : "Firebase project"} too, reading the same data,`,
        "at a link you can share with your team. It signs in with the same login, and you can still run it locally.",
        `Skip it and setup carries on; host it later with ${cmdFor("deploy-dashboard")}.`,
      ].join("\n"),
      "Host the dashboard",
    );
    const choice = await choose(
      hostedUrl ? `The dashboard is hosted at ${hostedUrl}. Update it?` : "Host the dashboard online?",
      [
        { value: "host", label: hostedUrl ? "Update it" : "Host it", hint: "a few minutes" },
        { value: "skip", label: "Skip for now" },
      ],
      "host",
    );
    // Retry or skip, never stop: setup always goes on to wire the app.
    for (let attempt = choice === "host"; attempt; ) {
      try {
        const out = await hostDashboard(cwd, readConfig(cwd) ?? cfg, { onProblem: "skip", confirmed: true });
        if (out) [hostedUrl, hostedLive] = [out.url, out.live];
        attempt = false;
      } catch (err) {
        p.log.error((err as Error).message);
        attempt =
          (await choose("Hosting didn't finish. What now?", [
            { value: "retry", label: "Retry" },
            { value: "skip", label: "Skip hosting for now", hint: "setup carries on" },
          ], "retry")) === "retry";
        if (!attempt) p.log.info(`Setup carries on. Host it later with ${code(cmdFor("deploy-dashboard"))}.`);
      }
    }
    if (choice === "skip") p.log.info(dim(`Skipped. Any time later: ${cmdFor("deploy-dashboard")}`));
  }
  const setup = readConfig(cwd) ?? cfg;

  /* 4. The app's code */
  const remaining = await wireApp(app, setup);

  /* 5. The dashboard, empty, then the walkthrough: on the hosted one when it's up */
  let dash: Awaited<ReturnType<typeof startDashboard>> | undefined;
  if (!(hostedUrl && hostedLive)) {
    try {
      dash = await startDashboard(cwd);
    } catch (err) {
      p.log.error((err as Error).message);
      p.outro(`deBug is set up, but the dashboard didn't start. Try ${code(cmdFor("dashboard"))}.`);
      return;
    }
  }
  await walkthrough({ cwd, app, cfg: setup, dashboardUrl: dash?.url ?? hostedUrl!, remaining });

  if (provider === "local" && dash) {
    const running = dash;
    p.log.info(`The dashboard is your ingest on this setup, so keep it running while you try the app. Stop it with ${code("Ctrl-C")}.`);
    p.outro("deBug is set up.");
    await new Promise<void>((r) => running.child.once("exit", () => r()));
    return;
  }
  dash?.stop();

  const others = listEnvironments(cwd).filter((e) => e !== environment.get());
  p.outro(
    `deBug is set up${envLabel()}. ${hostedUrl ? `Share the dashboard: ${code(hostedUrl)}. ` : ""}Open it locally any time with ${code(cmdFor("dashboard"))}.` +
      (environment.get() && !others.length ? `\n   Set up the next environment the same way, e.g. ${code("npx debugkit init --env production")}.` : ""),
  );
}

async function deployDashboard(cwd: string) {
  const cfg = requireConfig(cwd);
  p.intro(`${pc.bgRed(pc.white(" deBug "))} host the dashboard${envLabel()}`);
  if (cfg.provider === "local") bail(`This setup keeps data on this machine, so there's nothing to host. Run ${code(cmdFor("init"))} with Firebase or AWS first.`);
  const out = await hostDashboard(cwd, cfg);
  if (!out) return;
  const { url } = out;
  const { openUrl } = await import("./exec");
  openUrl(url);
  p.outro(`Share ${code(url)} with your team. ${loginHint(cwd)}`);
}

async function dashboard(cwd: string) {
  const cfg = requireConfig(cwd);
  p.intro(`${pc.bgRed(pc.white(" deBug "))} dashboard${envLabel()}`);
  if (cfg.hosted) p.log.info(`Also online at ${code(cfg.hosted.url)}`);
  const dash = await startDashboard(cwd);
  p.log.info(`${code(dash.url)} · reading ${cfg.provider === "local" ? "in-memory data (and accepting events)" : cfg.provider} · Ctrl-C to stop`);
  const { openUrl } = await import("./exec");
  openUrl(dash.url);
  await new Promise<void>((r) => dash.child.once("exit", () => r()));
}

async function test(cwd: string) {
  const cfg = requireConfig(cwd);
  const app = detectApp(cwd);
  p.intro(`${pc.bgRed(pc.white(" deBug "))} test`);
  const s = p.spinner();
  s.start(`Sending test events to ${cfg.endpoint}`);
  const r = await sendTestEvents(cfg, app);
  if (r.error) {
    s.error(`Not accepted: ${r.error}`);
    process.exitCode = 1;
    if (cfg.provider === "local") p.log.info(`On this setup the dashboard is the ingest: start it with ${code(cmdFor("dashboard"))} first.`);
    return;
  }
  s.stop("Accepted by your ingest");
  p.outro(`Open the dashboard (${code(cmdFor("dashboard"))}) to see them under the ${code("onboarding.test")} flow.`);
}

async function guide(cwd: string) {
  const cfg = requireConfig(cwd);
  const app = detectApp(cwd);
  p.intro(`${pc.bgRed(pc.white(" deBug "))} walkthrough`);
  const dash = await startDashboard(cwd);
  await walkthrough({ cwd, app, cfg, dashboardUrl: dash.url, remaining: initFile(app, cfg).then });
  if (cfg.provider === "local") {
    p.outro("Keep the dashboard running while you try the app. Ctrl-C to stop.");
    await new Promise<void>((r) => dash.child.once("exit", () => r()));
  } else {
    dash.stop();
    p.outro("Done.");
  }
}

async function password(cwd: string) {
  p.intro(`${pc.bgRed(pc.white(" deBug "))} reset the dashboard login`);
  const cfg = requireConfig(cwd);
  await resetLogin(cwd);
  if (cfg.hosted) p.log.info(`The hosted dashboard (${cfg.hosted.url}) still has the old login until you run ${code(cmdFor("deploy-dashboard"))}.`);
  p.outro(`Saved. Restart the dashboard (${code(cmdFor("dashboard"))}) and sign in with the new password.`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  flags.yes = args.yes;
  flags.command = args.cmd ?? "help";
  if (args.help || !args.cmd) {
    console.log(HELP);
    return;
  }
  try {
    environment.set(args.env);
  } catch (err) {
    bail((err as Error).message);
  }
  if (args.provider && !["firebase", "aws", "local"].includes(args.provider)) bail(`Unknown provider ${args.provider}. Use firebase, aws or local.`);
  switch (args.cmd) {
    case "init":
      return init(args.cwd, args.provider);
    case "dashboard":
      return dashboard(args.cwd);
    case "deploy-dashboard":
      return deployDashboard(args.cwd);
    case "test":
      return test(args.cwd);
    case "guide":
      return guide(args.cwd);
    case "password":
      return password(args.cwd);
    default:
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  p.log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

