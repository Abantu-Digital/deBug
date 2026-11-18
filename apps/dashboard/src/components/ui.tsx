import type { CSSProperties, ReactNode } from "react";
import { Link, type LinkProps } from "@tanstack/react-router";
import { SEVERITY_INFO, type Severity } from "@debugkit/schema";
import type { HealthLevel } from "~/lib/health";

export function Logo() {
  return (
    <span className="inline-flex items-center gap-2 font-semibold tracking-tight">
      <span className="grid h-7 w-7 place-items-center rounded-md bg-sev-critical text-[11px] font-bold text-white">dB</span>
      <span>
        de<span className="text-sev-critical">Bug</span>
      </span>
    </span>
  );
}

/* ---------- Issue levels (ABA-139): words always, colour too; green only for healthy services and journeys */

type Tone = HealthLevel;

/** Full class names (not built from parts) so Tailwind keeps them. */
const TONE: Record<Tone, { surface: string; edge: string; text: string }> = {
  critical: { surface: "bg-level-critical-bg text-level-critical-fg border-level-critical-edge", edge: "border-level-critical-edge", text: "text-level-critical-fg" },
  high: { surface: "bg-level-high-bg text-level-high-fg border-level-high-edge", edge: "border-level-high-edge", text: "text-level-high-fg" },
  medium: { surface: "bg-level-medium-bg text-level-medium-fg border-level-medium-edge", edge: "border-level-medium-edge", text: "text-level-medium-fg" },
  low: { surface: "bg-level-low-bg text-level-low-fg border-level-low-edge", edge: "border-level-low-edge", text: "text-level-low-fg" },
  healthy: { surface: "bg-level-healthy-bg text-level-healthy-fg border-level-healthy-edge", edge: "border-level-healthy-edge", text: "text-level-healthy-fg" },
};

/** A level's classes: `surface` fills a box (background, text, edge), `edge` and `text` colour one part. */
export const toneClass = (level: Tone, part: "surface" | "edge" | "text"): string => TONE[level][part];

/** An issue's level, in words and colour. */
export function LevelBadge({ level }: { level: Severity }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${TONE[level].surface}`} title={SEVERITY_INFO[level].description}>
      {SEVERITY_INFO[level].name}
    </span>
  );
}

/**
 * A row in a list ranked by level: a coloured block with the level in words (and, say, the
 * customers affected), then the row's content. The block sits on top at phone width.
 */
export function LevelRow({ level, aside, children }: { level: Tone; aside?: ReactNode; children: ReactNode }) {
  return (
    <div className={`flex flex-col overflow-hidden rounded-xl border bg-panel sm:flex-row ${TONE[level].edge}`}>
      <div className={`flex shrink-0 flex-row items-center justify-between gap-2 px-3 py-2 sm:w-28 sm:flex-col sm:justify-center sm:py-3 sm:text-center ${TONE[level].surface}`}>
        <strong className="text-sm">{levelName(level)}</strong>
        {aside && <span className="text-xs">{aside}</span>}
      </div>
      <div className="min-w-0 flex-1 p-3 sm:p-4">{children}</div>
    </div>
  );
}

/** A level's name, healthy included. */
export const levelName = (level: Tone): string => (level === "healthy" ? "Healthy" : SEVERITY_INFO[level].name);

/**
 * A box on the health wall: the whole box in its level's colour, so the wall reads at a glance.
 * The whole box is a link one level down, and looks it (arrow, lift on hover, focus ring). A
 * critical one still failing in the last hour pulses; any still failing says so.
 */
export function HealthBox({ level, name, headline, measure, live, lastFailure, link, big, now }: {
  level: Tone;
  name: string;
  headline?: string;
  measure: string;
  live: boolean;
  lastFailure?: string;
  link: LinkProps;
  big?: boolean;
  /** The time the page's data was read, so the server and the browser print the same "last …". */
  now: number;
}) {
  return (
    <Link
      {...link}
      style={{ "--alarm": `var(--level-${level}-edge)` } as CSSProperties}
      aria-label={`${name}: ${levelName(level)}. ${headline ? `${headline}. ` : ""}${measure}.${live ? " Still happening." : ""}`}
      className={`group relative flex h-full flex-col gap-1.5 rounded-xl border-2 p-4 pr-10 transition hover:-translate-y-0.5 hover:shadow-lg hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${TONE[level].surface} ${live && level === "critical" ? "level-alarm" : ""}`}
    >
      <span className="flex flex-wrap items-center gap-2 text-[11px] font-bold uppercase tracking-wide">
        {levelName(level)}
        {live && (
          <span className="inline-flex items-center gap-1 normal-case">
            <span className="relative flex h-2 w-2" aria-hidden>
              <span className="absolute inline-flex h-full w-full rounded-full bg-current opacity-75 motion-safe:animate-ping" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-current" />
            </span>
            Still happening
          </span>
        )}
      </span>
      <strong className={`break-words leading-tight ${big ? "text-2xl" : "text-lg"}`}>{name}</strong>
      {headline && <span className={`break-words font-mono ${big ? "text-sm" : "line-clamp-2 text-xs"}`}>{headline}</span>}
      <span className="tabular mt-auto pt-1 text-xs opacity-90">
        {measure}
        {lastFailure && level !== "healthy" ? ` · last ${timeAgo(lastFailure, now)}` : ""}
      </span>
      <span aria-hidden className="absolute right-3 top-1/2 -translate-y-1/2 text-xl opacity-60 transition group-hover:translate-x-0.5 group-hover:opacity-100">→</span>
    </Link>
  );
}

export function Card({ title, subtitle, children, right }: { title: string; subtitle?: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="min-w-0 rounded-xl border border-line bg-panel p-4 sm:p-5">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: Severity }) {
  const color = tone === "critical" ? "text-sev-critical" : tone === "high" ? "text-sev-high" : "text-ink";
  return (
    <div className="rounded-xl border border-line bg-panel p-4">
      <div className="text-xs text-muted">{label}</div>
      <div className={`tabular mt-1 text-2xl font-semibold ${color}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </div>
  );
}

