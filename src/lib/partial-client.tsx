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
  Suspense,
  useCallback,
  useContext,
  useState,
  useRef,
  type ReactNode,
} from "react";

/** Dispatch a single target — batched via microtask in PartialsClient */
type DispatchFn = (
  target: {
    id: string;
    props?: Record<string, unknown>;
    revalidate?: boolean;
  },
) => Promise<void>;

/** Options for `usePartial().refetch(props, options)` */
export interface PartialRefetchOptions {
  /**
   * Revalidate mode: preserve the current Suspense content while fresh
   * content loads (no fallback flash). Default: false (fresh mount — fallback
   * shows immediately). Overrides the action-level default.
   */
  revalidate?: boolean;
}

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
 * Walk a cached element tree and substitute any nested partial wrappers
 * with the current cache entry for that partial id.
 *
 * When the initial streaming render caches a parent partial (e.g. "header"),
 * the cached element has the child partial's Suspense/PartialErrorBoundary
 * embedded directly. Later, when the child partial is refetched alone, the
 * cache entry for the child id is updated but the parent's embedded copy is
 * stale. This walker finds those embedded wrappers by key and swaps them
 * with the fresh cache entry, so nested refetches patch into cached parents.
 *
 * Safety: stops at Suspense boundaries (children there are lazy RSC refs
 * that must not be touched). For Suspense whose own key matches a partial
 * id, we substitute the whole Suspense from cache without walking inside.
 */
