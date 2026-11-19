import { MemoryStore } from "@debugkit/adapters/memory";
import { ingest } from "@debugkit/ingest";
import { DASHBOARD_VERSION } from "./versions";
import type { EnvelopeInput, EventInput } from "@debugkit/schema";

/**
 * Builds a realistic 14-day dataset for a fictional app by pushing synthetic SDK
 * envelopes through the real ingest pipeline (so fingerprints/rollups are genuine).
 */
export async function seedDemo(): Promise<MemoryStore> {
  const store = new MemoryStore();
  const rand = mulberry32(42);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
  const keys = DEMO_KEYS;
  const now = Date.now();
  let seq = 0;

  const devices = [
    { os: { name: "android", version: "14" }, device: { model: "SM-S918B", manufacturer: "samsung", type: "phone" as const } },
    { os: { name: "android", version: "14" }, device: { model: "Pixel 8", manufacturer: "Google", type: "phone" as const } },
    { os: { name: "android", version: "13" }, device: { model: "SM-A546E", manufacturer: "samsung", type: "phone" as const } },
    { os: { name: "ios", version: "18.1" }, device: { model: "iPhone 15", manufacturer: "Apple", type: "phone" as const } },
    { os: { name: "ios", version: "17.6" }, device: { model: "iPhone 13", manufacturer: "Apple", type: "phone" as const } },
  ];
  const networks = ["wifi", "cellular", "cellular"] as const;

  const stack = (fn: string, file: string, line: number) =>
    `Error\n    at ${fn} (/app/src/${file}:${line}:17)\n    at onPress (/app/src/components/Button.tsx:31:9)\n    at /app/node_modules/react-native/Libraries/Pressability/Pressability.js:704:17`;

  type Scenario = {
    flow: string;
    step: string;
    weight: (dayAgo: number, d: (typeof devices)[number], version: string) => number;
    error: () => { name: string; message: string; stack: string };
    crumbs?: { category: "network" | "navigation" | "ui"; message: string; level?: "error" | "info" }[];
    /** Unhandled and fatal: the app crashes (feeds crash-free rates). */
    fatal?: boolean;
    /** The failed request the SDK's network capture records alongside the error. */
    request?: { method: string; url: string; status?: number; message: string; captured?: { request: { query?: string; headers?: Record<string, string> }; response: { status: number; headers?: Record<string, string>; body?: string; bodySize?: number } } };
  };

  const scenarios: Scenario[] = [
    {
      // The story: a 2.4.0 regression breaks OTP login on Android 14.
      flow: "auth.login",
      step: "submit_otp",
      weight: (dayAgo, d, v) => (v === "2.4.0" && d.os.name === "android" && d.os.version === "14" ? (dayAgo <= 3 ? 9 : 0) : 0.05),
      error: () => ({ name: "TypeError", message: "Cannot read property 'accessToken' of undefined", stack: stack("handleOtpResponse", "screens/auth/OtpScreen.tsx", 88) }),
      crumbs: [
        { category: "navigation", message: "Login → OtpScreen" },
        { category: "ui", message: "Tapped Verify" },
        { category: "network", message: "POST /v2/auth/otp/verify → 200 (412ms)" },
      ],
      fatal: true,
    },
    {
      flow: "checkout.payment",
      step: "create_intent",
      weight: (_d, dev) => (dev.os.name === "ios" ? 0.6 : 0.9),
      error: () => ({ name: "NetworkError", message: `Request timed out after ${pick([15000, 20000, 30000])}ms`, stack: stack("createPaymentIntent", "services/payments.ts", 54) }),
      crumbs: [
        { category: "navigation", message: "Cart → Checkout" },
        { category: "network", message: "POST /v1/payments/intent → timed out (30000ms)", level: "error" },
      ],
      request: { method: "POST", url: "/v1/payments/intent", message: "POST /v1/payments/intent timed out" },
    },
    {
      flow: "feed.load",
      step: "parse",
      weight: () => 0.35,
      error: () => ({ name: "SyntaxError", message: "JSON Parse error: Unexpected token '<'", stack: stack("loadFeed", "features/feed/useFeed.ts", 23) }),
      crumbs: [{ category: "network", message: "GET /v1/feed → 502 (2210ms)", level: "error" }],
      request: {
        method: "GET",
        url: "/v1/feed",
        status: 502,
        message: "GET /v1/feed responded 502",
        // What the SDK captures with network.bodies (ABA-117), redacted on the phone.
        captured: {
          request: { query: "page=2&session=[redacted]", headers: { accept: "application/json", authorization: "[redacted]", "x-app-version": "2.4.0" } },
          response: { status: 502, headers: { "content-type": "text/html", server: "nginx" }, body: "<html><head><title>502 Bad Gateway</title></head><body><center><h1>502 Bad Gateway</h1></center></body></html>", bodySize: 108 },
        },
      },
    },
    {
      flow: "profile.update",
      step: "upload_avatar",
      weight: () => 0.12,
      error: () => ({ name: "Error", message: "Image exceeds 10MB limit", stack: stack("uploadAvatar", "features/profile/avatar.ts", 41) }),
    },
    {
      flow: "auth.session",
      step: "refresh",
      weight: (dayAgo) => (dayAgo > 7 ? 0.6 : 0.08),
      error: () => ({ name: "AuthError", message: "401 Unauthorized: refresh token expired", stack: stack("refreshSession", "services/auth/session.ts", 112) }),
    },
  ];

  // The step each flow's success is logged under, matching the failing scenario's step.
  const successFlows: [string, string][] = [
    ["auth.login", "submit_otp"],
    ["checkout.payment", "create_intent"],
    ["feed.load", "parse"],
    ["profile.update", "upload_avatar"],
  ];
  // Request timings the SDK would send each minute: [endpoint, typical ms, spread, failure rate].
  const endpoints: [string, number, number, number][] = [
    ["GET /v1/feed", 380, 900, 0.03],
    ["POST /v2/auth/otp/verify", 420, 500, 0.01],
    ["POST /v1/payments/intent", 1900, 9000, 0.06],
    ["GET /v1/profile", 160, 250, 0.002],
  ];
  const EDGES = [50, 100, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 10000];
  // A second generator for timings and places, so the original story's random sequence is unchanged.
  const rand2 = mulberry32(7);
  const pick2 = <T,>(xs: readonly T[]) => xs[Math.floor(rand2() * xs.length)]!;
  // Mostly South Africa, with a few travellers.
  const places: [string, string][] = [
    ["Africa/Johannesburg", "en-ZA"], ["Africa/Johannesburg", "en-ZA"], ["Africa/Johannesburg", "en-ZA"], ["Africa/Johannesburg", "en-US"],
    ["Africa/Johannesburg", "en-ZA"], ["Europe/London", "en-GB"], ["Africa/Windhoek", "en-NA"], ["Africa/Gaborone", "en-BW"],
  ];

  for (let dayAgo = 13; dayAgo >= 0; dayAgo--) {
    const version = dayAgo <= 3 ? pick(["2.4.0", "2.4.0", "2.4.0", "2.3.1"]) : pick(["2.3.1", "2.3.1", "2.3.0"]);
    for (let s = 0; s < 70; s++) {
      const ts = new Date(now - dayAgo * 86_400_000 - Math.floor(rand() * 86_400_000)).toISOString();
      const dev = pick(devices);
      const appVersion = rand() < 0.85 ? version : "2.3.1";
      const events: EventInput[] = [];
      const userId = `user_${Math.floor(rand() * 400)}`;
      const id = () => `evt_${(seq++).toString().padStart(10, "0")}`;
      let crashed = false;

      for (const sc of scenarios) {
        const w = sc.weight(dayAgo, dev, appVersion);
        let n = Math.floor(w) + (rand() < w % 1 ? 1 : 0);
        while (n-- > 0) {
          const err = sc.error();
          if (sc.request) {
            const r = sc.request;
            events.push({
              type: "error",
              id: id(),
              ts,
              flow: sc.flow,
              handled: true,
              tags: { source: "network" },
              error: { name: r.status ? "HttpError" : "NetworkError", message: r.message },
              request: { method: r.method, url: r.url, status: r.status, durationMs: r.status ? 2210 : 30000, ...r.captured?.request },
              ...(r.captured ? { response: r.captured.response } : {}),
              breadcrumbs: (sc.crumbs ?? []).map((c) => ({ ts, level: c.level ?? "info", ...c })),
            });
          }
          if (sc.fatal) crashed = true;
          events.push({
            type: "error",
            id: `evt_${(seq++).toString().padStart(10, "0")}`,
            ts,
            flow: sc.flow,
            step: sc.step,
            handled: !sc.fatal,
            ...(sc.fatal ? { severity: "critical" as const } : {}),
            error: err,
            breadcrumbs: (sc.crumbs ?? []).map((c) => ({ ts, level: c.level ?? "info", ...c })),
          });
          events.push({ type: "event", id: `evt_${(seq++).toString().padStart(10, "0")}`, ts, name: `${sc.flow}.${sc.step}`, flow: sc.flow, step: sc.step, outcome: "failure" });
        }
      }
      for (const [flow, step] of successFlows) {
        if (rand() < 0.55)
          events.push({ type: "event", id: `evt_${(seq++).toString().padStart(10, "0")}`, ts, name: `${flow}.${step}`, flow, step, outcome: "success" });
      }
      for (const [key, typical, spread, failRate] of endpoints) {
        if (rand2() < 0.4) continue;
        const buckets = new Array(13).fill(0);
        const count = 1 + Math.floor(rand2() * 6);
        let errors = 0;
        for (let k = 0; k < count; k++) {
          const msTaken = typical * (0.5 + rand2()) + (rand2() < 0.1 ? rand2() * spread : 0);
          const b = EDGES.findIndex((e) => msTaken <= e);
          buckets[b === -1 ? 12 : b]++;
          if (rand2() < failRate) errors++;
        }
        events.push({ type: "metric", id: id(), ts, name: "http", key, count, errors, buckets });
      }
      // Session markers, as the SDK sends them: started, then errored/crashed at most once.
      events.unshift({ type: "session", id: id(), ts, status: "started" });
      if (crashed) events.push({ type: "session", id: id(), ts, status: "errored" }, { type: "session", id: id(), ts, status: "crashed" });
      if (events.length > 100) events.length = 100;

      const env: EnvelopeInput = {
        // The demo's app is on this release, so the versions read as in step.
        sdk: { name: "@debugkit/sdk", version: DASHBOARD_VERSION },
        context: {
          app: { id: "megatron-native", version: appVersion, build: appVersion.replace(/\./g, "") + "0", environment: "production" },
          ...dev,
          runtime: { name: "react-native", version: "0.79", engine: "hermes" },
          network: { type: pick(networks) },
          ...(([timezone, locale]) => ({ timezone, locale }))(pick2(places)),
        },
        user: { id: userId, anonymousId: `anon_${userId}` },
        session: { id: `sess_${seq}`, startedAt: ts },
        events,
      };
      const out = await ingest(JSON.stringify(env), "pk_demo", { store, keys, now: () => new Date(Date.parse(ts) + 1000) });
      if (out.status !== 202) throw new Error(`demo seed rejected: ${JSON.stringify(out.body)}`);
    }
  }
  await seedUpstreamOutage(store, keys, now);
  return store;
}

