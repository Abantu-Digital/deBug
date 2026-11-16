import type { ApiCall, TimelineItem } from "~/server/event";

/** One glyph per breadcrumb category, next to its label. */
export const ICON: Record<TimelineItem["category"], string> = { navigation: "→", network: "⇅", ui: "◉", log: "≡", event: "◆", custom: "✱" };

/** A breadcrumb's text: the API call it describes, or its message, plus a repeat count and extra data. */
export function CrumbBody({ item }: { item: TimelineItem }) {
  return (
    <>
      <span className="mr-2 rounded bg-panel-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">{item.category}</span>
      {item.api ? <ApiLine call={item.api} /> : <span className="break-words">{item.message}</span>}
      {item.repeated && <span className="ml-2 text-xs text-muted">×{item.repeated}</span>}
      {item.data && (
        <div className="mt-0.5 break-words font-mono text-[11px] text-muted">
          {Object.entries(item.data).map(([k, v]) => `${k}=${String(v)}`).join(" · ")}
        </div>
      )}
    </>
  );
}

export function ApiLine({ call }: { call: ApiCall }) {
  return (
    <span className="break-words">
      {call.service && <span className="font-medium">{call.service} </span>}
      <span className="font-mono text-xs">{joined([call.method, call.path])}</span>
      {" → "}
      <span className={call.failed ? "font-semibold text-sev-critical" : ""}>{call.status ?? call.outcome ?? "failed"}</span>
      {call.status !== undefined && call.outcome && call.outcome !== "answered" && <span className="text-muted"> ({call.outcome})</span>}
      {call.durationMs !== undefined && <span className="text-muted"> · {call.durationMs} ms</span>}
      {call.errorKind && <span className="text-muted"> · {call.errorKind}</span>}
      {call.backendCode && <span className="text-muted"> · {call.backendCode}</span>}
    </span>
  );
}

/** The parts that are set, joined; undefined when none are. */
export function joined(parts: (string | false | undefined)[], sep = " "): string | undefined {
  return parts.filter(Boolean).join(sep) || undefined;
}

/** "14 Nov, 12:59:55" in the viewer's time zone. */
export function clock(iso: string) {
  return new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** How long before the error: "−5.9 s", "−2 min". */
export function offset(ts: string, errorTs: string) {
  const s = (Date.parse(ts) - Date.parse(errorTs)) / 1000;
  if (!Number.isFinite(s)) return "";
  const a = Math.abs(s);
  if (a < 0.05) return "0 s";
  return `${s < 0 ? "−" : "+"}${roundedSpan(a)}`;
}

/** A span of seconds in one unit: "5.9 s", "42 s", "2 min", "3 h". */
export function roundedSpan(a: number) {
  // Round first, then pick the unit, so 59.6 s reads "1 min", not "60 s".
  if (a < 9.95) return `${a.toFixed(1)} s`;
  if (Math.round(a) < 60) return `${Math.round(a)} s`;
  if (Math.round(a / 60) < 60) return `${Math.round(a / 60)} min`;
  return `${Math.round(a / 3600)} h`;
}
