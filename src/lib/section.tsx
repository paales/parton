/**
 * Section Architecture
 *
 * Pages are flat lists of sections. Each section is independently
 * re-renderable — like Shopify's section architecture for React.
 *
 * <SectionList getSchema={getSchema} execute={execute} sections={sections}>
 *   <div key="header">
 *     <CartSection key="cart" />
 *   </div>
 *   <main>
 *     <ProductGrid key="products" search={search} />
 *   </main>
 *   <footer>
 *     <QueryDebug key="debug" />
 *   </footer>
 * </SectionList>
 *
 * The `key` of each child is its section ID. Keyless elements like
 * <main> and <footer> are structural wrappers — preserved in layout
 * but transparent to the section system.
 *
 * Components read the query root via getQueryRoot() from the request
 * context — no prop injection needed.
 *
 * Nested sections are first-class: `<div key="header"><Cart key="cart" /></div>`
 * renders cart independently of its parent. Refreshing "header" re-renders
 * the header layout but keeps the cached cart. Refreshing "cart" patches
 * just the cart into the cached header. Refreshing both updates everything.
 *
 * On full page render: all sections render, one GraphQL query.
 * On section re-fetch (?sections=hero,stats): only those sections render.
 * The client SectionListClient merges fresh sections with its cache,
 * so non-requested sections remain visible.
 */

import React, { type ReactNode } from "react";
import { AccessRecorder } from "./access-recorder.ts";
import { renderForDiscovery } from "./discovery.ts";
import { createProxy } from "./proxy-node.ts";
import { compileQuery } from "./query-compiler.ts";
import { SectionListClient } from "./section-client.tsx";
import { SectionErrorBoundary } from "./section-error-boundary.tsx";
import type { SchemaGraph } from "./schema.ts";
import { setQueryRoot, getRequest } from "../framework/context.ts";

interface SectionListProps {
  children: ReactNode;
  /** Schema provider for the GraphQL backend */
  getSchema: () => Promise<SchemaGraph>;
  /** Query executor for the GraphQL backend */
  execute: <T>(query: string) => Promise<T>;
}

interface SectionEntry {
  id: string;
  element: React.ReactElement;
  depth: number;
}

/**
 * Compute a lightweight fingerprint of a React element tree.
 *
 * Walks the element structure as plain data — no component functions
 * are called. Inspects type (tag name or component name), key, and
 * non-children props. Recurses into children.
 *
 * Used to detect when a cached section's shape has changed between
 * pages (e.g., header gains SectionControls on the detail page).
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

  // Include non-children props that affect shape (skip event handlers & objects)
  for (const [k, v] of Object.entries(props)) {
    if (k === "children") continue;
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
function collectSections(children: ReactNode, depth = 0): SectionEntry[] {
  const entries: SectionEntry[] = [];
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return;
    if (child.key != null) {
      entries.push({ id: String(child.key), element: child, depth });
      if (child.props.children) {
        entries.push(...collectSections(child.props.children, depth + 1));
      }
    } else if (child.props.children) {
      entries.push(...collectSections(child.props.children, depth));
    }
  });
  return entries;
}

/**
 * Build a structural template from the children tree: keyless wrappers
 * are preserved, keyed sections are replaced with placeholders.
 * The client fills these placeholders from its section cache.
 */
function buildTemplate(children: ReactNode): ReactNode[] {
  const result: ReactNode[] = [];
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) {
      result.push(child);
      return;
    }
    if (child.key != null) {
      result.push(React.createElement("i", { key: child.key, hidden: true }));
    } else if (child.props.children) {
      result.push(
        React.cloneElement(child, {}, ...buildTemplate(child.props.children)),
      );
    } else {
      result.push(child);
    }
  });
  return result;
}

/**
 * Replace nested sections inside an element with keyed placeholders.
 * This allows parent sections to render without triggering discovery
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

/**
 * Resolve boundary + section orchestrator.
 *
 * Owns the full lifecycle: runs discovery across all active sections,
 * compiles a single GraphQL query, fetches data, then stores the
 * data-backed proxy on the request context. Section components read
 * it via getQueryRoot() — no prop injection needed.
 *
 * Nested sections are extracted from their parents and rendered
 * independently. Parents get keyed placeholders; the client patches
 * cached nested sections back in via patchNested.
 *
 * Keyless wrappers (main, footer) are preserved in a structural
 * template that the client uses for layout.
 */
