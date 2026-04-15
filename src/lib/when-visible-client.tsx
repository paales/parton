"use client";

import {
  Fragment,
  useEffect,
  useRef,
  type FragmentInstance,
  type ReactNode,
} from "react";
import { usePartial } from "./partial-client.tsx";

interface WhenVisibleClientProps {
  partialId: string;
  children: ReactNode;
  rootMargin?: string;
  threshold?: number;
}

/**
 * Tracks partials that a <WhenVisible> has already activated in
 * this session. A Suspense boundary re-showing its fallback during
 * a new refetch would otherwise remount the trigger and re-fire.
 */
const activated = new Set<string>();

/**
 * Client half of <WhenVisible>. Renders the fallback as direct
 * siblings (no wrapper element, via `<Fragment ref>`), attaches
 * an IntersectionObserver to the fragment's DOM range, and on
 * first intersection calls `usePartial(partialId).refetch()`.
 *
 * Uses React 19 canary's Fragment ref API. See
 * `src/lib/react-canary.d.ts` for the type augmentation.
 */
export function WhenVisibleClient({
  partialId,
  children,
  rootMargin = "0px",
  threshold,
}: WhenVisibleClientProps) {
  const ref = useRef<FragmentInstance | null>(null);
  const [refetch] = usePartial(partialId);

  useEffect(() => {
    if (activated.has(partialId)) return;
    const instance = ref.current;
    if (!instance) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        if (activated.has(partialId)) return;
        activated.add(partialId);
        instance.unobserveUsing(observer);
        observer.disconnect();
        refetch();
      },
      { rootMargin, threshold },
    );
    instance.observeUsing(observer);
    return () => {
      instance.unobserveUsing(observer);
      observer.disconnect();
    };
  }, [refetch, partialId, rootMargin, threshold]);

  return <Fragment ref={ref}>{children}</Fragment>;
}
