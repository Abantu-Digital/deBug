import { cleanFnName, hostNameFor, CATEGORY_INFO, CAUSE_INFO, IMPACT_INFO, OWNER_INFO, type Category, type Cause, type Classification, type HostName, type StackFrame, type StoredEvent } from "@debugkit/schema";
import { evidenceOf, NO_EVIDENCE, type Evidence } from "@debugkit/ingest";

/**
 * Two explanations for every issue, built from its labels, the evidence behind them and the
 * stack. No LLM: one template per category, and a line per cause pattern. See docs/taxonomy.md.
 *
 * - summary: for support. What the user saw, where, how many people, whether it's still
 *   happening, and who should look at it. No jargon.
 * - technical: for a developer. The category and owner, the evidence, where in the code and what
 *   started it, and a suggested fix.
 *
 * Text may contain `code` in backticks: Markdown keeps it, the page strips it.
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

/** The issue facts an explanation needs. */
export interface ExplainIssue {
  culprit?: string;
  count24h: number;
  countRange: number;
  lastSeen: string;
  status: string;
  incidentTitle?: string;
}

export interface ExplainInput {
  issue: ExplainIssue;
  labels: Classification;
  /** The occurrence the labels came from. */
  lastEvent?: StoredEvent;
  rangeLabel: string;
  /** Distinct users affected, when counted. */
  users?: number;
  /** Platforms seen in recent occurrences (e.g. ["ios", "android"]), when known. */
  platforms?: string[];
  /** Request durations of recent occurrences, for a range ("3–49 ms"). */
  durations?: number[];
  /** Host names from Settings: the request's host is named in both blocks. */
  hosts?: readonly HostName[];
  now?: number;
}

/** Handlers whose name says what the user did. Matched on the cleaned Hermes name. */
const USER_ACTIONS: [RegExp, string][] = [
  [/^_?onRefresh$/, "pull to refresh"],
  [/^_?onPress([A-Z]\w*)?$|^_?handlePress([A-Z]\w*)?$/, "a tap"],
  [/^_?onLongPress$/, "a long press"],
  [/^_?onSubmit(Editing)?$|^_?handleSubmit([A-Z]\w*)?$/, "submitting a form"],
  [/^_?onChangeText$/, "typing"],
  [/^_?onEndReached$/, "scrolling to the end of a list"],
  [/^_?onValueChange$/, "changing a setting"],
];

/** The first app frame that is a known user-action handler: `_onRefresh` → "pull to refresh". */
export function userAction(frames: StackFrame[] | undefined): { fn: string; action: string } | undefined {
  for (const f of frames ?? []) {
    if (f.inApp === false) continue;
    const fn = cleanFnName(f.fn);
    const known = fn && USER_ACTIONS.find(([re]) => re.test(fn));
    if (fn && known) return { fn, action: known[1] };
  }
  return undefined;
}

const seconds = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const PLATFORM: Record<string, string> = { ios: "iPhone", android: "Android", web: "the web", macos: "Mac", windows: "Windows" };
const platformName = (os: string) => PLATFORM[os] ?? os;

/** A durations range: "16 ms", or "3–49 ms" across occurrences. */
function durationText(ds: number[]): string | undefined {
  const xs = ds.filter((d) => Number.isFinite(d) && d >= 0);
  if (!xs.length) return undefined;
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  if (lo === hi || hi < 1000) return lo === hi ? seconds(lo) : `${Math.round(lo)}–${Math.round(hi)} ms`;
  return `${seconds(lo)}–${seconds(hi)}`;
}

const VERB = /^(get|fetch|load|list|read|find|create|add|update|set|save|post|put|patch|delete|remove|check|validate|send|submit|sync)(?=[A-Z_-]|$)/;

/**
 * What a request was for, in plain words, from its path: "/api/balance/getBalances" → "balances",
 * "/api/app-force-update" → "app force update". Undefined when the path says nothing.
 */
