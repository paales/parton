/**
 * Cycle-safety for the CMS slot-tree walkers. The store is a forest of
 * `CmsNode`s and slot children are referenced by inclusion, so a
 * malformed / hand-edited store can contain a slot that lists an
 * ancestor's id — a cycle. The walkers (`buildIndex`,
 * `contributionForNode`, `buildCmsTreeEntries`) must terminate on such
 * a store rather than recurse until the stack overflows; the index
 * lookup and the fingerprint contribution run on every CMS-bound
 * render, so an unbounded walk is a crash in the hot path.
 *
 * Storage isolation: an in-memory backend is injected so a cyclic
 * fixture can be loaded through the real sync read path (which builds
 * the flat index) without committing fixture JSON or touching the
 * shared on-disk store.
 */
import { afterEach, describe, expect, it } from "vitest"
import {
  _invalidateCmsStoreCache,
  buildCmsTreeEntries,
  cmsFingerprintContribution,
  lookupCmsNode,
  type CmsNode,
  type CmsStore,
} from "../cms-runtime.ts"
import {
  setCmsStorage,
  _resetCmsStorage,
  type CmsStorage,
  type LoadedStore,
} from "../cms-storage.ts"

/** Minimal in-memory backend serving a fixed published store. */
function memoryStorage(published: CmsStore): CmsStorage {
  const loaded: LoadedStore = { store: published, mtime: 1 }
  return {
    loadPublished: async () => loaded,
    loadPublishedSync: () => loaded,
    savePublished: async () => {},
    loadDraft: async () => null,
    loadDraftSync: () => null,
    saveDraft: async () => {},
    deleteDraft: async () => {},
  }
}

function install(published: CmsStore): void {
  setCmsStorage(memoryStorage(published))
  _invalidateCmsStoreCache()
}

afterEach(() => {
  _resetCmsStorage()
  _invalidateCmsStoreCache()
})

describe("CMS walkers — cyclic slot trees terminate", () => {
  it("builds the flat index for a node whose slot lists its own id (1-cycle)", () => {
    const self: CmsNode = {
      id: "self",
      configs: [{ match: {}, fields: { headline: "loop" } }],
      slots: { body: [] },
    }
    // Slot child is the node itself — a 1-cycle.
    self.slots!.body.push(self)
    install({ partials: { self } })

    // lookupCmsNode triggers buildIndex via the sync load path.
    const node = lookupCmsNode("self")
    expect(node?.id).toBe("self")
  })

  it("builds the flat index for an A→B→A 2-cycle", () => {
    const a: CmsNode = { id: "a", configs: [{ match: {}, fields: {} }], slots: { body: [] } }
    const b: CmsNode = { id: "b", configs: [{ match: {}, fields: {} }], slots: { body: [] } }
    a.slots!.body.push(b)
    b.slots!.body.push(a)
    install({ partials: { a } })

    expect(lookupCmsNode("a")?.id).toBe("a")
    expect(lookupCmsNode("b")?.id).toBe("b")
  })

  it("computes a fingerprint contribution for a cyclic node without overflowing", () => {
    const a: CmsNode = { id: "a", configs: [{ match: {}, fields: { x: 1 } }], slots: { body: [] } }
    const b: CmsNode = { id: "b", configs: [{ match: {}, fields: { y: 2 } }], slots: { body: [] } }
    a.slots!.body.push(b)
    b.slots!.body.push(a)
    install({ partials: { a } })

    const request = new Request("http://localhost/")
    const fp = cmsFingerprintContribution("a", request)
    expect(fp).toContain("cms=a")
    // The contribution is a finite string, not a stack overflow.
    expect(typeof fp).toBe("string")
  })

  it("builds editor tree entries for a cyclic store without overflowing", () => {
    // A real (acyclic) root holds the cycle: page → a, then a → b → a.
    const a: CmsNode = {
      id: "a",
      type: "hero",
      configs: [{ match: {}, fields: {} }],
      slots: { body: [] },
    }
    const b: CmsNode = {
      id: "b",
      type: "hero",
      configs: [{ match: {}, fields: {} }],
      slots: { body: [] },
    }
    a.slots!.body.push(b)
    b.slots!.body.push(a)
    const page: CmsNode = {
      id: "page",
      configs: [{ match: {}, fields: {} }],
      slots: { body: [a] },
    }

    const entries = buildCmsTreeEntries({ page }, {})
    // The reachable nodes appear; the walk terminates instead of
    // recursing forever through the a→b→a cycle.
    const ids = entries.filter((e) => e.kind === "node").map((e) => e.id)
    expect(ids).toContain("page")
    expect(ids).toContain("a")
    expect(ids).toContain("b")
  })
})
