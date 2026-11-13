import { useState } from "react";

export type RangeSearch = { range?: string; from?: string; to?: string };

const PRESETS: [string, string][] = [
  ["24h", "Last 24 hours"],
  ["7d", "Last 7 days"],
  ["14d", "Last 14 days"],
  ["30d", "Last 30 days"],
  ["90d", "Last 90 days"],
  ["custom", "Custom range…"],
];

export function rangeSearch(s: Record<string, unknown>): RangeSearch {
  const pick = (k: string) => (typeof s[k] === "string" ? (s[k] as string) : undefined);
  return { range: pick("range"), from: pick("from"), to: pick("to") };
}

/** Preset select, plus two date inputs for a custom range. Calls onChange with the new search params. */
export function RangePicker({ value, today, onChange }: { value: RangeSearch & { preset: string; from: string; to: string }; today: string; onChange: (r: RangeSearch) => void }) {
  const [custom, setCustom] = useState(value.preset === "custom");
  const [from, setFrom] = useState(value.from);
  const [to, setTo] = useState(value.to);
  const input = "rounded-md border border-line bg-panel px-2 py-1.5 text-sm";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        aria-label="Date range"
        value={custom ? "custom" : value.preset}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "custom") return setCustom(true);
          setCustom(false);
          onChange({ range: v === "14d" ? undefined : v, from: undefined, to: undefined });
        }}
        className={input}
      >
        {PRESETS.map(([v, label]) => (
          <option key={v} value={v}>{label}</option>
        ))}
      </select>
      {custom && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (from && to) onChange({ range: "custom", from: from <= to ? from : to, to: from <= to ? to : from });
          }}
        >
          <input type="date" aria-label="From" value={from} max={today} onChange={(e) => setFrom(e.target.value)} className={input} />
          <span className="text-muted">to</span>
          <input type="date" aria-label="To" value={to} max={today} onChange={(e) => setTo(e.target.value)} className={input} />
          <button type="submit" className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white">Apply</button>
        </form>
      )}
    </div>
  );
}

/** "Counts kept forever; details from 14 Sep" — shown when the range reaches past retention. */
export function RetentionNote({ rangeFrom, retention }: { rangeFrom: string; retention: { days: number | null; detailsFrom: string | null } }) {
  if (!retention.detailsFrom || rangeFrom >= retention.detailsFrom) return null;
  const when = new Date(`${retention.detailsFrom}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return (
    <p className="rounded-lg border border-line bg-panel-2 px-3 py-2 text-xs text-muted">
      Raw events are kept for {retention.days} days, so details (stack traces, breadcrumbs) before {when} have expired. The counts and charts still cover the whole range.
    </p>
  );
}
