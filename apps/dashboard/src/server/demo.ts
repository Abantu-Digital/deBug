import { MemoryStore } from "@debug/adapters/memory";
import { ingest } from "@debug/ingest";
import type { EnvelopeInput, EventInput } from "@debug/schema";

/**
 * Builds a realistic 14-day dataset for a fictional app by pushing synthetic SDK
 * envelopes through the real ingest pipeline (so fingerprints/rollups are genuine).
 */
export async function seedDemo(): Promise<MemoryStore> {
  const store = new MemoryStore();
  const rand = mulberry32(42);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
  const keys = { pk_demo: "megaton-native" };
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
        { category: "network", message: "POST /v2/auth/otp/verify → 200 (body: {\"session\":{...}})" },
      ],
    },
    {
      flow: "checkout.payment",
      step: "create_intent",
      weight: (_d, dev) => (dev.os.name === "ios" ? 0.6 : 0.9),
      error: () => ({ name: "NetworkError", message: `Request timed out after ${pick([15000, 20000, 30000])}ms`, stack: stack("createPaymentIntent", "services/payments.ts", 54) }),
      crumbs: [
        { category: "navigation", message: "Cart → Checkout" },
        { category: "network", message: "POST /v1/payments/intent → timeout", level: "error" },
      ],
    },
    {
      flow: "feed.load",
      step: "parse",
      weight: () => 0.35,
      error: () => ({ name: "SyntaxError", message: "JSON Parse error: Unexpected token '<'", stack: stack("loadFeed", "features/feed/useFeed.ts", 23) }),
      crumbs: [{ category: "network", message: "GET /v1/feed?page=2 → 502", level: "error" }],
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

  const successFlows = ["auth.login", "checkout.payment", "feed.load", "profile.update"];

  for (let dayAgo = 13; dayAgo >= 0; dayAgo--) {
    const version = dayAgo <= 3 ? pick(["2.4.0", "2.4.0", "2.4.0", "2.3.1"]) : pick(["2.3.1", "2.3.1", "2.3.0"]);
    for (let s = 0; s < 70; s++) {
      const ts = new Date(now - dayAgo * 86_400_000 - Math.floor(rand() * 86_400_000)).toISOString();
      const dev = pick(devices);
      const appVersion = rand() < 0.85 ? version : "2.3.1";
      const events: EventInput[] = [];
      const userId = `user_${Math.floor(rand() * 400)}`;

      for (const sc of scenarios) {
        const w = sc.weight(dayAgo, dev, appVersion);
        let n = Math.floor(w) + (rand() < w % 1 ? 1 : 0);
        while (n-- > 0) {
          const err = sc.error();
          events.push({
            type: "error",
            id: `evt_${(seq++).toString().padStart(10, "0")}`,
            ts,
            flow: sc.flow,
            step: sc.step,
            handled: true,
            error: err,
            breadcrumbs: (sc.crumbs ?? []).map((c) => ({ ts, level: c.level ?? "info", ...c })),
          });
          events.push({ type: "event", id: `evt_${(seq++).toString().padStart(10, "0")}`, ts, name: `${sc.flow}.${sc.step}`, flow: sc.flow, step: sc.step, outcome: "failure" });
        }
      }
      for (const flow of successFlows) {
        if (rand() < 0.55)
          events.push({ type: "event", id: `evt_${(seq++).toString().padStart(10, "0")}`, ts, name: `${flow}.complete`, flow, outcome: "success" });
      }
      if (!events.length) continue;

      const env: EnvelopeInput = {
        sdk: { name: "@debug/sdk", version: "0.1.0" },
        context: {
          app: { id: "megaton-native", version: appVersion, build: appVersion.replace(/\./g, "") + "0", environment: "production" },
          ...dev,
          runtime: { name: "react-native", version: "0.79", engine: "hermes" },
          network: { type: pick(networks) },
          locale: "en-ZA",
          timezone: "Africa/Johannesburg",
        },
        user: { id: userId, anonymousId: `anon_${userId}` },
        session: { id: `sess_${seq}`, startedAt: ts },
        events,
      };
      const out = await ingest(JSON.stringify(env), "pk_demo", { store, keys, now: () => new Date(Date.parse(ts) + 1000) });
      if (out.status !== 202) throw new Error(`demo seed rejected: ${JSON.stringify(out.body)}`);
    }
  }
  return store;
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
