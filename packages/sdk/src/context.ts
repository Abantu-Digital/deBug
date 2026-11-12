import type { ContextInput } from "@debug/schema/core";

type Shallow<T> = { [K in keyof T]?: T[K] extends object ? Partial<T[K]> : T[K] };
export type ContextPatch = Shallow<ContextInput>;

/** Merge two context patches one level deep (os, device, app ... are merged field by field). */
export function mergeContext(a: ContextPatch, b: ContextPatch): ContextPatch {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const prev = out[k];
    out[k] = v && typeof v === "object" && prev && typeof prev === "object" ? { ...prev, ...v } : v ?? prev;
  }
  return out as ContextPatch;
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

export function timezone(): string | undefined {
  return safe(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
}
export function locale(): string | undefined {
  return safe(() => Intl.DateTimeFormat().resolvedOptions().locale);
}

/**
 * Best-effort context for browsers (React, TanStack Start/Router client, Next client ...).
 * Safe to call in any runtime: it never touches globals that might not exist.
 */
export function browserContext(): ContextPatch {
  if (typeof navigator === "undefined" || typeof window === "undefined") {
    const ua = typeof navigator !== "undefined" ? navigator.userAgent : undefined;
    const node = typeof process !== "undefined" ? process.versions?.node : undefined;
    return {
      runtime: { name: ua === "Cloudflare-Workers" ? "cloudflare-workers" : node ? "node" : "edge", version: node },
      os: { name: "server" },
      timezone: timezone(),
    };
  }
  const ua = navigator.userAgent;
  const android = /Android ([\d.]+)/.exec(ua)?.[1];
  const ios = /(?:iPhone|iPad|iPod).*? OS (\d+[_\d]*)/.exec(ua)?.[1];
  const os = android
    ? { name: "android", version: android }
    : ios
      ? { name: "ios", version: ios.replace(/_/g, ".") }
      : /Mac OS X/.test(ua)
        ? { name: "macos" }
        : /Windows/.test(ua)
          ? { name: "windows" }
          : /Linux/.test(ua)
            ? { name: "linux" }
            : { name: "web" };
  const conn = (navigator as { connection?: { effectiveType?: string; type?: string } }).connection;
  const browser = /Edg\/([\d.]+)/.exec(ua)
    ? { name: "edge", v: /Edg\/([\d.]+)/.exec(ua)![1] }
    : /Chrome\/([\d.]+)/.exec(ua)
      ? { name: "chrome", v: /Chrome\/([\d.]+)/.exec(ua)![1] }
      : /Version\/([\d.]+).*Safari/.exec(ua)
        ? { name: "safari", v: /Version\/([\d.]+)/.exec(ua)![1] }
        : /Firefox\/([\d.]+)/.exec(ua)
          ? { name: "firefox", v: /Firefox\/([\d.]+)/.exec(ua)![1] }
          : undefined;
  return {
    os,
    runtime: { name: "browser", version: browser ? `${browser.name} ${browser.v}` : undefined },
    device: {
      type: /iPad|Tablet/.test(ua) ? "tablet" : /Mobi/.test(ua) ? "phone" : "desktop",
      screen: typeof screen !== "undefined" ? { width: screen.width, height: screen.height, scale: window.devicePixelRatio } : undefined,
    },
    network: conn
      ? {
          type: conn.type === "wifi" ? "wifi" : conn.type === "cellular" ? "cellular" : "unknown",
          effectiveType: conn.effectiveType,
          isConnected: navigator.onLine,
        }
      : undefined,
    locale: navigator.language,
    timezone: timezone(),
  };
}
