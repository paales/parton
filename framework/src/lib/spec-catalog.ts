/**
 * Spec catalog — framework-internal index of every `parton`
 * spec by its catalog id.
 *
 * Lookups feed three internal consumers:
 *
 *  - `partialFromSnapshot` in cache-mode refetch — finds the spec
 *    Component when re-spawning from a snapshot.
 *  - `descendantContribution` in the descendant-fp fold — re-runs a
 *    descendant's `match` against the current request to keep
 *    ancestors' fingerprints honest.
 *  - `deriveMatchKey` walking `parent.path` — looks up ancestors to
 *    find the closest match-bearing pattern for variant identity.
 *
 * No CMS coupling: this catalog knows about spec id, render component,
 * and match pattern. CMS-specific block metadata (`schema` callbacks)
 * lives separately in `runtime/cms-runtime.ts` as a side-table.
 */

import type { FC } from "react"
import type { PartialCtx } from "./partial-context.ts"

/** Minimal framework-internal props every spec component accepts. */
export interface SpecComponentProps {
  /** Per-instance render-id override. Slot wiring (and any other
   *  caller that needs per-placement identity) sets this; the value
   *  becomes the rendered effective id. Framework-internal — author
   *  code never reads or sets it. */
  __instanceId?: string
  children?: import("react").ReactNode
}

export interface SpecCatalogEntry {
  /** Spec catalog id. Auto-derived from `Render.name` (kebab-cased,
   *  suffix-stripped — see `autoSpecId` in partial.tsx). */
  id: string
  /** The component returned by `parton(...)`. */
  Component: FC<SpecComponentProps>
  /** Compiled match gate for the spec's `match` option, if any. */
  match?: import("./match.ts").CompiledMatch
  /** Render-fn display name (for debug). */
  displayName: string
  /** Capability schema type name — referenced by the remote
   *  manifest so the `parton add` CLI can generate typed bindings.
   *  See `PartialOptions.capabilityType`. */
  capabilityType?: string
  /** The spec's `fpSkip` option. `false` = always-authoritative (the
   *  body runs on every request, never fp-skipped) — read by the
   *  broadcast-lane eligibility classifier (`lib/broadcast.ts`), which
   *  keeps such specs per-connection. */
  fpSkip?: boolean
  /** Bound-cell requirements for embed renders — the spec's `cells`
   *  option, advertised on the remote manifest so a host knows what
   *  to bind (`docs/reference/remote-frame.md` § Bound cells).
   *  Runtime enforcement lives in the spec pipeline, not here. */
  cells?: Record<string, { required?: boolean }>
  /** Code-version generation this spec was constructed under
   *  (`currentCodeVersion()` at construct time — 0 in prod and tests,
   *  bumped per HMR js-update in dev). The collision gate's HMR
   *  discriminator: a claim from a NEWER generation is a module
   *  re-evaluation of edited code and replaces silently; a
   *  same-generation claim of a live id is two DISTINCT specs
   *  fighting over one identity and throws. */
  generation: number
  /** Best-effort definition site (first non-framework stack frame at
   *  construct time). Diagnostic only — it names both sides of an id
   *  collision in the throw below. */
  definedAt: string
}

const specCatalog = new Map<string, SpecCatalogEntry>()

/**
 * Claim a catalog id. The id is the spec's GLOBAL identity — the
 * snapshot `type`, the wire-id stem, the refetch label root — so two
 * distinct specs sharing one id is split-brain: whole-tree renders run
 * each placement's own closure while every catalog consumer (lane
 * reconstruction, the descendant fold's gate re-evaluation, the
 * matchKey ancestor walk) resolves the LAST registration.
 *
 * Collision policy (one gate for every id-keyed spec surface —
 * `componentById` in partial.tsx writes in lockstep, AFTER this claim
 * succeeds):
 *
 *  - no live entry, or a claim from a NEWER code generation → the
 *    claim lands (first definition, or an HMR re-evaluation of edited
 *    code replacing its predecessor).
 *  - a live entry from the SAME generation → throw, naming both
 *    definition sites. In dev this is the author's collision signal;
 *    in prod the generation never moves, so a duplicate id fails the
 *    deploy at module init instead of split-braining at runtime.
 */
export function registerSpec(entry: SpecCatalogEntry): void {
  const existing = specCatalog.get(entry.id)
  if (existing !== undefined && existing.generation === entry.generation) {
    throw new Error(
      `parton: duplicate spec id "${entry.id}" — two distinct specs claimed one catalog id.\n` +
        `  first defined: ${existing.definedAt} (Render: ${existing.displayName})\n` +
        `  claimed again: ${entry.definedAt} (Render: ${entry.displayName})\n` +
        `Ids derive from the Render function's name — rename one Render ` +
        `(or set a distinct \`displayName\` when a factory mints per-variant Renders).`,
    )
  }
  specCatalog.set(entry.id, entry)
}

export function getSpecById(id: string): SpecCatalogEntry | undefined {
  return specCatalog.get(id)
}

export function listSpecIds(): string[] {
  return [...specCatalog.keys()]
}

/** Read-only iteration over every registered spec entry. */
export function listSpecs(): SpecCatalogEntry[] {
  return [...specCatalog.values()]
}

export function _clearSpecCatalog(): void {
  specCatalog.clear()
}
