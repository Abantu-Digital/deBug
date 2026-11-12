import type { StackFrame } from "./index";

// V8/Hermes: "    at fn (file:line:col)" or "    at file:line:col"
const V8 = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/;
// JSC/Firefox: "fn@file:line:col"
const GECKO = /^\s*(.*?)@(.+?):(\d+):(\d+)\s*$/;

const NOT_IN_APP = [/node_modules/, /\bnative\b/, /\[native code\]/, /^address at/, /InternalBytecode/];

export function parseStack(stack: string | undefined): StackFrame[] {
  if (!stack) return [];
  const frames: StackFrame[] = [];
  for (const raw of stack.split("\n")) {
    const m = V8.exec(raw) ?? GECKO.exec(raw);
    if (!m) continue;
    const [, fn, file, line, col] = m;
    frames.push({
      fn: fn || undefined,
      file,
      line: Number(line),
      col: Number(col),
      inApp: !NOT_IN_APP.some((re) => re.test(file ?? "")),
    });
    if (frames.length >= 100) break;
  }
  return frames;
}
