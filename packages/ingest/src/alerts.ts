import type { AppSettings, IssueUpsert, UpsertOutcome } from "@debugkit/adapters";

/** Slack incoming webhooks only: anything else could make ingest call arbitrary URLs. */
export const SLACK_WEBHOOK = /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{10,200}$/;

const recent = new Map<string, number>();
const HOUR = 3_600_000;

type Post = (url: string, body: unknown) => Promise<unknown>;
const defaultPost: Post = (url, body) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(3000) });

/**
 * Tell Slack about new and regressed issues, per the app's alert settings. At most one alert
 * per issue per hour per function instance, and never more than 10 per batch. Failures are
 * logged, never thrown: alerts must not break ingest.
 */
export async function sendAlerts(
  app: string,
  outcome: UpsertOutcome | void,
  issues: Map<string, IssueUpsert>,
  settings: AppSettings | null,
  post: Post = defaultPost,
): Promise<number> {
  const a = settings?.alerts;
  if (!outcome || !a?.slackWebhookUrl || !SLACK_WEBHOOK.test(a.slackWebhookUrl)) return 0;
  const critical = new Set(settings?.criticalFlows ?? []);
  const picks = [
    ...(a.newIssues !== false ? outcome.created.map((fp) => ({ fp, kind: "new" as const })) : []),
    ...(a.regressions !== false ? outcome.regressed.map((fp) => ({ fp, kind: "regressed" as const })) : []),
  ]
    .filter(({ fp }) => !a.onlyCriticalFlows || critical.has(issues.get(fp)?.flow ?? ""))
    .filter(({ fp, kind }) => {
      const k = `${app}|${fp}|${kind}`;
      const at = recent.get(k);
      if (at && Date.now() - at < HOUR) return false;
      recent.set(k, Date.now());
      return true;
    })
    .slice(0, 10);
  if (recent.size > 5000) recent.clear();

  let sent = 0;
  for (const { fp, kind } of picks) {
    const u = issues.get(fp);
    if (!u) continue;
    const link = a.dashboardUrl ? `${a.dashboardUrl.replace(/\/+$/, "")}/issues/${fp}?app=${encodeURIComponent(app)}` : undefined;
    const where = [u.culprit && `\`${u.culprit}\``, u.flow && `flow \`${u.flow}\`${critical.has(u.flow) ? " (critical)" : ""}`, u.version && `version ${u.version}`].filter(Boolean).join(" · ");
    const text = `${kind === "new" ? ":new: New issue" : ":rotating_light: Regressed"} in *${app}*: ${link ? `<${link}|${u.title}>` : u.title}${where ? `\n${where}` : ""}`;
    try {
      await post(a.slackWebhookUrl, { text });
      sent++;
    } catch (err) {
      console.error("[deBug] Slack alert failed", err);
    }
  }
  return sent;
}

/** For tests. */
export function clearAlertMemory() {
  recent.clear();
}
