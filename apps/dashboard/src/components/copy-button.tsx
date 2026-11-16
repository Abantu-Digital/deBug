import { useEffect, useRef, useState } from "react";
import { copyText } from "~/lib/copy";

/** Copies `text`, then says whether it worked for a few seconds. */
export function CopyButton({ text, label, ariaLabel }: { text: string; label: string; ariaLabel?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      className="rounded-md border border-line px-2 py-1 text-xs text-muted hover:bg-panel-2"
      onClick={() => {
        void copyText(text).then((ok) => {
          setState(ok ? "copied" : "failed");
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setState("idle"), 2500);
        });
      }}
    >
      {state === "copied" ? "Copied" : state === "failed" ? "Couldn't copy" : label}
    </button>
  );
}