export function thingOf(url: string): string | undefined {
  const last = url.split("?")[0]!.split("/").filter((p) => p && p !== ":id" && !/^v\d+$/.test(p)).pop();
  if (!last || last.includes(".")) return undefined; // a bare host
  const words = last
    .replace(VERB, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .trim()
    .toLowerCase();
  return words || undefined;
}

/** "Balances", "Balances (Balance service)", "The app" — the subject of the summary. */
function subject(e: { request?: { url: string } } | undefined, service: string | undefined): { name: string; plural: boolean } {
  const thing = e?.request ? thingOf(e.request.url) : undefined;
  if (!thing) return { name: service ? `a request to ${service}` : e?.request ? "a request" : "the app", plural: false };
  return { name: service ? `${thing} (${service})` : thing, plural: /s$/.test(thing) && !/ss$/.test(thing) };
}

function stillHappening(i: ExplainIssue, rangeLabel: string, now: number): string {
  if (i.status === "resolved") return "It's marked fixed.";
  if (i.status === "ignored") return "It's marked as ignored.";
  if (i.count24h > 0) return now - Date.parse(i.lastSeen) < 3_600_000 ? "It's still happening: last seen within the hour." : `It happened ${plural(i.count24h, "time")} in the last 24 hours.`;
  return `It hasn't happened in the last 24 hours (${plural(i.countRange, "time")} in ${rangeLabel}).`;
}

const PASS_TO: Record<string, string> = {
  app: "app team",
  backend: "backend team",
  infrastructure: "whoever runs the network and hosting",
  third_party: "whoever manages that third-party service",
  unknown: "app team first, to find out whose it is",
};

interface Template {
  /** What the user saw: `name` is the thing that failed ("balances"), `are` its verb. */
  saw: (name: string, are: string) => string;
  /** Why, in plain words. */
  why: (ev: Evidence, causes: readonly Cause[]) => string;
  /** One-line diagnosis for developers; `took` is the duration text, if any. */
  diagnosis: (ev: Evidence, took: string | undefined) => string;
  fix: (ev: Evidence, causes: readonly Cause[]) => string;
}

const TEMPLATES: Record<Category, Template> = {
  "network.offline": {
    saw: (n, are) => `${cap(n)} ${are === "are" ? "weren't" : "wasn't"} available`,
    why: () => "The phone was offline.",
    diagnosis: () => "No connection when the request was made.",
    fix: () => "Check connectivity before sending (NetInfo), queue the request until the phone is back online, and show an offline state.",
  },
  "network.never_sent": {
    saw: (n) => `${cap(n)} didn't load`,
    why: (_ev, causes) =>
      causes.includes("resumed_from_background")
        ? "The app had just been reopened and the phone hadn't reconnected yet. Not a server outage."
        : "The request failed on the phone before reaching the server. Not a server outage.",
    diagnosis: (_ev, took) => (took ? `No HTTP status after ${took}: too fast to have reached a server.` : "No HTTP status, and too fast to have reached a server."),
    fix: (_ev, causes) =>
      causes.includes("resumed_from_background")
        ? "Wait for the connection when the app returns to the foreground (NetInfo `isConnected` on AppState `active`) before sending, or retry idempotent requests once with a short backoff."
        : "Check connectivity before sending, and retry idempotent requests once with a short backoff.",
  },
  "network.timeout": {
    saw: (n) => `${cap(n)} took too long and gave up`,
    why: () => "The request was sent but no answer came back in time: a slow network or a slow server.",
    diagnosis: (_ev, took) => `Timed out${took ? ` after ${took}` : ""} with no response.`,
    fix: () => "Check this endpoint's p95 under Response times. If the server is slow, fix it there; otherwise raise the timeout, retry idempotent requests, and show a retry state.",
  },
  "network.failed": {
    saw: (n) => `${cap(n)} couldn't connect`,
    why: (ev) => (ev.failedHosts.length > 1 ? "Several servers were unreachable at once, which points at the network." : "The phone couldn't reach the server."),
    diagnosis: (_ev, took) => `No HTTP status${took ? ` after ${took}` : ""}: DNS, TLS or a refused connection.`,
    fix: (ev) =>
      ev.failedHosts.length > 1
        ? "Several hosts failed together: check the network path (VPN, proxy, carrier) before the servers."
        : "Check the host resolves and its certificate is valid from the phone's network, and retry once with backoff.",
  },
  auth: {
    saw: (n, are) => `${cap(n)} ${are === "are" ? "were" : "was"} refused`,
    why: (_ev, causes) => (causes.includes("auth_expired") ? "The user's sign-in had expired." : "The server didn't accept the user's sign-in for this."),
    diagnosis: (ev) => `HTTP ${ev.status ?? "401/403"}.${ev.sameHostWorkedBefore ? " An earlier request to the same server succeeded, so the session ran out." : ""}`,
    fix: (_ev, causes) =>
      causes.includes("auth_expired") ? "Refresh the token before it expires, or on a 401 refresh it and retry the request once." : "Check the token is sent with this request and is allowed for this endpoint.",
  },
  server: {
    saw: (n) => `${cap(n)} failed with a server error`,
    why: () => "The server received the request and failed. The problem is on the server side.",
    diagnosis: (ev) => `HTTP ${ev.status ?? "5xx"} from the server.`,
    fix: () => "Check the backend logs for this endpoint at the times above. In the app, show a friendly error and let the user retry.",
  },
  client_request: {
    saw: (n, are) => `${cap(n)} ${are === "are" ? "were" : "was"} rejected`,
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

/** What each cause adds: a plain sentence for support, a step for the fix. */
const CAUSE_LINES: Partial<Record<Cause, { summary?: (x: { model?: string; firstVersion?: string }) => string; fix?: string }>> = {
  burst: { summary: () => "Several requests failed at the same moment." },
  slow_network: { summary: () => "The connection was slow.", fix: "Test on a throttled connection." },
  new_in_release: { summary: () => "It started in the latest version of the app.", fix: "Look at what changed in the latest release around the culprit." },
  regressed: { summary: () => "It was marked fixed, but it has come back.", fix: "The earlier fix didn't hold: compare with the release it was resolved in." },
  single_device: { summary: (x) => `It's only been seen on one phone model${x.model ? ` (${x.model})` : ""}.`, fix: "Reproduce on that model first." },
};

export function explain(input: ExplainInput): Explanation {
  const { issue, labels, rangeLabel } = input;
  const now = input.now ?? Date.now();
  const ev0 = input.lastEvent?.event;
  const e = ev0?.type === "error" ? ev0 : undefined;
  const ev = e ? evidenceOf(e) : NO_EVIDENCE;
  const t = TEMPLATES[labels.category] ?? TEMPLATES.other;
  const causes = labels.causes;
  const model = input.lastEvent?.context.device.model;
  const service = e?.request ? hostNameFor(e.request.url, input.hosts)?.host.name : undefined;

  // Summary: what, who, where, when, why, causes, still happening, who to pass it to.
  const s = subject(e, service);
  const who = input.users ? ` for ${plural(input.users, "user")}` : "";
  // Name the platform only when it's known for all of them: recent occurrences, or a single user.
  const platforms = input.platforms?.length ? input.platforms : input.users === 1 && input.lastEvent ? [input.lastEvent.context.os.name] : [];
  const where = platforms.length ? ` on ${platforms.map(platformName).join(" and ")}` : "";
  const when = causes.includes("resumed_from_background") ? " right after reopening the app" : "";
  const action = userAction(e?.error.frames);
  const doing = action ? ` (after ${action.action})` : "";
  const causeSentences = causes.flatMap((c) => CAUSE_LINES[c]?.summary?.({ model }) ?? []);
  const summary = [
    `${t.saw(s.name, s.plural ? "are" : "is")}${who}${where}${when}${doing}.`,
    t.why(ev, causes),
    ...causeSentences,
    stillHappening(issue, rangeLabel, now),
    `Pass to: ${PASS_TO[labels.owner] ?? PASS_TO.unknown}${service && (labels.owner === "backend" || labels.owner === "third_party") ? ` (${service})` : ""}.`,
  ].join(" ");

  // Technical: category and owner, evidence, where, fix.
  const took = durationText(input.durations?.length ? input.durations : ev.durationMs !== undefined ? [ev.durationMs] : []);
  const evidence = [t.diagnosis(ev, took)];
  if (e?.request) evidence.push(`Request: \`${e.request.method.toUpperCase()} ${e.request.url}\`${service ? ` (${service})` : ""}.`);
  if (causes.includes("resumed_from_background") && ev.msSinceForeground !== undefined)
    evidence.push(`The app came to the foreground ${seconds(ev.msSinceForeground)} before; no request has succeeded since.`);
  if (ev.failedBefore > 0) evidence.push(`${plural(ev.failedBefore, "other request")} failed in the 5 s before${ev.failedHosts.length > 1 ? `, across ${ev.failedHosts.length} hosts` : ""}.`);
  else if (ev.repeatedFailure) evidence.push("The same request had already failed just before.");
  if (causes.includes("slow_network")) evidence.push(`${ev.slowRecent} of the last 5 requests were slow.`);
  if (ev.inBackground) evidence.push("The app was in the background, so the user probably didn't see it.");
  for (const c of causes) if (CAUSE_LINES[c]?.fix) evidence.push(`${CAUSE_INFO[c].name}: ${CAUSE_INFO[c].description}`);
  if (issue.incidentTitle) evidence.push(`Part of the incident "${issue.incidentTitle}".`);

  const whereParts = [issue.culprit ? `\`${issue.culprit}\`` : undefined, action ? `started by \`${action.fn}\` (${action.action})` : undefined].filter(Boolean);
  const fixSteps = [t.fix(ev, causes), ...causes.flatMap((c) => CAUSE_LINES[c]?.fix ?? [])];
  return {
    summary,
    technical: {
      headline: `${CATEGORY_INFO[labels.category]?.name ?? labels.category} · owner: ${OWNER_INFO[labels.owner]?.name ?? labels.owner} · impact: ${IMPACT_INFO[labels.impact]?.name ?? labels.impact}`,
      evidence,
      where: whereParts.length ? whereParts.join(", ") : undefined,
      fix: fixSteps.join(" "),
    },
  };
}

/** The explanation as Markdown lines, without a title: for tickets and prefilled links. */
export function explanationLines(x: Explanation): string[] {
  return [
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
  ];
}

/** The explanation as Markdown, for pasting into a Jira or Linear ticket by hand. */
export function explanationMarkdown(title: string, x: Explanation, link?: string): string {
  return [`## ${title}`, ...(link ? ["", `deBug: ${link}`] : []), "", ...explanationLines(x)].join("\n");
}
