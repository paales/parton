/**
 * Block catalog manifest builder.
 *
 * For the new define-step API, the manifest is reconstructed from the
 * spec catalog directly: walk each registered spec, invoke its `vary`
 * function with a tracking CMS surface, and record what fields it
 * touched. No JSX walking — `vary` is a pure function declaring the
 * dependency surface.
 */

import {
  listSpecTypes,
  getSpecByType,
  type ContentFieldKind,
  type SlotSpec,
  type CmsReadSurface,
} from "./cms-runtime.ts"

export interface BlockManifest {
  readonly type: string
  readonly tags: readonly `.${string}`[]
  readonly contentFields: Record<string, ContentFieldKind>
  readonly references: Record<string, string>
  readonly childSlots: Record<string, SlotSpec>
}

const PRERENDER_REQUEST = new Request("http://localhost/__prerender/")

function trackingCms(): {
  surface: CmsReadSurface
  contentFields: Map<string, ContentFieldKind>
  references: Map<string, string>
} {
  const contentFields = new Map<string, ContentFieldKind>()
  const references = new Map<string, string>()
  const surface: CmsReadSurface = {
    text(name) {
      contentFields.set(name, "text")
      return ""
    },
    richText(name) {
      contentFields.set(name, "richText")
      return ""
    },
    number(name) {
      contentFields.set(name, "number")
      return 0
    },
    boolean(name) {
      contentFields.set(name, "boolean")
      return false
    },
    enum<T extends string>(name: string, values: readonly T[]): T {
      contentFields.set(name, "enum")
      return values[0]
    },
    image(name) {
      contentFields.set(name, "image")
      return { src: "", alt: "" }
    },
    reference(name, type) {
      references.set(name, type)
      return null
    },
  }
  return { surface, contentFields, references }
}

export async function prerenderBlock(type: string): Promise<BlockManifest | null> {
  const spec = getSpecByType(type)
  if (!spec) return null
  const tracker = trackingCms()
  if (spec.vary) {
    try {
      spec.vary({
        request: PRERENDER_REQUEST,
        params: {},
        cms: tracker.surface,
      })
    } catch {
      // vary may reference params that aren't present in the prerender
      // request; we still get the field reads it did before throwing.
    }
  }
  return {
    type,
    tags: spec.selectorTokens.sharedTokens.map((t) => `.${t}` as `.${string}`),
    contentFields: Object.fromEntries(tracker.contentFields),
    references: Object.fromEntries(tracker.references),
    childSlots: {},
  }
}

export async function buildCatalogManifest(): Promise<Record<string, BlockManifest>> {
  const out: Record<string, BlockManifest> = {}
  for (const type of listSpecTypes()) {
    const manifest = await prerenderBlock(type)
    if (manifest) out[type] = manifest
  }
  return out
}

let cached: Promise<Record<string, BlockManifest>> | null = null

export function getCatalogManifest(): Promise<Record<string, BlockManifest>> {
  if (!cached) cached = buildCatalogManifest()
  return cached
}

export function _invalidateCatalogManifest(): void {
  cached = null
}

if (import.meta.hot) {
  import.meta.hot.on("vite:beforeUpdate", () => {
    cached = null
  })
  import.meta.hot.on("vite:beforeFullReload", () => {
    cached = null
  })
}
