import { CATEGORY_INFO, IMPACT_INFO, OWNER_INFO, type Category, type Classification, type Impact, type LabelInfo, type Owner } from "@debugkit/schema";

/**
 * Narrowing the overview's issue list: by status, flow and the labels from docs/taxonomy.md.
 * Shared by the overview page and GET /api/summary, so both filter the same way.
 */

export const STATUS_FILTERS = ["open", "resolved", "ignored", "all"] as const;
/** "open" is open or regressed; "all" is everything. */
export type StatusFilter = (typeof STATUS_FILTERS)[number];

export interface IssueFilter {
  /** Unset means "open". */
  status?: StatusFilter;
  flow?: string;
  category?: Category;
  owner?: Owner;
  impact?: Impact;
}

export type LabelFilterKey = "impact" | "owner" | "category";

/** The label filters, in the order they're shown: how bad, whose, what kind. */
export const LABEL_FILTERS: Record<LabelFilterKey, { title: string; info: Record<string, LabelInfo> }> = {
  impact: { title: "Impact", info: IMPACT_INFO },
  owner: { title: "Owner", info: OWNER_INFO },
  category: { title: "Category", info: CATEGORY_INFO },
};
export const LABEL_FILTER_KEYS = Object.keys(LABEL_FILTERS) as LabelFilterKey[];
/** Every label filter unset, to spread into search params. */
export const NO_LABEL_FILTERS = Object.fromEntries(LABEL_FILTER_KEYS.map((k) => [k, undefined])) as Record<LabelFilterKey, undefined>;

/** Read the label filters from search params or a query string. Unknown ids are dropped. */
export function labelFilterOf(get: (key: LabelFilterKey) => unknown): Pick<IssueFilter, LabelFilterKey> {
  const out: Record<string, string> = {};
  for (const k of LABEL_FILTER_KEYS) {
    const v = get(k);
    if (typeof v === "string" && Object.hasOwn(LABEL_FILTERS[k].info, v)) out[k] = v;
  }
  return out as Pick<IssueFilter, LabelFilterKey>;
}

export const isStatusFilter = (v: unknown): v is StatusFilter => typeof v === "string" && (STATUS_FILTERS as readonly string[]).includes(v);

/**
 * The filters in a /api/summary query string, or what's wrong with them. Unlike the page, the API
 * lists every status unless asked: scripts written before filters existed expect all issues.
 */
export function issueFilterFromQuery(q: URLSearchParams): IssueFilter | string {
  const status = q.get("status") ?? "all";
  if (!isStatusFilter(status)) return `status must be one of ${STATUS_FILTERS.join(", ")}`;
  for (const k of LABEL_FILTER_KEYS) {
    const v = q.get(k);
    if (v !== null && !Object.hasOwn(LABEL_FILTERS[k].info, v)) return `Unknown ${k} "${v}": use one of ${Object.keys(LABEL_FILTERS[k].info).join(", ")}`;
  }
  return { status, flow: q.get("flow") ?? undefined, ...labelFilterOf((k) => q.get(k)) };
}

interface FilterableIssue {
  status: string;
  flow?: string;
  labels?: Pick<Classification, LabelFilterKey>;
}

export function matchesStatus(i: { status: string }, status: StatusFilter = "open"): boolean {
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
 * option, and "whose is it" for the filtered list. Values with no issues are left out.
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
