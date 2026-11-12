import { randomBytes } from "node:crypto";
import { DEFAULT_SEVERITY_THRESHOLDS, type SeverityThresholds } from "@debugkit/schema";

let loaded = false;
function loadEnv() {
  if (loaded) return;
  loaded = true;
  try {
    process.loadEnvFile?.(".env");
  } catch {
    /* no .env file is fine */
  }
}

export type StoreKind = "demo" | "firestore" | "dynamodb";

let generatedSecret: string | undefined;

export function config() {
  loadEnv();
  const env = process.env;
  const store = (env.DEBUG_STORE ?? "demo") as StoreKind;
  let secret = env.DEBUG_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    if (store !== "demo") throw new Error("DEBUG_SESSION_SECRET must be set (≥32 chars) when not in demo mode. Try: openssl rand -hex 32");
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
    secureCookies: env.NODE_ENV === "production" && env.DEBUG_INSECURE_COOKIES !== "1",
  };
}
