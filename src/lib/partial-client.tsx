"use client";

/**
 * Client-side partial merge coordinator.
 *
 * Receives a structural template (layout with partial placeholders)
 * and fresh partial content. Caches partials across renders and fills
 * the template from cache on every render.
 *
 * On full renders: all partials are fresh → cache fully populated.
 * On partial renders: only requested partials update the cache.
 * The template is always the same structural layout (main, footer, etc.),
 * so keyless wrappers are preserved across partial updates.
 *
 * Nested partials are supported: if "cart" is nested inside "header",
 * refreshing "header" re-renders the header layout but keeps cached
 * cart. Refreshing "cart" patches just the cart into cached header.
 */

import React, {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useState,
  useRef,
  type ReactNode,
} from "react";

/** Dispatch a single target — batched via microtask in PartialsClient */
type DispatchFn = (
  target: { id: string; props?: Record<string, unknown> },
) => Promise<void>;

const PartialRefetchContext = createContext<DispatchFn>(async () => {
  throw new Error("usePartial must be used inside a Partials");
});

const PartialNamespaceContext = createContext<string>("");

export interface PartialDebugEntry {
  id: string;
  status: "fresh" | "cached" | "data-cached";
  fingerprint: string;
  query: string | null;
}

interface PartialsClientProps {
  /**
   * Rendering mode:
   * - "streaming": passthrough — renders children directly in the tree.
   *   Used on full page renders so Suspense boundaries stay in the server
   *   component tree and can stream.
   * - "cache": template + cache merge — the existing behavior.
   *   Used on partial re-fetches where only requested partials are fresh
   *   and the rest are served from the client cache.
   */
  mode?: "streaming" | "cache";
  template: ReactNode;
  namespace: string;
  freshIds: string[];
  /** Partial fingerprints: { partialId: hash } — used for cache invalidation */
  fingerprints: Record<string, string>;
  /** Per-partial debug metadata */
  debug: PartialDebugEntry[];
  /** Total fetch time for all parallel queries */
  fetchMs: number;
  children: ReactNode;
}

/**
 * Walk the structural template, filling partial placeholders from cache.
 * Keyless wrappers (main, footer) are preserved; keyed placeholders
 * are replaced with cached partial content.
 *
 * IMPORTANT: cached partials are pushed as-is with NO traversal of their
 * own children. The Suspense boundaries inside cached partials have lazy
 * refs (from the RSC Flight stream) as `props.children`; any `React.Children.*`
 * helper on those thenables causes React to resolve them during reconcile
 * instead of showing a fallback on remount, which breaks progressive
 * streaming on refetch. See STREAMING_DEBUG_NOTES.md §7-8.
 */
function isPlaceholder(child: React.ReactElement): boolean {
  return child.type === "i" && (child.props as any)["data-partial"] === true;
}

/**
 * Walk the streaming children tree and cache each partial's outer wrapper
 * (the Suspense or PartialErrorBoundary from transformForStreaming) by
 * bare partial id. This populates the cache after a streaming render so
 * subsequent partial refetches (cache mode) can fill template placeholders
 * for partials that aren't in the refetch response.
 *
 * Uses manual iteration instead of React.Children.* to avoid touching
 * RSC lazy-ref thenables inside Suspense boundaries, which triggers
 * eager resolution and breaks progressive streaming. See
 * STREAMING_DEBUG_NOTES.md §7-8. We stop at partial boundaries, so the
 * lazy refs inside never get walked.
 */
function cacheFromStreamingChildren(
  node: ReactNode,
  cache: Map<string, ReactNode>,
  freshIds: Set<string>,
): void {
  if (node == null || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number") return;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      cacheFromStreamingChildren(node[i], cache, freshIds);
    }
    return;
  }
  if (!isValidElement(node)) return;

  const keyStr = node.key != null ? String(node.key) : null;
  if (keyStr) {
    const hashIdx = keyStr.indexOf("#");
    const partialId = hashIdx >= 0 ? keyStr.slice(0, hashIdx) : keyStr;
    if (freshIds.has(partialId)) {
      cache.set(partialId, node);
      return;
    }
  }

  const inner = (node.props as any)?.children;
  if (inner != null) {
    cacheFromStreamingChildren(inner, cache, freshIds);
  }
}

