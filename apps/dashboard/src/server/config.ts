import { randomBytes } from "node:crypto";
import { DEFAULT_SEVERITY_THRESHOLDS, type SeverityThresholds } from "@debugkit/schema";

let loaded = false;
function loadEnv() {
  if (loaded) return;
  loaded = true;
  try {
    // DEBUG_ENV_FILE lets `npx debugkit dashboard` point at the app's own settings.
    process.loadEnvFile?.(process.env.DEBUG_ENV_FILE ?? ".env");
  } catch {
    /* no .env file is fine */
  }
}

/** demo = sample data; memory = empty, in-process (local trial); firestore / dynamodb = your cloud. */
export type StoreKind = "demo" | "memory" | "firestore" | "dynamodb";

let generatedSecret: string | undefined;

export function config() {
  loadEnv();
  const env = process.env;
  const store = (env.DEBUG_STORE ?? "demo") as StoreKind;
  let secret = env.DEBUG_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    if (store !== "demo" && store !== "memory") throw new Error("DEBUG_SESSION_SECRET must be set (≥32 chars) when not in demo mode. Try: openssl rand -hex 32");
    secret = generatedSecret ??= randomBytes(32).toString("hex");
  }
  const num = (v: string | undefined, d: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : d);
  const severity: SeverityThresholds = {
    critical: num(env.DEBUG_SEVERITY_CRITICAL, DEFAULT_SEVERITY_THRESHOLDS.critical),
    high: num(env.DEBUG_SEVERITY_HIGH, DEFAULT_SEVERITY_THRESHOLDS.high),
    medium: num(env.DEBUG_SEVERITY_MEDIUM, DEFAULT_SEVERITY_THRESHOLDS.medium),
  };
  return {
    store,
    sessionSecret: secret,
    users: env.DEBUG_DASHBOARD_USERS ?? "",
    apiToken: env.DEBUG_API_TOKEN,
    /** Demo mode: keys accepted by POST /api/ingest. "*" = any app. */
    localIngestKeys: env.DEBUG_LOCAL_INGEST_KEYS ?? "pk_local:*",
    firestoreRoot: env.DEBUG_FIRESTORE_ROOT ?? "debug_apps",
    dynamoTable: env.DEBUG_DYNAMO_TABLE ?? "debug",
    severity,
    /** The ingest function's admin routes (…/admin) and their token, for changing settings. */
    adminUrl: env.DEBUG_ADMIN_URL?.replace(/\/+$/, ""),
    adminToken: env.DEBUG_ADMIN_TOKEN,
    /** The deployment's default retention (what ingest uses before an app has a setting). */
    retentionDays: num(env.DEBUG_RETENTION_DAYS, 0) || undefined,
    secureCookies: env.NODE_ENV === "production" && env.DEBUG_INSECURE_COOKIES !== "1",
  };
}
