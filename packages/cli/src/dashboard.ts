import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, scryptSync } from "node:crypto";
import { existsSync } from "node:fs";
import { connect, createServer } from "node:net";
import { join } from "node:path";
import { capture } from "./exec";
import { paths, readEnv, upsertEnv } from "./state";
import { ask, code, dim, flags, must, p } from "./ui";

export const DASHBOARD_VERSION = "^0.2.0";

/** Hash a dashboard password the same way the dashboard's hash-password script does. */
export function hashPassword(password: string) {
  const salt = randomBytes(16);
  return `scrypt.${salt.toString("hex")}.${scryptSync(password, salt, 64).toString("hex")}`;
}

/** Something already answers on this port, on IPv4 or IPv6 localhost. */
function inUse(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ port, host });
    sock.setTimeout(400);
    sock.once("connect", () => (sock.destroy(), resolve(true)));
    sock.once("timeout", () => (sock.destroy(), resolve(false)));
    sock.once("error", () => resolve(false));
  });
}

export async function freePort(preferred: number): Promise<number> {
  for (let port = preferred; port < preferred + 50; port++) {
    if ((await inUse(port, "127.0.0.1")) || (await inUse(port, "::1"))) continue;
    const ok = await new Promise<boolean>((resolve) => {
      const srv = createServer().once("error", () => resolve(false));
      srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
    });
    if (ok) return port;
  }
  return preferred;
}

/**
 * Write .debugkit/dashboard.env: where to read data from, plus a login. The password is asked
 * for here and only its scrypt hash is stored.
 */
export async function prepareDashboardEnv(cwd: string, storeEnv: Record<string, string>, port: number): Promise<string> {
  const file = paths(cwd).dashboardEnv;
  const cur = readEnv(file);
  const values: Record<string, string> = { ...storeEnv, PORT: String(port) };
  if (!cur.DEBUG_SESSION_SECRET) values.DEBUG_SESSION_SECRET = randomBytes(32).toString("hex");
  // Lets the CLI check the dashboard over its JSON API (and agents too): Authorization: Bearer <token>.
  if (!cur.DEBUG_API_TOKEN) values.DEBUG_API_TOKEN = `dbk_${randomBytes(24).toString("hex")}`;
  if (!cur.DEBUG_DASHBOARD_USERS) {
    p.note("The dashboard is behind a login, even on your own machine. Pick the email and password you'll sign in with.", "Dashboard login");
    const gitEmail = (await capture("git", ["config", "user.email"], { cwd })).stdout.trim();
    const email = await ask("Dashboard email", { initial: gitEmail || undefined, validate: (v) => (/^\S+@\S+\.\S+$/.test(v) ? undefined : "Enter an email address") });
    const password =
      flags.yes && process.env.DEBUGKIT_DASHBOARD_PASSWORD
        ? process.env.DEBUGKIT_DASHBOARD_PASSWORD
        : String(must(await p.password({ message: "Dashboard password (10+ characters)", validate: (v) => ((v ?? "").length >= 10 ? undefined : "At least 10 characters") })));
    values.DEBUG_DASHBOARD_USERS = `${email.toLowerCase()}=${hashPassword(password)}`;
    values.DEBUGKIT_LOGIN_EMAIL = email.toLowerCase();
  }
  upsertEnv(file, values);
  return file;
}

/** How to run the dashboard: a local checkout (for deBug's own development) or the published package. */
function dashboardCommand(): [string, string[]] {
  const dir = process.env.DEBUGKIT_DASHBOARD_DIR;
  if (dir && existsSync(join(dir, "server.mjs"))) return [process.execPath, [join(dir, "server.mjs")]];
  return ["npx", ["-y", `@debugkit/dashboard@${DASHBOARD_VERSION}`]];
}

export interface RunningDashboard {
  url: string;
  child: ChildProcess;
  stop(): void;
}

/** Start the dashboard with the app's settings and wait until it answers. */
export async function startDashboard(cwd: string): Promise<RunningDashboard> {
  const envFile = paths(cwd).dashboardEnv;
  const env = readEnv(envFile);
  const port = Number(env.PORT ?? 4400);
  // 127.0.0.1, not localhost: the dashboard binds there, and localhost can resolve to another server on ::1.
  const url = `http://127.0.0.1:${port}`;
  const [cmd, args] = dashboardCommand();
  const child = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env, DEBUG_ENV_FILE: envFile, NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout?.on("data", (d) => (log += d));
  child.stderr?.on("data", (d) => (log += d));

  const s = p.spinner();
  s.start(cmd === "npx" ? "Starting the dashboard (the first run downloads it)" : "Starting the dashboard");
  const deadline = Date.now() + 180_000;
  for (;;) {
    if (child.exitCode !== null) {
      s.error("The dashboard stopped");
      throw new Error(`The dashboard exited:\n${log.slice(-1500)}`);
    }
    try {
      const r = await fetch(`${url}/login`, { redirect: "manual" });
      // Make sure it's our dashboard answering, not something else that took the port.
      if (r.status < 500 && child.exitCode === null && log.includes("deBug dashboard on")) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      s.error("The dashboard didn't start in time");
      child.kill();
      throw new Error(log.slice(-1500));
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  s.stop(`Dashboard running at ${code(url)}`);
  const stop = () => {
    if (child.exitCode === null) child.kill();
  };
  process.once("exit", stop);
  return { url, child, stop };
}

/** Ask the dashboard what it sees, through the same JSON API agents use. */
export async function summary(cwd: string, url: string, app: string): Promise<{ ok: boolean; status: number; data?: any; error?: string }> {
  const token = readEnv(paths(cwd).dashboardEnv).DEBUG_API_TOKEN;
  try {
    const r = await fetch(`${url}/api/summary?app=${encodeURIComponent(app)}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    const text = await r.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {}
    return { ok: r.ok, status: r.status, data, error: r.ok ? undefined : text.slice(0, 300) };
  } catch (err) {
    return { ok: false, status: 0, error: (err as Error).message };
  }
}

export const loginHint = (cwd: string) => {
  const email = readEnv(paths(cwd).dashboardEnv).DEBUGKIT_LOGIN_EMAIL;
  return email ? `Sign in as ${code(email)} with the password you chose.` : dim("Sign in with the login in .debugkit/dashboard.env.");
};
