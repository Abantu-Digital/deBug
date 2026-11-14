import { cleanFnName, CATEGORY_INFO, CAUSE_INFO, IMPACT_INFO, OWNER_INFO, type Category, type Classification, type StackFrame, type StoredEvent } from "@debugkit/schema";
import { evidenceOf, type Evidence } from "@debugkit/ingest";

/**
 * Two explanations for every issue, built from its labels, the evidence behind them and the
 * stack. No LLM: one template per category, adjusted by the causes. See docs/taxonomy.md.
 *
 * - summary: for support. What the user saw, where, how many people, whether it's still
 *   happening, and who should look at it. No jargon.
 * - technical: for a developer. The category and owner, the evidence, where in the code, what
 *   started it, and a suggested fix.
 */
export interface Explanation {
  summary: string;
  technical: {
    headline: string;
    evidence: string[];
    /** The culprit and the user action that started it, when known. */
    where?: string;
    fix: string;
  };
}

export interface ExplainInput {
  labels: Classification;
  lastEvent?: StoredEvent;
  culprit?: string;
  /** Occurrences and users, for the summary. */
  count24h: number;
  countRange: number;
  rangeLabel: string;
  users?: number;
  lastSeen: string;
  status: string;
  incidentTitle?: string;
  now?: number;
}

/** Handlers whose name says what the user did. Matched on the cleaned Hermes name. */
const USER_ACTIONS: [RegExp, string][] = [
  [/^_?onRefresh$/, "pull to refresh"],
  [/^_?onPress(In|Out)?$|^handlePress$/, "a tap"],
  [/^_?onLongPress$/, "a long press"],
  [/^_?onSubmit(Editing)?$|^handleSubmit$/, "submitting a form"],
  [/^_?onChangeText$/, "typing"],
  [/^_?onEndReached$/, "scrolling to the end of a list"],
  [/^_?onScroll$/, "scrolling"],
  [/^_?onValueChange$/, "changing a setting"],
];

/** The first app frame that is an event handler, and what the user did, e.g. `_onRefresh` → "pull to refresh". */
export function userAction(frames: StackFrame[] | undefined): { fn: string; action?: string } | undefined {
  for (const f of frames ?? []) {
    if (f.inApp === false) continue;
    const fn = cleanFnName(f.fn);
    if (!fn) continue;
    const known = USER_ACTIONS.find(([re]) => re.test(fn));
    if (known) return { fn, action: known[1] };
    if (/^_?(on|handle)[A-Z]/.test(fn)) return { fn };
  }
  return undefined;
}

const seconds = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
const osName = (os?: string) => (os === "ios" ? "iPhone" : os === "android" ? "Android" : os || "their device");

/** "the getBalances request" from "POST api.x/api/balance/getBalances". */
function requestName(url: string): string {
  const last = url.split("?")[0]!.split("/").filter((p) => p && p !== ":id").pop();
  return last ? `the ${last} request` : "a request";
}

function stillHappening(i: ExplainInput): string {
  const now = i.now ?? Date.now();
  if (i.status === "resolved") return "It's marked fixed.";
  if (i.status === "ignored") return "It's marked as ignored.";
  const ago = now - Date.parse(i.lastSeen);
  if (i.count24h > 0) return ago < 3_600_000 ? "It's still happening: last seen within the hour." : `It happened ${plural(i.count24h, "time")} in the last 24 hours.`;
  return `It hasn't happened in the last 24 hours (${plural(i.countRange, "time")} in ${i.rangeLabel}).`;
}

const PASS_TO: Record<string, string> = {
  app: "the app team",
  backend: "the backend team",
  infrastructure: "whoever runs the network and hosting",
  third_party: "whoever manages that third-party service",
  unknown: "the app team first, to find out whose it is",
};

interface Template {
  /** What the user saw, without the who/where/when. */
  saw: (name: string, ev: Evidence) => string;
  /** Why, in plain words. */
  why: (ev: Evidence, causes: Classification["causes"]) => string;
  /** One-line diagnosis for developers. */
  diagnosis: (ev: Evidence) => string;
  fix: (ev: Evidence, causes: Classification["causes"]) => string;
}

