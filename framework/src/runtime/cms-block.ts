/**
 * `block(...)` constructor — CMS-aware wrapper around `parton(...)`.
 * Lives here, in the CMS layer, so `partial.tsx` stays CMS-free.
 *
 * A block:
 *   - Resolves its CMS content row at render time. The row id is
 *     `__instanceId ?? spec.id` (slot wiring sets `__instanceId`
 *     to the slot entry's id; direct-JSX singletons read from the
 *     row matching the spec's catalog id).
 *   - Calls the author's `schema({cms})` with a read surface bound
 *     to that row, merges the result into the props passed to the
 *     author's Render.
 *   - Records the row as a `cms:<contentKey>` tracked dependency, so
 *     the partial's fingerprint re-reads the content hash on every
 *     fold and moves on CMS edits — and registers the row as a
 *     `cms:<contentKey>` tag, so an editor write's
 *     `refreshSelector("cms:<key>")` wakes exactly the instance
 *     bound to the edited row.
 *   - Registers as a slot block (`registerSlotBlockMeta`) so the
 *     editor catalog manifest can enumerate it and slot lookups
 *     can resolve `entry.type` to this Component.
 *
 * A block's identity is its Render function's name, exactly like a
 * parton: `HeroRender` → catalog type `"hero"` — which is also the
 * CMS storage key for singleton placements.
 */

import { createElement, type ReactNode } from "react"
import {
  _buildPartial,
  autoSpecId,
  type PartialOptions,
  type RenderArgs,
  type SpecComponent,
  type SpecExtraProps,
} from "../lib/partial.tsx"
import { getCurrentParton, tag } from "../lib/current-parton.ts"
import { createCmsReadSurface, registerSlotBlockMeta, type CmsReadSurface } from "./cms-runtime.ts"
import { getRequest } from "./context.ts"

/** Scope passed into `schema` callbacks. CMS reads live here;
 *  request dimensions are tracked-hook reads. */
export interface SchemaScope {
  cms: CmsReadSurface
}

/** Options for `block(R, opts)` — a slot-placeable
 *  CMS-driven spec with a declared `schema`. Internally produces a
 *  partial; same fingerprint / cache / refetch path.
 *
 *  Omits PartialOptions.schema so block's CMS-shaped schema
 *  (`(scope) => S`) is the block's own surface — the one declared
 *  schema in the framework; it runs inside the cms-block wrapper's
 *  Render. */
export type BlockOptions<V, S> = PartialOptions<V> & {
  /** CMS field reads + child slots. Runs at render time with a real
   *  `cms` surface; the result is merged into Render's prop bag
   *  alongside the match params. The editor's catalog prerender invokes it
   *  with a tracking surface to discover content fields + child slot
   *  declarations. */
  schema?: (scope: SchemaScope) => S
}

export function block<
  V extends object = object,
  S extends object = object,
  R extends V & S & RenderArgs = V & S & RenderArgs,
>(
  Render: (props: R) => ReactNode,
  opts: BlockOptions<V, S> = {} as BlockOptions<V, S>,
): SpecComponent<SpecExtraProps<R, V & S>, R> {
  // The block's catalog type + singleton storage key — the Render
  // name, kebab-cased (`HeroRender` → `"hero"`). Same derivation the
  // partial layer applies; computed here too because the CMS layer
  // needs it for the slot-block side-table before the spec exists.
  const specId = autoSpecId(Render as (...args: never[]) => unknown)

  // Wrap the author's Render with a CMS-aware front-end. partial.tsx
  // sees this wrapper as its `Render` and knows nothing about CMS;
  // the wrapper resolves the per-instance content row, invokes the
  // schema, and forwards the merged props to the author's Render.
  function BlockRender(props: V & RenderArgs & { __instanceId?: string }): ReactNode {
    const { __instanceId, children, ...rest } = props as V &
      RenderArgs & {
        __instanceId?: string
      } & Record<string, unknown>
    const contentKey = __instanceId ?? specId
    // Record the content row as a tracked dependency (`cms:<key>` —
    // evaluated by the dep kind cms-runtime registers): every fp fold
    // re-reads the row's CURRENT hash, so a CMS edit moves the fp —
    // both for schema edits (fields the schema reads) and for
    // slot-subtree edits (which schema doesn't directly observe but
    // the hash's `contributionForNode` folds in). The key is
    // per-instance (`__instanceId ?? spec.id`): keying on `specId`
    // would give every multi-instance placement the same
    // contribution, so cascade-resolution changes (`/cms-demo/alpha`
    // → `/cms-demo/beta`) wouldn't move the fp and the spec would
    // fp-skip with stale cached content.
    getCurrentParton()?.deps.add(`cms:${contentKey}`)
    // And as a TAG — the event-shaped half: an editor write fires
    // `refreshSelector("cms:<key>")`, which wakes the live preview's
    // held connection and lanes exactly this instance. The hash dep
    // above covers freshness (store-and-reread); the tag covers
    // delivery.
    tag(`cms:${contentKey}`)
    const cms = createCmsReadSurface(contentKey, getRequest())
    let schemaResult: S | object = {}
    if (opts.schema) {
      try {
        schemaResult = opts.schema({ cms }) as S
      } catch {
        schemaResult = {} as S
      }
    }
    return (Render as (p: V & S & RenderArgs) => ReactNode)({
      ...(rest as unknown as V),
      ...(schemaResult as S),
      children,
    })
  }
  // The wrapper is what partial.tsx derives the catalog id from —
  // carry the block's identity through it (every block shares the
  // `BlockRender` function name otherwise).
  BlockRender.displayName = specId

  const partialOptions: PartialOptions<V & S> = {
    match: opts.match,
    cache: opts.cache,
    defer: opts.defer,
    fallback: opts.fallback,
    keepalive: opts.keepalive,
  }

  const spec = _buildPartial(BlockRender as never, partialOptions)

  registerSlotBlockMeta({
    id: specId,
    schema: opts.schema as ((scope: SchemaScope) => unknown) | undefined,
  })

  return spec as unknown as SpecComponent<SpecExtraProps<R, V & S>, R>
}

// Re-export `createElement` to make sure tree-shaking doesn't drop
// the JSX runtime in modules that only import from this file.
void createElement
