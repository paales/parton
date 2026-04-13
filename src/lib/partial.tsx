/**
 * Partial Architecture
 *
 * Pages are flat lists of partials. Each partial is independently
 * re-renderable — like Shopify's section rendering for React.
 *
 * <Partials getSchema={getSchema} execute={execute}>
 *   <div key="header">
 *     <Cart key="cart" />
 *   </div>
 *   <main>
 *     <ProductGrid key="products" search={search} />
 *   </main>
 * </Partials>
 *
 * The `key` of each child is its partial ID. Keyless elements like
 * <main> and <footer> are structural wrappers — preserved in layout
 * but transparent to the partial system.
 *
 * Components read the query root via getQueryRoot() from the request
 * context — no prop injection needed.
 *
 * Nested partials are first-class: `<div key="header"><Cart key="cart" /></div>`
 * renders cart independently of its parent. Refreshing "header" re-renders
 * the header layout but keeps the cached cart. Refreshing "cart" patches
 * just the cart into the cached header. Refreshing both updates everything.
 *
 * Data is optional. Without getSchema/execute, partials render directly —
 * useful for static content (head, nav) or wrapping nested Partials
 * that each bring their own data source.
 *
 * On full page render: all partials render.
 * On partial re-fetch (?partials=hero,stats): only those partials render.
 * The client PartialsClient merges fresh partials with its cache,
 * so non-requested partials remain visible.
 *
 * Namespace: when multiple Partials instances are nested and may share
 * key names, use the `namespace` prop to disambiguate. IDs are prefixed
 * with `namespace/` in all communication (URL params, cache, debug).
 */

import React, { type ReactNode } from "react";
import { AccessRecorder } from "./access-recorder.ts";
import { renderForDiscovery } from "./discovery.ts";
import { createProxy } from "./proxy-node.ts";
import { compileQuery } from "./query-compiler.ts";
import {
  PartialsClient,
  type PartialDebugEntry,
} from "./partial-client.tsx";
import { PartialErrorBoundary } from "./partial-error-boundary.tsx";
import { getCachedData, setCachedData } from "./partial-cache.ts";
import type { SchemaGraph } from "./schema.ts";
import { setQueryRoot, getRequest } from "../framework/context.ts";

interface PartialsProps {
  children: ReactNode;
  /** Namespace prefix for partial IDs — required to disambiguate nested Partials instances */
  namespace: string;
  /** Schema provider for the GraphQL backend (optional — without it, partials render without data) */
  getSchema?: () => Promise<SchemaGraph>;
  /** Query executor for the GraphQL backend (optional — required if getSchema is provided) */
  execute?: <T>(query: string) => Promise<T>;
}

/** Props reserved by the Partials system — stripped before rendering the component. */
const RESERVED_PROPS = new Set(["tags", "cache"]);

interface PartialEntry {
  id: string;
  element: React.ReactElement;
  depth: number;
  /** Invalidation tags declared via `tags` prop */
  tags: string[];
  /** Data cache TTL in seconds (0 = no cache, default) */
  cacheTtl: number;
}

/**
 * Compute a lightweight fingerprint of a React element tree.
 *
 * Walks the element structure as plain data — no component functions
 * are called. Inspects type (tag name or component name), key, and
 * non-children props. Recurses into children.
 *
 * Used to detect when a cached partial's shape has changed between
 * pages (e.g., header gains controls on the detail page).
 */
function fingerprintElement(node: React.ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(fingerprintElement).join(",");
  if (!React.isValidElement(node)) return "";

  const type =
    typeof node.type === "string"
      ? node.type
      : (node.type as any).displayName ||
        (node.type as any).name ||
        "Anonymous";

  const props = node.props as Record<string, unknown>;
  const parts: string[] = [type];

  if (node.key != null) parts.push(`k=${node.key}`);

  // Include non-children props that affect shape (skip event handlers, objects, reserved)
  for (const [k, v] of Object.entries(props)) {
    if (k === "children" || RESERVED_PROPS.has(k)) continue;
    if (typeof v === "function") continue;
    if (typeof v === "object" && v !== null) continue;
    parts.push(`${k}=${v}`);
  }

  // Recurse into children
  if (props.children != null) {
    parts.push(`(${fingerprintElement(props.children as React.ReactNode)})`);
  }

  return parts.join("|");
}

