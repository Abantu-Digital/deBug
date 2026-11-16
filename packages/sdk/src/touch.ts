/**
 * Taps on React Native, as `ui` breadcrumbs. React Native has no DOM click events, so a passive
 * boundary watches touches and names what was tapped from the React tree: the nearest element,
 * at or above the touched one, with an accessibilityLabel or a testID. Pure: never throws.
 */

import type { DebugClient } from "./client";
import { maskPersonal } from "./redact";

export interface TouchOptions {
  /** testIDs whose taps aren't recorded (substring match). */
  ignoreTestIDs?: string[];
  /** Which name to prefer when an element has both. Default "accessibilityLabel". */
  labelFrom?: "accessibilityLabel" | "testID";
}

/** The part of a React fiber the walk reads. */
interface FiberLike {
  memoizedProps?: Record<string, unknown> | null;
  return?: FiberLike | null;
}

export interface TouchEventLike {
  nativeEvent?: { pageX?: number; pageY?: number; timestamp?: number; touches?: unknown[] };
  /** React Native's touched component, in development and production builds alike. */
  _targetInst?: FiberLike | null;
}

/** A tap moves less than this, in points, and lasts less than TAP_MS (React Native's long press). */
const TAP_SLOP = 10;
const TAP_MS = 500;
/** How far up from the touched element to look for a name. */
const MAX_DEPTH = 30;

export interface TouchTarget {
  label?: string;
  testID?: string;
}

/** A name as recorded: trimmed, short, and with any phone number or email in it masked. */
const text = (v: unknown) => (typeof v === "string" && v.trim() ? maskPersonal(v.trim()).slice(0, 100) : undefined);

/** The nearest element at or above the touched one that has a name. Its text input values are never read. */
export function describeTouchTarget(inst: FiberLike | null | undefined): TouchTarget | undefined {
  let node = inst;
  for (let depth = 0; node && depth < MAX_DEPTH; depth++, node = node.return) {
    const p = node.memoizedProps;
    if (!p || typeof p !== "object") continue;
    const label = text(p.accessibilityLabel) ?? text(p["aria-label"]);
    const testID = text(p.testID);
    if (label || testID) return { label, testID };
  }
  return undefined;
}

/** onTouchStart / onTouchEnd handlers that record taps on `client`, for <DebugTouchBoundary>. */
export function touchHandlers(client: DebugClient, opts: TouchOptions = {}) {
  let start: { x: number; y: number; t: number; target?: TouchTarget } | undefined;
  const point = (e: TouchEventLike) => ({ x: e.nativeEvent?.pageX ?? 0, y: e.nativeEvent?.pageY ?? 0, t: e.nativeEvent?.timestamp ?? Date.now() });
  return {
    onTouchStart(e: TouchEventLike) {
      try {
        // A second finger makes it a gesture, not a tap.
        start = (e.nativeEvent?.touches?.length ?? 1) > 1 ? undefined : { ...point(e), target: describeTouchTarget(e._targetInst) };
      } catch {
        start = undefined;
      }
    },
    /**
     * Also used for onTouchCancel: a native gesture handler (react-native-gesture-handler's
     * buttons, bottom sheets) cancels the JS touch when it takes a tap. A scroll that cancels
     * has moved too far to count.
     */
    onTouchEnd(e: TouchEventLike) {
      try {
        const s = start;
        start = undefined;
        const target = s?.target;
        if (!s || !target) return;
        const end = point(e);
        // Scrolls, drags and long presses aren't taps.
        if (Math.hypot(end.x - s.x, end.y - s.y) > TAP_SLOP || end.t - s.t > TAP_MS) return;
        if (target.testID && opts.ignoreTestIDs?.some((id) => target.testID?.includes(id))) return;
        const name = opts.labelFrom === "testID" ? (target.testID ?? target.label) : (target.label ?? target.testID);
        client.breadcrumb("ui", `Tapped ${name === target.label ? `"${name}"` : name}`, {
          label: target.label ?? null,
          testID: target.testID ?? null,
          screen: client.screen ?? null,
        });
      } catch {
        // Recording a tap must never affect it.
      }
    },
  };
}
