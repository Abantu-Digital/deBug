import type { Exchange, ExchangeSide } from "~/server/exchange";

/** A body as shown: JSON pretty-printed when it parses, with a note when it was cut or is binary. */
export interface BodyView {
  text: string;
  json: boolean;
  /** "Binary, 12 KB (image/png)", or "Cut at 16 KB of 48 KB". */
  note?: string;
}

const BINARY = /^\[binary ([\d.]+ ?[KMG]?B), ([^\]]+)\]$/i;
const SDK_CUT = /…\[truncated(?:, ([\d.]+ ?[KMG]?B) total)?\]$/;

function kb(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function bodyView(side: ExchangeSide): BodyView | undefined {
  const body = side.body;
  if (body === undefined) return undefined;
  const bin = BINARY.exec(body.trim());
  if (bin) return { text: "", json: false, note: `Binary, ${bin[1]} (${bin[2]}). Not captured.` };
  const cut = SDK_CUT.exec(body);
  const raw = cut ? body.slice(0, cut.index) : body;
  const total = cut?.[1] ?? (side.bodySize !== undefined ? kb(side.bodySize) : undefined);
  const note = cut || side.truncated ? `Cut at ${kb(raw.length)}${total ? ` of ${total}` : ""}: the rest wasn't captured.` : undefined;
  if (!raw.trim()) return { text: "", json: false, note: note ?? "Empty body." };
  try {
    return { text: JSON.stringify(JSON.parse(raw), null, 2), json: true, note };
  } catch {
    // A cut JSON body doesn't parse: show it as it came.
    return { text: raw, json: false, note };
  }
}

/** Single-quoted for a POSIX shell. */
const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The request as a cURL command. Secrets come through as "[redacted]", and a cut or binary body
 * can't be sent as it was, so the command says so; the host is a placeholder when the SDK named the
 * call by its path only.
 */
export function curlOf(x: Exchange): { command: string; complete: boolean } {
  const r = x.request;
  const base = r.fullUrl ?? (/^https?:\/\//.test(r.url) ? r.url : `https://HOST${r.url.startsWith("/") ? "" : "/"}${r.url}`);
  const url = r.query ? `${base}?${r.query}` : base;
  const parts = [`curl -X ${r.method} ${sh(url)}`];
  for (const [k, v] of Object.entries(r.headers ?? {})) parts.push(`-H ${sh(`${k}: ${v}`)}`);
  const view = bodyView(r);
  const sendable = r.body !== undefined && !BINARY.test(r.body.trim());
  if (sendable) parts.push(`--data-raw ${sh(view?.json ? JSON.stringify(JSON.parse(view.text)) : (view?.text ?? ""))}`);
  const redacted = /\[redacted\]/.test(JSON.stringify(r.headers ?? {})) || /\[redacted\]/.test(r.body ?? "") || /\[redacted\]/.test(r.query ?? "");
  const notes = [
    redacted && "secrets are [redacted]",
    !r.fullUrl && !/^https?:\/\//.test(r.url) && "replace HOST",
    (r.truncated || (view?.note && sendable && /Cut/.test(view.note))) && "the body was cut",
    r.body !== undefined && !sendable && "the body was binary",
  ].filter(Boolean);
  const command = parts.join(" \\\n  ");
  return { command: notes.length ? `# Redacted by deBug: ${notes.join("; ")}.\n${command}` : command, complete: notes.length === 0 };
}
