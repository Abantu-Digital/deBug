# @debugkit/cli

Set up [deBug](https://github.com/Abantu-Digital/deBug) in your app with one command:

```bash
npx @debugkit/cli init
```

Once `@debugkit/sdk` is installed in the app, the shorter `npx debugkit init` works too: the SDK includes a `debugkit` command that runs this CLI at the same version.

Run it from your app's folder. It walks you through these steps:

1. **Detects your app:** Expo, React Native, Next.js, TanStack Start, React (Vite) or Node. It installs `@debugkit/sdk` if it's missing.
2. **Asks where your data should live:**
   - **Firebase:** a Cloud Function and Firestore.
   - **AWS:** a Lambda with a public URL and DynamoDB.
   - **Just this machine:** no cloud, for a first look.
3. **Signs you in and sets everything up in your own account.**
   - **Firebase:** you sign in with Google in your browser, then pick or create a project. The CLI creates the Firestore database, deploys the indexes and the expiry on raw events, and deploys the ingest function. Cloud Functions need the Blaze plan, so it opens the billing page if you need to upgrade.
   - **AWS:** you use an existing profile or sign in with AWS SSO in your browser, so you don't paste any access keys. The CLI creates the DynamoDB table, a Lambda with a public URL, an IAM role that can only write to the table, and a read-only policy for hosting the dashboard later.
4. **Asks how long to keep raw events:** 30, 60 (default), 90, 180 or 365 days, or any number, with a rough storage cost. Counts, issues and release health are kept forever. You can change it later on the dashboard's Settings page.
5. **Wires up your app.** It writes the endpoint and ingest key to `.env` (or into the code for bare React Native), creates `debug.ts`, and tells you the one or two lines left to add.
6. **Opens your dashboard,** connected to your data and still empty, behind a login you choose.
7. **Walks you through it:**
   - what each part of the dashboard will show;
   - a test event, sent through the real ingest so you watch it arrive;
   - what the SDK records on its own;
   - what you add in your own try/catches.
8. **Offers to host the dashboard** in the same Firebase project or AWS account, at a link you can share with your team. Say no and do it later with `npx debugkit deploy-dashboard`.

## Hosting the dashboard for your team

`npx debugkit deploy-dashboard` puts the dashboard online, next to your data, and prints the link.
It uses the same login as your local dashboard, and you can keep running it locally too.

| | Firebase | AWS |
|---|---|---|
| Address | `https://<project>-debug.web.app`, a Hosting site of its own (your app's site is untouched) | the Lambda's Function URL |
| Runs as | a 2nd-gen Cloud Function `debugkitDashboard`, behind Firebase Hosting | a Lambda `debugkit-dashboard-<table>` |
| Reads data as | a service account `debugkit-dashboard` with Cloud Datastore Viewer only (needs `gcloud`; without it, the project's default account) | an IAM role with the read-only policy `init` created |
| Secrets | `.debugkit/firebase/dashboard/.env.<project>`, gitignored | the Lambda's environment |

- Run it again after upgrading deBug, or after `npx debugkit password`, to update the hosted copy.
- Slack alerts link to the hosted dashboard once it exists.
- Anyone with the link sees the sign-in page; only people with a login get in.
- If Firebase Hosting can't reach a function in your database's region, the CLI offers to retry with the function in `us-central1`.

## Several environments (preview, production…)

When each environment has its own backend, such as separate Firebase projects or AWS accounts, set
deBug up once per environment:

```bash
npx debugkit init --env preview      # e.g. into your staging Firebase project
npx debugkit init --env production   # into the production one
```

Each environment gets its own provider, project, endpoint, ingest key and dashboard login. They're
saved under `environments` in `.debugkit/config.json`, with `.debugkit/dashboard.<env>.env`.

- **Expo apps with EAS:** for `development`, `preview` and `production`, the CLI offers to put
  `EXPO_PUBLIC_DEBUG_ENDPOINT`, `EXPO_PUBLIC_DEBUG_KEY` and `EXPO_PUBLIC_DEBUG_ENVIRONMENT` into
  that EAS environment (`eas env:set`). `eas build` and `eas env:pull` then pick them up.
- **Other apps:** it prints the three values to set wherever that environment's builds get their
  config. With `--env` it never writes `.env`, which would point every build at one environment.
- **`debug.ts` is the same for every environment:** it's on in release builds that have an
  endpoint, and off in development builds and local runs (`enabled: !__DEV__ && !!endpoint`). To
  leave an environment out, such as development, don't set it up.
- **Later commands take `--env` too:** `npx debugkit dashboard --env production`, `test`, `guide`
  and `password`.

## Commands

Every command below also works as `npx @debugkit/cli <command>`.

| Command | What it does |
|---|---|
| `npx debugkit init` | The full setup above |
| `npx debugkit dashboard` | Runs the dashboard on this machine against your data. On "just this machine", it also receives your app's events |
| `npx debugkit deploy-dashboard` | Hosts the dashboard in your Firebase project or AWS account, at a link to share |
| `npx debugkit test` | Sends test events and checks they're accepted |
| `npx debugkit guide` | Replays the walkthrough |

Options: `--provider firebase|aws|local` skips the provider question, `--cwd <dir>` points at another folder, and `--yes` accepts the defaults (for scripts; set `DEBUGKIT_DASHBOARD_PASSWORD`).

## What's been verified

| Path | Status |
|---|---|
| Just this machine | Run end to end: the empty dashboard, then test events arriving |
| Firebase | Run end to end against a real project: function deployed, indexes added without touching existing ones, test events read back on the dashboard |
| Hosting the dashboard | The handler and the Lambda package run locally, sign-in included. Not yet deployed to a real project |
| AWS | Unit-tested (profile parsing, the "not found" handling, key merging) and the bundled Lambda run locally. Not yet run against a real account |
| Environments (`--env`) | Run end to end with "just this machine" in an Expo-style app: separate config and login, `.env` untouched, `debug.ts` with the on/off switch. `eas env:set` is checked against EAS's help but not yet run against a real EAS project |
| Platforms | Vite and React run for real. The Expo, React Native, Next.js, TanStack Start and Node templates are unit-tested |

## What it needs

- Node 20.12 or later.
- **Firebase:**
  - the Firebase CLI, which is used automatically through `npx firebase-tools` if it isn't installed;
  - `gcloud`, so the dashboard can read Firestore with your Google credentials. Without it, you create a read-only service account yourself.
- **AWS:** an AWS profile, or the AWS CLI for SSO sign-in.

## What it writes in your repo

| Path | What it is | Commit it? |
|---|---|---|
| `.debugkit/config.json` | provider, endpoint, ingest key, resource names | yes |
| `.debugkit/firebase/` | the ingest function source (Firebase), so you can redeploy it | yes |
| `.debugkit/firebase/dashboard/` | the hosted dashboard's function source (Firebase). Its `.env.<project>` holds secrets and is gitignored | yes, except `.env.*` |
| `.debugkit/dashboard.env` | the dashboard login (a password hash), session secret, API token | no, it's gitignored |
| `debug.ts` (or `src/debug.ts`) | `init()` for your platform | yes |
| `.env` | the endpoint and ingest key | added to `.gitignore` |

The ingest key is public and write-only, the same kind of key that ships inside your app. Your cloud credentials stay with the Firebase, gcloud and AWS tools on your machine. deBug never receives them.
