import { Component, useEffect, type ErrorInfo, type ReactNode } from "react";
import { deBug, type DebugClient } from "./index";

export interface DebugErrorBoundaryProps {
  children?: ReactNode;
  /** What to render after a crash. A function gets the error and a reset callback. */
  fallback?: ReactNode | ((props: { error: Error; reset: () => void }) => ReactNode);
  /** Part of the app this boundary protects, e.g. "checkout". */
  flow?: string;
  client?: DebugClient;
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface State {
  error: Error | null;
}

/**
 * Catches render errors that React would otherwise swallow (or turn into a white/red screen)
 * and reports them. Works in React DOM and React Native.
 */
export class DebugErrorBoundary extends Component<DebugErrorBoundaryProps, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const client = this.props.client ?? deBug;
    if (info.componentStack) {
      client.breadcrumb("ui", "React render error", { componentStack: info.componentStack.trim().slice(0, 1500) }, "error");
    }
    client.error(error, { flow: this.props.flow, handled: false, tags: { source: "error-boundary" } });
    void client.flush();
    this.props.onError?.(error, info);
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const { fallback } = this.props;
    return typeof fallback === "function" ? fallback({ error, reset: this.reset }) : (fallback ?? null);
  }
}

/** Adds a navigation breadcrumb whenever `path` changes. Works with any router. */
export function useDebugNavigation(path: string | undefined, client: DebugClient = deBug) {
  useEffect(() => {
    if (path) client.breadcrumb("navigation", path);
  }, [path, client]);
}

/** Minimal shape of a TanStack Router instance (avoids a hard dependency). */
interface RouterLike {
  subscribe(event: "onResolved", fn: (e: { toLocation: { pathname: string; href?: string } }) => void): () => void;
}

/**
 * Records a breadcrumb for every navigation in a TanStack Router app:
 *   const router = createRouter({ routeTree }); trackTanStackRouter(router);
 * Returns an unsubscribe function.
 */
export function trackTanStackRouter(router: RouterLike, client: DebugClient = deBug) {
  return router.subscribe("onResolved", ({ toLocation }) => client.breadcrumb("navigation", toLocation.pathname));
}

export { deBug } from "./index";
