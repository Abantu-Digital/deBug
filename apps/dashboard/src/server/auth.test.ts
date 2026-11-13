import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "@debugkit/adapters/memory";
import { teamAction } from "@debugkit/ingest";

// A cookie jar in place of TanStack Start's request context.
const jar = new Map<string, string>();
vi.mock("@tanstack/react-start/server", () => ({
  getCookie: (n: string) => jar.get(n),
  setCookie: (n: string, v: string) => void jar.set(n, v),
  deleteCookie: (n: string) => void jar.delete(n),
  getRequestHeader: () => undefined,
}));
const store = new MemoryStore();
vi.mock("./store", () => ({ getStore: async () => store, getLocalWriteStore: async () => store }));

process.env.DEBUG_STORE = "memory";
process.env.DEBUG_DASHBOARD_USERS = "";
const { checkCredentials, forgetMember, hashPassword, readSession, startSession } = await import("./auth");

async function join(email: string, role = "member") {
  const t = (await teamAction(store, "invite", { role, invitedBy: "owner@acme.dev" })).body.token;
  return teamAction(store, "accept", { token: t, email, passwordHash: hashPassword("correct-horse-1") });
}

beforeEach(() => jar.clear());

describe("team sign-in", () => {
  it("signs in an invited member with their role, and rejects a wrong password", async () => {
    await join("sam@acme.dev", "admin");
    expect(await checkCredentials("sam@acme.dev", "nope-nope-nope")).toBeNull();
    const creds = await checkCredentials("Sam@Acme.dev", "correct-horse-1");
    expect(creds).toMatchObject({ email: "sam@acme.dev", role: "admin", source: "team", v: 1 });
    startSession(creds!);
    expect(await readSession()).toEqual({ email: "sam@acme.dev", role: "admin", name: undefined, source: "team" });
  });

  it("ends a removed member's existing session, and a role change applies at once", async () => {
    await join("kim@acme.dev");
    startSession((await checkCredentials("kim@acme.dev", "correct-horse-1"))!);
    await teamAction(store, "role", { email: "kim@acme.dev", role: "admin" });
    forgetMember("kim@acme.dev");
    expect((await readSession())?.role).toBe("admin");
    await teamAction(store, "remove", { email: "kim@acme.dev" });
    forgetMember("kim@acme.dev");
    expect(await readSession()).toBeNull();
    expect(await checkCredentials("kim@acme.dev", "correct-horse-1")).toBeNull();
  });

  it("rejects a tampered cookie", async () => {
    await join("lee@acme.dev");
    startSession((await checkCredentials("lee@acme.dev", "correct-horse-1"))!);
    const [payload, sig] = [...jar.values()][0]!.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, "base64url").toString()), email: "owner@acme.dev", s: "env" })).toString("base64url");
    jar.set([...jar.keys()][0]!, `${forged}.${sig}`);
    expect(await readSession()).toBeNull();
  });
});
