import type { ReactNode } from "react";

/**
 * Deferred-render trigger for a `<Partial>`.
 *
 * When set, the partial's children are NOT rendered on the initial page
 * render. Instead a small client-side observer is placed at the partial's
 * position; when the trigger condition fires, the observer calls
 * `usePartial(id).refetch()` and the server renders the real content.
 *
 * Currently supported:
 *   - "visible" — IntersectionObserver. Fires once when the placeholder
 *     enters the viewport (optional `rootMargin` / `threshold`).
 */
export type RenderOn =
  | "visible"
  | { on: "visible"; rootMargin?: string; threshold?: number };

export interface PartialProps {
  id: string;
  children: ReactNode;
  tags?: string[];
  cache?: number;
  fallback?: ReactNode;
  renderOn?: RenderOn;
}

/**
 * Marker wrapper for a re-renderable fragment of a page.
 *
 * `<PartialRoot>` statically walks the element tree, detects `<Partial>`
 * elements, fingerprints their contents, applies request filters, and
 * wraps them in Suspense/ErrorBoundary. This component is a pass-through
 * so that `<Partial>` rendered outside a `<PartialRoot>` still produces
 * its children.
 */
export function Partial({ children }: PartialProps): ReactNode {
  return children;
}
