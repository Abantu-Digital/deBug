import { useEffect, useState } from "react";
import { CopyButton } from "~/components/copy-button";
import { bannerText } from "~/lib/version-text";
import type { VersionStatus } from "~/server/versions";

const DISMISSED = "debugkit.versionBanner.dismissed";

/** What the banner was dismissed for: the versions behind, so the next release shows it again. */
const signature = (s: VersionStatus) => `${s.newest}|${s.behind.map((p) => `${p.part}@${p.version ?? "?"}`).join(",")}`;

/**
 * Across the top of every page when part of the project's deBug is a minor version or more behind
 * the rest. Dismissed per browser for these versions; it comes back when they change.
 */
export function VersionBanner({ status }: { status: VersionStatus | null }) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(DISMISSED));
    } catch {
      /* storage blocked: the banner just stays */
    }
  }, []);
  if (!status || status.level !== "banner") return null;
  const sig = signature(status);
  if (dismissed === sig) return null;
  return (
    <div role="status" className="border-b border-sev-medium/40 bg-sev-medium/10">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 text-sm sm:px-6">
        <span className="min-w-0 flex-1 basis-64">{bannerText(status)}</span>
        <code className="break-all rounded bg-panel px-2 py-1 font-mono text-xs">{status.command}</code>
        <CopyButton text={status.command} label="Copy" ariaLabel="Copy the upgrade command" />
        {!status.environment && <span className="text-xs text-muted">Add --env &lt;name&gt; if you set up environments.</span>}
        <button
          type="button"
          className="ml-auto text-xs text-muted hover:text-ink"
          onClick={() => {
            setDismissed(sig);
            try {
              localStorage.setItem(DISMISSED, sig);
            } catch {
              /* not remembered: it shows again next visit */
            }
          }}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
