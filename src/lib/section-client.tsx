"use client";

/**
 * Client-side section merge coordinator.
 *
 * Receives a structural template (layout with section placeholders)
 * and fresh section content. Caches sections across renders and fills
 * the template from cache on every render.
 *
 * On full renders: all sections are fresh → cache fully populated.
 * On partial renders: only requested sections update the cache.
 * The template is always the same structural layout (main, footer, etc.),
 * so keyless wrappers are preserved across partial updates.
 *
 * Nested sections are supported: if "cart" is nested inside "header",
 * refreshing "header" re-renders the header layout but keeps cached
 * cart. Refreshing "cart" patches just the cart into cached header.
 */

import {
  Children,
  cloneElement,
  isValidElement,
  useRef,
  type ReactNode,
} from "react";

interface SectionListClientProps {
  template: ReactNode;
  freshIds: string[];
  /** Section fingerprints: { sectionId: hash } — used for cache invalidation */
  fingerprints: Record<string, string>;
  children: ReactNode;
}

/**
 * Clone an element tree, replacing any keyed child whose cache entry
 * differs from the current child. Recurses into replacements to handle
 * deeply nested sections (e.g., header > nav > cart).
 */
function patchNested(
  node: ReactNode,
  cache: Map<string, ReactNode>,
  visited = new Set<string>(),
): ReactNode {
  if (!isValidElement(node) || !(node.props as any).children) return node;

  let changed = false;
  const patched: ReactNode[] = [];

  Children.forEach((node.props as any).children, (child) => {
    if (isValidElement(child) && child.key != null) {
      const key = String(child.key);
      const cached = cache.get(key);
      if (cached && cached !== child && !visited.has(key)) {
        // Replace with cached version, then recurse to patch ITS nested sections.
        // Track the key to prevent infinite recursion when error boundary
        // wrappers share the same key as their inner section child.
        visited.add(key);
        patched.push(patchNested(cached, cache, visited));
        changed = true;
        return;
      }
    }
    const p = patchNested(child, cache, visited);
    if (p !== child) changed = true;
    patched.push(p);
  });

  return changed ? cloneElement(node, {}, ...patched) : node;
}

/**
 * Walk the structural template, filling section placeholders from cache.
 * Keyless wrappers (main, footer) are preserved; keyed placeholders
 * are replaced with cached section content.
 */
function renderTemplate(
  template: ReactNode,
  cache: Map<string, ReactNode>,
): ReactNode[] {
  const result: ReactNode[] = [];

  Children.forEach(template, (child) => {
    if (isValidElement(child) && child.key != null) {
      // Section placeholder — fill from cache, then patch nested sections
      const cached = cache.get(String(child.key));
      if (cached) {
        result.push(patchNested(cached, cache));
      }
    } else if (isValidElement(child) && (child.props as any).children) {
      // Structural wrapper (main, footer) — recurse into it
      const inner = renderTemplate((child.props as any).children, cache);
      result.push(cloneElement(child, {}, ...inner));
    } else {
      result.push(child);
    }
  });

  return result;
}

/**
 * Module-level accessor for cached section tokens.
 * Returns "id:fingerprint" pairs so the server can detect shape changes.
 * Used by the browser entry to send ?cached= during navigation.
 */
let _cachedSectionTokens: string[] = [];
export function getCachedSectionIds(): string[] {
  return _cachedSectionTokens;
}

export function SectionListClient({
  template,
  fingerprints,
  children,
}: SectionListClientProps) {
  const cacheRef = useRef(new Map<string, ReactNode>());
  const fpRef = useRef(new Map<string, string>());

  // Index fresh sections by key (direct children only — nested sections
  // arrive as their own independent entries, not buried inside parents)
  Children.forEach(children, (child) => {
    if (isValidElement(child) && child.key != null) {
      cacheRef.current.set(String(child.key), child);
    }
  });

  // Update fingerprints — always take the server's latest fingerprints
  for (const [id, fp] of Object.entries(fingerprints)) {
    fpRef.current.set(id, fp);
  }

  // Expose cached tokens (id:fingerprint) for navigation
  _cachedSectionTokens = [...cacheRef.current.keys()].map((id) => {
    const fp = fpRef.current.get(id);
    return fp ? `${id}:${fp}` : id;
  });

  // Fill the structural template with cached sections
  return <>{renderTemplate(template, cacheRef.current)}</>;
}
