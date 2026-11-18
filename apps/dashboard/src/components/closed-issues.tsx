import { Link } from "@tanstack/react-router";
import type { PageSearch } from "./range-picker";
import { timeAgo } from "./ui";

/** What the list needs of a resolved or ignored issue. */
export interface ClosedIssue {
  fingerprint: string;
  title: string;
  status?: string;
  resolvedIn?: string;
  lastSeen: string;
}

/**
 * Resolved and ignored issues, folded away at the bottom of a page: where to find one again and
 * reopen it from its page.
 */
export function ClosedIssues({ issues, keep, now }: { issues: readonly ClosedIssue[]; keep: PageSearch; now: number }) {
  if (!issues.length) return null;
  return (
    <details className="rounded-xl border border-line bg-panel p-4 text-sm">
      <summary className="cursor-pointer font-semibold text-muted hover:text-ink">Resolved or ignored ({issues.length})</summary>
      <ul className="mt-3 space-y-1.5">
        {issues.map((i) => (
          <li key={i.fingerprint}>
            <Link to="/issues/$fingerprint" params={{ fingerprint: i.fingerprint }} search={{ ...keep, app: keep.app ?? "" }} className="flex flex-wrap justify-between gap-2 rounded px-1 py-0.5 hover:bg-panel-2">
              <span className="min-w-0 break-words">{i.title}</span>
              <span className="shrink-0 text-xs text-muted">
                {i.status === "resolved" ? `Resolved${i.resolvedIn ? ` in ${i.resolvedIn}` : ""}` : "Ignored"} · last {timeAgo(i.lastSeen, now)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </details>
  );
}
