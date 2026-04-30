/**
 * Slot primitives — `<Children>` and `<Child>`.
 *
 * Slots render store-contributed blocks. Each block instance is a spec
 * registered via `ReactCms.partial(...)` with an explicit `type` tag.
 * The slot looks up the host node (`hostCmsId`) in the CMS store, reads
 * its `slots[name]` array, and renders each entry by mapping
 * `entry.type → spec.Component`.
 *
 * Slots take `host` (the parent's PartialCtx for descendants) and
 * `hostCmsId` (the CMS id whose `slots[name]` to read) as props. No
 * ALS / cell reads — explicit threading.
 */

import React, { type ReactNode } from "react"
import type { PartialCtx } from "./partial-context.ts"
import { lookupCmsNode, getSpecByType, type CmsNode } from "../framework/cms-runtime.ts"
import { getRequest } from "../framework/context.ts"

export interface ChildrenProps {
  /** Slot key — matches `node.slots[name]` in the store. */
  name: string
  /** Selector grammar constraining which block types the editor's
   *  +add palette offers. Not enforced at runtime. */
  allow: string
  /** PartialCtx of the host spec (passed from its render fn's
   *  `parent`). Slot-rendered blocks become its descendants. */
  host: PartialCtx
  /** cmsId of the host whose `slots[name]` to read. */
  hostCmsId: string
}

export interface ChildProps extends ChildrenProps {}

export const SLOT_KIND_BRAND = Symbol.for("cms.slotKind")
export type SlotKind = "multi" | "single"

interface SlotComponent {
  (props: ChildrenProps | ChildProps): ReactNode
  [SLOT_KIND_BRAND]?: SlotKind
}

export const Children: SlotComponent = function Children({
  name,
  host,
  hostCmsId,
}: ChildrenProps): ReactNode {
  const node = lookupCmsNode(hostCmsId, getRequest())
  const entries = node?.slots?.[name] ?? []
  if (entries.length === 0) return null
  return renderSlotEntries(entries, host)
}
Children[SLOT_KIND_BRAND] = "multi"

export const Child: SlotComponent = function Child({
  name,
  host,
  hostCmsId,
}: ChildProps): ReactNode {
  const node = lookupCmsNode(hostCmsId, getRequest())
  const entries = node?.slots?.[name] ?? []
  const entry = entries[0]
  if (!entry) return null
  return renderSlotEntries([entry], host)
}
Child[SLOT_KIND_BRAND] = "single"

function renderSlotEntries(entries: readonly CmsNode[], host: PartialCtx): ReactNode {
  return entries.map((entry) => {
    const type = entry.type
    if (!type) return null
    const spec = getSpecByType(type)
    if (!spec) {
      if (import.meta.env?.DEV) {
        console.warn(
          `[cms] slot entry "${entry.id}" has type "${type}" which is not registered. ` +
            `Register with ReactCms.partial(...) {type: "${type}"}.`,
        )
      }
      return null
    }
    const Component = spec.Component
    return (
      <React.Fragment key={entry.id}>
        {/* Per-instance cmsId override — the spec is registered with
            its `type` (e.g. "page-greeting") and a class-only
            selector. Each slot entry has its own cmsId; the override
            makes that entry's effective id `cmsId`, and the CMS read
            surface inside vary resolves against `cmsId`'s configs. */}
        <Component parent={host} cmsId={entry.id} />
      </React.Fragment>
    )
  })
}
