import { usePathname } from "expo-router";
import { deBug, type DebugClient } from "./index";
import { useDebugNavigation } from "./react";

/**
 * Navigation breadcrumbs for Expo Router. Call once in your root layout:
 *   export default function RootLayout() { useDebugExpoRouter(); return <Stack />; }
 */
export function useDebugExpoRouter(client: DebugClient = deBug) {
  useDebugNavigation(usePathname(), client);
}