function renderTemplate(
  template: ReactNode,
  cache: Map<string, ReactNode>,
): ReactNode[] {
  const result: ReactNode[] = [];

  Children.forEach(template, (child) => {
    if (!isValidElement(child)) {
      result.push(child);
      return;
    }
    if (child.key != null && isPlaceholder(child)) {
      const cached = cache.get(String(child.key));
      if (cached) result.push(cached);
      return;
    }
    if ((child.props as any).children != null) {
      const inner = renderTemplate((child.props as any).children, cache);
      result.push(cloneElement(child, {}, ...inner));
    } else {
      result.push(child);
    }
  });

  return result;
}

/**
 * Module-level per-namespace state.
 *
 * Lives outside the React tree so it survives the two-phase void→payload
 * remount in entry.browser.tsx. Without this, each refetch would wipe the
 * cache and force every partial to re-render.
 *
 *   cache       — partial id → rendered ReactNode (used by renderTemplate)
 *   fingerprints — partial id → latest server fingerprint
 *   debug        — accumulated debug entries across renders
 */
type NamespaceState = {
  cache: Map<string, ReactNode>;
  fingerprints: Map<string, string>;
  debug: PartialDebugEntry[];
};
const _nsState = new Map<string, NamespaceState>();
function getNamespaceState(namespace: string): NamespaceState {
  let s = _nsState.get(namespace);
  if (!s) {
    s = { cache: new Map(), fingerprints: new Map(), debug: [] };
    _nsState.set(namespace, s);
  }
  return s;
}

/**
 * Module-level accessor for cached partial tokens.
 * Returns "id:fingerprint" pairs so the server can detect shape changes.
 * Used by the browser entry to send ?cached= during navigation.
 */
export function getCachedPartialIds(): string[] {
  const out: string[] = [];
  for (const [namespace, state] of _nsState) {
    for (const id of state.cache.keys()) {
      const fp = state.fingerprints.get(id);
      out.push(fp ? `${namespace}/${id}:${fp}` : `${namespace}/${id}`);
    }
  }
  return out;
}

/**
 * Hook to interact with a partial — like useActionState for sections.
 *
 * Binds to one partial by ID. Returns [dispatch, isPending]:
 *
 *   const [dispatch, isPending] = usePartial("search");
 *   dispatch({ query: "bulba" });
 *
 *   // Simple invalidation (no props)
 *   const [refresh, isPending] = usePartial("hero");
 *   refresh();
 *
 * Multiple dispatches in the same tick are batched into one RSC request:
 *
 *   const [refreshProducts] = usePartial("products");
 *   const [refreshSidebar] = usePartial("sidebar");
 *   refreshProducts({ filter: "shoes" });
 *   refreshSidebar();  // → single request with both
 */
export function usePartial(
  partialId: string,
): [(props?: Record<string, unknown>) => Promise<void>, boolean] {
  const dispatchFn = useContext(PartialRefetchContext);
  const namespace = useContext(PartialNamespaceContext);
  const [isPending, setIsPending] = useState(false);

  const namespacedId = `${namespace}/${partialId}`;

  const dispatch = useCallback(
    (props?: Record<string, unknown>): Promise<void> => {
      setIsPending(true);
      const p = dispatchFn({ id: namespacedId, props }).finally(() =>
        setIsPending(false),
      );
      return p;
    },
    [namespacedId, dispatchFn],
  );

  return [dispatch, isPending];
}

