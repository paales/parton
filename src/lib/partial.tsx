/**
 * PartialRoot Architecture
 *
 * Pages are composed of independently re-renderable partials declared
 * with the <Partial> wrapper:
 *
 *   <PartialRoot>
 *     <html>
 *       <Partial id="head"><head>...</head></Partial>
 *       <body>
 *         <Partial id="nav"><nav>...</nav></Partial>
 *         <Partial id="cart" tags={["cart"]} fallback={<Spinner/>}>
 *           <CartBadge/>
 *         </Partial>
 *       </body>
 *     </html>
 *   </PartialRoot>
 *
 * `<PartialRoot>` is a thin orchestrator: it parses the request
 * params, sets up the request-scoped state that each `<Partial>`
 * reads during render, decides whether we're in streaming mode (full
 * page) or cache mode (partial refetch, served from snapshots), and
 * wraps the output in `<PartialsClient>`.
 *
 * Every decision about an individual partial — "render fresh?",
 * "emit placeholder because the fingerprint matched?", "apply an
 * __inputs override?" — lives in the `Partial` component itself.
 * There is no static walker; each Partial discovers itself by
 * running. Deep Partials produced inside `.map()` loops or other
 * opaque component bodies are first-class: they register themselves
 * via `<PartialBoundary>` on every render.
 *
 * Snapshots stored by `<PartialBoundary>` are captured JSX from the
 * ancestor's most recent execution. `__inputs` overrides reach the
 * content via `cloneElement` (now unimpeded — `<Cache>` is folded
 * into `<Partial cache>`, so there is no intermediate wrapper); the
 * Partial's fingerprint is computed from the content AFTER
 * `applyInputs`, so cache-mode refetches with new inputs produce
 * distinct keys and correctly miss stale entries. This replaces what
 * the old `refreshRegistry` walker used to handle.
 */

import React, { type ReactNode } from "react";
import {
  PartialsClient,
  type PartialDebugEntry,
} from "./partial-client.tsx";
import {
  Partial,
  PartialBoundary,
  type PartialProps,
} from "./partial-component.tsx";
import { PartialErrorBoundary } from "./partial-error-boundary.tsx";
import { getRequest } from "../framework/context.ts";
import {
  clearRoute,
  getRouteSnapshots,
  lookupPartial,
  type PartialSnapshot,
} from "./partial-registry.ts";
import {
  enterPartialState,
  type PartialRequestState,
} from "./partial-request-state.ts";

export { Partial, type PartialProps };

