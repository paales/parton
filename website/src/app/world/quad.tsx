import type { RenderArgs } from "@parton/framework"
import { parton } from "@parton/framework"
import { WorldChunk } from "./chunk.tsx"
import {
  CHUNK_PX,
  QUAD_LEAF_PX,
  QUAD_ROOT_PX,
  quadMaterializeMargin,
  seedIntersects,
} from "./constants.ts"
import { QuadShell } from "./quad-shell.tsx"

/**
 * The quadtree's tiles — the recursive LOAD units, one cullable
 * parton SPEC PER LEVEL (1024 … 16384). A tile covers the
 * plane-coordinate box `[x, x+size)²`; in view it materializes its
 * four half-size children (the next level's tiles, or 2×2 chunks at
 * the leaf), out of view the framework skips its body and the client
 * renders `QuadShell` — so the whole subtree under an off-screen tile
 * costs one ~200-byte pair, no matter how much world it covers. Each
 * child sits in its own positioned box (`contain: strict`) so a
 * tile's materialization never lays out beyond its cell.
 *
 * The levels are separate specs because their cull runways are
 * STAGGERED (`quadMaterializeMargin`): each tile mounts its
 * children's observers one chunk-column of scroll before their own
 * flip line, so a steady scroll crosses every level's line with the
 * observers long mounted and the IntersectionObserver batches each
 * crossing into one visibility statement — the alternative is a
 * serialized mount → measure → flip → lane cascade down the spine,
 * one single-id statement per frame.
 *
 * Cold seed: a tile renders content before any client measurement iff
 * its box intersects the seed viewport estimate — the same test at
 * every level, so the placed tree is exactly the root-to-viewport
 * spine: O(visible chunks + log₂ world).
 */

type QuadPos = { x: number; y: number }
type QuadLevel = (props: QuadPos) => React.ReactNode | Promise<React.ReactNode>

function defineQuadLevel(size: number, Child: QuadLevel | null): QuadLevel {
  const half = size / 2
  return parton(
    function QuadTileRender({ x, y }: QuadPos & RenderArgs) {
      const cells: React.ReactNode[] = []
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const cellX = x + dx * half
          const cellY = y + dy * half
          cells.push(
            <div
              key={`${dx},${dy}`}
              className="quad"
              style={{ left: dx * half, top: dy * half, width: half, height: half }}
            >
              {Child === null ? (
                <WorldChunk cx={cellX / CHUNK_PX - 32} cy={cellY / CHUNK_PX - 32} />
              ) : (
                <Child x={cellX} y={cellY} />
              )}
            </div>,
          )
        }
      }
      return <>{cells}</>
    },
    {
      selector: `#quad-tile-${size}`,
      cull: {
        rootMargin: `${quadMaterializeMargin(size)}px`,
        seed: ({ x, y }: QuadPos) => seedIntersects(x, y, size),
        skeleton: QuadShell,
      },
    },
  )
}

// Leaf (1024, places 2×2 chunks) up to the root tile (16384).
let level: QuadLevel | null = null
for (let size = QUAD_LEAF_PX; size <= QUAD_ROOT_PX; size *= 2) {
  level = defineQuadLevel(size, size === QUAD_LEAF_PX ? null : level)
}
/** The root-level (16384px) tile — what the world page places. */
export const QuadTile = level as QuadLevel
