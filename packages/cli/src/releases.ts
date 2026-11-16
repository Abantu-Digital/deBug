/**
 * Versions and their release notes, for `npx debugkit upgrade`. The notes come from the packages'
 * CHANGELOG.md files, read at build time (tsup.config.ts), so the CLI carries them offline.
 */

/** One line per version: each change's headline, newest version first. */
export type ReleaseNotes = { version: string; headlines: string[] }[];

/** [major, minor, patch] of "0.8.0", "^0.7.2" or "0.8.0-next.1"; undefined when it isn't a version. */
export function parseVersion(v: string | undefined): [number, number, number] | undefined {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(v ?? "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/** Negative when a is older than b, 0 when equal, positive when newer. Unparseable versions sort oldest. */
export function compareVersions(a: string | undefined, b: string | undefined): number {
  const x = parseVersion(a) ?? [-1, 0, 0];
  const y = parseVersion(b) ?? [-1, 0, 0];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/**
 * Each change's headline: the words before its first colon or full stop ("Customer lookup: a
 * Customers page …" gives "Customer lookup"). The packages release together, so a change listed in
 * several changelogs is kept once.
 */
export function releaseNotes(changelogs: readonly string[]): ReleaseNotes {
  const byVersion = new Map<string, string[]>();
  for (const text of changelogs) {
    let version: string | undefined;
    for (const line of text.split(/\r?\n/)) {
      const heading = /^## (\d+\.\d+\.\d+\S*)\s*$/.exec(line);
      if (heading) {
        version = heading[1]!;
        continue;
      }
      // "- 4ed7eb7: Customer lookup: …". Dependency bumps ("- Updated dependencies") have no commit.
      const entry = version && /^- [0-9a-f]{7,}: (.+)$/.exec(line);
      if (!entry) continue;
      const headline = headlineOf(entry[1]!);
      const list = byVersion.get(version!) ?? [];
      if (headline && !list.includes(headline)) list.push(headline);
      byVersion.set(version!, list);
    }
  }
  return [...byVersion.entries()].map(([version, headlines]) => ({ version, headlines })).sort((a, b) => compareVersions(b.version, a.version));
}

function headlineOf(text: string): string {
  // A colon inside `code` (like `npx debugkit init`) isn't the end of the headline.
  const plain = text.replace(/`[^`]*`/g, (s) => s.replace(/[:.]/g, "\u0000"));
  // A sentence ends at ": " or at ". " before a capital, so "e.g. " doesn't end it.
  const end = plain.search(/:(\s|$)|\.(\s+[A-Z(`]|\s*$)/);
  const headline = (end > 0 ? text.slice(0, end) : text).trim();
  // One line per version: a headline that runs on is cut.
  return headline.length > 70 ? `${headline.slice(0, 69).trimEnd()}…` : headline;
}

/** The versions after `from`, up to and including `to`, oldest first, each as one line. */
export function notesBetween(notes: ReleaseNotes, from: string | undefined, to: string): string[] {
  return notes
    .filter((n) => compareVersions(n.version, from) > 0 && compareVersions(n.version, to) <= 0)
    .sort((a, b) => compareVersions(a.version, b.version))
    .map((n) => `${n.version}: ${n.headlines.join("; ") || "fixes"}`);
}

declare const __DEBUGKIT_RELEASES__: ReleaseNotes | undefined;
/** Built into the CLI; empty when running from source. */
export const RELEASES: ReleaseNotes = typeof __DEBUGKIT_RELEASES__ === "object" ? __DEBUGKIT_RELEASES__ : [];
