import { createServerFn } from "@tanstack/react-start";
import { redirect } from "@tanstack/react-router";
import { canManage, checkCredentials, demoLoginEnabled, DEMO_USER, endSession, readSession, recordFailure, startSession, tooManyAttempts, type SessionUser } from "./auth";
import { config } from "./config";
import { buildEventDetail } from "./event";
import { buildSessionDetail } from "./session";
import { lookupCustomer } from "./customers";
import { buildEndpoints } from "./endpoints";
import { buildAppCode, buildHealth } from "./health";
import { buildVersionStatus } from "./versions";
import { isMissingIndex } from "./errors";
import { buildIssueDetail, buildSummary } from "./queries";
import { appNames, readSettings, restampStep, seenHosts, settingsWriter, testAlert, validRetention, writeIssueStatus, writeRetention, writeSettings } from "./settings";
import { clearStoreCache, getStore } from "./store";
import { acceptInvite, changeRole, createInvite, readTeam, removeMember, revokeInvite } from "./team";
import { hashInviteToken } from "@debugkit/ingest";
import { TEAM_ROLES, type TeamRole } from "@debugkit/adapters";
import { validAppName, validHostNames } from "@debugkit/schema";

export const getSessionUser = createServerFn({ method: "GET" }).handler(async () => readSession());

/** Whether the project's SDK, ingest and this dashboard are in step; null when the store can't be read. */
export const getVersionStatus = createServerFn({ method: "GET" }).handler(async () => {
  await requireUser();
  try {
    return await buildVersionStatus(await getStore(), config().environment);
  } catch (e) {
    console.warn("[deBug] couldn't read versions", (e as Error).message);
    return null;
  }
});

export const getLoginInfo = createServerFn({ method: "GET" }).handler(async () => {
  // Start reading the health wall while the person signs in (see warm.ts).
  void getStore().catch(() => undefined);
  return { store: config().store, demo: demoLoginEnabled() ? DEMO_USER : null };
});

export const login = createServerFn({ method: "POST" })
  .validator((d: { email: string; password: string }) => {
    if (typeof d?.email !== "string" || typeof d?.password !== "string") throw new Error("email and password required");
    return { email: d.email.slice(0, 200), password: d.password.slice(0, 200) };
  })
  .handler(async ({ data }) => {
    const key = data.email.trim().toLowerCase();
    if (tooManyAttempts(key)) return { ok: false as const, error: "Too many attempts. Wait 15 minutes, or ask an owner to reset your access." };
    const user = await checkCredentials(data.email, data.password);
    if (!user) {
      recordFailure(key);
      await new Promise((r) => setTimeout(r, 400)); // slow down guessing
      return { ok: false as const, error: "Incorrect email or password." };
    }
    startSession(user);
    return { ok: true as const };
  });

export const logout = createServerFn({ method: "POST" }).handler(async () => {
  endSession();
  return { ok: true };
});

async function requireUser(): Promise<SessionUser> {
  const user = await readSession();
  if (!user) throw redirect({ to: "/login" });
  return user;
}

/** Settings and the team: owners and admins only. */
async function requireManager(): Promise<SessionUser> {
  const user = await requireUser();
  if (!canManage(user)) throw new Error("Only owners and admins can change this.");
  return user;
}

type RangeInput = { range?: string; from?: string; to?: string };
const str = (v: unknown) => (typeof v === "string" && v.length <= 32 ? v : undefined);
/** An endpoint key ("GET host/path…") is far longer than an app or a date: up to the 300 the SDK keeps. */
const endpointParam = (v: unknown) => (typeof v === "string" && v.length <= 400 ? v : undefined);
const rangeOf = (d: RangeInput | undefined): RangeInput => ({ range: str(d?.range), from: str(d?.from), to: str(d?.to) });

export const refreshData = createServerFn({ method: "POST" }).handler(async () => {
  await requireUser();
  clearStoreCache();
  return { ok: true };
});

