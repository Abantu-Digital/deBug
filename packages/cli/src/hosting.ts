import { createHash } from "node:crypto";
import { cpSync, renameSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { zipSync } from "fflate";
import FIRESTORE_INDEXES from "../../adapters/firestore.indexes.json" with { type: "json" };
import { DASHBOARD_VERSION } from "./dashboard";
import { capture, interactive, which } from "./exec";
import { lookup } from "./providers/aws";
import { asArray, firebaseCli, writeFirebaseJson } from "./providers/firebase";
import { environment, paths, readEnv, upsertEnv, writeConfig, type DebugkitConfig } from "./state";
import { bail, bold, choose, code, dim, p, yes } from "./ui";

export const DASHBOARD_FUNCTION = "debugkitDashboard";
export const DASHBOARD_CODEBASE = "debugkit-dashboard";
const SA_NAME = "debugkit-dashboard";

/** Which settings from the local dashboard env go online. Never PORT, and nothing a host reserves. */
const SHARED = ["DEBUG_STORE", "DEBUG_SESSION_SECRET", "DEBUG_DASHBOARD_USERS", "DEBUG_API_TOKEN", "DEBUG_ADMIN_URL", "DEBUG_ADMIN_TOKEN", "DEBUG_RETENTION_DAYS", "DEBUG_LINEAR_TEAM", "DEBUG_LINEAR", "DEBUG_GITHUB_REPO"];
/** The secrets among them: kept out of files that might be committed. */
const SECRET = new Set(["DEBUG_SESSION_SECRET", "DEBUG_DASHBOARD_USERS", "DEBUG_API_TOKEN", "DEBUG_ADMIN_TOKEN"]);

/** The hosted dashboard's settings: the same data and login as the local one, at its public URL. */
export function hostedEnv(local: Record<string, string>, url: string, extra: Record<string, string> = {}): { plain: Record<string, string>; secret: Record<string, string> } {
  const plain: Record<string, string> = { DEBUG_DASHBOARD_URL: url, ...extra };
  const secret: Record<string, string> = {};
  for (const k of SHARED) if (local[k]) (SECRET.has(k) ? secret : plain)[k] = local[k]!;
  if (!secret.DEBUG_SESSION_SECRET || !secret.DEBUG_DASHBOARD_USERS) throw new Error("The dashboard login isn't set up yet. Run npx debugkit init (or npx debugkit password) first.");
  return { plain, secret };
}

/** KEY="value" lines that dotenv parsers (Firebase's included) read back exactly. */
export const dotenv = (values: Record<string, string>) =>
  Object.entries(values)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join("\n") + "\n";

/**
 * The dashboard package to deploy: the published one at this CLI's version, or a local build
 * when DEBUGKIT_DASHBOARD_DIR points at a checkout (for testing before a release).
 */
async function dashboardDependency(into: string): Promise<string> {
  const dir = process.env.DEBUGKIT_DASHBOARD_DIR;
  if (!dir || !existsSync(join(dir, "handler.mjs"))) return `^${DASHBOARD_VERSION}`;
  for (const f of readdirSync(into)) if (f.endsWith(".tgz")) rmSync(join(into, f));
  const r = await capture("npm", ["pack", "--silent", "--pack-destination", into], { cwd: dir });
  const tgz = r.stdout.trim().split(/\r?\n/).pop();
  if (r.code !== 0 || !tgz) throw new Error(`Couldn't pack the local dashboard: ${r.stderr.slice(-400)}`);
  // Name it by content: npm keeps an installed package whose file name and version haven't changed.
  const hash = createHash("sha256").update(readFileSync(join(into, tgz))).digest("hex").slice(0, 12);
  const named = tgz.replace(/\.tgz$/, `-${hash}.tgz`);
  renameSync(join(into, tgz), join(into, named));
  return `file:./${named}`;
}

async function npmInstall(cwd: string, extra: string[] = []) {
  const r = await capture("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", ...extra], { cwd });
  if (r.code !== 0) throw new Error(`npm install failed in ${cwd}:\n${r.stderr.slice(-600)}`);
}

