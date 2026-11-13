import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { capture, interactive, openUrl, which } from "../exec";
import { paths } from "../state";
import { ask, bail, choose, code, dim, next, p, yes } from "../ui";
import type { ProviderResult, SetupContext } from "./types";

/** Firestore locations offered, with the Cloud Functions region that sits closest to each. */
const LOCATIONS: { value: string; label: string; region: string }[] = [
  { value: "africa-south1", label: "Johannesburg (africa-south1)", region: "africa-south1" },
  { value: "eur3", label: "Europe, multi-region (eur3)", region: "europe-west1" },
  { value: "europe-west1", label: "Belgium (europe-west1)", region: "europe-west1" },
  { value: "nam5", label: "United States, multi-region (nam5)", region: "us-central1" },
  { value: "us-central1", label: "Iowa (us-central1)", region: "us-central1" },
  { value: "asia-southeast1", label: "Singapore (asia-southeast1)", region: "asia-southeast1" },
];

const FUNCTION_NAME = "debugIngest";
const CODEBASE = "debugkit";

/** The Firebase CLI: the installed one if it's recent enough, otherwise the latest via npx. */
async function firebaseCli(): Promise<[string, string[]]> {
  if (which("firebase")) {
    const v = await capture("firebase", ["--version"]);
    const major = Number(/^(\d+)/.exec(v.stdout.trim())?.[1] ?? 0);
    if (major >= 13) return ["firebase", []];
  }
  return ["npx", ["-y", "firebase-tools@latest"]];
}

const emailsIn = (text: string) => [...new Set(text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? [])];

