import type { ReactNode } from "react";

export interface PartialProps {
  id: string;
  children: ReactNode;
  tags?: string[];
  cache?: number;
  /**
   * Suspense fallback. Shown while async children resolve. The
   * framework auto-wraps the partial's children in `<Suspense>` when
   * this is set.
   */
  fallback?: ReactNode;
  /**
   * Error boundary fallback. Shown if the partial's rendering
   * throws. If omitted, a built-in red card with a retry button is
   * used.
   */
  errorWith?: ReactNode;
}

/**
 * Marker wrapper for a re-renderable fragment of a page.
 *
 * `<PartialRoot>` statically walks the element tree, detects `<Partial>`
 * elements, fingerprints their contents, applies request filters, and
 * wraps them in Suspense/ErrorBoundary. This component is a pass-through
 * so that `<Partial>` rendered outside a `<PartialRoot>` still produces
 * its children.
 *
 * For deferred-until-activated blocks (trivia card, consent-gated
 * widgets, below-the-fold prefetches) use an activator component as
 * the child: `<Partial id="x"><WhenVisible fallback=…>…</WhenVisible></Partial>`.
 */
export function Partial({ children }: PartialProps): ReactNode {
  return children;
}
