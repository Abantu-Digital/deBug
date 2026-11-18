import { useEffect, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
const axis = { stroke: "var(--muted)", fontSize: 11, tickLine: false, axisLine: false } as const;
const tooltipStyle = {
  contentStyle: { background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12, color: "var(--text)" },
  labelStyle: { color: "var(--muted)" },
  cursor: { fill: "var(--panel-2)" },
};

/** Recharts measures the DOM, so render a same-size placeholder during SSR. */
function ClientOnly({ height, children }: { height: number; children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  return <div style={{ height }}>{ready ? children : null}</div>;
}

/** "13 Nov" for a day, "14:00" for an hour bucket ("YYYY-MM-DDTHH"). */
const shortDay = (d: string) =>
  d.length === 13
    ? `${d.slice(11)}:00`
    : new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

export function TrendChart({ data, markers = [] }: { data: { day: string; errors: number }[]; markers?: { day: string; label: string }[] }) {
  // Snap each marker to the point it falls in (weekly charts are labelled by week start).
  const days = data.map((d) => d.day);
  const snapped = markers
    .map((m) => ({ ...m, x: [...days].reverse().find((d) => d <= m.day) }))
    .filter((m): m is { day: string; label: string; x: string } => !!m.x);
  return (
    <ClientOnly height={220}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }} accessibilityLayer>
          <defs>
            <linearGradient id="errFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-errors)" stopOpacity={0.35} />
              <stop offset="100%" stopColor="var(--chart-errors)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
          <XAxis dataKey="day" tickFormatter={shortDay} {...axis} minTickGap={16} />
          <YAxis allowDecimals={false} {...axis} />
          <Tooltip {...tooltipStyle} labelFormatter={(d) => shortDay(String(d))} />
          <Area type="monotone" dataKey="errors" name="Errors" stroke="var(--chart-errors)" strokeWidth={2} fill="url(#errFill)" />
          {snapped.map((m) => (
            <ReferenceLine
              key={`${m.label}${m.day}`}
              x={m.x}
              stroke="var(--chart-events)"
              strokeDasharray="3 3"
              label={{ value: m.label, position: "insideTopLeft", fontSize: 10, fill: "var(--chart-events)" }}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </ClientOnly>
  );
}

export function HourlyChart({ data }: { data: { hour: string; count: number }[] }) {
  const label = (h: string) => new Date(`${h}:00:00Z`).toLocaleString(undefined, { hour: "2-digit", day: "numeric", month: "short" });
  return (
    <ClientOnly height={180}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }} accessibilityLayer>
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
          <XAxis dataKey="hour" tickFormatter={(h) => new Date(`${h}:00:00Z`).toLocaleTimeString(undefined, { hour: "2-digit" })} {...axis} minTickGap={24} />
          <YAxis allowDecimals={false} {...axis} />
          <Tooltip {...tooltipStyle} labelFormatter={(h) => label(String(h))} formatter={(v) => [v, "Occurrences"]} />
          <Bar dataKey="count" fill="var(--chart-errors)" radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </ClientOnly>
  );
}
