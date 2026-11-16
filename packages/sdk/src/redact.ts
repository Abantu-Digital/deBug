/**
 * Redaction for the request and response a failed call carries (network.bodies). Everything is
 * kept except secrets: values that would let someone act as the user or use their card.
 * Pure functions: no globals, never throws.
 */

export interface RedactOptions {
  /** More body field names to redact, at any depth, without case. */
  fields?: string[];
  /** More header names to redact, without case. */
  headers?: string[];
}

export interface CapturedBody {
  body?: string;
  /** The body's size before it was cut, in characters. */
  bodySize?: number;
  truncated?: boolean;
}

const REDACTED = "[redacted]";

/** Body fields redacted at any depth. Plain `code` is kept: it is usually the backend's error code. */
const SECRET_FIELDS = [
  "password",
  "pin",
  "otp",
  "otpcode",
  "verificationcode",
  "cvv",
  "cvc",
  "cardnumber",
  "pan",
  "idtoken",
  "accesstoken",
  "refreshtoken",
  "token",
  "secret",
  "apikey",
];

const SECRET_HEADERS = ["authorization", "cookie", "set-cookie"];
/** Header names holding these words are secrets too: x-id-token, x-api-key, client-secret. */
const SECRET_HEADER_WORDS = /token|key|secret/i;

const JWT = /\beyJ[\w-]+\.[\w-]+\.[\w-]*/g;
const CARD_CANDIDATE = /\b(?:\d[ -]?){12,18}\d\b/g;

/** The Luhn check card numbers pass, so ordinary long numbers (ids, amounts) are left alone. */
function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** JWTs and card numbers, wherever they appear in a piece of text. */
export function redactValues(text: string): string {
  return text.replace(JWT, REDACTED).replace(CARD_CANDIDATE, (m) => {
    const digits = m.replace(/\D/g, "");
    return digits.length >= 13 && digits.length <= 19 && luhn(digits) ? `•••• ${digits.slice(-4)}` : m;
  });
}

function secretFields(opts: RedactOptions): Set<string> {
  return new Set([...SECRET_FIELDS, ...(opts.fields ?? []).map((f) => f.toLowerCase())]);
}

function redactJson(value: unknown, fields: Set<string>): unknown {
  if (typeof value === "string") return redactValues(value);
  if (Array.isArray(value)) return value.map((v) => redactJson(v, fields));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = fields.has(k.toLowerCase()) ? REDACTED : redactJson(v, fields);
    return out;
  }
  return value;
}

/** `a=1&password=x` with secret keys redacted (forms and query strings). */
function redactForm(text: string, fields: Set<string>): string {
  return text.replace(/(^|&)([^=&]*)=([^&]*)/g, (m, sep: string, key: string) => {
    let name = key;
    try {
      name = decodeURIComponent(key.replace(/\+/g, " "));
    } catch {
      // A key that won't decode is checked as it is.
    }
    return fields.has(name.toLowerCase()) ? `${sep}${key}=${encodeURIComponent(REDACTED)}` : redactValues(m);
  });
}

/** A body or query string with its secrets redacted: JSON at any depth, forms, or plain text. */
export function redactText(text: string, opts: RedactOptions = {}): string {
  const fields = secretFields(opts);
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.stringify(redactJson(JSON.parse(trimmed), fields));
    } catch {
      // Not JSON after all: treat it as text.
    }
  }
  if (/^[^\s=&]+=[^\s]*$/.test(trimmed)) return redactForm(trimmed, fields);
  return redactValues(text);
}

export function redactHeaders(headers: Record<string, string> | undefined, opts: RedactOptions = {}): Record<string, string> | undefined {
  if (!headers) return undefined;
  const extra = new Set((opts.headers ?? []).map((h) => h.toLowerCase()));
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    out[lower] = SECRET_HEADERS.includes(lower) || extra.has(lower) || SECRET_HEADER_WORDS.test(lower) ? REDACTED : redactValues(String(value));
  }
  return out;
}

/** A body redacted, then cut to `maxChars` with a marker saying how big it was. */
export function captureBody(text: string | undefined, maxChars: number, opts: RedactOptions = {}): CapturedBody {
  if (text === undefined || text === "") return {};
  const redacted = redactText(text, opts);
  if (redacted.length <= maxChars) return { body: redacted, bodySize: redacted.length };
  const kb = Math.ceil(redacted.length / 1024);
  return { body: `${redacted.slice(0, maxChars)}…[truncated, ${kb} KB total]`, bodySize: redacted.length, truncated: true };
}

/** What a body the SDK can't read as text is recorded as. */
export function binaryBody(bytes: number | undefined, type: string | undefined): CapturedBody {
  const size = bytes === undefined ? "" : ` ${Math.max(1, Math.ceil(bytes / 1024))} KB`;
  return { body: `[binary${size}${type ? `, ${type}` : ""}]`, bodySize: bytes };
}