/** The health wall: every service and the app's own code, coloured by level, worst first. */
export const getHealth = createServerFn({ method: "GET" })
  .validator((d: { app?: string } & RangeInput) => ({ app: str(d?.app), ...rangeOf(d) }))
  .handler(async ({ data }) => {
    await requireUser();
    const store = await getStore();
    const now = Date.now();
    const opts = { range: data, retentionDays: config().retentionDays };
    const [endpoints, summary] = await Promise.all([buildEndpoints(store, data.app, now, opts), buildSummary(store, data.app, config().severity, now, opts)]);
    return endpoints && summary ? { ...buildHealth(endpoints, summary, now), names: await appNames(summary.apps) } : null;
  });

/** The App code page: the app's own crashes and code errors, worst first. */
export const getAppCode = createServerFn({ method: "GET" })
  .validator((d: { app?: string } & RangeInput) => ({ app: str(d?.app), ...rangeOf(d) }))
  .handler(async ({ data }) => {
    await requireUser();
    const summary = await buildSummary(await getStore(), data.app, config().severity, Date.now(), { range: data, retentionDays: config().retentionDays });
    return summary ? buildAppCode(summary) : null;
  });

export const getEndpoints = createServerFn({ method: "GET" })
  .validator((d: { app?: string; endpoint?: string } & RangeInput) => ({ app: str(d?.app), endpoint: endpointParam(d?.endpoint), ...rangeOf(d) }))
  .handler(async ({ data }) => {
    await requireUser();
    const report = await buildEndpoints(await getStore(), data.app, Date.now(), { range: data, endpoint: data.endpoint, retentionDays: config().retentionDays });
    return report ? { ...report, names: await appNames(report.apps) } : null;
  });

export const getIssueDetail = createServerFn({ method: "GET" })
  .validator((d: { app: string; fingerprint: string } & RangeInput) => ({ app: String(d.app), fingerprint: String(d.fingerprint), ...rangeOf(d) }))
  .handler(async ({ data }) => {
    await requireUser();
    const detail = await buildIssueDetail(await getStore(), data.app, data.fingerprint, config().severity, Date.now(), { range: data, retentionDays: config().retentionDays, trackers: config().trackers });
    return detail ? { ...detail, canChangeStatus: settingsWriter() !== "none" } : null;
  });

export const getEventDetail = createServerFn({ method: "GET" })
  .validator((d: { app: string; fingerprint: string; eventId: string }) => ({ app: String(d.app), fingerprint: String(d.fingerprint), eventId: String(d.eventId) }))
  .handler(async ({ data }) => {
    await requireUser();
    return buildEventDetail(await getStore(), data.app, data.fingerprint, data.eventId);
  });

export const getSessionDetail = createServerFn({ method: "GET" })
  .validator((d: { app: string; sessionId: string }) => ({ app: String(d.app), sessionId: String(d.sessionId) }))
  .handler(async ({ data }) => {
    await requireUser();
    try {
      return { session: await buildSessionDetail(await getStore(), data.app, data.sessionId) };
    } catch (e) {
      // Firestore refuses the query until the (sessionId, ts) index exists.
      if (isMissingIndex(e, config().store)) return { session: null, missingIndex: true };
      throw e;
    }
  });

export const findCustomer = createServerFn({ method: "GET" })
  .validator((d: { app?: string; q?: string }) => ({ app: typeof d?.app === "string" ? d.app : undefined, q: typeof d?.q === "string" ? d.q.slice(0, 100) : "" }))
  .handler(async ({ data }) => {
    await requireUser();
    const store = await getStore();
    const apps = await store.listApps();
    // No app chosen: search them all, as Android and iOS are often separate apps.
    const app = data.app && apps.includes(data.app) ? data.app : undefined;
    const base = { apps, app, store: config().store, names: await appNames(apps) };
    try {
      return { ...base, lookup: data.q.trim() && apps.length ? await lookupCustomer(store, app ? [app] : apps, data.q) : null, missingIndex: false };
    } catch (e) {
      // Firestore refuses the lookup until the user.id and user.anonymousId indexes exist.
      if (isMissingIndex(e, config().store)) return { ...base, lookup: null, missingIndex: true };
      throw e;
    }
  });

