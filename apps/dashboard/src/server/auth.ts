import { createHmac, scryptSync, timingSafeEqual } from "node:crypto";
import { deleteCookie, getCookie, getRequestHeader, setCookie } from "@tanstack/react-start/server";
import { config } from "./config";

const cookie = () => config().cookieName;
const MAX_AGE_S = 60 * 60 * 12; // 12h

export const DEMO_USER = { email: "demo@debug.local", password: "demo-debug" };

export interface SessionUser {
  email: string;
}

function users(): Map<string, string> {
  const cfg = config();
  const map = new Map<string, string>();
  for (const pair of cfg.users.split(",").map((s) => s.trim()).filter(Boolean)) {
    const i = pair.indexOf("=");
    if (i > 0) map.set(pair.slice(0, i).toLowerCase(), pair.slice(i + 1));
  }
  return map;
}

export function demoLoginEnabled() {
  return config().store === "demo" && users().size === 0;
}

function verifyHash(password: string, stored: string): boolean {
  const [algo, saltHex, hashHex] = stored.split(".");
  if (algo !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(actual, expected);
}

export function checkCredentials(email: string, password: string): SessionUser | null {
  const e = email.trim().toLowerCase();
  if (demoLoginEnabled()) return e === DEMO_USER.email && password === DEMO_USER.password ? { email: e } : null;
  const stored = users().get(e);
  // Always run a hash so response time doesn't reveal which emails exist.
  const ok = verifyHash(password, stored ?? "scrypt.00000000000000000000000000000000." + "00".repeat(64));
  return stored && ok ? { email: e } : null;
}

const sign = (payload: string) => createHmac("sha256", config().sessionSecret).update(payload).digest("base64url");

export function startSession(user: SessionUser) {
  const payload = Buffer.from(JSON.stringify({ email: user.email, exp: Date.now() + MAX_AGE_S * 1000 })).toString("base64url");
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

export function readSession(): SessionUser | null {
  const raw = getCookie(cookie());
  if (!raw) return null;
  const [payload, sig] = raw.split(".");
  if (!payload || !sig) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as { email: string; exp: number };
    if (Date.now() > data.exp) return null;
    return { email: data.email };
  } catch {
    return null;
  }
}

/** For /api/* routes: a browser session or `Authorization: Bearer $DEBUG_API_TOKEN`. */
export function authorizeApi(request: Request): boolean {
  if (readSession()) return true;
  const token = config().apiToken;
  const header = request.headers.get("authorization") ?? getRequestHeader("authorization") ?? "";
  if (!token || !header.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
