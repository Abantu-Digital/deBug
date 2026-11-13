import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

export type ProviderId = "firebase" | "aws" | "local";

/** What `npx debugkit init` set up, saved in .debugkit/config.json so later commands can reuse it. */
export interface DebugkitConfig {
  provider: ProviderId;
  appId: string;
  endpoint: string;
  ingestKey: string;
  /** `account` is only in configs from before 0.6.1; it now lives in the dashboard env (DEBUGKIT_FIREBASE_ACCOUNT). */
  firebase?: { projectId: string; region: string; account?: string; location: string };
  aws?: { region: string; profile?: string; table: string; functionName: string; roleName: string; readOnlyPolicyArn?: string; account?: string };
  local?: { port: number };
  /** Port the dashboard runs on. */
  dashboardPort: number;
  createdAt: string;
  /** Raw-event retention chosen at init (the dashboard's Settings page can change it per app). */
  retentionDays?: number;
  /** The hosted dashboard, when init or deploy-dashboard put it online. */
  hosted?: { url: string; region: string; functionName: string; site?: string; deployedAt: string };
  /** Set when this is one of several environments (npx debugkit init --env preview). */
  environment?: string;
}

/** .debugkit/config.json: one setup at the top level, and/or named environments. */
interface ConfigFile extends Partial<DebugkitConfig> {
  environments?: Record<string, DebugkitConfig>;
}

export const DIR = ".debugkit";

/** Lowercase name such as "preview" or "production". */
export const ENV_NAME = /^[a-z][a-z0-9-]{0,30}$/;

/**
 * The environment this run works on (--env), or undefined for a single-environment app. One
 * per process, so every command reads and writes that environment's files.
 */
let current: string | undefined;
export const environment = {
  get: () => current,
  set(name: string | undefined) {
    if (name !== undefined && !ENV_NAME.test(name)) throw new Error(`"${name}" isn't a valid environment name: use lowercase letters, digits and dashes, like preview.`);
    current = name;
  },
};

/** The command with this run's --env, for hints like "npx debugkit dashboard --env preview". */
export const cmdFor = (sub: string) => `npx debugkit ${sub}${current ? ` --env ${current}` : ""}`;

export function paths(cwd: string) {
  const dir = join(cwd, DIR);
  return {
    dir,
    config: join(dir, "config.json"),
    dashboardEnv: join(dir, current ? `dashboard.${current}.env` : "dashboard.env"),
    firebase: join(dir, current ? `firebase-${current}` : "firebase"),
  };
}

function readFile(cwd: string): ConfigFile | undefined {
  try {
    return JSON.parse(readFileSync(paths(cwd).config, "utf8")) as ConfigFile;
  } catch {
    return undefined;
  }
}

export function readConfig(cwd: string): DebugkitConfig | undefined {
  const f = readFile(cwd);
  if (!f) return undefined;
  if (current) return f.environments?.[current];
  return f.provider ? (f as DebugkitConfig) : undefined;
}

/**
 * Which other setup in this app already uses a backend: an environment's name, or "the default
 * setup" for the one made without --env. Each environment needs its own Firebase project or
 * DynamoDB table, so preview data never mixes with production.
 */
export function usedByAnotherEnvironment(cwd: string, uses: (cfg: DebugkitConfig) => boolean): string | undefined {
  const f = readFile(cwd);
  if (!f) return undefined;
  if (current !== undefined && f.provider && uses(f as DebugkitConfig)) return "the default setup";
  for (const [name, cfg] of Object.entries(f.environments ?? {})) if (name !== current && uses(cfg)) return `the ${name} environment`;
  return undefined;
}

/** Another setup in this app already using this Firebase project, if any. */
export const firebaseProjectUsedBy = (cwd: string, projectId: string) =>
  usedByAnotherEnvironment(cwd, (c) => c.provider === "firebase" && c.firebase?.projectId === projectId);

/** Another setup already using this DynamoDB table (same region; same account, or an older config that didn't save one). */
export const dynamoTableUsedBy = (cwd: string, table: string, region: string, account: string) =>
  usedByAnotherEnvironment(cwd, (c) => c.provider === "aws" && c.aws?.table === table && c.aws.region === region && (!c.aws.account || c.aws.account === account));

/** Names of the environments set up so far. */
export function listEnvironments(cwd: string): string[] {
  return Object.keys(readFile(cwd)?.environments ?? {});
}

export function writeConfig(cwd: string, cfg: DebugkitConfig) {
  const { dir, config } = paths(cwd);
  mkdirSync(dir, { recursive: true });
  const f = readFile(cwd) ?? {};
  const out: ConfigFile = current ? { ...f, environments: { ...f.environments, [current]: { ...cfg, environment: current } } } : { ...cfg, ...(f.environments ? { environments: f.environments } : {}) };
  writeFileSync(config, JSON.stringify(out, null, 2) + "\n");
  // Dashboard env files hold a session secret and a password hash: keep them out of git.
  writeFileSync(join(dir, ".gitignore"), "dashboard*.env\nfirebase*/functions/node_modules/\nfirebase*/functions/.env.*\nfirebase*/dashboard/node_modules/\nfirebase*/dashboard/.env.*\nfirebase*/dashboard/*.tgz\nfirebase*/hosting-public/\nfirebase*/.firebase/\n*.log\n");
}

/** Write KEY=value lines, replacing keys that are already there. */
export function upsertEnv(file: string, values: Record<string, string>) {
  const lines = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/) : [];
  const seen = new Set<string>();
  const out = lines.map((line) => {
    const m = /^\s*([A-Z0-9_]+)\s*=/.exec(line);
    if (m && m[1]! in values) {
      seen.add(m[1]!);
      return `${m[1]}=${quote(values[m[1]!]!)}`;
    }
    return line;
  });
  while (out.length && out[out.length - 1] === "") out.pop();
  for (const [k, v] of Object.entries(values)) if (!seen.has(k)) out.push(`${k}=${quote(v)}`);
  writeFileSync(file, out.join("\n") + "\n");
}

const quote = (v: string) => (/[\s#"'=]/.test(v) ? JSON.stringify(v) : v);

export function readEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!.trim();
    if (v.startsWith('"')) {
      try {
        v = JSON.parse(v);
      } catch {}
    }
    out[m[1]!] = v;
  }
  return out;
}

export function ensureGitignored(cwd: string, entry: string) {
  const file = join(cwd, ".gitignore");
  const cur = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (cur.split(/\r?\n/).some((l) => l.trim() === entry)) return false;
  appendFileSync(file, `${cur && !cur.endsWith("\n") ? "\n" : ""}${entry}\n`);
  return true;
}
