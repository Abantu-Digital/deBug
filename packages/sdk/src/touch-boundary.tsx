import { useMemo, type ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import type { DebugClient } from "./client";
import { deBug } from "./index";
import { touchHandlers, type TouchOptions } from "./touch";

export interface DebugTouchBoundaryProps extends TouchOptions {
  children?: ReactNode;
  client?: DebugClient;
  /** Default `{ flex: 1 }`, so wrapping the app's root doesn't change its layout. */
  style?: StyleProp<ViewStyle>;
}

/**
 * Records the app's taps as breadcrumbs, named by accessibilityLabel or testID. Wrap the root
 * once: `<DebugTouchBoundary><Stack /></DebugTouchBoundary>`. It never takes the touch
 * responder, so taps, scrolls and gestures behave exactly as before.
 */
export function DebugTouchBoundary({ children, client = deBug, ignoreTestIDs, labelFrom, style }: DebugTouchBoundaryProps) {
  const handlers = useMemo(() => touchHandlers(client, { ignoreTestIDs, labelFrom }), [client, ignoreTestIDs, labelFrom]);
  return (
    <View style={style ?? { flex: 1 }} onTouchStart={handlers.onTouchStart as never} onTouchEnd={handlers.onTouchEnd as never}>
      {children}
    </View>
  );
}