export function PartialsClient({
  mode = "cache",
  template,
  namespace,
  freshIds,
  fingerprints,
  debug,
  fetchMs,
  children,
}: PartialsClientProps) {
  // Cache/fingerprints/debug live at module scope so they survive the
  // void→payload remount in entry.browser.tsx (two-phase flush that forces
  // Suspense boundaries to re-mount for progressive reveal).
  const nsState = getNamespaceState(namespace);
  const cache = nsState.cache;
  const fps = nsState.fingerprints;

  // Namespace prefix for cache tokens exposed to the browser entry
  const prefix = `${namespace}/`;

  // ── Microtask-batched dispatch ────────────────────────────────────
  // Each usePartial("id") dispatches a single target. Multiple dispatches
  // in the same tick (e.g., refreshProducts(); refreshSidebar();) accumulate
  // here and flush as one RSC request via queueMicrotask.
  const batchRef = useRef<Array<{ id: string; props?: Record<string, unknown> }>>([]);
  const flushRef = useRef<{ promise: Promise<void>; resolve: () => void } | null>(null);

  const flush = useCallback(
    async (targets: Array<{ id: string; props?: Record<string, unknown> }>) => {
      const url = new URL(window.location.href);

      // Build __inputs for targets with props
      const inputs: Record<string, Record<string, unknown>> = {};
      for (const t of targets) {
        if (t.props) inputs[t.id] = t.props;
      }
      if (Object.keys(inputs).length > 0) {
        url.searchParams.set("__inputs", JSON.stringify(inputs));
      }

      const targetIds = targets.map((t) => t.id);

      if (cache.size === 0) {
        // First refetch after streaming render: cache is empty.
        // Request ALL partials for this namespace to populate the cache.
        const allIds = [...fps.keys()].map((id) => `${prefix}${id}`);
        url.searchParams.set("partials", allIds.join(","));
      } else {
        // Normal refetch: request only the target partials.
        // Exclude targets from ?cached= so the server re-renders them.
        url.searchParams.set("partials", targetIds.join(","));
        const targetPrefixes = targetIds.map((id) => `${id}:`);
        const cached = getCachedPartialIds().filter(
          (t) => !targetPrefixes.some((p) => t.startsWith(p)),
        );
        if (cached.length > 0) {
          url.searchParams.set("cached", cached.join(","));
        }
      }

      const handler = (window as any).__rsc_partial_refetch as
        | ((url: string) => Promise<void>)
        | undefined;
      if (handler) await handler(url.toString());
    },
    [prefix],
  );

  const dispatchFn: DispatchFn = useCallback(
    (target) => {
      batchRef.current.push(target);

      if (!flushRef.current) {
        let resolve: () => void;
        const promise = new Promise<void>((r) => { resolve = r; });
        flushRef.current = { promise, resolve: resolve! };

        queueMicrotask(() => {
          const targets = batchRef.current;
          const { resolve: done } = flushRef.current!;
          batchRef.current = [];
          flushRef.current = null;
          flush(targets).then(done);
        });
      }

      return flushRef.current.promise;
    },
    [flush],
  );

  // ── Streaming mode ──────────────────────────────────────────────────
  // Passthrough: children are rendered directly in the tree so Suspense
  // boundaries stay in the server component tree and can stream.
  // We also populate the cache by walking the streaming children tree
  // and caching each partial's outer Suspense/PartialErrorBoundary
  // wrapper by bare partial id. Subsequent partial refetches (cache mode)
  // need a populated cache so template placeholders for not-refetched
  // partials can be filled from cache.
  if (mode === "streaming") {
    for (const [id, fp] of Object.entries(fingerprints)) {
      fps.set(id, fp);
    }
    // Replace the cache with wrappers derived from this streaming render
    cache.clear();
    cacheFromStreamingChildren(children, cache, new Set(freshIds));
    nsState.debug = [];

    return (
      <PartialRefetchContext value={dispatchFn}>
        <PartialNamespaceContext value={namespace}>
          {children}
          <PartialDebugPanel entries={debug} fetchMs={fetchMs} />
        </PartialNamespaceContext>
      </PartialRefetchContext>
    );
  }

  // ── Cache mode ──────────────────────────────────────────────────────
  // Template + cache merge: fresh children update the cache, the template
  // is filled from cache. Used on partial re-fetches.

  // Index fresh partials by key (direct children only — nested partials
  // arrive as their own independent entries, not buried inside parents).
  //
  // The server stamps a per-request version onto each fresh Suspense key
  // (e.g., `stage-1#V2`) to force React to treat it as a new mount so the
  // fallback shows and content streams in progressively. The cache keys
  // by the bare partial ID (before the `#`) so template placeholders
  // — which only know the partial ID — still resolve.
  Children.forEach(children, (child) => {
    if (isValidElement(child) && child.key != null) {
      const rawKey = String(child.key);
      const hashIdx = rawKey.indexOf("#");
      const partialId = hashIdx >= 0 ? rawKey.slice(0, hashIdx) : rawKey;
      cache.set(partialId, child);
    }
  });

  // Update fingerprints — always take the server's latest fingerprints
  for (const [id, fp] of Object.entries(fingerprints)) {
    fps.set(id, fp);
  }

  // Merge debug info: fresh entries replace, cached entries persist
  const freshDebugIds = new Set(debug.map((d) => d.id));
  nsState.debug = [
    // Keep previous entries for partials not in this render
    ...nsState.debug.filter(
      (d) => !freshDebugIds.has(d.id) && cache.has(d.id),
    ),
    // Add/update entries from this render
    ...debug,
  ];

  const rendered = renderTemplate(template, cache);
  return (
    <PartialRefetchContext value={dispatchFn}>
      <PartialNamespaceContext value={namespace}>
        {rendered}
        <PartialDebugPanel entries={nsState.debug} fetchMs={fetchMs} />
      </PartialNamespaceContext>
    </PartialRefetchContext>
  );
}

