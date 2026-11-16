import type { Exchange, ExchangeSide } from "~/server/exchange";

/** A body as shown: JSON pretty-printed when it parses, with what was cut or left out. */
export interface BodyView {
  /** Pretty-printed when `json`; otherwise the body as it came, without the cut marker. */
  text: string;
  /** The body as it came, without the cut marker: what was sent, for replaying it. */
  raw: string;
  json: boolean;
  /** The SDK or ingest cut it. */
  cut: boolean;
  /** A binary body: only its size and type were captured. */
  binary: boolean;
  /** "Binary, 12 KB (image/png): not captured.", or "Cut after 16,384 of 48,213 characters…". */
  note?: string;
}

/** The SDK's "[binary 12 KB, image/png]", with the size or the type left out when it didn't know them. */
const BINARY = /^\[binary(?: ([\d.]+ ?[KMG]?B))?(?:, ([^\]]+))?\]$/i;
/** The SDK's cut "…[truncated, 48 KB total]", or ingest's "…[truncated]". */
const CUT = /…\[truncated(?:, ([\d.]+ ?[KMG]?B) total)?\]$/;

/** A byte count: "512 B", "47 KB", "1.2 MB". */
export function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Text without a cut marker, and whether it had one. */
export function uncut(text: string): { text: string; cut: boolean; total?: string } {
  const m = CUT.exec(text);
  return m ? { text: text.slice(0, m.index), cut: true, total: m[1] } : { text, cut: false };
}

export function bodyView(side: ExchangeSide): BodyView | undefined {
  const body = side.body;
  if (body === undefined) return undefined;
  const bin = BINARY.exec(body.trim());
  if (bin) {
    const bytes = bin[1] ?? (side.bodySize !== undefined ? size(side.bodySize) : undefined);
    return { text: "", raw: "", json: false, cut: false, binary: true, note: `Binary${bytes ? `, ${bytes}` : ""}${bin[2] ? ` (${bin[2]})` : ""}: not captured.` };
  }
  const u = uncut(body);
  const cut = u.cut || !!side.truncated;
  // bodySize counts characters for text.
  const total = u.total ?? (side.bodySize !== undefined ? `${side.bodySize.toLocaleString("en")} characters` : undefined);
  const note = cut ? `Cut after ${u.text.length.toLocaleString("en")} characters${total ? ` of ${total}` : ""}: the rest wasn't captured.` : undefined;
  const base = { raw: u.text, cut, binary: false, note };
  if (!u.text.trim()) return { ...base, text: "", json: false, note: note ?? "Empty body." };
  try {
    return { ...base, text: JSON.stringify(JSON.parse(u.text), null, 2), json: true };
  } catch {
    // A cut JSON body doesn't parse: show it as it came.
    return { ...base, text: u.text, json: false };
  }
}

/** Single-quoted for a POSIX shell: nothing inside is expanded. */
const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The request as a cURL command, quoted so pasting it runs nothing but curl. It's what the SDK
 * captured, so the command starts with a comment saying what to fill in: secrets show as
 * "[redacted]", ids in the path as ":id", a cut or binary body isn't the one sent, and HOST stands
 * in when the SDK named the call by its path only.
 */
export function curlOf(x: Exchange): { command: string; complete: boolean } {
  const r = x.request;
  const query = r.query !== undefined ? uncut(r.query) : undefined;
  const base = r.fullUrl ?? `https://HOST${r.url.startsWith("/") ? "" : "/"}${r.url}`;
  const url = query?.text ? `${base}?${query.text}` : base;
  const parts = [`curl -X ${sh(r.method)} ${sh(url)}`];
  for (const [k, v] of Object.entries(r.headers ?? {})) parts.push(`-H ${sh(`${k}: ${v}`)}`);
  const body = bodyView(r);
  if (body && !body.binary) parts.push(`--data-raw ${sh(body.raw)}`);
  const redacted = [JSON.stringify(r.headers ?? {}), r.body ?? "", r.query ?? ""].some((t) => t.includes("[redacted]"));
  const fill = [
    redacted && "secrets show as [redacted]",
    /\/:id(\/|$)/.test(r.url) && "ids in the path show as :id",
    !r.fullUrl && "replace HOST",
    query?.cut && "the query was cut",
    body?.cut && "the body was cut",
    body?.binary && "the binary body wasn't captured",
  ].filter(Boolean);
  const command = parts.join(" \\\n  ");
  return { command: fill.length ? `# From deBug, as captured: ${fill.join("; ")}.\n${command}` : command, complete: fill.length === 0 };
}
