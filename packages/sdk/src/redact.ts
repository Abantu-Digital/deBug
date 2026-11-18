/**
 * Redaction for the request and response a failed call carries (network.bodies). Everything is
 * kept except secrets: values that would let someone act as the user or use their card.
 * Pure functions: no globals, never throws.
 */
import { REDACTED } from "@debugkit/schema/core";

export interface RedactOptions {
  /** More body field names to redact, at any depth, without case. */
  fields?: string[];
  /** More header names to redact, without case. */
  headers?: string[];
}

/** A body as the SDK records it on a failed call (the event's request/response body fields). */
export interface CapturedBody {
  body?: string;
  /** The body's size before it was cut, in characters. */
  bodySize?: number;
  truncated?: boolean;
}

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

const SECRET_HEADERS = ["authorization", "proxy-authorization", "cookie", "set-cookie"];
/** Header names holding these words are secrets too: x-id-token, x-api-key, client-secret. */
const SECRET_HEADER_WORDS = /token|key|secret/i;

const JWT = /eyJ[\w-]+\.[\w-]+\.[\w-]*(?:\.[\w-]*){0,2}/g;
/** 13 to 19 digits, maybe split by spaces, dashes, dots or underscores; bounded by non-digits (checked below). */
const CARD_CANDIDATE = /\d(?:[ ._-]?\d){12,18}/g;
/** The most headers kept per side, and of each value. */
const MAX_HEADERS = 50;
const MAX_HEADER_VALUE = 1000;

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

/** JWTs and card numbers, wherever they appear in a piece of text, even next to letters. */
export function redactValues(text: string): string {
  return text.replace(JWT, REDACTED).replace(CARD_CANDIDATE, (m, offset: number, whole: string) => {
    if (/\d/.test(whole[offset - 1] ?? "") || /\d/.test(whole[offset + m.length] ?? "")) return m; // part of a longer number
    const digits = m.replace(/\D/g, "");
    return luhn(digits) ? `•••• ${digits.slice(-4)}` : m;
  });
}

// Moved to the schema so the dashboard masks text the same way (ABA-161); kept exported here.
export { maskPersonal } from "@debugkit/schema/core";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Secret fields in text that isn't parsed as JSON: `"otp": "123456"`, `otp: 123456`,
 * `otp=123456`, also in JSON cut short or embedded in a string.
 */
function redactKeyValues(text: string, fields: Set<string>): string {
  if (fields.size === 0) return text;
  const names = [...fields].map(escapeRe).join("|");
  const quoted = new RegExp(`((["'])(?:${names})\\2\\s*:\\s*)("(?:[^"\\\\]|\\\\.)*"?|'[^']*'?|[^,}\\]\\s]+)`, "gi");
  const bare = new RegExp(`((?:^|[\\s,{;&?])(?:${names})\\s*[:=]\\s*)("(?:[^"\\\\]|\\\\.)*"?|[^,}\\]\\s&;]+)`, "gi");
  return text.replace(quoted, (_m, key: string) => `${key}"${REDACTED}"`).replace(bare, (_m, key: string) => `${key}${REDACTED}`);
}

function secretFields(opts: RedactOptions): Set<string> {
  return new Set([...SECRET_FIELDS, ...(opts.fields ?? []).map((f) => f.toLowerCase())]);
}

function redactJson(value: unknown, fields: Set<string>): unknown {
  // A string may hold JSON or a form of its own ("{\"otp\":1}", "pin=1"): redact it as a body.
  if (typeof value === "string") return redactTextWith(value, fields);
  // A card number sent as a JSON number.
  if (typeof value === "number" && Number.isInteger(value) && value >= 1e12) {
    const masked = redactValues(String(value));
    return masked === String(value) ? value : masked;
  }
  if (Array.isArray(value)) return value.map((v) => redactJson(v, fields));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = fields.has(k.toLowerCase()) ? REDACTED : redactJson(v, fields);
    return out;
  }
  return value;
}

/** The field name a form key stands for: `user[password]` and `user.password` are `password`. */
function formField(key: string): string {
  let name = key;
  try {
    name = decodeURIComponent(key.replace(/\+/g, " "));
  } catch {
    // A key that won't decode is checked as it is.
  }
  return (/([^[\].]+)\]?$/.exec(name)?.[1] ?? name).toLowerCase();
}

/** `a=1&password=x` with secret keys redacted (forms and query strings). */
function redactForm(text: string, fields: Set<string>): string {
  return text
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq < 0) return redactValues(pair);
      const key = pair.slice(0, eq);
      return fields.has(formField(key)) ? `${key}=${encodeURIComponent(REDACTED)}` : redactValues(pair);
    })
    .join("&");
}

function redactTextWith(text: string, fields: Set<string>): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.stringify(redactJson(JSON.parse(trimmed), fields));
    } catch {
      // Not whole JSON (cut short, say): redact its fields as text below.
    }
  }
  if (trimmed.includes("=") && !/\s/.test(trimmed)) return redactForm(trimmed, fields);
  return redactValues(redactKeyValues(text, fields));
}

/**
 * A body or query string with its secrets redacted: JSON at any depth (and JSON inside its
 * strings), forms, JSON cut short, or plain text.
 */
export function redactText(text: string, opts: RedactOptions = {}): string {
  return redactTextWith(text, secretFields(opts));
}

export function redactHeaders(headers: Record<string, string> | undefined, opts: RedactOptions = {}): Record<string, string> | undefined {
  if (!headers) return undefined;
  const extra = new Set((opts.headers ?? []).map((h) => h.toLowerCase()));
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers).slice(0, MAX_HEADERS)) {
    const lower = name.toLowerCase();
    out[lower] = SECRET_HEADERS.includes(lower) || extra.has(lower) || SECRET_HEADER_WORDS.test(lower) ? REDACTED : redactValues(String(value)).slice(0, MAX_HEADER_VALUE);
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

/** A body: its text redacted and cut, or, when it isn't text, its size and type. */
export function bodyOf(text: string | undefined, binary: { bytes?: number; type?: string } | undefined, maxChars: number, opts: RedactOptions = {}): CapturedBody {
  return binary ? binaryBody(binary.bytes, binary.type) : captureBody(text, maxChars, opts);
}

/** What a body the SDK can't read as text is recorded as. */
export function binaryBody(bytes: number | undefined, type: string | undefined): CapturedBody {
  const size = bytes === undefined ? "" : ` ${Math.max(1, Math.ceil(bytes / 1024))} KB`;
  return { body: `[binary${size}${type ? `, ${type}` : ""}]`, bodySize: bytes };
}