function PartialDebugPanel({
  entries,
  fetchMs,
}: {
  entries: PartialDebugEntry[];
  fetchMs: number;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const freshCount = entries.filter((e) => e.status === "fresh").length;
  const dataCachedCount = entries.filter((e) => e.status === "data-cached").length;
  const cachedCount = entries.filter((e) => e.status === "cached").length;
  const queryCount = entries.filter((e) => e.query).length;

  return (
    <details
      style={{
        background: "#111",
        border: "1px solid #333",
        borderRadius: 8,
        padding: "1rem",
        marginTop: "2rem",
        overflow: "hidden",
      }}
    >
      <summary
        style={{
          cursor: "pointer",
          color: "#888",
          fontSize: "0.85rem",
          display: "flex",
          gap: "1rem",
          alignItems: "center",
        }}
      >
        <span>Partials</span>
        <span style={{ color: "#8b8" }}>{freshCount} fresh</span>
        {dataCachedCount > 0 && (
          <span style={{ color: "#8bd" }}>{dataCachedCount} data-cached</span>
        )}
        {cachedCount > 0 && (
          <span style={{ color: "#bb8" }}>{cachedCount} cached</span>
        )}
        <span style={{ color: "#88b" }}>
          {queryCount} {queryCount === 1 ? "query" : "queries"}
        </span>
        <span style={{ color: "#666" }}>{fetchMs}ms</span>
      </summary>
      <div style={{ marginTop: "0.75rem" }}>
        {entries.map((entry) => (
          <div
            key={entry.id}
            style={{
              borderTop: "1px solid #222",
              padding: "0.5rem 0",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.75rem",
                cursor: entry.query ? "pointer" : "default",
              }}
              onClick={() =>
                entry.query &&
                setExpandedId(expandedId === entry.id ? null : entry.id)
              }
            >
              <span
                style={{
                  display: "inline-block",
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background:
                    entry.status === "fresh"
                      ? "#48bb78"
                      : entry.status === "data-cached"
                        ? "#63b3ed"
                        : "#ecc94b",
                  flexShrink: 0,
                }}
              />
              <code style={{ color: "#ededed", fontSize: "0.8rem" }}>
                {entry.id}
              </code>
              <span style={{ color: "#666", fontSize: "0.75rem" }}>
                {entry.status}
              </span>
              <span style={{ color: "#444", fontSize: "0.7rem", marginLeft: "auto" }}>
                fp:{entry.fingerprint}
              </span>
              {entry.query && (
                <span style={{ color: "#555", fontSize: "0.75rem" }}>
                  {expandedId === entry.id ? "\u25BC" : "\u25B6"}
                </span>
              )}
            </div>
            {expandedId === entry.id && entry.query && (
              <pre
                style={{
                  fontSize: "0.7rem",
                  color: "#8b8",
                  whiteSpace: "pre-wrap",
                  marginTop: "0.5rem",
                  padding: "0.5rem",
                  background: "#0a0a0a",
                  borderRadius: 4,
                  maxHeight: 300,
                  overflow: "auto",
                }}
              >
                {entry.query}
              </pre>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}
