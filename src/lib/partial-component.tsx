import type { ReactNode } from "react";

export interface PartialProps {
  id: string;
  children: ReactNode;
  tags?: string[];
  cache?: number;
  fallback?: ReactNode;
  /**
   * Dormant partial. When true, the children are not rendered on
   * initial load (or on any refetch that does not explicitly target
   * this id). The `fallback` is rendered in their place. The block
   * becomes "alive" only when a client component activates it via
   * `usePartial(id).refetch()`.
   *
   * The framework provides no trigger machinery — activation is any
   * `"use client"` code that calls `usePartial`. Common patterns:
   * an IntersectionObserver placed inside the fallback, a button,
   * a hover handler, a timer, an SSE listener. See the trivia
   * example in `src/app/pages/pokemon.tsx` for a visible-trigger
   * component placed inside the fallback.
   */
  defer?: boolean;
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
