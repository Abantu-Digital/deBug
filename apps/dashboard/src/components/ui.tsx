import type { ReactNode } from "react";
import { CATEGORY_INFO, IMPACT_INFO, OWNER_INFO, type Classification, type Impact, type Severity } from "@debugkit/schema";

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

const SEV_STYLE: Record<Severity, string> = {
  critical: "bg-sev-critical text-white",
  high: "bg-sev-high text-white",
  medium: "bg-sev-medium text-black",
  low: "bg-panel-2 text-muted border border-line",
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${SEV_STYLE[severity]}`}>
      {severity}
    </span>
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

const IMPACT_STYLE: Record<Impact, string> = {
  blocked: "bg-sev-critical text-white",
  degraded: "bg-sev-medium text-black",
  silent: "border border-line text-muted",
};

/** An issue's impact and category as badges, and its likely owner, from docs/taxonomy.md. */
export function LabelBadges({ labels }: { labels?: Pick<Classification, "category" | "owner" | "impact"> }) {
  if (!labels) return null;
  const chip = "mt-1 mr-1 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide";
  return (
    <>
      <span className={`${chip} ${IMPACT_STYLE[labels.impact]}`} title={IMPACT_INFO[labels.impact].description}>{IMPACT_INFO[labels.impact].name}</span>
      <span className={`${chip} bg-panel-2 text-ink/80`} title={CATEGORY_INFO[labels.category].description}>{CATEGORY_INFO[labels.category].name}</span>
      <span className="mt-1 mr-1 inline-flex text-[11px] text-muted" title={OWNER_INFO[labels.owner].description}>{OWNER_INFO[labels.owner].name}</span>
    </>
  );
}

export function timeAgo(iso: string, now = Date.now()) {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** Small labels under an issue: regressed, new in the latest release, resolved, ignored. */
export function IssueLabels({ issue }: { issue: { status: string; resolvedIn?: string; firstVersion?: string; newInLatest: boolean } }) {
  const chip = "mt-1 mr-1 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide";
  return (
    <>
      {issue.status === "regressed" && <span className={`${chip} bg-sev-critical text-white`}>Regressed{issue.resolvedIn ? ` after ${issue.resolvedIn}` : ""}</span>}
      {issue.newInLatest && <span className={`${chip} bg-accent-soft text-accent`}>New in {issue.firstVersion}</span>}
      {issue.status === "resolved" && <span className={`${chip} border border-line text-muted`}>Resolved{issue.resolvedIn ? ` in ${issue.resolvedIn}` : ""}</span>}
      {issue.status === "ignored" && <span className={`${chip} border border-line text-muted`}>Ignored</span>}
    </>
  );
}
