"use client";

import { useEffect, useRef, useTransition } from "react";

/**
 * Tracks which page partials are currently visible.
 * When scrolling up and a page leaves the viewport,
 * silently updates ?pages= to the highest visible page.
 */
const visiblePages = new Set<number>();

function silentlyUpdatePages() {
  if (visiblePages.size === 0) return;
  const maxVisible = Math.max(...visiblePages);
  const url = new URL(window.location.href);
  const current = Number(url.searchParams.get("pages")) || 1;

  if (maxVisible < current) {
    // Scrolling up — update URL for bookmarking/refresh without
    // triggering a server fetch. Uses the unpatched replaceState
    // so the navigation listener in entry.browser doesn't fire.
    url.searchParams.set("pages", String(maxVisible));
    History.prototype.replaceState.call(
      history,
      history.state,
      "",
      url.toString(),
    );
  }
}

/**
 * Invisible sentinel placed at the top of each page partial.
 * Tracks visibility so ?pages= stays in sync with scroll position.
 */
export function PageSentinel({ page }: { page: number }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        visiblePages.add(page);
      } else {
        visiblePages.delete(page);
        silentlyUpdatePages();
      }
    });

    observer.observe(el);
    return () => {
      observer.disconnect();
      visiblePages.delete(page);
    };
  }, [page]);

  return <div ref={ref} style={{ height: 0 }} />;
}

/**
 * Sentinel element that triggers loading the next page of results
 * when it enters the viewport via IntersectionObserver.
 *
 * Uses startTransition + replaceState so the partial caching system
 * fetches only the new page — all previous pages stay cached.
 */
export function LoadMore({ nextPage }: { nextPage: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [isPending, startTransition] = useTransition();
  const triggered = useRef(false);

  useEffect(() => {
    triggered.current = false;
  }, [nextPage]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !triggered.current) {
          triggered.current = true;
          startTransition(() => {
            const url = new URL(window.location.href);
            url.searchParams.set("pages", String(nextPage));
            history.replaceState(null, "", url.toString());
          });
        }
      },
      { rootMargin: "200px" },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [nextPage]);

  return (
    <div ref={ref} style={{ padding: "2rem", textAlign: "center" }}>
      {isPending && (
        <span
          style={{
            display: "inline-block",
            width: 24,
            height: 24,
            border: "3px solid #2d3748",
            borderTopColor: "#58a6ff",
            borderRadius: "50%",
            animation: "spin 0.6s linear infinite",
          }}
        />
      )}
    </div>
  );
}
