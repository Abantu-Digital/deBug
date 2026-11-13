import type { TeamInvite, TeamMember, TeamRole, WriteStore } from "@debugkit/adapters";
import { teamAction, type TeamResult } from "@debugkit/ingest";
import { envOwnerEmails, forgetMember, hashPassword, type SessionUser } from "./auth";
import { config } from "./config";
import { settingsWriter } from "./settings";
import { getLocalWriteStore, getStore } from "./store";

/**
 * The team: the bootstrap owner(s) from the dashboard's settings, plus people invited by link
 * and stored in your database. Changes go through the ingest function's admin routes (or, in
 * demo and memory mode, straight to the in-process store), like settings.
 */

export interface TeamView {
  members: { email: string; name?: string; role: TeamRole; source: "env" | "team"; createdAt?: string; invitedBy?: string }[];
  invites: { id: string; role: TeamRole; email?: string; invitedBy: string; createdAt: string; expiresAt: string }[];
  canWrite: boolean;
  note?: string;
}

async function run(action: string, body: Record<string, unknown>): Promise<TeamResult["body"]> {
  const writer = settingsWriter();
  let out: TeamResult;
  if (writer === "local") out = await teamAction((await getLocalWriteStore()) as WriteStore, action, body);
  else if (writer === "admin") {
    const c = config();
    const res = await fetch(`${c.adminUrl}/team/${action}`, {
      method: "POST",
      headers: { authorization: `Bearer ${c.adminToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    out = { status: res.status, body: (await res.json().catch(() => ({ error: `The ingest function answered ${res.status}` }))) as Record<string, unknown> };
    if (res.status === 404 && out.body.error === "not found") throw new Error("Your ingest function is older than this dashboard. Redeploy it (npx debugkit init) to manage the team.");
  } else throw new Error("The team can't be changed from this dashboard: DEBUG_ADMIN_URL and DEBUG_ADMIN_TOKEN aren't set.");
  if (out.status >= 400) throw new Error(String(out.body.error ?? "That didn't work."));
  if (typeof body.email === "string") forgetMember(body.email.toLowerCase());
  return out.body;
}

const pending = (i: TeamInvite, now = Date.now()) => !i.usedAt && !i.revokedAt && Date.parse(i.expiresAt) > now;

async function teamMembers(): Promise<TeamMember[]> {
  const store = await getStore();
  return typeof store.listMembers === "function" ? store.listMembers() : [];
}

export async function readTeam(): Promise<TeamView> {
  const store = await getStore();
  const env = new Set(envOwnerEmails());
  const [members, invites] = await Promise.all([teamMembers(), typeof store.listInvites === "function" ? store.listInvites() : Promise.resolve([])]);
  const writer = settingsWriter();
  return {
    members: [
      ...[...env].map((email) => ({ email, role: "owner" as const, source: "env" as const })),
      ...members.filter((m) => !m.removedAt && !env.has(m.email)).map((m) => ({ email: m.email, name: m.name, role: m.role, source: "team" as const, createdAt: m.createdAt, invitedBy: m.invitedBy })),
    ],
    invites: invites.filter((i) => pending(i)).map(({ id, role, email, invitedBy, createdAt, expiresAt }) => ({ id, role, email, invitedBy, createdAt, expiresAt })),
    canWrite: writer !== "none",
    note: writer === "none" ? "Inviting people needs DEBUG_ADMIN_URL and DEBUG_ADMIN_TOKEN (npx debugkit init sets them)." : undefined,
  };
}

/** Owners can do anything; admins can't create, change or remove owners. */
function allowed(actor: SessionUser, targetRole: TeamRole | undefined, newRole?: TeamRole) {
  if (actor.role === "owner") return;
  if (actor.role !== "admin") throw new Error("Only owners and admins can manage the team.");
  if (targetRole === "owner" || newRole === "owner") throw new Error("Only an owner can add, change or remove owners.");
}

/** At least one owner must remain who can sign in. */
async function keepsAnOwner(email: string) {
  if (envOwnerEmails().length) return;
  const owners = (await teamMembers()).filter((m) => !m.removedAt && m.role === "owner" && m.email !== email);
  if (!owners.length) throw new Error("This is the last owner. Make someone else an owner first.");
}

export async function createInvite(actor: SessionUser, role: TeamRole, email?: string) {
  allowed(actor, undefined, role);
  if (email && envOwnerEmails().includes(email.toLowerCase())) throw new Error(`${email} already has access.`);
  const out = await run("invite", { role, email, invitedBy: actor.email });
  return { token: String(out.token), expiresAt: String((out.invite as TeamInvite).expiresAt) };
}

export async function revokeInvite(actor: SessionUser, id: string) {
  const i = (await (await getStore()).listInvites()).find((x) => x.id === id);
  allowed(actor, i?.role);
  await run("revoke", { id });
}

async function target(email: string) {
  const m = (await teamMembers()).find((x) => x.email === email && !x.removedAt);
  if (!m) throw new Error(envOwnerEmails().includes(email) ? "This login is set in the dashboard's settings (DEBUG_DASHBOARD_USERS); change it there." : "No such member.");
  return m;
}

export async function changeRole(actor: SessionUser, email: string, role: TeamRole) {
  const m = await target(email);
  allowed(actor, m.role, role);
  if (m.role === "owner" && role !== "owner") await keepsAnOwner(email);
  await run("role", { email, role });
}

export async function removeMember(actor: SessionUser, email: string) {
  const m = await target(email);
  allowed(actor, m.role);
  if (m.role === "owner") await keepsAnOwner(email);
  await run("remove", { email });
}

/** Someone opening an invite link: make their login. Returns what the session needs. */
export async function acceptInvite(token: string, email: string, name: string | undefined, password: string) {
  if (password.length < 10) throw new Error("Use at least 10 characters for your password.");
  if (password.length > 200) throw new Error("That password is too long.");
  if (envOwnerEmails().includes(email.trim().toLowerCase())) throw new Error(`${email} already has access. Sign in instead.`);
  const out = await run("accept", { token, email, name, passwordHash: hashPassword(password) });
  const m = out.member as Omit<TeamMember, "passwordHash">;
  return { email: m.email, role: m.role, name: m.name, source: "team" as const, v: m.sessionVersion };
}
