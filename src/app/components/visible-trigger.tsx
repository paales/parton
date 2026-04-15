"use client";

import { useEffect, useRef } from "react";
import { usePartial } from "../../lib/partial-client.tsx";

interface VisibleTriggerProps {
  partialId: string;
  rootMargin?: string;
  threshold?: number;
}

/**
 * Tracks partials that have already been activated by a
 * VisibleTrigger in this session. When a dormant partial is placed
 * inside a Suspense fallback, the Suspense temporarily re-shows its
 * fallback on every refetch while the new content resolves — that
 * would cause the trigger to remount and re-fire without this guard.
 */
const fired = new Set<string>();

/**
 * Activates a `<Partial defer>` when this component enters the
 * viewport. Place inside the dormant partial's `fallback` so it
 * unmounts automatically once the real content takes over.
 *
 * This is app-level — the framework deliberately has no trigger
 * machinery. Other activation shapes (hover prefetch, button click,
 * timer, SSE, media query) are just different "use client"
 * components calling `usePartial(id).refetch()`.
 */
export function VisibleTrigger({
  partialId,
  rootMargin = "0px",
  threshold,
}: VisibleTriggerProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const [refetch] = usePartial(partialId);

  useEffect(() => {
    if (fired.has(partialId)) return;
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting || fired.has(partialId)) return;
        fired.add(partialId);
        observer.disconnect();
        refetch();
      },
      { rootMargin, threshold },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [refetch, partialId, rootMargin, threshold]);

  return <span ref={ref} data-partial-trigger={partialId} />;
}
