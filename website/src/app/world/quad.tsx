import type { RenderArgs } from "@parton/framework"
import { parton } from "@parton/framework"
import { defineWorldChunk, type ChunkComponent } from "./chunk.tsx"
import { CENTER_PX, seedIntersects, type WorldGeometry } from "./constants.ts"
import { QuadShell } from "./quad-shell.tsx"

/**
 * The quadtree's tiles — the recursive LOAD units, one cullable
 * parton SPEC PER LEVEL PER GEOMETRY (`geo.quadSizes`, leaf … 16384;
 * catalog ids `quad-tile-<size>` for the 512 default, suffixed
 * `quad-tile-<size>-<chunkPx>` for the density geometries — the
 * catalog is one flat namespace). A tile covers the plane-coordinate
 * box `[x, x+size)²`; in view it materializes its four half-size
 * children (the next level's tiles, or 2×2 chunks at the leaf), out
 * of view the framework skips its body and the client renders
 * `QuadShell` — so the whole subtree under an off-screen tile costs
 * one ~200-byte pair, no matter how much world it covers. Each child
 * sits in its own positioned box (`contain: strict`) so a tile's
 * materialization never lays out beyond its cell.
 *
 * The levels are separate specs because their cull runways are
 * STAGGERED (`geo.quadMaterializeMargin`): each tile mounts its
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
export type QuadLevel = (props: QuadPos) => React.ReactNode | Promise<React.ReactNode>

function defineQuadLevel(
  geo: WorldGeometry,
  size: number,
  Child: QuadLevel | null,
  Chunk: ChunkComponent,
): QuadLevel {
  const half = size / 2
  return parton(
    // One spec per (geometry, level) — the factory names each product;
    // the Render name is the identity (`quad-tile-4096`,
    // `quad-tile-1024-128`, …).
    Object.assign(
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
                  <Chunk
                    cx={(cellX - CENTER_PX) / geo.chunkPx}
                    cy={(cellY - CENTER_PX) / geo.chunkPx}
                  />
                ) : (
                  <Child x={cellX} y={cellY} />
                )}
              </div>,
            )
          }
        }
        return <>{cells}</>
      },
      { displayName: `quad-tile-${size}${geo.suffix}` },
    ),
    {
      cull: {
        rootMargin: `${geo.quadMaterializeMargin(size)}px`,
        seed: ({ x, y }: QuadPos) => seedIntersects(x, y, size),
        skeleton: QuadShell,
      },
    },
  )
}

/** Build one geometry's whole spec chain — the chunk spec plus the
 *  quad levels from the leaf (places 2×2 chunks) up to the root tile
 *  (16384px, what the world page places). Called once per whitelisted
 *  geometry at module scope. */
export function defineQuadTree(geo: WorldGeometry): QuadLevel {
  const Chunk = defineWorldChunk(geo)
  let level: QuadLevel | null = null
  for (const size of geo.quadSizes) {
    level = defineQuadLevel(geo, size, size === geo.quadLeafPx ? null : level, Chunk)
  }
  return level as QuadLevel
}