export async function setupFirebase(ctx: SetupContext): Promise<ProviderResult> {
  const [fbCmd, fbPre] = await firebaseCli();
  const fb = (args: string[], opts: { cwd?: string } = {}) => capture(fbCmd, [...fbPre, ...args], opts);
  const fbLive = (args: string[], opts: { cwd?: string } = {}) => interactive(fbCmd, [...fbPre, ...args], opts);

  /* ---------- 1. Sign in ---------- */
  p.note(
    [
      "deBug deploys a small ingest function and a Firestore database into your own Firebase project.",
      "Firebase will ask you to sign in with Google and allow the Firebase CLI to manage your projects.",
      "That access stays on this machine. deBug doesn't receive it.",
    ].join("\n"),
    "Sign in to Firebase",
  );
  let accounts = emailsIn((await fb(["login:list"])).stdout);
  let account: string;
  if (!accounts.length) {
    await next("Open the Google sign-in page");
    if ((await fbLive(["login"])) !== 0) bail("Firebase sign-in didn't finish. Run npx debugkit init to try again.");
    accounts = emailsIn((await fb(["login:list"])).stdout);
  }
  const ADD = "__add__";
  const picked = await choose(
    "Which Google account should own the deBug resources?",
    [...accounts.map((a) => ({ value: a, label: a })), { value: ADD, label: "Sign in with another account" }],
    accounts[0],
  );
  if (picked === ADD) {
    if ((await fbLive(["login:add"])) !== 0) bail("Firebase sign-in didn't finish.");
    const now = emailsIn((await fb(["login:list"])).stdout);
    account = now.find((a) => !accounts.includes(a)) ?? now[0] ?? bail("No Firebase account is signed in.");
  } else account = picked;
  const acct = ["--account", account];

  /* ---------- 2. Project ---------- */
  const s = p.spinner();
  s.start("Loading your Firebase projects");
  const list = await fb(["projects:list", "--json", ...acct]);
  s.stop("Loaded your Firebase projects");
  let projects: { projectId: string; displayName?: string }[] = [];
  try {
    projects = (JSON.parse(list.stdout).result ?? []) as typeof projects;
  } catch {
    p.log.warn(`Couldn't read the project list: ${dim(list.stderr.slice(-300))}`);
  }
  const NEW = "__new__";
  let projectId = await choose(
    "Which Firebase project should deBug use?",
    [
      { value: NEW, label: "Create a new project", hint: "recommended: keeps deBug's data and bill separate" },
      ...projects.map((x) => ({ value: x.projectId, label: x.displayName ? `${x.displayName}` : x.projectId, hint: x.projectId })),
    ],
    NEW,
  );
  if (projectId === NEW) {
    const suggested = `${ctx.app.appId}-debug`.slice(0, 26).replace(/-+$/, "") + `-${Math.random().toString(36).slice(2, 6)}`;
    projectId = await ask("Project id (lowercase, globally unique)", {
      initial: suggested,
      validate: (v) => (/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(v) ? undefined : "6–30 characters: lowercase letters, digits and dashes"),
    });
    if ((await fbLive(["projects:create", projectId, "--display-name", `${ctx.app.name} deBug`.slice(0, 30), ...acct])) !== 0)
      bail(`Couldn't create ${projectId}. Pick an existing project or another id.`);
  }
  const proj = ["--project", projectId, ...acct];

  /* ---------- 3. Billing (Cloud Functions needs the Blaze plan) ---------- */
  p.note(
    [
      "Cloud Functions only run on Firebase's pay-as-you-go plan (Blaze).",
      "deBug's ingest typically stays inside the free monthly allowance, but Google requires a billing account.",
      `If ${projectId} is already on Blaze, skip this.`,
    ].join("\n"),
    "Billing",
  );
  if (await yes(`Open the billing page for ${projectId} to check or upgrade?`, true)) {
    openUrl(`https://console.firebase.google.com/project/${projectId}/usage/details`);
    await next("I've checked: it's on Blaze");
  }

  /* ---------- 4. Firestore ---------- */
  const dbs = await fb(["firestore:databases:list", "--json", ...proj]);
  let location: string;
  if (/\(default\)/.test(dbs.stdout)) {
    p.log.info(`Using the existing Firestore database in ${projectId}`);
    const loc = /"locationId"\s*:\s*"([^"]+)"/.exec(dbs.stdout)?.[1];
    location = loc ?? "nam5";
  } else {
    location = await choose("Where should the Firestore database live? This can't be changed later.", LOCATIONS.map(({ value, label }) => ({ value, label })), "africa-south1");
    s.start(`Creating the Firestore database in ${location}`);
    const r = await fb(["firestore:databases:create", "(default)", "--location", location, ...proj]);
    if (r.code !== 0 && !/already exists/i.test(r.stderr + r.stdout)) {
      s.error("Couldn't create the database");
      p.log.error((r.stderr || r.stdout).slice(-600));
      bail("Fix the error above (often: the Firestore API needs enabling, or billing), then run npx debugkit init again.");
    }
    s.stop(`Created the Firestore database (${location})`);
  }
  const region = LOCATIONS.find((l) => l.value === location)?.region ?? (/^[a-z]+-[a-z]+\d$/.test(location) ? location : "us-central1");

  /* ---------- 5. The ingest function ---------- */
  const dir = writeFunctionSource(ctx, region);
  s.start("Installing the ingest function's dependencies");
  const inst = await capture("npm", ["install", "--no-audit", "--no-fund"], { cwd: join(dir, "functions") });
  if (inst.code !== 0) {
    s.error("npm install failed");
    p.log.error(inst.stderr.slice(-600));
    bail();
  }
  s.stop("Installed the ingest function's dependencies");

  p.log.step(`Deploying ${code(FUNCTION_NAME)} and the Firestore indexes. The first deploy turns on the Google APIs it needs and takes a few minutes.`);
  for (;;) {
    const exit = await fbLive(["deploy", "--only", `functions:${CODEBASE},firestore:indexes`, "--force", ...proj], { cwd: dir });
    if (exit === 0) break;
    p.log.warn("The deploy didn't finish. The most common cause is that the project isn't on the Blaze plan yet.");
    const again = await choose(
      "What now?",
      [
        { value: "billing", label: "Open billing, then retry" },
        { value: "retry", label: "Retry the deploy" },
        { value: "stop", label: "Stop here" },
      ],
      "billing",
    );
    if (again === "stop") bail(`Fix the error above, then deploy with: cd ${paths(ctx.app.cwd).firebase} && firebase deploy --only functions:${CODEBASE},firestore:indexes --project ${projectId}`);
    if (again === "billing") {
      openUrl(`https://console.firebase.google.com/project/${projectId}/usage/details`);
      await next("Upgraded: retry the deploy");
    }
  }
  const endpoint = `https://${region}-${projectId}.cloudfunctions.net/${FUNCTION_NAME}`;

  /* ---------- 6. Read access for the dashboard ---------- */
  await ensureDashboardAccess(projectId);

  return {
    config: { provider: "firebase", endpoint, ingestKey: ctx.ingestKey, firebase: { projectId, region, account, location } },
    dashboardEnv: { DEBUG_STORE: "firestore", GOOGLE_CLOUD_PROJECT: projectId, GCLOUD_PROJECT: projectId },
    created: [
      `Firestore database in ${code(projectId)} (${location}), with indexes and 30-day expiry on raw events`,
      `Cloud Function ${code(FUNCTION_NAME)} in ${region}: ${code(endpoint)}`,
      `Function source in ${code(".debugkit/firebase")}, so you can redeploy it with the Firebase CLI`,
    ],
  };
}

