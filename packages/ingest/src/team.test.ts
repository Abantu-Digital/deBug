import { describe, expect, it } from "vitest";
import { MemoryStore } from "@debugkit/adapters/memory";
import { handleAdmin } from "./admin";
import { hashInviteToken } from "./team";

const TOKEN = "admin_token_0123456789abcdef";
const HASH = `scrypt.${"a".repeat(32)}.${"b".repeat(128)}`;
const call = (store: MemoryStore, action: string, body: unknown, auth = `Bearer ${TOKEN}`) =>
  handleAdmin({ method: "POST", path: `/debugIngest/admin/team/${action}`, body: JSON.stringify(body), authorization: auth }, { store, adminToken: TOKEN });

describe("team admin routes", () => {
  it("invites by link, accepts once, and stores only hashes", async () => {
    const store = new MemoryStore();
    expect((await call(store, "invite", { role: "admin", invitedBy: "me@acme.dev" }, "Bearer wrong")).status).toBe(401);
    const inv = await call(store, "invite", { role: "admin", invitedBy: "me@acme.dev" });
    expect(inv.status).toBe(200);
    const token = inv.body.token as string;
    expect(store.invites.has(token)).toBe(false);
    expect(store.invites.has(hashInviteToken(token))).toBe(true);

    const ok = await call(store, "accept", { token, email: "Ash@Acme.dev", name: "Ashwin", passwordHash: HASH });
    expect(ok.status).toBe(200);
    expect(ok.body.member).toMatchObject({ email: "ash@acme.dev", role: "admin", name: "Ashwin", sessionVersion: 1 });
    expect(ok.body.member).not.toHaveProperty("passwordHash");
    expect(store.members.get("ash@acme.dev")?.passwordHash).toBe(HASH);

    // Single use.
    expect((await call(store, "accept", { token, email: "eve@acme.dev", passwordHash: HASH })).status).toBe(410);
  });

  it("rejects expired, revoked, wrong-email and malformed accepts", async () => {
    const store = new MemoryStore();
    const inv = await call(store, "invite", { role: "member", email: "sam@acme.dev", invitedBy: "me@acme.dev" });
    const token = inv.body.token as string;
    expect((await call(store, "accept", { token, email: "eve@acme.dev", passwordHash: HASH })).status).toBe(403);
    expect((await call(store, "accept", { token, email: "sam@acme.dev", passwordHash: "plain-password" })).status).toBe(400);
    expect((await call(store, "accept", { token: "x".repeat(43), email: "sam@acme.dev", passwordHash: HASH })).status).toBe(410);

    const id = hashInviteToken(token);
    store.invites.set(id, { ...store.invites.get(id)!, expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect((await call(store, "accept", { token, email: "sam@acme.dev", passwordHash: HASH })).status).toBe(410);

    const two = await call(store, "invite", { role: "member", invitedBy: "me@acme.dev" });
    await call(store, "revoke", { id: hashInviteToken(two.body.token as string) });
    expect((await call(store, "accept", { token: two.body.token, email: "sam@acme.dev", passwordHash: HASH })).status).toBe(410);
  });

  it("changes roles, and removal bumps the session version; re-inviting starts a new one", async () => {
    const store = new MemoryStore();
    const join = async (who: string) => {
      const t = (await call(store, "invite", { role: "member", invitedBy: "me@acme.dev" })).body.token;
      return call(store, "accept", { token: t, email: who, passwordHash: HASH });
    };
    await join("sam@acme.dev");
    expect((await call(store, "role", { email: "sam@acme.dev", role: "boss" })).status).toBe(400);
    expect((await call(store, "role", { email: "sam@acme.dev", role: "admin" })).body.member).toMatchObject({ role: "admin" });
    expect((await call(store, "invite", { role: "member", email: "sam@acme.dev", invitedBy: "me@acme.dev" })).status).toBe(409);

    const removed = await call(store, "remove", { email: "sam@acme.dev" });
    expect(removed.body.member).toMatchObject({ sessionVersion: 2, removedAt: expect.any(String) });
    expect((await call(store, "role", { email: "sam@acme.dev", role: "owner" })).status).toBe(404);
    expect((await join("sam@acme.dev")).body.member).toMatchObject({ sessionVersion: 3, role: "member" });
    expect(store.members.get("sam@acme.dev")?.removedAt).toBeUndefined();
  });

  it("only takes POST, and needs no app", async () => {
    const store = new MemoryStore();
    const r = await handleAdmin({ method: "GET", path: "/admin/team/invite", body: "", authorization: `Bearer ${TOKEN}` }, { store, adminToken: TOKEN });
    expect(r.status).toBe(405);
    expect((await call(store, "nope", {})).status).toBe(404);
  });
});
