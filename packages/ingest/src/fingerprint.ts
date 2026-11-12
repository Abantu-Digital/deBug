import { createHash } from "node:crypto";
import type { ErrorEvent, StackFrame } from "@debug/schema";

/** Strip volatile parts so "User 123 not found" and "User 456 not found" group together. */
export function normaliseMessage(msg: string): string {
  return msg
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\b[0-9a-f]{16,}\b/gi, "<hex>")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "<email>")
    .replace(/\d+(\.\d+)?/g, "<n>")
    .replace(/(["'`]).*?\1/g, "<str>")
    .trim()
    .slice(0, 300);
}

/** Remove build hashes / absolute prefixes so the same code location matches across builds and devices. */
export function normaliseFile(file: string | undefined): string {
  if (!file) return "";
  // Metro dev bundles put options after "//&" instead of "?"; drop both.
  let f = file.replace(/\/\/&.*$/, "").replace(/[?#].*$/, "").replace(/^[a-z]+:\/\/[^/]+/i, "");
  // React Native bundles: the path is noise, the bundle name is enough.
  if (/\.(?:js)?bundle$/.test(f)) return f.replace(/^.*\//, "");
  // Keep the path from the deepest conventional source root, preferring src/.
  for (const root of ["/src/", "/lib/", "/app/"]) {
    const i = f.lastIndexOf(root);
    if (i >= 0) {
      f = f.slice(i + 1);
      break;
    }
  }
  return f.replace(/\.[0-9a-f]{6,}\./g, ".");
}

export function topInAppFrame(frames: StackFrame[] | undefined): StackFrame | undefined {
  return frames?.find((f) => f.inApp !== false && f.file) ?? frames?.[0];
}

export function culpritOf(e: ErrorEvent): string | undefined {
  const f = topInAppFrame(e.error.frames);
  if (!f) return undefined;
  const loc = normaliseFile(f.file) + (f.line ? `:${f.line}` : "");
  return f.fn ? `${f.fn} (${loc})` : loc;
}

/**
 * Fingerprint = error name + top in-app frame (function + file, not line, so small edits
 * don't split issues) + flow. Falls back to the normalised message when there's no stack.
 */
export function fingerprint(e: ErrorEvent): string {
  const f = topInAppFrame(e.error.frames);
  const where = f ? `${f.fn ?? "?"}@${normaliseFile(f.file)}` : normaliseMessage(e.error.message);
  return createHash("sha256")
    .update([e.error.name, where, e.flow ?? ""].join("|"))
    .digest("hex")
    .slice(0, 24);
}

export function titleOf(e: ErrorEvent): string {
  return `${e.error.name}: ${e.error.message}`.slice(0, 200);
}