const TEMPLATES: Record<Category, Template> = {
  "network.offline": {
    saw: (name) => `${cap(name)} failed`,
    why: () => "The phone was offline.",
    diagnosis: () => "No connection when the request was made.",
    fix: () => "Check connectivity before sending (NetInfo), queue the request until the phone is back online, and show an offline state.",
  },
  "network.never_sent": {
    saw: (name) => `${cap(name)} didn't load`,
    why: (_ev, causes) =>
      causes.includes("resumed_from_background")
        ? "The app had just been reopened and the phone hadn't reconnected yet, so the request never left the phone. Not a server outage."
        : "The request failed on the phone before reaching the server. Not a server outage.",
    diagnosis: (ev) => `No HTTP status after ${seconds(ev.durationMs ?? 0)}: too fast to have reached a server.`,
    fix: (_ev, causes) =>
      causes.includes("resumed_from_background")
        ? "Wait for the connection when the app returns to the foreground (NetInfo `isConnected` on AppState `active`) before sending, or retry idempotent requests once with a short backoff."
        : "Check connectivity before sending, and retry idempotent requests once with a short backoff.",
  },
  "network.timeout": {
    saw: (name) => `${cap(name)} took too long and gave up`,
    why: () => "The request was sent but no answer came back in time: a slow network or a slow server.",
    diagnosis: (ev) => `Timed out${ev.durationMs ? ` after ${seconds(ev.durationMs)}` : ""} with no response.`,
    fix: () => "Check this endpoint's p95 under Response times. If the server is slow, fix it there; otherwise raise the timeout, retry idempotent requests, and show a retry state.",
  },
  "network.failed": {
    saw: (name) => `${cap(name)} couldn't connect`,
    why: (ev) => (ev.failedHosts.length > 1 ? "Several servers were unreachable at once, which points at the network." : "The phone couldn't reach the server."),
    diagnosis: (ev) => `No HTTP status after ${seconds(ev.durationMs ?? 0)}: DNS, TLS or a refused connection.`,
    fix: (ev) =>
      ev.failedHosts.length > 1
        ? "Several hosts failed together: check the network path (VPN, proxy, carrier) before the servers."
        : "Check the host resolves and its certificate is valid from the phone's network, and retry once with backoff.",
  },
  auth: {
    saw: (name) => `${cap(name)} was refused`,
    why: (_ev, causes) => (causes.includes("auth_expired") ? "The user's sign-in had expired." : "The server didn't accept the user's sign-in for this."),
    diagnosis: (ev) => `HTTP ${ev.status ?? "401/403"}.${ev.sameHostWorkedBefore ? " An earlier request to the same server succeeded, so the session ran out." : ""}`,
    fix: (_ev, causes) =>
      causes.includes("auth_expired")
        ? "Refresh the token before it expires, or on a 401 refresh it and retry the request once."
        : "Check the token is sent with this request and is allowed for this endpoint.",
  },
  server: {
    saw: (name) => `${cap(name)} failed with a server error`,
    why: () => "The server received the request and failed. The problem is on the server side.",
    diagnosis: (ev) => `HTTP ${ev.status ?? "5xx"} from the server.`,
    fix: () => "Check the backend logs for this endpoint at the times above. In the app, show a friendly error and let the user retry.",
  },
  client_request: {
    saw: (name) => `${cap(name)} was rejected`,
    why: () => "The server refused what the app sent as invalid.",
    diagnosis: (ev) => `HTTP ${ev.status ?? "4xx"}: the request didn't match what the API expects.`,
    fix: () => "Compare the request the app sends (fields, types, headers) with what the API expects, and validate input before sending.",
  },
  crash: {
    saw: () => "The app closed unexpectedly",
    why: () => "An error nobody caught closed the app.",
    diagnosis: () => "Fatal error from the global handler.",
    fix: () => "Open the culprit below, replay the breadcrumbs to reproduce, and add a guard or an error boundary around it.",
  },
  screen_crash: {
    saw: () => "A screen failed to show and the error screen appeared instead",
    why: () => "Something on that screen broke while drawing. The rest of the app kept working.",
    diagnosis: () => "Caught by an error boundary while rendering.",
    fix: () => "Open the culprit below. Usually data the screen expects is missing or not loaded yet: add a loading state or a guard.",
  },
  unhandled_rejection: {
    saw: () => "Something in the background failed",
    why: () => "Background work failed and nothing handled it, so whatever it was doing may not have happened.",
    diagnosis: () => "Unhandled promise rejection.",
    fix: () => "Find the promise at the culprit below and add a catch that handles or reports the failure.",
  },
  uncaught: {
    saw: () => "Something failed while the user was using the app",
    why: () => "An error nobody caught. The app kept running.",
    diagnosis: () => "Uncaught, non-fatal error.",
    fix: () => "Open the culprit below and handle the error where it's thrown.",
  },
  app_reported: {
    saw: () => "The app reported an error",
    why: () => "The app caught this itself and reported it.",
    diagnosis: () => "Reported with deBug.error().",
    fix: () => "See where the app reports it (culprit below) and decide whether the user needs to know.",
  },
  other: {
    saw: () => "Something went wrong",
    why: () => "This error doesn't match a known kind yet.",
    diagnosis: () => "No category matched.",
    fix: () => "Start at the culprit below and use the breadcrumbs to replay what the user did.",
  },
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function explain(i: ExplainInput): Explanation {
  const ev0 = i.lastEvent?.event;
  const e = ev0?.type === "error" ? ev0 : undefined;
  const ev: Evidence = e
    ? evidenceOf(e)
    : { workedSinceForeground: false, inBackground: false, failedBefore: 0, failedHosts: [], repeatedFailure: false, slowRecent: 0, sameHostWorkedBefore: false };
  const { labels } = i;
  const t = TEMPLATES[labels.category] ?? TEMPLATES.other;
  const name = e?.request ? requestName(e.request.url) : "it";
  const os = i.lastEvent?.context.os.name;

  // Summary: what, who, where, when, why, still happening, who to pass it to.
  const who = i.users ? ` for ${plural(i.users, "user")}` : "";
  const where = ` on ${osName(os)}`;
  const when = labels.causes.includes("resumed_from_background") ? " right after reopening the app" : "";
  const action = userAction(e?.error.frames);
  const doing = action?.action ? ` (after ${action.action})` : "";
  const summary = [
    `${t.saw(name, ev)}${who}${where}${when}${doing}.`,
    t.why(ev, labels.causes),
    stillHappening(i),
    `Pass to: ${PASS_TO[labels.owner] ?? PASS_TO.unknown}.`,
  ].join(" ");

  // Technical: category and owner, evidence, where, fix.
  const evidence = [t.diagnosis(ev)];
  if (labels.causes.includes("resumed_from_background") && ev.msSinceForeground !== undefined)
    evidence.push(`The app came to the foreground ${seconds(ev.msSinceForeground)} before; no request has succeeded since.`);
  if (ev.failedBefore > 0) evidence.push(`${plural(ev.failedBefore, "other request")} failed in the 5 s before${ev.failedHosts.length > 1 ? `, across ${ev.failedHosts.length} hosts` : ""}.`);
  else if (ev.repeatedFailure) evidence.push("The same request had already failed just before.");
  if (labels.causes.includes("slow_network")) evidence.push(`${ev.slowRecent} of the last 5 requests were slow.`);
  if (ev.inBackground) evidence.push("The app was in the background, so the user probably didn't see it.");
  for (const c of labels.causes) if (["new_in_release", "regressed", "single_device"].includes(c)) evidence.push(`${CAUSE_INFO[c].name}: ${CAUSE_INFO[c].description}`);
  if (i.incidentTitle) evidence.push(`Part of the incident "${i.incidentTitle}".`);

  const whereParts = [i.culprit ? `\`${i.culprit}\`` : undefined, action ? `started by \`${action.fn}\`${action.action ? ` (${action.action})` : ""}` : undefined].filter(Boolean);
  return {
    summary,
    technical: {
      headline: `${CATEGORY_INFO[labels.category]?.name ?? labels.category} · owner: ${OWNER_INFO[labels.owner]?.name ?? labels.owner} · impact: ${IMPACT_INFO[labels.impact]?.name ?? labels.impact}`,
      evidence,
      where: whereParts.length ? whereParts.join(", ") : undefined,
      fix: t.fix(ev, labels.causes),
    },
  };
}

/** The explanation as Markdown, for pasting into a Jira or Linear ticket by hand. */
export function explanationMarkdown(title: string, x: Explanation, link?: string): string {
  return [
    `## ${title}`,
    "",
    "### What happened",
    x.summary,
    "",
    "### For developers",
    `**${x.technical.headline}**`,
    "",
    ...x.technical.evidence.map((l) => `- ${l}`),
    ...(x.technical.where ? ["", `**Where:** ${x.technical.where}`] : []),
    "",
    `**Suggested fix:** ${x.technical.fix}`,
    ...(link ? ["", `deBug: ${link}`] : []),
  ].join("\n");
}
