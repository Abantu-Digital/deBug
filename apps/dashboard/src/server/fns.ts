import { createServerFn } from "@tanstack/react-start";
import { redirect } from "@tanstack/react-router";
import { checkCredentials, demoLoginEnabled, DEMO_USER, endSession, readSession, startSession } from "./auth";
import { config } from "./config";
import { buildIssueDetail, buildSummary } from "./queries";
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

export const getOverview = createServerFn({ method: "GET" })
  .validator((d: { app?: string }) => ({ app: typeof d?.app === "string" ? d.app : undefined }))
  .handler(async ({ data }) => {
    requireUser();
    return buildSummary(await getStore(), data.app, config().severity);
  });

export const getIssueDetail = createServerFn({ method: "GET" })
  .validator((d: { app: string; fingerprint: string }) => ({ app: String(d.app), fingerprint: String(d.fingerprint) }))
  .handler(async ({ data }) => {
    requireUser();
    return buildIssueDetail(await getStore(), data.app, data.fingerprint, config().severity);
  });