export const updateIssueStatus = createServerFn({ method: "POST" })
  .validator((d: { app: string; fingerprint: string; status: string; resolvedIn?: string }) => {
    const status = d?.status;
    if (status !== "open" && status !== "resolved" && status !== "ignored") throw new Error("status must be open, resolved or ignored");
    return { app: String(d.app ?? ""), fingerprint: String(d.fingerprint ?? ""), status: status as "open" | "resolved" | "ignored", resolvedIn: typeof d.resolvedIn === "string" ? d.resolvedIn.trim().slice(0, 100) || undefined : undefined };
  })
  .handler(async ({ data }) => {
    await requireUser();
    try {
      return { ok: true as const, ...(await writeIssueStatus(data.app, data.fingerprint, data.status, data.resolvedIn)) };
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  });

export const getSettings = createServerFn({ method: "GET" })
  .validator((d: { app?: string }) => ({ app: str(d?.app) }))
  .handler(async ({ data }) => {
    await requireUser();
    const apps = await (await getStore()).listApps();
    const app = data.app && apps.includes(data.app) ? data.app : apps[0];
    const [settings, hosts, names] = app ? await Promise.all([readSettings(app), seenHosts(app), appNames(apps)]) : [null, [], {}];
    return { apps, settings, seenHosts: hosts, names };
  });

export const saveRetention = createServerFn({ method: "POST" })
  .validator((d: { app: string; retentionDays: number }) => ({ app: String(d?.app ?? ""), retentionDays: validRetention(d?.retentionDays) }))
  .handler(async ({ data }) => {
    await requireManager();
    try {
      return { ok: true as const, settings: await writeRetention(data.app, data.retentionDays) };
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  });

const FLOW = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/;

export const saveAppSettings = createServerFn({ method: "POST" })
  .validator((d: { app: string; displayName?: string; criticalFlows?: string[]; hosts?: { match: string; name: string; owner?: string }[]; alerts?: { slackWebhookUrl?: string; newIssues?: boolean; regressions?: boolean; onlyCriticalFlows?: boolean; dashboardUrl?: string } }) => {
    const flows = Array.isArray(d?.criticalFlows) ? d.criticalFlows.map((f) => String(f).trim().toLowerCase()).filter(Boolean) : undefined;
    if (flows && (flows.length > 30 || !flows.every((f) => FLOW.test(f) && f.length <= 64))) throw new Error("Flows are dotted lowercase names like checkout.payment (up to 30).");
    const a = d?.alerts;
    const hosts = d?.hosts === undefined ? undefined : validHostNames(d.hosts);
    if (typeof hosts === "string") throw new Error(hosts);
    const name = d?.displayName === undefined ? undefined : validAppName(d.displayName);
    if (typeof name === "string") throw new Error(name);
    return {
      app: String(d?.app ?? ""),
      displayName: name?.name,
      criticalFlows: flows,
      hosts,
      alerts: a
        ? {
            slackWebhookUrl: typeof a.slackWebhookUrl === "string" ? a.slackWebhookUrl.trim().slice(0, 300) : undefined,
            newIssues: a.newIssues !== false,
            regressions: a.regressions !== false,
            onlyCriticalFlows: a.onlyCriticalFlows === true,
            dashboardUrl: typeof a.dashboardUrl === "string" ? a.dashboardUrl.trim().slice(0, 300) || undefined : undefined,
          }
        : undefined,
    };
  })
  .handler(async ({ data }) => {
    await requireManager();
    try {
      return { ok: true as const, settings: await writeSettings(data.app, { displayName: data.displayName, criticalFlows: data.criticalFlows, alerts: data.alerts, hosts: data.hosts }) };
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  });

export const sendTestAlert = createServerFn({ method: "POST" })
  .validator((d: { app: string }) => ({ app: String(d?.app ?? "") }))
  .handler(async ({ data }) => {
    await requireManager();
    try {
      await testAlert(data.app);
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  });

export const restampExisting = createServerFn({ method: "POST" })
  .validator((d: { app: string; cursor?: string }) => ({ app: String(d?.app ?? ""), cursor: str(d?.cursor) ?? (typeof d?.cursor === "string" ? d.cursor.slice(0, 200) : undefined) }))
  .handler(async ({ data }) => {
    await requireManager();
    try {
      return { ok: true as const, ...(await restampStep(data.app, data.cursor)) };
    } catch (err) {
      return { ok: false as const, error: (err as Error).message, updated: 0 };
    }
  });

/* ---------------------------------------------------------------- team */

const role = (v: unknown): TeamRole => {
  if (!TEAM_ROLES.includes(v as TeamRole)) throw new Error("role must be owner, admin or member");
  return v as TeamRole;
};
const emailOf = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase().slice(0, 254) : "");
const ok = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return { ok: true as const };
  } catch (err) {
    return { ok: false as const, error: (err as Error).message };
  }
};

export const getTeam = createServerFn({ method: "GET" }).handler(async () => {
  const user = await requireUser();
  return { ...(await readTeam()), me: user, canManage: canManage(user) };
});

export const inviteToTeam = createServerFn({ method: "POST" })
  .validator((d: { role: string; email?: string }) => ({ role: role(d?.role), email: emailOf(d?.email) || undefined }))
  .handler(async ({ data }) => {
    const user = await requireManager();
    try {
      return { ok: true as const, ...(await createInvite(user, data.role, data.email)) };
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  });

export const cancelInvite = createServerFn({ method: "POST" })
  .validator((d: { id: string }) => ({ id: String(d?.id ?? "").slice(0, 64) }))
  .handler(async ({ data }) => {
    const user = await requireManager();
    return ok(() => revokeInvite(user, data.id));
  });

export const setMemberRole = createServerFn({ method: "POST" })
  .validator((d: { email: string; role: string }) => ({ email: emailOf(d?.email), role: role(d?.role) }))
  .handler(async ({ data }) => {
    const user = await requireManager();
    if (data.email === user.email) return { ok: false as const, error: "You can't change your own role." };
    return ok(() => changeRole(user, data.email, data.role));
  });

export const removeFromTeam = createServerFn({ method: "POST" })
  .validator((d: { email: string }) => ({ email: emailOf(d?.email) }))
  .handler(async ({ data }) => {
    const user = await requireManager();
    if (data.email === user.email) return { ok: false as const, error: "You can't remove yourself." };
    return ok(() => removeMember(user, data.email));
  });

const TOKEN = /^[A-Za-z0-9_-]{40,64}$/;

/** What an invite link is for, before the person accepts it. Public: the token is the secret. */
export const getInvite = createServerFn({ method: "GET" })
  .validator((d: { token: string }) => ({ token: String(d?.token ?? "") }))
  .handler(async ({ data }) => {
    if (!TOKEN.test(data.token)) return { valid: false as const };
    const store = await getStore();
    const id = hashInviteToken(data.token);
    const i = typeof store.listInvites === "function" ? (await store.listInvites()).find((x) => x.id === id) : undefined;
    if (!i || i.usedAt || i.revokedAt || Date.parse(i.expiresAt) < Date.now()) return { valid: false as const };
    return { valid: true as const, role: i.role, email: i.email, invitedBy: i.invitedBy, expiresAt: i.expiresAt };
  });

export const joinTeam = createServerFn({ method: "POST" })
  .validator((d: { token: string; email: string; name?: string; password: string }) => {
    if (typeof d?.password !== "string") throw new Error("password required");
    return { token: String(d?.token ?? "").slice(0, 64), email: emailOf(d?.email), name: typeof d?.name === "string" ? d.name.trim().slice(0, 80) || undefined : undefined, password: d.password };
  })
  .handler(async ({ data }) => {
    if (!TOKEN.test(data.token)) return { ok: false as const, error: "This invite link isn't valid." };
    try {
      const user = await acceptInvite(data.token, data.email, data.name, data.password);
      startSession(user);
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  });