export async function SectionList({
  children,
  getSchema,
  execute,
}: SectionListProps) {
  // Read sections and cached from the current request URL
  const requestUrl = new URL(getRequest().url);
  const sections = requestUrl.searchParams.get("sections");
  const cached = requestUrl.searchParams.get("cached");
  // Collect all keyed elements (top-level and nested, through keyless wrappers)
  const allSections = collectSections(children);
  const nestedIds = new Set(
    allSections.filter((e) => e.depth > 0).map((e) => e.id),
  );

  const requestedIds = sections
    ? new Set(sections.split(",").map((s) => s.trim()))
    : null;

  // Compute fingerprints for all sections (cheap — walks element tree, no rendering)
  const fingerprints = new Map<string, string>();
  for (const entry of allSections) {
    fingerprints.set(
      entry.id,
      hashFingerprint(fingerprintElement(entry.element)),
    );
  }

  // Parse cached entries: "id:fingerprint,id:fingerprint" or legacy "id,id"
  const cachedFingerprints = new Map<string, string | null>();
  if (cached) {
    for (const token of cached.split(",").map((s) => s.trim())) {
      const colonIdx = token.indexOf(":");
      if (colonIdx > 0) {
        cachedFingerprints.set(
          token.slice(0, colonIdx),
          token.slice(colonIdx + 1),
        );
      } else {
        cachedFingerprints.set(token, null);
      }
    }
  }

  // Active entries: sections to discover + render.
  // Skip sections the client has cached AND whose fingerprint still matches.
  const activeEntries = allSections.filter((e) => {
    if (requestedIds && !requestedIds.has(e.id)) return false;
    if (cachedFingerprints.has(e.id)) {
      const clientFp = cachedFingerprints.get(e.id);
      const serverFp = fingerprints.get(e.id);
      // Only skip if client sent a fingerprint and it matches
      if (clientFp != null && clientFp === serverFp) return false;
      // Fingerprint mismatch or no fingerprint → must re-render
    }
    return true;
  });

  const freshIds = activeEntries.map((e) => e.id);

  // Strip nested sections from parents — they render independently.
  // Parents get keyed placeholders; the client patches cached children in.
  const activeChildren = activeEntries.map((e) =>
    nestedIds.has(e.id) ? e.element : stripNested(e.element, nestedIds),
  );

  // Structural template: preserves keyless wrappers, sections become placeholders
  const template = buildTemplate(children);

  // Phase 1: Discovery — phantom proxy on request context, walk active sections
  const schema = await getSchema();
  const queryTypeName = schema.getQueryTypeName();
  const recorder = new AccessRecorder();
  const phantom = createProxy(schema, queryTypeName, recorder);

  setQueryRoot(phantom, { query: "" });
  for (const child of activeChildren) {
    renderForDiscovery(child);
  }

  // Phase 2: Compile + fetch
  const tree = recorder.getAccessTree();
  const query = compileQuery(tree);
  const data = await execute<Record<string, unknown>>(query);

  // Phase 3: Store data proxy on request context for component rendering.
  // Reuse the discovery recorder — it holds the alias mappings so the
  // data proxy resolves the same aliases for parameterized fields.
  const dataProxy = createProxy(schema, queryTypeName, recorder, data);
  setQueryRoot(dataProxy, { query });

  // Wrap each section in an error boundary so one failure doesn't crash the page
  const wrappedChildren = activeChildren.map((child) => {
    const id = React.isValidElement(child) ? String(child.key) : "unknown";
    return (
      <SectionErrorBoundary key={id} sectionId={id}>
        {child}
      </SectionErrorBoundary>
    );
  });

  // Return template + active sections — components read q via getQueryRoot()
  // Send fingerprints as a plain object so the client can cache them
  const fpObject = Object.fromEntries(fingerprints);
  return (
    <SectionListClient
      template={template}
      freshIds={freshIds}
      fingerprints={fpObject}
    >
      {wrappedChildren}
    </SectionListClient>
  );
}