/** Hash a fingerprint string into a short hex digest. */
function hashFingerprint(fp: string): string {
  // djb2 — fast, non-crypto, sufficient for change detection
  let hash = 5381;
  for (let i = 0; i < fp.length; i++) {
    hash = ((hash << 5) + hash + fp.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/**
 * Walk the children tree to collect all keyed elements at any depth.
 * Keyless wrappers (main, footer, div without key) are transparent —
 * we recurse into them without incrementing depth.
 */
function collectPartials(children: ReactNode, depth = 0): PartialEntry[] {
  const entries: PartialEntry[] = [];
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return;
    if (child.key != null) {
      const props = child.props as Record<string, unknown>;
      const tags = Array.isArray(props.tags) ? (props.tags as string[]) : [];
      const cacheTtl = typeof props.cache === "number" ? props.cache : 0;
      entries.push({ id: String(child.key), element: child, depth, tags, cacheTtl });
      if (child.props.children) {
        entries.push(...collectPartials(child.props.children, depth + 1));
      }
    } else if (child.props.children) {
      entries.push(...collectPartials(child.props.children, depth));
    }
  });
  return entries;
}

/**
 * Strip reserved props (tags, cache) from an element before rendering.
 * These are consumed by the Partials orchestrator, not by the component.
 */
function stripReservedProps(element: React.ReactElement): React.ReactElement {
  const props = element.props as Record<string, unknown>;
  const hasReserved = Object.keys(props).some((k) => RESERVED_PROPS.has(k));
  if (!hasReserved) return element;
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (!RESERVED_PROPS.has(k)) clean[k] = v;
  }
  return React.createElement(element.type as any, { ...clean, key: element.key });
}

/**
 * Build a structural template from the children tree: keyless wrappers
 * are preserved, keyed partials are replaced with placeholders.
 * The client fills these placeholders from its cache.
 */
function buildTemplate(children: ReactNode): ReactNode[] {
  const result: ReactNode[] = [];
  let wrapIdx = 0;
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) {
      result.push(child);
      return;
    }
    if (child.key != null) {
      // Partial placeholder — client fills from cache
      result.push(
        React.createElement("i", {
          key: child.key,
          hidden: true,
          "data-partial": true,
        }),
      );
    } else if (child.props.children) {
      // Structural wrapper — preserve layout, assign key to avoid React warning
      const wrapKey =
        typeof child.type === "string"
          ? `_${child.type}`
          : `_w${wrapIdx++}`;
      result.push(
        React.cloneElement(
          child,
          { key: wrapKey },
          ...buildTemplate(child.props.children),
        ),
      );
    } else {
      result.push(child);
    }
  });
  return result;
}

/**
 * Replace nested partials inside an element with keyed placeholders.
 * This allows parent partials to render without triggering discovery
 * or data fetching for their nested children — those render independently.
 */
function stripNested(
  element: React.ReactElement,
  nestedIds: Set<string>,
): React.ReactElement {
  const { children } = element.props;
  if (!children) return element;

  let changed = false;
  const result: ReactNode[] = [];

  React.Children.forEach(children, (child) => {
    if (
      React.isValidElement(child) &&
      child.key != null &&
      nestedIds.has(String(child.key))
    ) {
      result.push(React.createElement("i", { key: child.key, hidden: true }));
      changed = true;
    } else if (React.isValidElement(child)) {
      const stripped = stripNested(child, nestedIds);
      if (stripped !== child) changed = true;
      result.push(stripped);
    } else {
      result.push(child);
    }
  });

  return changed ? React.cloneElement(element, {}, ...result) : element;
}

// ─── Data Pipeline ──────────────────────────────────────────────────────
// Separated from Partials so partials can render with or without data.
// When getSchema/execute are provided, active partials go through:
//   discovery → compile → parallel fetch → PartialScope (proxy per partial)
// When not provided, partials render directly.

interface DataPipelineResult {
  wrappedChildren: React.ReactNode[];
  debug: PartialDebugEntry[];
  fetchMs: number;
}