function substituteNested(
  node: ReactNode,
  cache: Map<string, ReactNode>,
  skipId: string,
): ReactNode {
  if (node == null || typeof node === "boolean") return node;
  if (typeof node === "string" || typeof node === "number") return node;
  if (Array.isArray(node)) {
    let changed = false;
    const mapped = node.map((c) => {
      const s = substituteNested(c, cache, skipId);
      if (s !== c) changed = true;
      return s;
    });
    return changed ? mapped : node;
  }
  if (!isValidElement(node)) return node;

  const keyStr = node.key != null ? String(node.key) : null;
  if (keyStr) {
    const hashIdx = keyStr.indexOf("#");
    const partialId = hashIdx >= 0 ? keyStr.slice(0, hashIdx) : keyStr;
    if (partialId !== skipId) {
      if (isPlaceholder(node)) {
        return cache.get(partialId) ?? node;
      }
      const fresh = cache.get(partialId);
      if (fresh && fresh !== node) return fresh;
    }
  }

  // Don't walk into Suspense — children may be lazy RSC refs
  if (node.type === Suspense) return node;

  const children = (node.props as any).children;
  if (children == null) return node;
  const newChildren = substituteNested(children, cache, skipId);
  if (newChildren === children) return node;
  return cloneElement(node, {}, newChildren);
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
const LAZY_SYMBOL_STR = "Symbol(react.lazy)";

/**
 * Unwrap a raw lazy reference at the tree level.
 *
 * RSC Flight sometimes emits raw lazy objects (not wrapped in React
 * elements) when resolving back-references between payload paths.
 * These look like `{ $$typeof: Symbol(react.lazy), _payload, _init }`.
 *
 * If the lazy is already resolved (_payload._status === 1), return the
 * resolved value. Otherwise return null — callers should treat pending
 * lazies as opaque (don't descend, don't cache).
 */
function unwrapLazy(node: unknown): unknown {
  if (node == null || typeof node !== "object") return node;
  const n = node as any;
  if (typeof n.$$typeof !== "symbol") return node;
  if (n.$$typeof.toString() !== LAZY_SYMBOL_STR) return node;
  const payload = n._payload;
  if (payload && payload._status === 1) return payload._result;
  try {
    const init = n._init;
    if (typeof init === "function") return init(payload);
  } catch {
    // Pending/errored — treat as opaque
  }
  return null;
}

function cacheFromStreamingChildren(
  node: ReactNode,
  cache: Map<string, ReactNode>,
  freshIds: Set<string>,
): void {
  if (node == null || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number") return;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      cacheFromStreamingChildren(node[i] as ReactNode, cache, freshIds);
    }
    return;
  }
  // RSC Flight can emit raw lazy refs (not React elements) at the tree
  // level to resolve back-references between payload paths. Unwrap them
  // so we can continue walking. Pending lazies unwrap to null and are
  // dropped — treating them as opaque leaves.
  const unwrapped = unwrapLazy(node);
  if (unwrapped !== node) {
    cacheFromStreamingChildren(unwrapped as ReactNode, cache, freshIds);
    return;
  }
  if (!isValidElement(node)) return;

  const keyStr = node.key != null ? String(node.key) : null;
  if (keyStr) {
    const hashIdx = keyStr.indexOf("#");
    const partialId = hashIdx >= 0 ? keyStr.slice(0, hashIdx) : keyStr;
    if (freshIds.has(partialId)) {
      cache.set(partialId, node);
      // For Suspense, stop — children contain lazy RSC refs.
      // For PartialErrorBoundary (no-fallback partials), keep walking so
      // nested partials inside get cached separately, enabling nested-only
      // refetches to substitute fresh content into cached ancestors.
      if (node.type === Suspense) return;
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
      const id = String(child.key);
      const cached = cache.get(id);
      // Substitute nested partial wrappers inside cached ancestors from
      // the current cache. On first render this is a no-op (cached parent
      // already contains the child's Suspense by reference), but after a
      // nested-only refetch the child cache entry is updated and the stale
      // wrapper inside the parent gets swapped out here.
      if (cached) result.push(substituteNested(cached, cache, id));
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
 * Transient search-params for the next partial refetch, per namespace.
 * Written via `usePartialParams`, consumed (and cleared) by `flush`.
 *
 * Purpose: give Partial-mode callers the same server-side effect as URL
 * mode (server reads `?q=p` from the request URL and evaluates JSX gates
 * against it) without mutating `window.location` or the browser history.
 *
 * A `null` value deletes the param; a string sets it.
 */
const _transientParams = new Map<string, Record<string, string | null>>();

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
/**
 * Hook: set transient search-params for the next partial refetch.
 *
 * Returned setter writes params into a per-namespace transient store; the
 * next refetch picks them up, merges them into its fetch URL, and clears
 * the store. Never touches `window.location` or `history`.
 *
 * Use it when you want the server to observe a URL param for *this one
 * request* — e.g. a search query in "ephemeral" mode — without making the
 * param bookmarkable.
 *
 *   const setParams = usePartialParams();
 *   setParams({ q: "pika" });   // next refetch fetches ?q=pika
 *   setParams({ q: null });     // next refetch drops ?q
 */
export function usePartialParams(): (
  params: Record<string, string | null>,
) => void {
  const namespace = useContext(PartialNamespaceContext);
  return useCallback(
    (params: Record<string, string | null>) => {
      const current = _transientParams.get(namespace) ?? {};
      _transientParams.set(namespace, { ...current, ...params });
    },
    [namespace],
  );
}

export function usePartial(
  partialId: string,
): [
  (
    props?: Record<string, unknown>,
    options?: PartialRefetchOptions,
  ) => Promise<void>,
  boolean,
] {
  const dispatchFn = useContext(PartialRefetchContext);
  const namespace = useContext(PartialNamespaceContext);
  const [isPending, setIsPending] = useState(false);

  const namespacedId = `${namespace}/${partialId}`;

  const dispatch = useCallback(
    (
      props?: Record<string, unknown>,
      options?: PartialRefetchOptions,
    ): Promise<void> => {
      setIsPending(true);
      const p = dispatchFn({
        id: namespacedId,
        props,
        revalidate: options?.revalidate,
      }).finally(() => setIsPending(false));
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
  const batchRef = useRef<
    Array<{
      id: string;
      props?: Record<string, unknown>;
      revalidate?: boolean;
    }>
  >([]);
  const flushRef = useRef<{ promise: Promise<void>; resolve: () => void } | null>(null);

  const flush = useCallback(
    async (
      targets: Array<{
        id: string;
        props?: Record<string, unknown>;
        revalidate?: boolean;
      }>,
    ) => {
      const url = new URL(window.location.href);

      // If any target opted into revalidate, flag the whole batch. The
      // server uses this to emit bare Suspense keys so the client reconciles
      // in place (preserving old content during the transition).
      if (targets.some((t) => t.revalidate)) {
        url.searchParams.set("revalidate", "1");
      }

      // Apply (and clear) any transient search-params set via usePartialParams.
      // These are request-scoped overrides that never mutate window.location.
      const transient = _transientParams.get(namespace);
      if (transient) {
        for (const [k, v] of Object.entries(transient)) {
          if (v == null) url.searchParams.delete(k);
          else url.searchParams.set(k, v);
        }
        _transientParams.delete(namespace);
      }

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
    [prefix, namespace],
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
  // Populate the cache by walking the streaming children tree and caching
  // each partial's outer Suspense/PartialErrorBoundary wrapper by bare
  // partial id. Then render via renderTemplate(template, cache) — the SAME
  // output shape as cache mode. This way the React tree structure doesn't
  // change between streaming and the first cache-mode refetch, so React
  // reconciles in place (no fallback flash on first user interaction).
  //
  // The cached wrappers still contain the RSC lazy refs from the stream as
  // their descendants, so Suspense boundaries continue to stream progressively.
  //
  // Revalidate: when the server emits bare Suspense keys (action response
  // without explicit invalidate), adopt the previously cached stamped key so
  // React reconciles in place — no fallback flash.
  if (mode === "streaming") {
    for (const [id, fp] of Object.entries(fingerprints)) {
      fps.set(id, fp);
    }
    // Capture prev cache before clearing so bare-keyed fresh wrappers can
    // adopt the prior stamped keys.
    const prevCache = new Map(cache);
    cache.clear();
    cacheFromStreamingChildren(children, cache, new Set(freshIds));
    for (const [id, node] of cache) {
      if (!isValidElement(node) || node.key == null) continue;
      const rawKey = String(node.key);
      if (rawKey.indexOf("#") >= 0) continue; // already stamped, keep
      const prev = prevCache.get(id);
      if (
        prev &&
        isValidElement(prev) &&
        prev.key != null &&
        prev.key !== node.key
      ) {
        cache.set(id, cloneElement(node, { key: prev.key }));
      }
    }
    nsState.debug = [];

    const rendered = renderTemplate(template, cache);
    return (
      <PartialRefetchContext value={dispatchFn}>
        <PartialNamespaceContext value={namespace}>
          {rendered}
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
  // Invalidate: server stamps a per-request version onto each fresh Suspense
  // key (e.g., `cart#V2`). React treats it as a new mount — fallback shows,
  // content streams in progressively.
  //
  // Revalidate: server sends a bare key (`cart`). We clone the fresh child
  // with the prior cached element's key so React reconciles in place. Under
  // the client's startTransition, old content stays visible until the fresh
  // content resolves (no fallback flash).
  //
  // Cache keys are always the bare partial ID (before any `#`).
  Children.forEach(children, (child) => {
    if (isValidElement(child) && child.key != null) {
      const rawKey = String(child.key);
      const hashIdx = rawKey.indexOf("#");
      const partialId = hashIdx >= 0 ? rawKey.slice(0, hashIdx) : rawKey;

      let toCache = child;
      if (hashIdx < 0) {
        const prev = cache.get(partialId);
        if (
          prev &&
          isValidElement(prev) &&
          prev.key != null &&
          prev.key !== child.key
        ) {
          toCache = cloneElement(child, { key: prev.key });
        }
      }
      cache.set(partialId, toCache);
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
