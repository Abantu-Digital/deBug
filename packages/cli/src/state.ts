import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

export type ProviderId = "firebase" | "aws" | "local";

/** What `npx debugkit init` set up, saved in .debugkit/config.json so later commands can reuse it. */
export interface DebugkitConfig {
  provider: ProviderId;
  appId: string;
  endpoint: string;
  ingestKey: string;
  firebase?: { projectId: string; region: string; account?: string; location: string };
  aws?: { region: string; profile?: string; table: string; functionName: string; roleName: string; readOnlyPolicyArn?: string };
  local?: { port: number };
  /** Port the dashboard runs on. */
  dashboardPort: number;
  createdAt: string;
}

export const DIR = ".debugkit";

export function paths(cwd: string) {
  const dir = join(cwd, DIR);
  return { dir, config: join(dir, "config.json"), dashboardEnv: join(dir, "dashboard.env"), firebase: join(dir, "firebase") };
}

export function readConfig(cwd: string): DebugkitConfig | undefined {
  try {
    return JSON.parse(readFileSync(paths(cwd).config, "utf8")) as DebugkitConfig;
  } catch {
    return undefined;
  }
}

export function writeConfig(cwd: string, cfg: DebugkitConfig) {
  const { dir, config } = paths(cwd);
  mkdirSync(dir, { recursive: true });
  writeFileSync(config, JSON.stringify(cfg, null, 2) + "\n");
  // The dashboard env holds a session secret and a password hash: keep it out of git.
  writeFileSync(join(dir, ".gitignore"), "dashboard.env\nfirebase/functions/node_modules/\nfirebase/.firebase/\n*.log\n");
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