/** The dashboard reads Firestore with Google Application Default Credentials from gcloud. */
async function ensureDashboardAccess(projectId: string) {
  if (!which("gcloud")) {
    p.log.warn(
      [
        "The dashboard reads Firestore with Google Cloud credentials, and gcloud isn't installed.",
        `Install it (${code("https://cloud.google.com/sdk/docs/install")}), then run ${code("gcloud auth application-default login")}.`,
        "Or create a read-only service account (role: Cloud Datastore Viewer) and set GOOGLE_APPLICATION_CREDENTIALS in .debugkit/dashboard.env.",
      ].join("\n"),
    );
    return;
  }
  const t = await capture("gcloud", ["auth", "application-default", "print-access-token"]);
  if (t.code === 0) {
    p.log.success("The dashboard will read Firestore with your Google Cloud credentials");
    return;
  }
  p.note("One more Google sign-in: this one lets the dashboard on this machine read deBug's data.", "Dashboard access");
  await next("Open the Google sign-in page");
  const exit = await interactive("gcloud", ["auth", "application-default", "login", "--quiet"]);
  if (exit !== 0) p.log.warn("Google Cloud sign-in didn't finish. The dashboard won't be able to read Firestore until you run: gcloud auth application-default login");
  else await capture("gcloud", ["auth", "application-default", "set-quota-project", projectId]);
}

/** The Cloud Function the setup deploys, written to .debugkit/firebase in the app's repo. */
export function writeFunctionSource(ctx: SetupContext, region: string): string {
  const dir = paths(ctx.app.cwd).firebase;
  mkdirSync(join(dir, "functions"), { recursive: true });
  writeFileSync(
    join(dir, "firebase.json"),
    JSON.stringify(
      {
        functions: [{ source: "functions", codebase: CODEBASE, runtime: "nodejs22" }],
        firestore: { database: "(default)", indexes: "firestore.indexes.json" },
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(join(dir, "firestore.indexes.json"), JSON.stringify(FIRESTORE_INDEXES, null, 2) + "\n");
  writeFileSync(
    join(dir, "functions", "package.json"),
    JSON.stringify(
      {
        name: "debugkit-ingest",
        private: true,
        type: "module",
        main: "index.js",
        engines: { node: "22" },
        dependencies: {
          "@debugkit/adapters": "^0.2.0",
          "@debugkit/ingest": "^0.2.0",
          "firebase-admin": "^13.0.0",
          "firebase-functions": "^7.0.0",
        },
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    join(dir, "functions", "index.js"),
    `// deBug ingest, deployed by npx debugkit init. Receives events from the SDK and writes them to Firestore.
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { onRequest } from "firebase-functions/v2/https";
import { FirestoreStore } from "@debugkit/adapters/firestore";
import { parseIngestKeys } from "@debugkit/ingest";
import { firebaseHandler } from "@debugkit/ingest/firebase";

initializeApp();

export const ${FUNCTION_NAME} = onRequest(
  { region: ${JSON.stringify(region)}, invoker: "public", memory: "256MiB", maxInstances: 10 },
  firebaseHandler({ store: new FirestoreStore(getFirestore()), keys: parseIngestKeys(process.env.DEBUG_INGEST_KEYS) }),
);
`,
  );
  // Ingest keys are public (they ship in the app), so a .env file in the source is fine.
  writeFileSync(join(dir, "functions", ".env"), `DEBUG_INGEST_KEYS=${ctx.ingestKey}:${ctx.app.appId}\n`);
  return dir;
}

/** Same as packages/adapters/firestore.indexes.json: rollup and event queries, plus TTL on raw events. */
const FIRESTORE_INDEXES = {
  indexes: [
    {
      collectionGroup: "rollups",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "dimension", order: "ASCENDING" },
        { fieldPath: "day", order: "ASCENDING" },
      ],
    },
    {
      collectionGroup: "events",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "fingerprint", order: "ASCENDING" },
        { fieldPath: "ts", order: "DESCENDING" },
      ],
    },
  ],
  fieldOverrides: [{ collectionGroup: "events", fieldPath: "expireAt", ttl: true, indexes: [] }],
};