/** Collapsible table with the exact numbers behind a chart. */
export function DataTable({ columns, rows }: { columns: string[]; rows: (string | number)[][] }) {
  return (
    <details className="mt-3 text-xs">
      <summary className="cursor-pointer text-muted hover:text-ink">View data</summary>
      <div className="mt-2 max-h-64 overflow-auto rounded-md border border-line">
        <table className="tabular w-full text-left">
          <thead className="sticky top-0 bg-panel-2">
            <tr>{columns.map((c) => <th key={c} className="px-2 py-1 font-medium">{c}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-line">
                {r.map((v, j) => <td key={j} className="px-2 py-1">{v}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/**
 * Horizontal share bars — used for small categorical breakdowns where a full chart is overkill.
 * With onSelect, each row is a button that toggles a filter; `selected` marks the active one.
 */
export function ShareBars({ rows, total, onSelect, selected }: { rows: { key: string; label?: string; value: number }[]; total?: number; onSelect?: (key: string) => void; selected?: string }) {
  const sum = total ?? rows.reduce((a, r) => a + r.value, 0);
  if (!rows.length) return <p className="text-xs text-muted">No data.</p>;
  return (
    <ul className="space-y-2">
      {rows.map((r) => {
        const share = sum ? r.value / sum : 0;
        const on = selected === r.key;
        const body = (
          <>
            <div className="flex justify-between gap-2 text-xs">
              <span className={`truncate ${on ? "font-semibold text-accent" : ""}`} title={r.label ? r.key : undefined}>{r.label ?? r.key}</span>
              <span className="tabular shrink-0 text-muted">
                {r.value.toLocaleString()} · {Math.round(share * 100)}%
              </span>
            </div>
            <div className="mt-1 h-1.5 rounded-full bg-panel-2">
              <div className={`h-1.5 rounded-full ${on ? "bg-accent" : "bg-[var(--chart-errors)]"}`} style={{ width: `${Math.max(2, share * 100)}%` }} />
            </div>
          </>
        );
        return (
          <li key={r.key}>
            {onSelect ? (
              <button type="button" aria-pressed={on} onClick={() => onSelect(r.key)} className="-mx-1 block w-[calc(100%+0.5rem)] rounded px-1 py-0.5 text-left hover:bg-panel-2">
                {body}
              </button>
            ) : (
              body
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** A small chip under an issue's title. */
const CHIP = "mt-1 mr-1 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide";


export function timeAgo(iso: string, now = Date.now()) {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** Small labels under an issue: regressed, new in the latest release, resolved, ignored. */
export function IssueLabels({ issue }: { issue: { status: string; resolvedIn?: string; firstVersion?: string; newInLatest: boolean; test?: boolean } }) {
  return (
    <>
      {issue.test && <span className={`${CHIP} border border-line text-muted`} title="Made on purpose to test deBug (tag test=true). Never counted.">Test error</span>}
      {issue.status === "regressed" && <span className={`${CHIP} bg-sev-critical text-white`}>Regressed{issue.resolvedIn ? ` after ${issue.resolvedIn}` : ""}</span>}
      {issue.newInLatest && <span className={`${CHIP} bg-accent-soft text-accent`}>New in {issue.firstVersion}</span>}
      {issue.status === "resolved" && <span className={`${CHIP} border border-line text-muted`}>Resolved{issue.resolvedIn ? ` in ${issue.resolvedIn}` : ""}</span>}
      {issue.status === "ignored" && <span className={`${CHIP} border border-line text-muted`}>Ignored</span>}
    </>
  );
}
