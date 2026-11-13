import { createServerFn } from "@tanstack/react-start";
import { redirect } from "@tanstack/react-router";
import { checkCredentials, demoLoginEnabled, DEMO_USER, endSession, readSession, startSession } from "./auth";
import { config } from "./config";
import { buildIssueDetail, buildSummary } from "./queries";
import { readSettings, restampStep, validRetention, writeRetention } from "./settings";
import { getStore } from "./store";

export const getSessionUser = createServerFn({ method: "GET" }).handler(async () => readSession());

export const getLoginInfo = createServerFn({ method: "GET" }).handler(async () => ({
  store: config().store,
  demo: demoLoginEnabled() ? DEMO_USER : null,
}));

export const login = createServerFn({ method: "POST" })
  .validator((d: { email: string; password: string }) => {
    if (typeof d?.email !== "string" || typeof d?.password !== "string") throw new Error("email and password required");
    return { email: d.email.slice(0, 200), password: d.password.slice(0, 200) };
  })
  .handler(async ({ data }) => {
    const user = checkCredentials(data.email, data.password);
    if (!user) {
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

function requireUser() {
  const user = readSession();
  if (!user) throw redirect({ to: "/login" });
  return user;
}

type RangeInput = { range?: string; from?: string; to?: string };
const str = (v: unknown) => (typeof v === "string" && v.length <= 32 ? v : undefined);
const rangeOf = (d: RangeInput | undefined): RangeInput => ({ range: str(d?.range), from: str(d?.from), to: str(d?.to) });

export const getOverview = createServerFn({ method: "GET" })
  .validator((d: { app?: string } & RangeInput) => ({ app: str(d?.app), ...rangeOf(d) }))
  .handler(async ({ data }) => {
    requireUser();
    return buildSummary(await getStore(), data.app, config().severity, Date.now(), { range: data, retentionDays: config().retentionDays });
  });

export const getIssueDetail = createServerFn({ method: "GET" })
  .validator((d: { app: string; fingerprint: string } & RangeInput) => ({ app: String(d.app), fingerprint: String(d.fingerprint), ...rangeOf(d) }))
  .handler(async ({ data }) => {
    requireUser();
    return buildIssueDetail(await getStore(), data.app, data.fingerprint, config().severity, Date.now(), { range: data, retentionDays: config().retentionDays });
  });

export const getSettings = createServerFn({ method: "GET" })
  .validator((d: { app?: string }) => ({ app: str(d?.app) }))
  .handler(async ({ data }) => {
    requireUser();
    const apps = await (await getStore()).listApps();
    const app = data.app && apps.includes(data.app) ? data.app : apps[0];
    return { apps, settings: app ? await readSettings(app) : null };
  });

export const saveRetention = createServerFn({ method: "POST" })
  .validator((d: { app: string; retentionDays: number }) => ({ app: String(d?.app ?? ""), retentionDays: validRetention(d?.retentionDays) }))
  .handler(async ({ data }) => {
    requireUser();
    try {
      return { ok: true as const, settings: await writeRetention(data.app, data.retentionDays) };
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  });

export const restampExisting = createServerFn({ method: "POST" })
  .validator((d: { app: string; cursor?: string }) => ({ app: String(d?.app ?? ""), cursor: str(d?.cursor) ?? (typeof d?.cursor === "string" ? d.cursor.slice(0, 200) : undefined) }))
  .handler(async ({ data }) => {
    requireUser();
    try {
      return { ok: true as const, ...(await restampStep(data.app, data.cursor)) };
    } catch (err) {
      return { ok: false as const, error: (err as Error).message, updated: 0 };
    }
  });
