import { useEffect, useState } from "react";
import { getVersionStatus } from "~/server/fns";
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
export function VersionBanner() {
  const status = useVersionStatus();
  // undefined until this browser's dismissal is read: a dismissed banner never flashes on load.
  const [dismissed, setDismissed] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(DISMISSED));
    } catch {
      setDismissed(null); // storage blocked: the banner just stays
    }
  }, []);
  if (!status || status.level !== "banner" || dismissed === undefined) return null;
  const sig = signature(status);
  if (dismissed === sig) return null;
  return (
    <div role="status" className="border-b border-sev-medium/40 bg-sev-medium/10">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 text-sm sm:px-6">
        <span className="min-w-0 flex-1 basis-64">{bannerText(status)}</span>
        <UpgradeCommand status={status} />
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

/** The upgrade command with a copy button, and the --env hint when the dashboard doesn't know its environment. */
export function UpgradeCommand({ status }: { status: VersionStatus }) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      <code className="break-all rounded bg-panel-2 px-2 py-1 font-mono text-xs">{status.command}</code>
      <CopyButton text={status.command} label="Copy" ariaLabel="Copy the upgrade command" />
      {!status.environment && <span className="text-xs text-muted">Add --env &lt;name&gt; if you set up environments.</span>}
    </span>
  );
}

/** One read per page load, shared by the banner and Settings. */
let pending: Promise<VersionStatus | null> | undefined;

/**
 * The project's version status, read in the browser after the page renders: no page waits on it,
 * and the banner and Settings share one request. undefined until it arrives.
 */
export function useVersionStatus(): VersionStatus | null | undefined {
  const [status, setStatus] = useState<VersionStatus | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    pending ??= getVersionStatus().catch(() => null);
    void pending.then((s) => live && setStatus(s));
    return () => {
      live = false;
    };
  }, []);
  return status;
}
