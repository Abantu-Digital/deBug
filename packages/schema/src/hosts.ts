import { OWNERS, type Owner } from "./taxonomy";

/**
 * Friendly names for the hosts an app calls, set in Settings: "2qpssug3bh.execute-api…/prod" is
 * the "Balance service", owned by the backend team. A name can cover a whole host or one path
 * prefix on it; the longest match wins.
 *
 * Request URLs are stored without a scheme ("host/path"), as the SDK sends them.
 */
export interface HostName {
  /** A host, or a host and path prefix: "api.example.com" or "api.example.com/payments". */
  match: string;
  name: string;
  /** Who fixes what goes wrong on this host. Unset: the classifier decides. */
  owner?: Owner;
}

export const MAX_HOST_NAMES = 50;

/** "https://API.example.com/v1/" → "api.example.com/v1". Lowercases the host only. */
export function normaliseHostMatch(s: string): string {
  const bare = s.trim().replace(/^[a-z]+:\/\//i, "").replace(/[?#].*$/, "").replace(/\/+$/, "");
  const cut = bare.indexOf("/");
  return cut < 0 ? bare.toLowerCase() : bare.slice(0, cut).toLowerCase() + bare.slice(cut);
}

/** The entry for a URL, and the rest of the URL after the matched part ("" or "/…"). */
export function hostNameFor(url: string, hosts: readonly HostName[] | undefined): { host: HostName; rest: string } | undefined {
  if (!hosts?.length || !url) return undefined;
  const u = normaliseHostMatch(url);
  let best: HostName | undefined;
  for (const h of hosts) {
    const m = h.match;
    // Whole path segments only: "api.x/pay" doesn't match "api.x/payments".
    const hit = u === m || (u.startsWith(m) && (u[m.length] === "/" || (!m.includes("/") && u[m.length] === ":")));
    if (hit && (!best || m.length > best.match.length)) best = h;
  }
  return best ? { host: best, rest: u.slice(best.match.length).replace(/^:\d+/, "") } : undefined;
}

/** "api.x/v1/me" → "Accounts · /v1/me". Unnamed URLs come back as they are. */
export function nameUrl(url: string, hosts: readonly HostName[] | undefined): string {
  const hit = hostNameFor(url, hosts);
  return hit ? `${hit.host.name}${hit.rest ? ` · ${hit.rest}` : ""}` : url;
}

/** A host as it appears in free text: a dotted name, optionally with a port and path. */
const URL_IN_TEXT = /\b(?:[a-z]+:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s"'`)]*)?/gi;

/** Name every URL in a title or message: "GET api.x/v1/me failed" → "GET Accounts · /v1/me failed". */
export function nameUrlsIn(text: string, hosts: readonly HostName[] | undefined): string {
  if (!hosts?.length) return text;
  return text.replace(URL_IN_TEXT, (u) => nameUrl(u, hosts));
}

const OWNER_SET = new Set<string>(OWNERS);
const MATCH = /^(?:[a-z0-9-]+\.)*[a-z0-9-]+(?::\d{1,5})?(?:\/[^\s?#]*)?$/;

/** Check host names from Settings. Returns the cleaned list, or what's wrong with it. */
export function validHostNames(x: unknown): HostName[] | string {
  if (!Array.isArray(x)) return "hosts must be a list";
  if (x.length > MAX_HOST_NAMES) return `Up to ${MAX_HOST_NAMES} host names`;
  const out: HostName[] = [];
  const seen = new Set<string>();
  for (const raw of x) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const match = typeof r.match === "string" ? normaliseHostMatch(r.match) : "";
    const name = typeof r.name === "string" ? r.name.trim() : "";
    if (!match && !name) continue; // an empty row
    if (!match || match.length > 200 || !MATCH.test(match)) return `"${String(r.match ?? "")}" isn't a host, like api.example.com or api.example.com/payments`;
    if (!name || name.length > 60) return `Give ${match} a name of up to 60 characters`;
    if (r.owner !== undefined && r.owner !== "" && !OWNER_SET.has(String(r.owner))) return `Unknown owner "${String(r.owner)}"`;
    if (seen.has(match)) return `${match} is listed twice`;
    seen.add(match);
    out.push({ match, name, ...(r.owner ? { owner: r.owner as Owner } : {}) });
  }
  return out;
}
