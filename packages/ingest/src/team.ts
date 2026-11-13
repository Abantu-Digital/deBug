import { createHash, randomBytes } from "node:crypto";
import { TEAM_ROLES, type TeamInvite, type TeamMember, type TeamRole, type WriteStore } from "@debugkit/adapters";

/**
 * Dashboard team changes: invites, accepting them, roles and removal. The admin routes
 * (/admin/team/…) run these with the ingest function's write access; the dashboard's demo and
 * memory modes run them in-process. Who may do what (owner/admin) is checked by the dashboard,
 * which is the only holder of the admin token.
 */

export const INVITE_DAYS = 7;
const EMAIL = /^[^\s@/]{1,64}@[^\s@/]{1,190}\.[^\s@/]{2,63}$/;
const HASH = /^scrypt\.[0-9a-f]{32}\.[0-9a-f]{128}$/;

export type TeamResult = { status: number; body: Record<string, unknown> };
const bad = (error: string, status = 400): TeamResult => ({ status, body: { ok: false, error } });

export const hashInviteToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** A member as shown to people: never the password hash. */
export function publicMember(m: TeamMember) {
  const { passwordHash: _h, ...rest } = m;
  return rest;
}

const role = (v: unknown): TeamRole | undefined => (TEAM_ROLES.includes(v as TeamRole) ? (v as TeamRole) : undefined);
const email = (v: unknown) => (typeof v === "string" && EMAIL.test(v.trim()) ? v.trim().toLowerCase() : undefined);

export async function teamAction(store: WriteStore, action: string, body: Record<string, unknown>, now = new Date()): Promise<TeamResult> {
  const at = now.toISOString();
  switch (action) {
    case "invite": {
      const r = role(body.role);
      if (!r) return bad("role must be owner, admin or member");
      const by = email(body.invitedBy);
      if (!by) return bad("invitedBy must be an email");
      const to = body.email ? email(body.email) : undefined;
      if (body.email && !to) return bad("email isn't a valid address");
      if (to) {
        const m = await store.getMember(to);
        if (m && !m.removedAt) return bad(`${to} is already on the team`, 409);
      }
      const token = randomBytes(32).toString("base64url");
      const invite: TeamInvite = { id: hashInviteToken(token), role: r, email: to, invitedBy: by, createdAt: at, expiresAt: new Date(now.getTime() + INVITE_DAYS * 86_400_000).toISOString() };
      await store.putInvite(invite);
      // The token is returned once, here. Only its hash is stored.
      return { status: 200, body: { ok: true, token, invite } };
    }
    case "accept": {
      const token = typeof body.token === "string" ? body.token : "";
      if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) return bad("This invite link isn't valid.", 404);
      const who = email(body.email);
      if (!who) return bad("Enter a valid email address.");
      if (typeof body.passwordHash !== "string" || !HASH.test(body.passwordHash)) return bad("passwordHash must be a scrypt hash");
      const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) || undefined : undefined;
      const invite = await store.getInvite(hashInviteToken(token));
      if (!invite || invite.usedAt || invite.revokedAt) return bad("This invite link has already been used or was cancelled. Ask for a new one.", 410);
      if (Date.parse(invite.expiresAt) < now.getTime()) return bad("This invite link has expired. Ask for a new one.", 410);
      if (invite.email && invite.email !== who) return bad(`This invite is for ${invite.email}.`, 403);
      const existing = await store.getMember(who);
      if (existing && !existing.removedAt) return bad(`${who} already has access. Sign in instead.`, 409);
      if (!(await store.claimInvite(invite.id, who, at))) return bad("This invite link has already been used. Ask for a new one.", 410);
      const member: TeamMember = {
        email: who,
        name,
        role: invite.role,
        passwordHash: body.passwordHash,
        // Someone removed and invited again starts on a new version: old sessions stay dead.
        sessionVersion: (existing?.sessionVersion ?? 0) + 1,
        createdAt: existing?.createdAt ?? at,
        updatedAt: at,
        invitedBy: invite.invitedBy,
      };
      await store.putMember(member);
      return { status: 200, body: { ok: true, member: publicMember(member) } };
    }
    case "role": {
      const who = email(body.email);
      const r = role(body.role);
      if (!who || !r) return bad("email and role are required");
      const m = await store.getMember(who);
      if (!m || m.removedAt) return bad("No such member.", 404);
      const next = { ...m, role: r, updatedAt: at };
      await store.putMember(next);
      return { status: 200, body: { ok: true, member: publicMember(next) } };
    }
    case "remove": {
      const who = email(body.email);
      if (!who) return bad("email is required");
      const m = await store.getMember(who);
      if (!m || m.removedAt) return bad("No such member.", 404);
      const next = { ...m, removedAt: at, updatedAt: at, sessionVersion: m.sessionVersion + 1 };
      await store.putMember(next);
      return { status: 200, body: { ok: true, member: publicMember(next) } };
    }
    case "revoke": {
      const id = typeof body.id === "string" && /^[0-9a-f]{64}$/.test(body.id) ? body.id : undefined;
      if (!id) return bad("id is required");
      const i = await store.getInvite(id);
      if (!i) return bad("No such invite.", 404);
      if (!i.usedAt && !i.revokedAt) await store.putInvite({ ...i, revokedAt: at });
      return { status: 200, body: { ok: true } };
    }
    default:
      return bad("not found", 404);
  }
}
