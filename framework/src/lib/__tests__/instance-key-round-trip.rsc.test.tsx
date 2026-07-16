/**
 * Instance-key round-trip — the per-instance key a Render sees
 * (`__instanceId`) is the caller-managed identity UNDECORATED, and it
 * resolves identically whether the render is the streaming one or a
 * replay from a snapshot (`partialFromSnapshot`).
 *
 * An effective id carries this placement's framework-reserved terms —
 * the embed-namespace prefix and the placement-fold suffix. Those key
 * the WIRE identity. A Render's per-instance work is
 * placement-independent: a block reads the same CMS row wherever it
 * is placed. The two paths hand the prop in decorated differently —
 * a streaming render mints the decorations after deriving the key,
 * while replay hands its stored (fully decorated) id back through
 * `__instanceId` to keep the fold idempotent — so the wrapper
 * pipeline undecorates before forwarding.
 *
 * Without that, a placement-folded `block()` resolves its CMS row
 * under `<type>~<fold>` on replay, finds nothing, and renders an
 * empty body — the preview loses the subtree on the first slot move
 * that refetches it.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { ReactNode } from "react"
import {
  computeRouteKey,
  parton,
  PartialRoot,
  partialFromSnapshot,
  type RenderArgs,
} from "../partial.tsx"
import { block } from "../../runtime/cms-block.ts"
import { clearRegistry, _readSnapshotsForRoute, type PartialSnapshot } from "../partial-registry.ts"
import { _invalidateCmsStoreCache, type CmsStore } from "../../runtime/cms-runtime.ts"
import { setCmsStorage, _resetCmsStorage, type CmsStorage } from "../../runtime/cms-storage.ts"
import { runWithRequestAsync } from "../../runtime/context.ts"
import { renderServerToFlight, flightToString } from "../../test/rsc-server.ts"

// ─── In-memory CMS backend ───────────────────────────────────────────

/** One row: `ik-root`, whose `body` slot holds a single leaf entry. */
function storeFixture(): CmsStore {
  return {
    partials: {
      "ik-root": {
        id: "ik-root",
        configs: [{ match: {}, fields: {} }],
        slots: {
          body: [
            {
              id: "ik-body-leaf",
              type: "ik-leaf",
              configs: [{ match: {}, fields: { headline: "slot-content" } }],
            },
          ],
        },
      },
    },
  }
}

function memoryStorage(store: CmsStore): CmsStorage {
  const loaded = { store, mtime: 1 }
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

// ─── Fixture ─────────────────────────────────────────────────────────

/** What the pipeline forwarded to each Render as `__instanceId`. */
const seenKeys: Array<string | undefined> = []

/** Plain parton — observes the forwarded key directly. `block()`'s
 *  wrapper consumes the prop, so the raw contract needs a bare spec. */
const IkProbe = parton(function IkProbeRender(props: RenderArgs & { __instanceId?: string }) {
  seenKeys.push(props.__instanceId)
  return <span data-testid="ik-probe">probe</span>
})

/** The `body` slot's entry — never placed as JSX. Constructing it is
 *  what registers `ik-leaf` in the catalog, which is how the slot
 *  resolves `entry.type` to a Component. */
const IkLeaf = block(
  function IkLeafRender({ headline }: { headline: string } & RenderArgs) {
    return <span data-testid="ik-leaf">{headline}</span>
  },
  { schema: ({ cms }) => ({ headline: cms.text("headline") }) },
)

/** A `block()` placed as plain JSX under a parton — no `__instanceId`
 *  override, non-empty parent path, so its id folds the placement. */
const IkRoot = block(
  function IkRootRender({ body }: { body: ReactNode } & RenderArgs) {
    return <div data-testid="ik-root">{body}</div>
  },
  { schema: ({ cms }) => ({ body: cms.blocks("body") }) },
)

const IkHost = parton(function IkHostRender(_: RenderArgs) {
  return (
    <>
      <IkRoot />
      <IkProbe />
    </>
  )
}, "/ik")

const tree = (
  <PartialRoot>
    <html lang="en">
      <body>
        <IkHost />
      </body>
    </html>
  </PartialRoot>
)

// Referenced for its construction side effect alone (see above).
void IkLeaf

beforeEach(() => {
  clearRegistry("all")
  seenKeys.length = 0
  setCmsStorage(memoryStorage(storeFixture()))
  _invalidateCmsStoreCache()
})

afterEach(() => {
  _resetCmsStorage()
  _invalidateCmsStoreCache()
})

const URL_ = "http://t/ik"

async function streamingRender(): Promise<string> {
  const { result } = await runWithRequestAsync(new Request(URL_), () =>
    flightToString(renderServerToFlight(tree)),
  )
  return result
}

function snapshots(): Map<string, PartialSnapshot> {
  return _readSnapshotsForRoute("default", computeRouteKey(URL_))
}

/** The folded wire id a spec registered under. */
function foldedId(prefix: string): string {
  return [...snapshots().keys()].find((id) => id.startsWith(prefix))!
}

/** Replay a stored snapshot the way a targeted refetch does. */
async function replay(id: string): Promise<string> {
  const snap = snapshots().get(id)!
  const { result } = await runWithRequestAsync(new Request(URL_), () =>
    flightToString(renderServerToFlight(partialFromSnapshot(id, snap))),
  )
  return result
}

// ─── The round trip ──────────────────────────────────────────────────

describe("instance key — streaming render vs snapshot replay", () => {
  it("a replayed auto-minted placement forwards the UNDECORATED key", async () => {
    await streamingRender()

    // The wire id folds the placement — `ik-probe` is nested under
    // `ik-host`, so its id carries the reserved `~<16 hex>` suffix.
    const id = foldedId("ik-probe")
    expect(id).toMatch(/^ik-probe~[0-9a-f]{16}$/)

    // Streaming forwards NO override: an auto-minted placement has no
    // caller-managed key.
    expect(seenKeys).toEqual([undefined])

    seenKeys.length = 0
    await replay(id)

    // Replay must NOT leak the fold into the key. `ik-probe` is the
    // spec id — the same content key `?? spec.id` yields on the
    // streaming path — never `ik-probe~<fold>`.
    expect(seenKeys).toEqual(["ik-probe"])
    expect(seenKeys[0]).not.toContain("~")
  })

  it("a placement-folded block resolves its content row on replay", async () => {
    const streamed = await streamingRender()
    expect(streamed).toContain("slot-content")

    const id = foldedId("ik-root")
    expect(id).toMatch(/^ik-root~[0-9a-f]{16}$/)

    // The row lives at `ik-root`; a replay that keyed on the folded id
    // would find nothing and render an empty body.
    expect(await replay(id)).toContain("slot-content")
  })

  it("the replayed block keeps the same bare `cms:` dep + tag", async () => {
    await streamingRender()
    const id = foldedId("ik-root")

    // The editor's write fires `refreshSelector("cms:ik-root")` — the
    // label must stay bare, or the replayed instance stops being
    // wakeable by the row it renders.
    expect(snapshots().get(id)!.labels).toContain("cms:ik-root")

    await replay(id)

    const after = snapshots().get(id)!
    expect(after.labels).toContain("cms:ik-root")
    expect(after.labels.some((l) => l.includes("~"))).toBe(false)
    expect([...(after.deps ?? [])]).toContain("cms:ik-root")
  })
})
