import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { TeamMember, TeamRole } from "@debugkit/adapters";
import { deleteCookie, getCookie, getRequestHeader, setCookie } from "@tanstack/react-start/server";
import { config } from "./config";
import { getStore } from "./store";

const cookie = () => config().cookieName;
const MAX_AGE_S = 60 * 60 * 12; // 12h
/** How long a member's record is trusted before it's read again (removals apply within this). */
const MEMBER_CACHE_MS = 10_000;

export const DEMO_USER = { email: "demo@debug.local", password: "demo-debug" };

export interface SessionUser {
  email: string;
  role: TeamRole;
  name?: string;
  /** "env": the bootstrap login in the dashboard's settings. "team": invited, stored in the database. */
  source: "env" | "team";
}

function envUsers(): Map<string, string> {
  const cfg = config();
  const map = new Map<string, string>();
  for (const pair of cfg.users.split(",").map((s) => s.trim()).filter(Boolean)) {
    const i = pair.indexOf("=");
    if (i > 0) map.set(pair.slice(0, i).toLowerCase(), pair.slice(i + 1));
  }
  return map;
}

/** Emails of the bootstrap logins (always owners). */
export const envOwnerEmails = () => (demoLoginEnabled() ? [DEMO_USER.email] : [...envUsers().keys()]);

export function demoLoginEnabled() {
  return config().store === "demo" && envUsers().size === 0;
}

/** scrypt.<salt>.<hash>, the same format as scripts/hash-password.mjs and the CLI. */
export function hashPassword(password: string) {
  const salt = randomBytes(16);
  return `scrypt.${salt.toString("hex")}.${scryptSync(password, salt, 64).toString("hex")}`;
}

const DUMMY = "scrypt.00000000000000000000000000000000." + "00".repeat(64);
function verifyHash(password: string, stored: string): boolean {
  const [algo, saltHex, hashHex] = stored.split(".");
  if (algo !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(actual, expected);
}

/* Members, briefly cached so each request doesn't read the database. */
const members = new Map<string, { m: TeamMember | null; at: number }>();
export function forgetMember(email?: string) {
  if (email) members.delete(email);
  else members.clear();
}
async function member(email: string): Promise<TeamMember | null> {
  const hit = members.get(email);
  if (hit && Date.now() - hit.at < MEMBER_CACHE_MS) return hit.m;
  const store = await getStore();
  const m = typeof store.getMember === "function" ? await store.getMember(email).catch(() => null) : null;
  members.set(email, { m, at: Date.now() });
  return m;
}

/* Failed sign-ins: at most 10 per email in 15 minutes (per server instance). */
const failures = new Map<string, number[]>();
const WINDOW_MS = 15 * 60_000;
export function tooManyAttempts(email: string) {
  const now = Date.now();
  const recent = (failures.get(email) ?? []).filter((t) => now - t < WINDOW_MS);
  failures.set(email, recent);
  return recent.length >= 10;
}
export function recordFailure(email: string) {
  failures.set(email, [...(failures.get(email) ?? []), Date.now()]);
}

export interface Credentials extends SessionUser {
  v?: number;
}

export async function checkCredentials(email: string, password: string): Promise<Credentials | null> {
  const e = email.trim().toLowerCase();
  if (demoLoginEnabled() && e === DEMO_USER.email) return password === DEMO_USER.password ? { email: e, role: "owner", source: "env" } : null;
  const env = envUsers().get(e);
  if (env) return verifyHash(password, env) ? { email: e, role: "owner", source: "env" } : null;
  forgetMember(e);
  const m = await member(e);
  // Always run a hash so response time doesn't reveal which emails exist.
  const ok = verifyHash(password, m && !m.removedAt ? m.passwordHash : DUMMY);
  return m && !m.removedAt && ok ? { email: e, role: m.role, name: m.name, source: "team", v: m.sessionVersion } : null;
}

const sign = (payload: string) => createHmac("sha256", config().sessionSecret).update(payload).digest("base64url");

export function startSession(user: Credentials) {
  const payload = Buffer.from(JSON.stringify({ email: user.email, exp: Date.now() + MAX_AGE_S * 1000, s: user.source, v: user.v })).toString("base64url");
  setCookie(cookie(), `${payload}.${sign(payload)}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: config().secureCookies,
    path: "/",
    maxAge: MAX_AGE_S,
  });
}

export function endSession() {
  deleteCookie(cookie(), { path: "/" });
}

export async function readSession(): Promise<SessionUser | null> {
  const raw = getCookie(cookie());
  if (!raw) return null;
  const [payload, sig] = raw.split(".");
  if (!payload || !sig) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  let data: { email: string; exp: number; s?: "env" | "team"; v?: number };
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString());
  } catch {
    return null;
  }
  if (Date.now() > data.exp) return null;
  if (data.s === "team") {
    // Removed (or re-invited) members carry a newer version: their old sessions stop here.
    const m = await member(data.email);
    if (!m || m.removedAt || m.sessionVersion !== data.v) return null;
    return { email: m.email, role: m.role, name: m.name, source: "team" };
  }
  // The bootstrap login: still valid only while it's still configured.
  if (demoLoginEnabled() ? data.email !== DEMO_USER.email : !envUsers().has(data.email)) return null;
  return { email: data.email, role: "owner", source: "env" };
}

export const canManage = (u: SessionUser | null) => u?.role === "owner" || u?.role === "admin";

/** For /api/* routes: a browser session or `Authorization: Bearer $DEBUG_API_TOKEN`. */
export async function authorizeApi(request: Request): Promise<boolean> {
  if (await readSession()) return true;
  const token = config().apiToken;
  const header = request.headers.get("authorization") ?? getRequestHeader("authorization") ?? "";
  if (!token || !header.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