/** Our gateway, and the part of it that passes calls on to Cell C (the upstream). */
export const DEMO_GATEWAY = "api.megatron.example";
export const DEMO_UPSTREAM = `${DEMO_GATEWAY}/ppd/api/balance`;

/**
 * The upstream story: Cell C's balance service stops answering in the last few minutes, for many
 * customers at once. Settings names our gateway "ours" and its /ppd/api/balance path "upstream,
 * Cell C", so Health reads it as a Cell C outage, not our backend or the app. It has its own
 * random generator and runs after the rest, so the other stories don't change.
 */
async function seedUpstreamOutage(store: MemoryStore, keys: Record<string, string>, now: number): Promise<void> {
  await store.putSettings(DEMO_APP, {
    hosts: [
      { match: DEMO_GATEWAY, name: "Megatron API", kind: "ours", owner: "backend" },
      { match: DEMO_UPSTREAM, name: "Balance", kind: "upstream", provider: "Cell C", owner: "third_party" },
    ],
  });
  const send = upstreamSender(store, keys);
  // Every hour for 14 days, until 20 minutes ago: both work.
  for (let h = 14 * 24; h >= 1; h--) {
    const ts = new Date(now - h * 3_600_000 - 20 * 60_000).toISOString();
    await send(ts, `user_${h % 400}`, [
      { type: "metric", id: send.id(), ts, name: "http", key: BALANCE_KEY, count: 3, errors: 0, buckets: [0, 0, 0, 1, 2, 0, 0, 0, 0, 0, 0, 0, 0] },
      { type: "metric", id: send.id(), ts, name: "http", key: ACCOUNT_KEY, count: 4, errors: 0, buckets: [0, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    ]);
  }
  await upstreamBurst(send, now);
}

const DEMO_APP = "megatron-native";
const DEMO_KEYS = { pk_demo: DEMO_APP };
const BALANCE_URL = `${DEMO_UPSTREAM}/getBalances`;
const BALANCE_KEY = `POST ${BALANCE_URL}`;
const ACCOUNT_KEY = `GET ${DEMO_GATEWAY}/v1/account`;

type UpstreamSender = ((ts: string, userId: string, events: EventInput[]) => Promise<void>) & { id: () => string };

/** Sends the upstream story's envelopes through the real ingest, with ids of its own. */
function upstreamSender(store: MemoryStore, keys: Record<string, string>, prefix = "evt_up"): UpstreamSender {
  let seq = 0;
  const id = () => `${prefix}_${(seq++).toString().padStart(8, "0")}`;
  const send = async (ts: string, userId: string, events: EventInput[]) => {
    const env: EnvelopeInput = {
      sdk: { name: "@debugkit/sdk", version: DASHBOARD_VERSION },
      context: {
        app: { id: DEMO_APP, version: "2.4.0", build: "2400", environment: "production" },
        os: { name: seq % 5 < 3 ? "android" : "ios", version: "14" },
        device: { model: "Phone", manufacturer: "Generic", type: "phone" },
        runtime: { name: "react-native", version: "0.79", engine: "hermes" },
        network: { type: "cellular" },
        timezone: "Africa/Johannesburg",
        locale: "en-ZA",
      },
      user: { id: userId, anonymousId: `anon_${userId}` },
      session: { id: `sess_${prefix}_${seq}`, startedAt: ts },
      events,
    };
    const out = await ingest(JSON.stringify(env), "pk_demo", { store, keys, now: () => new Date(Date.parse(ts) + 1000) });
    if (out.status !== 202) throw new Error(`demo seed rejected: ${JSON.stringify(out.body)}`);
  };
  return Object.assign(send, { id });
}

/** The 8 minutes before `now`: Cell C's balance service answers 503 or nothing, for 7 customers. */
async function upstreamBurst(send: UpstreamSender, now: number): Promise<void> {
  for (let k = 0; k < 7; k++) {
    const ts = new Date(now - (8 - k) * 60_000).toISOString();
    const timedOut = k % 3 === 2;
    await send(ts, `user_up_${k}`, [
      { type: "metric", id: send.id(), ts, name: "http", key: BALANCE_KEY, count: 2, errors: 2, buckets: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1] },
      {
        type: "error",
        id: send.id(),
        ts,
        flow: "balance.view",
        handled: true,
        tags: { source: "network" },
        error: timedOut ? { name: "NetworkError", message: `${BALANCE_KEY} timed out` } : { name: "HttpError", message: `${BALANCE_KEY} responded 503` },
        request: { method: "POST", url: BALANCE_URL, status: timedOut ? undefined : 503, durationMs: timedOut ? 30000 : 8200 },
        ...(timedOut ? {} : { response: { status: 503, headers: { "content-type": "application/json" }, body: '{"code":"30007","message":"Balance lookup unsuccessful: upstream unavailable"}' } }),
        breadcrumbs: [
          { ts, level: "info", category: "navigation", message: "Home → Balance" },
          { ts, level: "error", category: "network", message: `${BALANCE_KEY} → ${timedOut ? "timed out (30000ms)" : "503 (8200ms)"}` },
        ],
      },
    ]);
  }
}

/**
 * The demo is seeded once, so "the last 15 minutes" would soon be empty: every 5 minutes, Cell C
 * stays down for another burst, and the dashboard forgets what it read. The timer doesn't keep the
 * process alive. Returns a stop function.
 */
export function keepUpstreamDown(store: MemoryStore, onChange: () => void, everyMs = 5 * 60_000): () => void {
  let n = 0;
  const timer = setInterval(() => {
    // Ids of its own for each burst.
    const send = upstreamSender(store, DEMO_KEYS, `evt_up${++n}`);
    void upstreamBurst(send, Date.now()).then(onChange, (err: Error) => console.warn(`deBug demo: couldn't add the Cell C burst: ${err.message}`));
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