async function runDataPipeline(
  activeChildren: React.ReactElement[],
  allIds: string[],
  freshIds: string[],
  fingerprints: Map<string, string>,
  cacheConfig: Map<string, { ttl: number; tags: string[] }>,
  getSchema: () => Promise<SchemaGraph>,
  execute: <T>(query: string) => Promise<T>,
): Promise<DataPipelineResult> {
  const schema = await getSchema();
  const queryTypeName = schema.getQueryTypeName();
  const fetchStart = Date.now();

  // Phase 1: Per-partial discovery — each partial gets its own recorder
  const partialPlans = activeChildren.map((child) => {
    const id = React.isValidElement(child) ? String(child.key) : "unknown";
    const recorder = new AccessRecorder();
    const phantom = createProxy(schema, queryTypeName, recorder);
    setQueryRoot(phantom, { query: "" });
    renderForDiscovery(child);
    const tree = recorder.getAccessTree();
    const query = compileQuery(tree);
    return { child, id, recorder, query };
  });

  // Phase 2: Parallel fetch — check data cache first, fetch on miss
  const responses = await Promise.all(
    partialPlans.map(async (plan) => {
      const config = cacheConfig.get(plan.id);
      // Check data cache if partial has a cache TTL
      if (config && config.ttl > 0) {
        const cached = getCachedData(plan.query);
        if (cached) return { data: cached, fromCache: true };
      }
      const data = await execute<Record<string, unknown>>(plan.query);
      // Store in data cache if partial has a cache TTL
      if (config && config.ttl > 0) {
        setCachedData(plan.query, data, config.ttl, config.tags);
      }
      return { data, fromCache: false };
    }),
  );
  const fetchMs = Date.now() - fetchStart;

  // Phase 3: Wrap each partial in PartialScope (sets queryRoot per partial)
  const wrappedChildren = partialPlans.map((plan, i) => {
    const dataProxy = createProxy(
      schema,
      queryTypeName,
      plan.recorder,
      responses[i].data,
    );
    return (
      <PartialErrorBoundary key={plan.id} partialId={plan.id}>
        <PartialScope proxy={dataProxy} meta={{ query: plan.query }}>
          {plan.child}
        </PartialScope>
      </PartialErrorBoundary>
    );
  });

  // Build debug info
  const freshSet = new Set(freshIds);
  const partialQueryMap = new Map(
    partialPlans.map((plan) => [plan.id, plan.query]),
  );
  const cacheHits = new Set(
    partialPlans
      .filter((_, i) => responses[i].fromCache)
      .map((plan) => plan.id),
  );

  const debug: PartialDebugEntry[] = allIds.map((id) => ({
    id,
    status: freshSet.has(id)
      ? cacheHits.has(id)
        ? "data-cached"
        : "fresh"
      : "cached",
    fingerprint: fingerprints.get(id) ?? "",
    query: partialQueryMap.get(id) ?? null,
  }));

  return { wrappedChildren, debug, fetchMs };
}

function renderWithoutData(
  activeChildren: React.ReactElement[],
  allIds: string[],
  freshIds: string[],
  fingerprints: Map<string, string>,
): DataPipelineResult {
  const freshSet = new Set(freshIds);

  const wrappedChildren = activeChildren.map((child) => {
    const id = React.isValidElement(child) ? String(child.key) : "unknown";
    return (
      <PartialErrorBoundary key={id} partialId={id}>
        {child}
      </PartialErrorBoundary>
    );
  });

  const debug: PartialDebugEntry[] = allIds.map((id) => ({
    id,
    status: freshSet.has(id) ? "fresh" : "cached",
    fingerprint: fingerprints.get(id) ?? "",
    query: null,
  }));

  return { wrappedChildren, debug, fetchMs: 0 };
}

// ─── Partials ──────────────────────────────────────────────────────────
// Partial orchestrator: collects partials, filters, caches, templates.
// Delegates to the data pipeline when a schema is provided.