interface PartialRootProps {
  children: ReactNode;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function parseCachedFingerprints(raw: string | null): Map<string, string | null> {
  const out = new Map<string, string | null>();
  if (!raw) return out;
  for (const token of raw.split(",").map((s) => s.trim())) {
    if (!token) continue;
    const colonIdx = token.indexOf(":");
    if (colonIdx > 0) {
      out.set(token.slice(0, colonIdx), token.slice(colonIdx + 1));
    } else {
      out.set(token, null);
    }
  }
  return out;
}

function parseRequestedIds(raw: string | null): Set<string> | null {
  if (!raw) return null;
  const ids = new Set(
    raw.split(",").map((s) => s.trim()).filter(Boolean),
  );
  return ids.size > 0 ? ids : null;
}

function resolveTagsToIds(
  tagsParam: string | null,
  route: string,
): Set<string> | null {
  if (!tagsParam) return null;
  const tagList = tagsParam.split(",").map((t) => t.trim()).filter(Boolean);
  if (tagList.length === 0) return null;

  const snapshots = getRouteSnapshots(route);
  if (!snapshots) return null;

  const ids = new Set<string>();
  for (const [id, snap] of snapshots) {
    for (const tag of snap.tags) {
      if (tagList.includes(tag)) {
        ids.add(id);
        break;
      }
    }
  }
  return ids.size > 0 ? ids : null;
}

/**
 * Reconstruct a `<Partial>` element from a registry snapshot. Used in
 * cache mode to render each explicitly-requested partial without
 * re-executing any ancestor component.
 */
function partialFromSnapshot(id: string, snap: PartialSnapshot): ReactNode {
  return React.createElement(
    Partial,
    {
      id,
      fallback: snap.fallback ?? undefined,
      errorWith: snap.errorWith,
      tags: snap.tags,
      cache: snap.cache,
    },
    snap.content,
  );
}

// ─── PartialRoot ───────────────────────────────────────────────────────

export async function PartialRoot({ children }: PartialRootProps) {
  const requestUrl = new URL(getRequest().url);
  const partialsParam = requestUrl.searchParams.get("partials");
  const tagsParam = requestUrl.searchParams.get("tags");
  const cachedParam = requestUrl.searchParams.get("cached");
  const inputsParam = requestUrl.searchParams.get("__inputs");
  const populateCache = requestUrl.searchParams.has("__populateCache");

  let partialInputs: Record<string, Record<string, unknown>> = {};
  if (inputsParam) {
    try {
      partialInputs = JSON.parse(inputsParam);
    } catch {
      // Malformed — ignore.
    }
  }

  const route = requestUrl.pathname;

  // Tag → id resolution reads the registry populated by PRIOR requests.
  const partialIds = parseRequestedIds(partialsParam);
  const tagIds = resolveTagsToIds(tagsParam, route);
  const requestedIds =
    partialIds || tagIds
      ? new Set<string>([...(partialIds ?? []), ...(tagIds ?? [])])
      : null;

  const hasGlobalFilter = partialsParam != null || tagsParam != null;
  const isPartialRefetch = hasGlobalFilter || populateCache;

  // Explicit ids are never skipped on a fingerprint match or filter —
  // they're what the caller asked for.
  const explicitIds = new Set<string>();
  if (requestedIds) for (const id of requestedIds) explicitIds.add(id);
  for (const id of Object.keys(partialInputs)) explicitIds.add(id);

  const state: PartialRequestState = {
    requestedIds: populateCache ? null : requestedIds,
    isPartialRefetch: isPartialRefetch && !populateCache,
    populateCache,
    partialInputs,
    cachedFingerprints: parseCachedFingerprints(cachedParam),
    explicitIds,
    seenIds: new Set(),
  };

  // Registry-miss fallback: a requested id that isn't in the registry
  // (e.g. a stale client-side button for a partial that no longer
  // exists on this route) drops the filter and does a full render so
  // the client reconciles against a fresh tree.
  let registryMiss = false;
  if (state.isPartialRefetch && state.requestedIds) {
    for (const id of state.requestedIds) {
      if (!lookupPartial(route, id)) {
        registryMiss = true;
        break;
      }
    }
  }

  // ── Streaming mode (full render) ──────────────────────────────────
  //
  // Every Partial runs; its body handles fingerprint-skip vs render.
  // Ancestors re-execute, so snapshots registered during this render
  // carry fresh closures — no refreshing walk required. Clear any
  // stale snapshots up-front so ids that no longer appear on this
  // request (e.g. `page-2` after the URL dropped to `?end=1`) don't
  // leak into future tag/id lookups.
  if (!state.isPartialRefetch || registryMiss) {
    clearRoute(route);
    const streamState: PartialRequestState = {
      ...state,
      requestedIds: null,
      isPartialRefetch: false,
    };
    enterPartialState(streamState);
    const debug: PartialDebugEntry[] = [];
    return (
      <PartialsClient mode="streaming" debug={debug} fetchMs={0}>
        {children}
      </PartialsClient>
    );
  }

  // ── Cache mode (partial refetch) ──────────────────────────────────
  //
  // Render each explicitly-requested partial from its registry
  // snapshot as a flat sibling. The `<Partial>` body re-runs (applying
  // `__inputs`, wrapping in Suspense + ErrorBoundary, re-registering)
  // — but its ancestors do not. No server-side template: the client
  // re-renders against the `_template` derived during the most recent
  // streaming render.
  //
  // Why no refresh walk: snapshots store the JSX captured at the
  // ancestor's most-recent execution. With `<Cache>` folded into
  // `<Partial cache>`, there's no intermediate wrapper between
  // `<Partial>` and its content, so `cloneElement(__inputs)` reaches
  // the content component directly — parameterising by the current
  // request. Closures that cloneElement can't reach stay stable-by-
  // construction (sku from `.map()` iteration, etc.) and don't need
  // refreshing.
  enterPartialState(state);

  const activeIds = [...(state.requestedIds ?? [])];
  const wrappedChildren = activeIds
    .map((id) => {
      const snap = lookupPartial(route, id);
      if (!snap) return null;
      return partialFromSnapshot(id, snap);
    })
    .filter((x): x is NonNullable<typeof x> => x != null);

  const debug: PartialDebugEntry[] = activeIds.map((id) => ({
    id,
    status: "fresh",
    fingerprint: "",
    query: null,
  }));

  return (
    <PartialsClient mode="cache" debug={debug} fetchMs={0}>
      {wrappedChildren}
    </PartialsClient>
  );
}

// Re-export PartialBoundary + PartialErrorBoundary so existing
// imports elsewhere (notably cache.tsx, which walks for PartialBoundary
// as a type marker) keep working.
export { PartialBoundary };
// PartialErrorBoundary is client-only but some server-only code paths
// reference its type; re-export for convenience.
export type { PartialErrorBoundary };
