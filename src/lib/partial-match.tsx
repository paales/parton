/**
 * Page-level routing primitives.
 *
 * `PartialMatch` is a first-match-wins router: it scans its top-level
 * `Match` children for one whose `pattern` matches the request
 * pathname and renders only that branch. When nothing matches it
 * renders `fallback` (closes the docs sharp-edge — page renders
 * empty when zero specs match — with an explicit hook).
 *
 *   <PartialMatch fallback={<NotFoundPage />}>
 *     <Match pattern="/pokemon/:id"><DetailPlacements parent={ROOT} /></Match>
 *     <Match pattern="/cms-demo/:slug"><CmsPlacements parent={ROOT} /></Match>
 *     <Match pattern="/"><HomePlacements parent={ROOT} /></Match>
 *   </PartialMatch>
 *
 * `Match` standalone self-gates on a miss (returns `null`).
 *
 * Ambient match-params: when `Match` matches, it walks its descendant
 * JSX tree and injects the matched params onto every spec component
 * it finds via the `__ambientMatchParams` prop. A spec without its
 * own `match` reads that prop and uses it as `params` in its
 * `vary` scope — removing the per-spec match repetition pattern
 * (every spec on `/pokemon/:id` declaring its own `match`).
 *
 * Why a JSX walk and not React Context: the `react-server` build
 * exports neither `createContext` nor `useContext`. ALS doesn't help
 * either — its `run()` scope exits before React descends into
 * children. Element-walk + clone is the option that survives RSC's
 * sync render boundary.
 *
 * Walk limitation: we only traverse plain JSX (Fragments, host
 * elements). We do NOT descend through user-defined function
 * components. A spec nested inside `<Wrapper>{specs}</Wrapper>`
 * will not see ambient params; threading via explicit props is the
 * escape hatch. Nested `<Match>` elements are treated as opaque so
 * their inner injection wins.
 *
 * Chrome that should render on every route (header, footer, debug
 * overlays) goes OUTSIDE `PartialMatch`. The wrapper deliberately
 * doesn't render non-`Match` children — its single job is routing.
 */

import { Fragment, cloneElement, isValidElement, type ReactElement, type ReactNode } from "react"
import { getRequest, matchRoutePattern } from "../framework/context.ts"
import { SPEC_COMPONENT_MARKER } from "./partial-context.ts"

interface MatchProps {
  pattern: string
  children: ReactNode
}

export function Match({ pattern, children }: MatchProps): ReactNode {
  const url = new URL(getRequest().url)
  const params = matchRoutePattern(url.pathname, pattern)
  if (params === null) return null
  return injectAmbientParams(children, params)
}

interface PartialMatchProps {
  fallback?: ReactNode
  children: ReactNode
}

export function PartialMatch({ fallback, children }: PartialMatchProps): ReactNode {
  const url = new URL(getRequest().url)
  const pathname = url.pathname

  const arr = Array.isArray(children) ? children : [children]
  for (const child of arr) {
    if (!isValidElement(child)) continue
    if (child.type !== Match) continue
    const props = child.props as MatchProps
    const params = matchRoutePattern(pathname, props.pattern)
    if (params !== null) {
      return injectAmbientParams(props.children, params)
    }
  }

  return fallback ?? null
}

/**
 * Walk a JSX tree and inject `__ambientMatchParams` onto every spec
 * component invocation. Stops at:
 *  - non-element nodes (text, null) — leaves.
 *  - spec components — inject the prop and stop descending into
 *    their rendered output (it doesn't exist yet at this stage —
 *    React will produce it later).
 *  - `<Match>` elements — their inner injection takes precedence,
 *    so we don't recurse into them.
 *  - user-defined function components — their render output is
 *    opaque to us at walk time, so we leave them alone.
 *
 * Plain host elements (`<div>`, etc.) and Fragments DO get walked
 * so a top-level `<>...</>` or a wrapping `<div>` doesn't break the
 * injection.
 */
function injectAmbientParams(node: ReactNode, params: Record<string, string>): ReactNode {
  if (!isValidElement(node)) {
    if (Array.isArray(node)) {
      return (node as ReactNode[]).map((c) => injectAmbientParams(c, params))
    }
    return node
  }

  const type = node.type as unknown
  // Spec component — inject and stop.
  if (typeof type === "function" && (type as { [key: symbol]: unknown })[SPEC_COMPONENT_MARKER]) {
    const existing = (node.props as { __ambientMatchParams?: unknown }).__ambientMatchParams
    if (existing != null) return node
    return cloneElement(node as ReactElement, { __ambientMatchParams: params })
  }

  // Nested Match — its own boundary will inject its own params.
  if (type === Match) return node

  // Host elements (string types) and Fragments — descend into children.
  const isHost = typeof type === "string"
  const isFragment = type === Fragment
  if (!isHost && !isFragment) {
    // Function component or class component — opaque.
    return node
  }

  const kids = (node.props as { children?: ReactNode }).children
  if (kids == null) return node
  const mapped = Array.isArray(kids)
    ? kids.map((c) => injectAmbientParams(c, params))
    : injectAmbientParams(kids, params)

  if (mapped === kids) return node
  return Array.isArray(mapped)
    ? cloneElement(node as ReactElement, {}, ...mapped)
    : cloneElement(node as ReactElement, {}, mapped)
}
