"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { usePartial } from "./partial-client.tsx";

export interface DeferredPartialProps {
  id: string;
  fallback?: ReactNode;
  rootMargin?: string;
  threshold?: number;
}

/**
 * Client-side placeholder emitted by `<Partial renderOn="visible">` when
 * the partial is not in the current request's explicit `?partials=` filter.
 *
 * Renders the partial's `fallback` (or nothing) and sets up an
 * IntersectionObserver on itself. On first intersection it calls
 * `usePartial(id).refetch()`, triggering the normal partial-refetch
 * machinery — the server renders the real content and the cache-merge
 * replaces this component with it.
 *
 * Fires once per mount. If the partial is later invalidated by a tag or
 * a full navigation without the partial in the filter, this component
 * mounts fresh and observes again.
 */
export function DeferredPartial({
  id,
  fallback = null,
  rootMargin = "0px",
  threshold,
}: DeferredPartialProps) {
  const [refetch] = usePartial(id);
  const ref = useRef<HTMLSpanElement>(null);
  const triggered = useRef(false);

  useEffect(() => {
    if (triggered.current) return;
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !triggered.current) {
          triggered.current = true;
          refetch();
        }
      },
      { rootMargin, threshold },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [refetch, rootMargin, threshold]);

  return (
    <span ref={ref} data-partial-deferred={id}>
      {fallback}
    </span>
  );
}
