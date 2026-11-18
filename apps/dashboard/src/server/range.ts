/** The date range a dashboard view covers, worked out from the URL (range=7d, or from/to). */

export const RANGE_PRESETS = ["24h", "7d", "14d", "30d", "90d"] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number] | "custom";
export type Granularity = "hour" | "day" | "week";

export interface DateRange {
  preset: RangePreset;
  /** First and last UTC day included, YYYY-MM-DD. For 24h these are the days the 24 hours touch. */
  from: string;
  to: string;
  /** Length in days (24h counts as 1). */
  days: number;
  /** "the last 7 days", "1 Nov – 13 Nov". */
  label: string;
  /** "7 days", "24 hours": for "vs the previous …". */
  span: string;
  /** The period of the same length just before this one. */
  prevFrom: string;
  prevTo: string;
  granularity: Granularity;
}

const DAY = 86_400_000;
export const MAX_RANGE_DAYS = 730;
const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function short(day: string) {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

export function resolveRange(input: { range?: string; from?: string; to?: string }, now = Date.now()): DateRange {
  const today = dayKey(now);
  let preset: RangePreset = (RANGE_PRESETS as readonly string[]).includes(input.range ?? "") ? (input.range as RangePreset) : "14d";
  let from: string;
  let to = today;
  let days: number;

  const customOk =
    input.range === "custom" &&
    ISO_DAY.test(input.from ?? "") &&
    ISO_DAY.test(input.to ?? "") &&
    !Number.isNaN(Date.parse(input.from!)) &&
    !Number.isNaN(Date.parse(input.to!));
  if (customOk) {
    preset = "custom";
    to = input.to! > today ? today : input.to!;
    from = input.from! > to ? to : input.from!;
    days = Math.round((Date.parse(to) - Date.parse(from)) / DAY) + 1;
    if (days > MAX_RANGE_DAYS) {
      from = dayKey(Date.parse(to) - (MAX_RANGE_DAYS - 1) * DAY);
      days = MAX_RANGE_DAYS;
    }
  } else if (preset === "24h") {
    from = dayKey(now - DAY);
    days = 1;
  } else {
    days = Number(preset.replace("d", ""));
    from = dayKey(now - (days - 1) * DAY);
  }

  const prevTo = dayKey(Date.parse(from) - DAY);
  const prevFrom = dayKey(Date.parse(from) - days * DAY);
  const span = preset === "24h" ? "24 hours" : `${days} day${days === 1 ? "" : "s"}`;
  const label = preset === "custom" ? (from === to ? short(from) : `${short(from)} – ${short(to)}`) : `the last ${span}`;
  const granularity: Granularity = preset === "24h" ? "hour" : days > 90 ? "week" : "day";
  return { preset, from, to, days, label, span, prevFrom, prevTo, granularity };
}

/** The range as ISO instants: the last 24 hours for "24h", else whole UTC days from `from` to `to`. */
export function rangeBounds(range: DateRange, now = Date.now()): { start: string; end: string } {
  if (range.preset === "24h") return { start: new Date(now - 86_400_000).toISOString(), end: new Date(now).toISOString() };
  return { start: `${range.from}T00:00:00.000Z`, end: `${range.to}T23:59:59.999Z` };
}

/** Every UTC day from `from` to `to`, inclusive. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY) out.push(dayKey(t));
  return out;
}

/** The Monday a day's week starts on, for weekly buckets. */
export function weekOf(day: string): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  const dow = (new Date(t).getUTCDay() + 6) % 7;
  return dayKey(t - dow * DAY);
}
