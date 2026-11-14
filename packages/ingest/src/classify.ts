import type { Breadcrumb, Category, Cause, Classification, ErrorEvent, Impact, Owner } from "@debugkit/schema";

/**
 * Labels for one error: category, likely owner, user impact and cause patterns. The rules, and
 * why each one is what it is, are in docs/taxonomy.md; keep the two in step.
 *
 * Decided per error from the error itself and its breadcrumbs, which only hold what happened
 * before it. Issue-level causes (new in this release, regressed, one device) are added by
 * `issueCauses`, from the issue.
 */
export interface ClassifyOptions {
  /** Flows marked critical in Settings: an error in one blocks the user. */
  criticalFlows?: readonly string[];
}

const FOREGROUND = "App came to the foreground";
const BACKGROUND = "App went to the background";
const NEVER_SENT_MS = 100;
/** How long after reopening a failure still counts as "on resume", if nothing has succeeded since. */
const RESUME_WINDOW_MS = 10_000;
const BURST_WINDOW_MS = 5_000;

const CRASH_SOURCES = new Set(["global-handler", "uncaughtException"]);
const REJECTION_SOURCES = new Set(["unhandled-rejection", "unhandledrejection", "unhandledRejection"]);

/** "GET host/path → 200 (93ms)", as the SDK writes network breadcrumbs. */
const NETWORK_CRUMB = /^\S+ (\S+) → /;
/** "GET host/path timed out", optionally followed by ": <cause>", as the SDK writes a timed-out request. */
const TIMED_OUT = /^\S+ \S+ timed out(?::|$)/;

interface CrumbRequest {
  url: string;
  status?: number;
  failed: boolean;
}