/** Tell ingest the dashboard's address, so Slack alerts link to it. Keeps every other alert setting. */
async function linkAlerts(local: Record<string, string>, app: string, url: string) {
  const base = local.DEBUG_ADMIN_URL;
  const token = local.DEBUG_ADMIN_TOKEN;
  if (!base || !token) return;
  const auth = { authorization: `Bearer ${token}` };
  try {
    const got = await fetch(`${base}/settings?app=${encodeURIComponent(app)}`, { headers: auth });
    if (!got.ok) return;
    const alerts = ((await got.json()) as { settings?: { alerts?: Record<string, unknown> } }).settings?.alerts ?? {};
    const cur = typeof alerts.dashboardUrl === "string" ? alerts.dashboardUrl : "";
    if (cur && !/\/\/(localhost|127\.0\.0\.1)/.test(cur)) return; // someone chose one already
    // The webhook comes back masked; sending the masked value keeps the real one.
    await fetch(`${base}/settings`, { method: "PUT", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ app, alerts: { ...alerts, dashboardUrl: url } }) });
  } catch {
    /* alerts just keep linking where they did */
  }
}

/** Wait until the hosted dashboard answers its sign-in page. */
async function waitLive(url: string, ms = 120_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(`${url}/login`, { redirect: "manual" });
      if (r.status === 200) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

export interface HostResult {
  url: string;
  created: string[];
  /** It answered its sign-in page after the deploy. */
  live: boolean;
}

/**
 * During init, hosting can be skipped but never ends the setup: declining or a failed deploy
 * returns undefined and init carries on. `npx debugkit deploy-dashboard` stops instead.
 */
export interface HostOptions {
  optional?: boolean;
}

/** Leave hosting out (init) or stop (deploy-dashboard). */
function skipOrStop(opts: HostOptions, message: string): undefined {
  if (opts.optional) {
    p.log.info(`${message} Host it any time with ${code("npx debugkit deploy-dashboard")}.`);
    return undefined;
  }
  bail(message);
}

/** Put the dashboard online in the same cloud as the data. Saves the URL in .debugkit/config.json. */
export async function hostDashboard(cwd: string, cfg: DebugkitConfig, opts: HostOptions = {}): Promise<HostResult | undefined> {
  const local = readEnv(paths(cwd).dashboardEnv);
  const out =
    cfg.provider === "firebase" ? await hostFirebase(cwd, cfg, local, opts) : cfg.provider === "aws" ? await hostAws(cfg, local, opts) : bail("The dashboard can only be hosted on Firebase or AWS. On this setup, run it locally.");
  if (!out) return undefined;
  // Configs from before 0.6.1 kept the Google account in config.json: move it to the gitignored env.
  if (cfg.firebase?.account) {
    if (!local.DEBUGKIT_FIREBASE_ACCOUNT) upsertEnv(paths(cwd).dashboardEnv, { DEBUGKIT_FIREBASE_ACCOUNT: cfg.firebase.account });
    const { account: _a, ...firebase } = cfg.firebase;
    cfg = { ...cfg, firebase };
  }
  writeConfig(cwd, { ...cfg, hosted: out.hosted });
  await linkAlerts(local, cfg.appId, out.hosted.url);
  const s = p.spinner();
  s.start(`Checking ${out.hosted.url}`);
  const live = await waitLive(out.hosted.url);
  if (live) s.stop(`The dashboard is live at ${code(out.hosted.url)}`);
  else s.error(`${out.hosted.url} didn't answer yet. New deploys can take a minute; open it again shortly.`);
  return { url: out.hosted.url, created: out.created, live };
}

/* ------------------------------------------------------------------ Firebase */

const SITE_ID = /^[a-z0-9](?:[a-z0-9-]{2,61}[a-z0-9])$/;

/** Firebase Hosting sites in the project, by id. */
async function listSites(fb: (a: string[]) => Promise<{ code: number; stdout: string }>, proj: string[]): Promise<string[]> {
  const r = await fb(["hosting:sites:list", "--json", ...proj]);
  return [...new Set([...r.stdout.matchAll(/sites\/([a-z0-9-]+)/g)].map((m) => m[1]!))];
}

/**
 * The read-only identity the hosted dashboard runs as: a service account with Cloud Datastore
 * Viewer, so it can read deBug's data and change nothing. Needs gcloud; without it the function
 * runs as the project's default account, and we say so.
 */
async function readOnlyServiceAccount(projectId: string): Promise<string | undefined> {
  const email = `${SA_NAME}@${projectId}.iam.gserviceaccount.com`;
  if (!which("gcloud")) {
    p.log.warn(`gcloud isn't installed, so the dashboard runs as the project's default service account (which can write). Install gcloud and run ${code("npx debugkit deploy-dashboard")} again to lock it to read-only.`);
    return undefined;
  }
  const g = (args: string[]) => capture("gcloud", [...args, "--project", projectId, "--quiet"]);
  if ((await g(["iam", "service-accounts", "describe", email, "--format=value(email)"])).code !== 0) {
    const c = await g(["iam", "service-accounts", "create", SA_NAME, "--display-name", "deBug dashboard (read-only)"]);
    if (c.code !== 0 && !/already exists/i.test(c.stderr)) {
      p.log.warn(`Couldn't create the read-only service account: ${dim(c.stderr.trim().slice(-300))}\nThe dashboard runs as the project's default service account instead.`);
      return undefined;
    }
  }
  const b = await g(["projects", "add-iam-policy-binding", projectId, "--member", `serviceAccount:${email}`, "--role", "roles/datastore.viewer", "--condition=None", "--format=none"]);
  if (b.code !== 0) {
    p.log.warn(`Couldn't give ${email} read access: ${dim(b.stderr.trim().slice(-300))}\nThe dashboard runs as the project's default service account instead.`);
    return undefined;
  }
  return email;
}

/** The function source for the hosted dashboard, next to the ingest function in .debugkit/firebase. */
export function writeDashboardSource(dir: string, opts: { region: string; projectId: string; serviceAccount?: string; dependency: string; plain: Record<string, string>; secret: Record<string, string> }) {
  const src = join(dir, "dashboard");
  mkdirSync(src, { recursive: true });
  writeFileSync(
    join(src, "package.json"),
    JSON.stringify(
      {
        name: "debugkit-dashboard-host",
        private: true,
        type: "module",
        main: "index.js",
        engines: { node: "22" },
        dependencies: { "@debugkit/dashboard": opts.dependency, "firebase-functions": "^7.0.0" },
      },
      null,
      2,
    ) + "\n",
  );
  const options = { region: opts.region, invoker: "public", memory: "512MiB", timeoutSeconds: 60, maxInstances: 5, ...(opts.serviceAccount ? { serviceAccount: opts.serviceAccount } : {}) };
  writeFileSync(
    join(src, "index.js"),
    `// The deBug dashboard, hosted by npx debugkit deploy-dashboard. Firebase Hosting sends every request here.
// It reads Firestore${opts.serviceAccount ? " as a read-only service account" : ""}; settings changes go through the ingest function.
import { onRequest } from "firebase-functions/v2/https";
import { createHandler } from "@debugkit/dashboard/handler";

process.env.NODE_ENV ??= "production";

export const ${DASHBOARD_FUNCTION} = onRequest(${JSON.stringify(options)}, createHandler());
`,
  );
  // Non-secret settings in .env; the login, session secret and tokens in .env.<projectId>,
  // which .debugkit/.gitignore keeps out of git. Firebase deploys both.
  writeFileSync(join(src, ".env"), dotenv(opts.plain));
  writeFileSync(join(src, `.env.${opts.projectId}`), dotenv(opts.secret), { mode: 0o600 });
  writeFirebaseJson(dir, (cur) => ({
    ...cur,
    functions: [...asArray(cur.functions).filter((f) => f.codebase !== DASHBOARD_CODEBASE), { source: "dashboard", codebase: DASHBOARD_CODEBASE, runtime: "nodejs22" }],
  }));
  return src;
}

/** Point a Hosting site at the dashboard function. Other sites in firebase.json are kept. */
export function writeHostingConfig(dir: string, site: string, region: string) {
  writeFirebaseJson(dir, (cur) => ({
    ...cur,
    hosting: [
      ...asArray(cur.hosting).filter((h) => h.site !== site),
      { site, public: "hosting-public", ignore: ["firebase.json", "**/.*"], rewrites: [{ source: "**", function: { functionId: DASHBOARD_FUNCTION, region } }] },
    ],
  }));
}

async function hostFirebase(cwd: string, cfg: DebugkitConfig, local: Record<string, string>, opts: HostOptions) {
  const fbc = cfg.firebase ?? bail("This setup has no Firebase project saved. Run npx debugkit init again.");
  const [fbCmd, fbPre] = await firebaseCli();
  const account = local.DEBUGKIT_FIREBASE_ACCOUNT || fbc.account;
  const acct = account ? ["--account", account] : [];
  const proj = ["--project", fbc.projectId, ...acct];
  const fb = (args: string[], o: { cwd?: string } = {}) => capture(fbCmd, [...fbPre, ...args], o);
  const fbLive = (args: string[], o: { cwd?: string } = {}) => interactive(fbCmd, [...fbPre, ...args], o);
  const dir = paths(cwd).firebase;
  if (!existsSync(join(dir, "firebase.json"))) bail(`${dir} is missing. Run ${code("npx debugkit init")} again to recreate it.`);
  const s = p.spinner();

  /* 1. A Hosting site of its own, so the project's own website is untouched */
  s.start("Finding a Hosting site for the dashboard");
  const sites = await listSites(fb, proj);
  const base = `${fbc.projectId}-debug`.replace(/-+/g, "-").slice(0, 63 - 5);
  let site = cfg.hosted?.site && sites.includes(cfg.hosted.site) ? cfg.hosted.site : sites.find((x) => x === base || x.startsWith(`${base}-`));
  if (!site) {
    for (const candidate of [base, `${base}-${Math.random().toString(36).slice(2, 6)}`, `${base}-${Math.random().toString(36).slice(2, 6)}`]) {
      if (!SITE_ID.test(candidate)) continue;
      const r = await fb(["hosting:sites:create", candidate, "--non-interactive", ...proj]);
      if (r.code === 0) {
        site = candidate;
        break;
      }
      if (!/already|taken|exists|reserved/i.test(r.stderr + r.stdout)) {
        s.error("Couldn't create a Hosting site");
        throw new Error((r.stderr || r.stdout).slice(-600));
      }
    }
  }
  if (!site) {
    s.error("Couldn't find a free Hosting site name");
    return skipOrStop(opts, "Create a site in the Firebase console (Hosting → Add another site).");
  }
  const url = `https://${site}.web.app`;
  s.stop(`Hosting site ${code(site)}: ${url}`);

  /* 2. A read-only identity */
  const serviceAccount = await readOnlyServiceAccount(fbc.projectId);

  /* 3. The function source and the static files */
  let region = cfg.hosted?.region ?? fbc.region;
  const { plain, secret } = hostedEnv(local, url, { DEBUG_COOKIE_NAME: "__session" }); // Hosting forwards only __session
  s.start("Preparing the dashboard function");
  mkdirSync(join(dir, "dashboard"), { recursive: true });
  const dependency = await dashboardDependency(join(dir, "dashboard"));
  const write = () => {
    const src = writeDashboardSource(dir, { region, projectId: fbc.projectId, serviceAccount, dependency, plain, secret });
    writeHostingConfig(dir, site!, region);
    return src;
  };
  const src = write();
  await npmInstall(src);
  const client = join(src, "node_modules", "@debugkit", "dashboard", "dist", "client");
  if (!existsSync(client)) throw new Error("The dashboard package has no built assets (dist/client).");
  rmSync(join(dir, "hosting-public"), { recursive: true, force: true });
  cpSync(client, join(dir, "hosting-public"), { recursive: true });
  s.stop("Prepared the dashboard function");

  p.note(
    [
      `In ${bold(fbc.projectId)}${environment.get() ? ` (your ${environment.get()} environment)` : ""}, deBug will add:`,
      `• a Hosting site ${code(site)} at ${code(url)}`,
      `• a Cloud Function ${code(DASHBOARD_FUNCTION)} in ${region}${serviceAccount ? `, running as ${code(serviceAccount)} (read-only)` : ""}`,
      "",
      "Anyone with the link sees the sign-in page; only people with a login get in.",
      "Your app's own Hosting site and functions are left alone.",
    ].join("\n"),
    "About to host the dashboard",
  );
  if (!(await yes(`Host the dashboard in ${fbc.projectId}?`))) return skipOrStop(opts, "Skipped hosting: the dashboard still runs locally with npx debugkit dashboard.");

  // A newer dashboard can query with indexes an older setup never added. Add deBug's current
  // ones; never with --force, which would delete indexes the project has that aren't in the file.
  writeFileSync(join(dir, "firestore.indexes.json"), JSON.stringify(FIRESTORE_INDEXES, null, 2) + "\n");
  p.log.step("Adding any Firestore indexes this version of deBug needs (existing ones are left alone)");
  if ((await fbLive(["deploy", "--only", "firestore:indexes", "--non-interactive", ...proj], { cwd: dir })) !== 0)
    p.log.warn("The indexes didn't deploy. Some counts on the dashboard may be missing until they do.");

  for (;;) {
    p.log.step(`Deploying the dashboard to ${url}. The first deploy takes a few minutes.`);
    const exit = await fbLive(["deploy", "--only", `functions:${DASHBOARD_CODEBASE},hosting:${site}`, "--force", ...proj], { cwd: dir });
    if (exit === 0) break;
    const choice = await choose(
      "The deploy didn't finish (see the error above). What now?",
      [
        // Hosting can't reach functions in some regions (africa-south1, for one): a plain retry fails the same way.
        ...(region !== "us-central1" ? [{ value: "us", label: "Retry with the function in us-central1", hint: "the usual fix when Hosting can't reach the function's region" }] : []),
        { value: "retry", label: "Retry as it is" },
        { value: "stop", label: opts.optional ? "Skip hosting for now" : "Stop here" },
      ],
      region !== "us-central1" ? "us" : "retry",
    );
    if (choice === "stop") return skipOrStop(opts, "The dashboard isn't hosted yet: fix the error above.");
    if (choice === "us") {
      region = "us-central1";
      write();
    }
  }
  return {
    hosted: { url, region, functionName: DASHBOARD_FUNCTION, site, deployedAt: new Date().toISOString() },
    created: [`Hosted dashboard at ${code(url)} (Hosting site ${code(site)}, function ${code(DASHBOARD_FUNCTION)} in ${region})`],
  };
}

/* ------------------------------------------------------------------ AWS */

const CREATED_BY = "created-by";

/** Every file under a folder, as zip entries. */
function filesUnder(root: string, skip: (rel: string) => boolean): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      const rel = relative(root, full).split("\\").join("/");
      if (skip(rel)) continue;
      if (statSync(full).isDirectory()) walk(full);
      else out[rel] = readFileSync(full);
    }
  };
  walk(root);
  return out;
}

