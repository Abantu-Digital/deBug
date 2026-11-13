import * as p from "@clack/prompts";
import pc from "picocolors";

export { p, pc };

/** Set by --yes: accept every default without asking. */
export const flags = { yes: false, command: "init" };

export function bail(message = flags.command === "init" ? "Setup cancelled. Run npx debugkit init again whenever you're ready." : "Stopped."): never {
  p.cancel(message);
  process.exit(0);
}

/** Unwrap a prompt result, exiting cleanly on Ctrl-C. */
export function must<T>(value: T | symbol): T {
  if (p.isCancel(value) || typeof value === "symbol") bail();
  return value as T;
}

export async function choose<T extends string>(message: string, options: { value: T; label: string; hint?: string }[], initial?: T): Promise<T> {
  if (flags.yes) return initial ?? options[0]!.value;
  return must<T>((await p.select({ message, options: options as never, initialValue: initial })) as T | symbol);
}

export async function ask(message: string, opts: { initial?: string; placeholder?: string; validate?: (v: string) => string | undefined } = {}): Promise<string> {
  if (flags.yes && opts.initial !== undefined) return opts.initial;
  const v = must(await p.text({ message, initialValue: opts.initial, placeholder: opts.placeholder, validate: opts.validate ? (x) => opts.validate!(x ?? "") : undefined }));
  return String(v).trim();
}

export async function yes(message: string, initial = true): Promise<boolean> {
  if (flags.yes) return initial;
  return must<boolean>(await p.confirm({ message, initialValue: initial }));
}

/** Pause a walkthrough step until the user is ready. */
export async function next(message = "Continue") {
  if (flags.yes) return;
  // During init there's one way forward: setup runs start to finish, with nothing to drop off at.
  if (flags.command === "init") {
    must(await p.select({ message, options: [{ value: "next", label: "Next" }] }));
    return;
  }
  must<boolean>(await p.confirm({ message, active: "Next", inactive: "Stop here", initialValue: true })) || bail("Stopped the walkthrough. Run npx debugkit guide to pick it up again.");
}

export const code = (s: string) => pc.cyan(s);
export const dim = (s: string) => pc.dim(s);
export const bold = (s: string) => pc.bold(s);