const hostOf = (url: string) => url.replace(/^[a-z]+:\/\//i, "").split("/")[0] ?? "";

function crumbRequest(b: Breadcrumb): CrumbRequest | undefined {
  if (b.category !== "network") return undefined;
  const m = NETWORK_CRUMB.exec(b.message);
  if (!m) return undefined;
  const status = typeof b.data?.status === "number" ? b.data.status : undefined;
  return { url: m[1]!, status, failed: b.level === "error" };
}

/** A request that got a good answer: 2xx or 3xx. */
const succeeded = (r: CrumbRequest) => !r.failed && r.status !== undefined && r.status < 400;

/**
 * The breadcrumbs before this error. The SDK records a failed request's own breadcrumb just
 * before reporting it; that one is the error, not something that happened before it. The SDK
 * also merges identical breadcrumbs in a row into one with `data.repeated`: when the error's own
 * breadcrumb says so, the same request had already failed just before.
 */
function earlierCrumbs(e: ErrorEvent): { crumbs: Breadcrumb[]; repeatedFailure: boolean } {
  const crumbs = e.breadcrumbs ?? [];
  const r = e.request;
  if (!r) return { crumbs, repeatedFailure: false };
  const own = `${r.method} ${r.url} → `.toUpperCase();
  for (let i = crumbs.length - 1; i >= 0; i--) {
    const b = crumbs[i]!;
    if (b.category === "network" && b.level === "error" && b.message.toUpperCase().startsWith(own))
      return { crumbs: [...crumbs.slice(0, i), ...crumbs.slice(i + 1)], repeatedFailure: Number(b.data?.repeated ?? 1) > 1 };
  }
  return { crumbs, repeatedFailure: false };
}

function category(e: ErrorEvent): Category {
  const r = e.request;
  const source = e.tags?.source;
  if (r && r.status === undefined) {
    // network.offline needs the phone's network state, which the SDK doesn't send yet.
    if (TIMED_OUT.test(e.error.message)) return "network.timeout";
    if (r.durationMs !== undefined && r.durationMs < NEVER_SENT_MS) return "network.never_sent";
    return "network.failed";
  }
  if (r?.status !== undefined) {
    if (r.status === 401 || r.status === 403) return "auth";
    if (r.status >= 500 && r.status <= 599) return "server";
    if (r.status >= 400 && r.status <= 499) return "client_request";
  }
  if (!e.handled && source && CRASH_SOURCES.has(source) && e.severity === "critical") return "crash";
  if (source === "error-boundary") return "screen_crash";
  if (source && REJECTION_SOURCES.has(source)) return "unhandled_rejection";
  if (!e.handled) return "uncaught";
  if (!r) return "app_reported";
  return "other";
}

/** The last foreground/background breadcrumb before the error. */
function lastLifecycle(crumbs: Breadcrumb[]): Breadcrumb | undefined {
  for (let i = crumbs.length - 1; i >= 0; i--) {
    const b = crumbs[i]!;
    if (b.category === "ui" && (b.message === FOREGROUND || b.message === BACKGROUND)) return b;
  }
  return undefined;
}

function eventCauses(e: ErrorEvent, cat: Category, crumbs: Breadcrumb[], repeatedFailure: boolean): { causes: Cause[]; burstHosts: Set<string> } {
  const causes: Cause[] = [];
  const at = Date.parse(e.ts);
  const within = (b: Breadcrumb, ms: number) => {
    const d = at - Date.parse(b.ts);
    return d >= 0 && d <= ms;
  };

  const requests = crumbs.map((b) => ({ b, r: crumbRequest(b) })).filter((x): x is { b: Breadcrumb; r: CrumbRequest } => !!x.r);

  // Reopened recently, and no request has worked since: the connection never came back.
  const life = lastLifecycle(crumbs);
  if (life?.message === FOREGROUND && within(life, RESUME_WINDOW_MS)) {
    const since = Date.parse(life.ts);
    const worked = requests.some((x) => Date.parse(x.b.ts) >= since && succeeded(x.r));
    if (!worked) causes.push("resumed_from_background");
  }

  const burst = requests.filter((x) => x.r.failed && within(x.b, BURST_WINDOW_MS));
  const burstHosts = new Set(burst.map((x) => hostOf(x.r.url)));
  if (burst.length >= 1 || repeatedFailure) {
    causes.push("burst");
    if (e.request) burstHosts.add(hostOf(e.request.url));
  }

  if (requests.slice(-5).filter((x) => x.b.level === "warning").length >= 2) causes.push("slow_network");

  if (cat === "auth" && e.request) {
    const host = hostOf(e.request.url);
    if (requests.some((x) => hostOf(x.r.url) === host && succeeded(x.r))) causes.push("auth_expired");
  }
  return { causes, burstHosts };
}

function owner(cat: Category, causes: Cause[], burstHosts: Set<string>): Owner {
  switch (cat) {
    case "network.never_sent":
    case "client_request":
    case "crash":
    case "screen_crash":
    case "unhandled_rejection":
    case "uncaught":
    case "app_reported":
      return "app";
    case "server":
      return "backend";
    case "auth":
      return causes.includes("auth_expired") ? "app" : "unknown";
    case "network.timeout":
    case "network.failed":
      return causes.includes("burst") && burstHosts.size > 1 ? "infrastructure" : "unknown";
    default:
      return "unknown";
  }
}

function impact(e: ErrorEvent, cat: Category, crumbs: Breadcrumb[], critical: ReadonlySet<string>): Impact {
  if (cat === "crash" || (e.flow && critical.has(e.flow))) return "blocked";
  if (lastLifecycle(crumbs)?.message === BACKGROUND) return "silent";
  if (cat === "app_reported" && !e.flow) return "silent";
  return "degraded";
}

/**
 * `e.ts` must be the device's own time, as sent: breadcrumbs carry device time too, and the time
 * rules compare the two. Ingest pins skewed clocks to the server's time for storage; classify
 * before that.
 */
export function classify(e: ErrorEvent, opts: ClassifyOptions = {}): Classification {
  const { crumbs, repeatedFailure } = earlierCrumbs(e);
  const cat = category(e);
  const { causes, burstHosts } = eventCauses(e, cat, crumbs, repeatedFailure);
  return {
    category: cat,
    owner: owner(cat, causes, burstHosts),
    impact: impact(e, cat, crumbs, new Set(opts.criticalFlows ?? [])),
    causes,
  };
}

/** What the issue adds to an error's causes. */
export interface IssueFacts {
  status?: string;
  firstVersion?: string;
  /** The newest app version seen for the app. */
  latestVersion?: string | null;
  /** Device models of recent occurrences, when known. */
  deviceModels?: readonly (string | undefined)[];
}

const SINGLE_DEVICE_MIN = 5;

export function issueCauses(f: IssueFacts): Cause[] {
  const causes: Cause[] = [];
  if (f.latestVersion && f.firstVersion === f.latestVersion) causes.push("new_in_release");
  if (f.status === "regressed") causes.push("regressed");
  const models = f.deviceModels ?? [];
  if (models.length >= SINGLE_DEVICE_MIN && models[0] && models.every((m) => m === models[0])) causes.push("single_device");
  return causes;
}

/** An error's labels with its issue's causes added, without repeats. */
export function withIssueCauses(labels: Classification, f: IssueFacts): Classification {
  const extra = issueCauses(f).filter((c) => !labels.causes.includes(c));
  return extra.length ? { ...labels, causes: [...labels.causes, ...extra] } : labels;
}