/** The dashboard as a Lambda zip: the package and its dependencies, without the SDKs Lambda already has. */
export async function dashboardZip(): Promise<Uint8Array> {
  const dir = mkdtempSync(join(tmpdir(), "debugkit-dashboard-"));
  try {
    const dependency = await dashboardDependency(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "debugkit-dashboard-lambda", private: true, type: "module", dependencies: { "@debugkit/dashboard": dependency } }));
    // Optional dependencies are firebase-admin and the AWS SDK: not needed (or already in the runtime).
    await npmInstall(dir, ["--omit=optional", "--omit=dev"]);
    writeFileSync(join(dir, "index.mjs"), `export { handler } from "@debugkit/dashboard/lambda";\n`);
    const files = filesUnder(dir, (rel) => rel.endsWith(".tgz") || rel === "package-lock.json" || /(^|\/)(\.bin|\.cache)(\/|$)/.test(rel) || /\.(map|md|d\.ts)$/.test(rel));
    return zipSync(files, { level: 6 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function hostAws(cfg: DebugkitConfig, local: Record<string, string>, opts: HostOptions) {
  const aws = cfg.aws ?? bail("This setup has no AWS details saved. Run npx debugkit init again.");
  if (!aws.readOnlyPolicyArn) bail("The read-only policy for the dashboard is missing. Run npx debugkit init again (it adds it), then npx debugkit deploy-dashboard.");
  const { fromNodeProviderChain } = await import("@aws-sdk/credential-providers");
  const [iamMod, lambdaMod] = await Promise.all([import("@aws-sdk/client-iam"), import("@aws-sdk/client-lambda")]);
  const base = { region: aws.region, credentials: fromNodeProviderChain(aws.profile ? { profile: aws.profile } : {}) };
  const iam = new iamMod.IAMClient(base);
  const lambda = new lambdaMod.LambdaClient(base);
  const functionName = `debugkit-dashboard-${aws.table}`.slice(0, 64);
  const roleName = `debugkit-dashboard-${aws.table}-${aws.region}`.slice(0, 64);
  const account = /arn:aws:iam::(\d+):/.exec(aws.readOnlyPolicyArn)?.[1];

  p.note(
    [
      `In AWS ${account ?? ""} (${aws.region})${environment.get() ? `, your ${environment.get()} environment` : ""}, deBug will add:`,
      `• a Lambda ${code(functionName)} with a public URL, serving the dashboard`,
      `• an IAM role ${code(roleName)} that can only read the ${code(aws.table)} table`,
      "",
      "Anyone with the link sees the sign-in page; only people with a login get in.",
    ].join("\n"),
    "About to host the dashboard",
  );
  if (!(await yes("Host the dashboard in AWS?"))) return skipOrStop(opts, "Skipped hosting: the dashboard still runs locally with npx debugkit dashboard.");

  const s = p.spinner();
  s.start("Packaging the dashboard");
  const zip = await dashboardZip();
  s.message(`Setting up IAM role ${roleName}`);

  /* Role: read the table (the policy init created) and write logs */
  let roleArn: string;
  let newRole = false;
  const role = await lookup(() => iam.send(new iamMod.GetRoleCommand({ RoleName: roleName })));
  if (role) {
    if (!role.Role?.Tags?.some((t) => t.Key === CREATED_BY && t.Value === "debugkit")) bail(`Role ${roleName} exists and wasn't created by deBug. deBug won't change it.`);
    roleArn = role.Role.Arn!;
  } else {
    roleArn = (
      await iam.send(
        new iamMod.CreateRoleCommand({
          RoleName: roleName,
          Description: `deBug dashboard Lambda: reads the DynamoDB table ${aws.table}`,
          AssumeRolePolicyDocument: JSON.stringify({
            Version: "2012-10-17",
            Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole", ...(account ? { Condition: { StringEquals: { "aws:SourceAccount": account } } } : {}) }],
          }),
          Tags: [{ Key: CREATED_BY, Value: "debugkit" }],
        }),
      )
    ).Role!.Arn!;
    newRole = true;
  }
  await iam.send(new iamMod.AttachRolePolicyCommand({ RoleName: roleName, PolicyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole" }));
  await iam.send(new iamMod.AttachRolePolicyCommand({ RoleName: roleName, PolicyArn: aws.readOnlyPolicyArn }));

  /* Function, then its URL (the URL goes into the function's own settings) */
  s.message(`Deploying Lambda ${functionName}`);
  const env = (url: string) => {
    const { plain, secret } = hostedEnv(local, url, { DEBUG_DYNAMO_TABLE: aws.table, NODE_ENV: "production" });
    return { Variables: { ...plain, ...secret } };
  };
  const fn = await lookup(() => lambda.send(new lambdaMod.GetFunctionCommand({ FunctionName: functionName })));
  const fnConfig = { FunctionName: functionName, Role: roleArn, Handler: "index.handler", Runtime: "nodejs22.x" as const, MemorySize: 1024, Timeout: 30 };
  if (fn) {
    if (fn.Tags?.[CREATED_BY] !== "debugkit") bail(`Function ${functionName} exists and wasn't created by deBug. deBug won't overwrite it.`);
    await lambda.send(new lambdaMod.UpdateFunctionCodeCommand({ FunctionName: functionName, ZipFile: zip }));
    await waitUpdated(lambda, lambdaMod, functionName);
  } else {
    for (let attempt = 0; ; attempt++) {
      try {
        await lambda.send(
          new lambdaMod.CreateFunctionCommand({
            ...fnConfig,
            Architectures: ["arm64"],
            Code: { ZipFile: zip },
            Environment: env(cfg.hosted?.url ?? "https://pending"),
            Description: "deBug dashboard (read-only on the deBug table)",
            Tags: { [CREATED_BY]: "debugkit" },
          }),
        );
        break;
      } catch (err) {
        if (attempt < 10 && /cannot be assumed|role defined for the function/i.test((err as Error).message)) {
          s.message(newRole ? "Waiting for the new IAM role to be ready" : "Retrying");
          await new Promise((r) => setTimeout(r, 3000));
        } else throw err;
      }
    }
    await waitUpdated(lambda, lambdaMod, functionName);
  }
  const urlCfg = await lookup(() => lambda.send(new lambdaMod.GetFunctionUrlConfigCommand({ FunctionName: functionName })));
  const fnUrl = urlCfg?.FunctionUrl ?? (await lambda.send(new lambdaMod.CreateFunctionUrlConfigCommand({ FunctionName: functionName, AuthType: "NONE" }))).FunctionUrl;
  if (!fnUrl) throw new Error(`AWS didn't return a URL for ${functionName}.`);
  const url = fnUrl.replace(/\/+$/, "");
  for (const [sid, input] of [
    ["debugkit-public-url", { Action: "lambda:InvokeFunctionUrl", FunctionUrlAuthType: "NONE" }],
    ["debugkit-public-invoke", { Action: "lambda:InvokeFunction", InvokedViaFunctionUrl: true }],
  ] as const) {
    try {
      await lambda.send(new lambdaMod.AddPermissionCommand({ FunctionName: functionName, StatementId: sid, Principal: "*", ...input } as never));
    } catch (err) {
      if ((err as { name?: string }).name !== "ResourceConflictException") p.log.warn(`Couldn't add ${sid}: ${(err as Error).message}`);
    }
  }
  await lambda.send(new lambdaMod.UpdateFunctionConfigurationCommand({ ...fnConfig, Environment: env(url) }));
  await waitUpdated(lambda, lambdaMod, functionName);
  s.stop(`Lambda ${functionName} serves the dashboard`);
  return {
    hosted: { url, region: aws.region, functionName, deployedAt: new Date().toISOString() },
    created: [`Hosted dashboard at ${code(url)} (Lambda ${code(functionName)}, read-only role ${code(roleName)})`],
  };
}

async function waitUpdated(lambda: { send(c: unknown): Promise<any> }, mod: typeof import("@aws-sdk/client-lambda"), name: string) {
  for (let i = 0; i < 60; i++) {
    const c = await lambda.send(new mod.GetFunctionConfigurationCommand({ FunctionName: name }));
    if (c.State !== "Pending" && c.LastUpdateStatus !== "InProgress") return;
    await new Promise((r) => setTimeout(r, 1500));
  }
}
