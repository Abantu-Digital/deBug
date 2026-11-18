import { AIRPLANE_TAG, nameUrl, type HostName, type StoredEvent } from "@debugkit/schema";

/**
 * A phone going offline (ABA-132): the calls that never left it, close together, read as one
 * burst. Ingest puts every such failure in the one offline issue; this groups that issue's
 * occurrences back into what happened to each phone.
 */
export interface OfflineBurst {
  /** First and last failure in the burst. */
  start: string;
  end: string;
  /** The install (anonymous id), else the session: "which phone". */
  phone: string;
  os: string;
  device?: string;
  appVersion?: string;
  /** The calls that never left the phone, named by Settings, most first. */
  calls: { call: string; count: number }[];
  failures: number;
  /** The phone said airplane mode was on (AIRPLANE_TAG). */
  airplaneMode: boolean;
}

/**
 * Failures this close together on one phone are one burst. Longer than ingest's BURST_WINDOW_MS
 * (5 s, "several at once"), on purpose: a phone that stays offline keeps failing every few
 * seconds or minutes as the app polls, and that is still one time it went offline.
 */
export const BURST_GAP_MS = 60_000;

export function offlineBursts(events: readonly StoredEvent[], hosts: readonly HostName[] = []): OfflineBurst[] {
  const errors = events.filter((e) => e.event.type === "error");
  const byPhone = new Map<string, StoredEvent[]>();
  for (const e of errors) {
    const phone = e.user?.anonymousId ?? e.sessionId;
    byPhone.set(phone, [...(byPhone.get(phone) ?? []), e]);
  }
  const bursts: OfflineBurst[] = [];
  for (const [phone, list] of byPhone) {
    const sorted = [...list].sort((a, b) => Date.parse(a.event.ts) - Date.parse(b.event.ts));
    let cur: StoredEvent[] = [];
    const close = () => {
      if (!cur.length) return;
      const first = cur[0]!;
      const last = cur[cur.length - 1]!;
      const counts = new Map<string, number>();
      for (const e of cur) {
        const r = e.event.type === "error" ? e.event.request : undefined;
        const call = r ? `${r.method.toUpperCase()} ${nameUrl(r.url, hosts)}` : "unknown call";
        counts.set(call, (counts.get(call) ?? 0) + 1);
      }
      bursts.push({
        start: first.event.ts,
        end: last.event.ts,
        phone,
        os: `${last.context.os.name} ${last.context.os.version ?? ""}`.trim(),
        device: last.context.device.model,
        appVersion: last.context.app.version,
        calls: [...counts].map(([call, count]) => ({ call, count })).sort((a, b) => b.count - a.count),
        failures: cur.length,
        airplaneMode: cur.some((e) => e.event.tags?.[AIRPLANE_TAG] === "true"),
      });
      cur = [];
    };
    for (const e of sorted) {
      if (cur.length && Date.parse(e.event.ts) - Date.parse(cur[cur.length - 1]!.event.ts) > BURST_GAP_MS) close();
      cur.push(e);
    }
    close();
  }
  return bursts.sort((a, b) => b.start.localeCompare(a.start));
}

/** How many bursts on how many phones, for Health's Folded away line. */
export function burstSummary(bursts: readonly OfflineBurst[]): { bursts: number; phones: number; lastSeen?: string } {
  return { bursts: bursts.length, phones: new Set(bursts.map((b) => b.phone)).size, lastSeen: bursts[0]?.end };
}

/** The offline issue's occurrences in a range: [start, end]. */
export const inRange = (events: readonly StoredEvent[], start: string, end: string): StoredEvent[] => events.filter((e) => e.event.ts >= start && e.event.ts <= end);
