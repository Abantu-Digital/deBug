import { CATEGORIES, IMPACTS, OWNERS, type Category, type Classification, type Impact, type Owner } from "@debugkit/schema";

/**
 * Narrowing the overview's issue list: by status, flow and the labels from docs/taxonomy.md.
 * Shared by the overview page and GET /api/summary, so both filter the same way.
 */
export interface IssueFilter {
  /** "open" (default) is open or regressed; "all" is everything. */
  status?: string;
  flow?: string;
  category?: Category;
  owner?: Owner;
  impact?: Impact;
}

export type LabelFilterKey = "category" | "owner" | "impact";
export const LABEL_FILTER_KEYS: readonly LabelFilterKey[] = ["category", "owner", "impact"];

const IDS: Record<LabelFilterKey, readonly string[]> = { category: CATEGORIES, owner: OWNERS, impact: IMPACTS };

/** Read the label filters from search params or a query string. Unknown ids are dropped. */
export function labelFilterOf(get: (key: LabelFilterKey) => unknown): Pick<IssueFilter, LabelFilterKey> {
  const out: Pick<IssueFilter, LabelFilterKey> = {};
  for (const k of LABEL_FILTER_KEYS) {
    const v = get(k);
    if (typeof v === "string" && IDS[k].includes(v)) (out as Record<string, string>)[k] = v;
  }
  return out;
}

interface FilterableIssue {
  status: string;
  flow?: string;
  labels?: Pick<Classification, LabelFilterKey>;
}

export function matchesStatus(i: { status: string }, status = "open"): boolean {
  if (status === "all") return true;
  if (status === "open") return i.status === "open" || i.status === "regressed";
  return i.status === status;
}

/** Issues matching every filter that's set. An issue without labels never matches a label filter. */
export function filterIssues<T extends FilterableIssue>(issues: readonly T[], f: IssueFilter): T[] {
  return issues.filter(
    (i) =>
      matchesStatus(i, f.status) &&
      (!f.flow || (i.flow ?? "untagged") === f.flow) &&
      LABEL_FILTER_KEYS.every((k) => !f[k] || i.labels?.[k] === f[k]),
  );
}

/**
 * How many issues each label value would leave, given the other filters: the counts next to each
 * option. Values with no issues are left out.
 */
export function labelCounts<T extends FilterableIssue>(issues: readonly T[], f: IssueFilter, key: LabelFilterKey): Map<string, number> {
  const rest = filterIssues(issues, { ...f, [key]: undefined });
  const out = new Map<string, number>();
  for (const i of rest) {
    const v = i.labels?.[key];
    if (v) out.set(v, (out.get(v) ?? 0) + 1);
  }
  return out;
}