export async function Partials({
  children,
  namespace,
  getSchema,
  execute,
}: PartialsProps) {
  // Read partials, tags, cached, and partial inputs from the current request URL
  const requestUrl = new URL(getRequest().url);
  const partialsParam = requestUrl.searchParams.get("partials");
  const tagsParam = requestUrl.searchParams.get("tags");
  const cached = requestUrl.searchParams.get("cached");
  const inputsParam = requestUrl.searchParams.get("__inputs");
  let partialInputs: Record<string, Record<string, unknown>> = {};
  if (inputsParam) {
    try {
      partialInputs = JSON.parse(inputsParam);
    } catch {
      // Malformed __inputs — ignore and render with default props
    }
  }

  // Collect all keyed elements (top-level and nested, through keyless wrappers)
  const allPartials = collectPartials(children);
  const nestedIds = new Set(
    allPartials.filter((e) => e.depth > 0).map((e) => e.id),
  );

  // Build tag → partial ID mapping for tag-based invalidation
  const tagIndex = new Map<string, Set<string>>();
  for (const entry of allPartials) {
    for (const tag of entry.tags) {
      let ids = tagIndex.get(tag);
      if (!ids) {
        ids = new Set();
        tagIndex.set(tag, ids);
      }
      ids.add(entry.id);
    }
  }

  // Build cache config per partial (for the data pipeline)
  const cacheConfig = new Map<string, { ttl: number; tags: string[] }>();
  for (const entry of allPartials) {
    if (entry.cacheTtl > 0 || entry.tags.length > 0) {
      cacheConfig.set(entry.id, { ttl: entry.cacheTtl, tags: entry.tags });
    }
  }

  // URL params use namespaced IDs (e.g., ?partials=pokemon/hero).
  // Strip the namespace prefix to match against raw child keys.
  const prefix = `${namespace}/`;

  // Resolve ?tags= to partial IDs via the tag index
  const tagResolvedIds = tagsParam
    ? new Set(
        tagsParam
          .split(",")
          .map((t) => t.trim())
          .flatMap((tag) => {
            const ids = tagIndex.get(tag);
            return ids ? [...ids] : [];
          }),
      )
    : null;

  // Resolve ?partials= (by ID) — only IDs matching this namespace
  const partialResolvedIds = partialsParam
    ? new Set(
        partialsParam
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.startsWith(prefix))
          .map((s) => s.slice(prefix.length)),
      )
    : null;

  // If ?partials= was set but no IDs matched our namespace prefix,
  // the filter targets a different namespace → pass through (render all)
  // so nested Partials instances with other namespaces can handle it.
  const partialFilterApplies =
    partialResolvedIds != null && partialResolvedIds.size > 0;

  // Merge applicable filters. Tags are always local (resolved against
  // this instance's tag index). If neither filter applies, render all.
  const requestedIds =
    partialFilterApplies || tagResolvedIds
      ? new Set([
          ...(partialFilterApplies ? partialResolvedIds : []),
          ...(tagResolvedIds ?? []),
        ])
      : null;

  // Strip namespace from __inputs keys
  const resolvedInputs: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(partialInputs)) {
    const rawKey = key.startsWith(prefix) ? key.slice(prefix.length) : key;
    resolvedInputs[rawKey] = value;
  }

  // Compute fingerprints for all partials (cheap — walks element tree, no rendering)
  const fingerprints = new Map<string, string>();
  for (const entry of allPartials) {
    fingerprints.set(
      entry.id,
      hashFingerprint(fingerprintElement(entry.element)),
    );
  }

  // Parse cached entries: "id:fingerprint,id:fingerprint" or legacy "id,id"
  // Strip namespace prefix from cached tokens too.
  const cachedFingerprints = new Map<string, string | null>();
  if (cached) {
    for (const token of cached.split(",").map((s) => s.trim())) {
      const colonIdx = token.indexOf(":");
      let id: string;
      let fp: string | null;
      if (colonIdx > 0) {
        id = token.slice(0, colonIdx);
        fp = token.slice(colonIdx + 1);
      } else {
        id = token;
        fp = null;
      }
      // Only process tokens belonging to this namespace
      if (!id.startsWith(prefix)) continue;
      id = id.slice(prefix.length);
      cachedFingerprints.set(id, fp);
    }
  }

  // Active entries: partials to discover + render.
  //
  // When ?partials= is set: only render requested partials (plus __inputs overrides).
  // When no filter: render all — a partial's output can depend on URL/context
  // changes that the element-tree fingerprint can't capture.
  //
  // Fingerprint-based skipping on the server is intentionally NOT done here.
  // The client-side PartialsClient cache handles the visual merge — only fresh
  // partials update the DOM. The fingerprints are sent to the client for
  // change detection, not used for server-side skip logic.
  const activeEntries = allPartials.filter((e) => {
    if (requestedIds && !requestedIds.has(e.id)) return false;
    return true;
  });

  const freshIds = activeEntries.map((e) => e.id);

  // Apply partial input overrides (from usePartial().refetch({ ... })),
  // strip reserved props (tags, cache), then strip nested partials.
  const activeChildren = activeEntries.map((e) => {
    const overrides = resolvedInputs[e.id];
    let element = overrides
      ? React.cloneElement(e.element, overrides)
      : e.element;
    element = stripReservedProps(element);
    return nestedIds.has(e.id) ? element : stripNested(element, nestedIds);
  });

  // Structural template: preserves keyless wrappers, partials become placeholders
  const template = buildTemplate(children);

  const allIds = allPartials.map((e) => e.id);

  // Run data pipeline if schema is available, otherwise render directly
  const hasData = getSchema != null && execute != null;
  const { wrappedChildren, debug, fetchMs } = hasData
    ? await runDataPipeline(
        activeChildren,
        allIds,
        freshIds,
        fingerprints,
        cacheConfig,
        getSchema,
        execute,
      )
    : renderWithoutData(activeChildren, allIds, freshIds, fingerprints);

  const fpObject = Object.fromEntries(fingerprints);
  return (
    <PartialsClient
      template={template}
      namespace={namespace}
      freshIds={freshIds}
      fingerprints={fpObject}
      debug={debug}
      fetchMs={fetchMs}
    >
      {wrappedChildren}
    </PartialsClient>
  );
}

/**
 * Sets the query root proxy for a partial's children.
 *
 * React's flight server renders server components depth-first:
 * PartialScope sets the proxy, React renders children (which call
 * getQueryRoot()), then moves to the next sibling's PartialScope.
 * This gives each partial its own isolated data proxy.
 */
function PartialScope({
  proxy,
  meta,
  children,
}: {
  proxy: unknown;
  meta: { query: string };
  children: React.ReactNode;
}) {
  setQueryRoot(proxy, meta);
  return <>{children}</>;
}
