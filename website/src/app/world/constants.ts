/**
 * World geometry. A tile is the atomic 16px grid cell — and the em
 * square of the world's type: every character advances exactly one
 * tile. A chunk is the content parton; its size is SELECTABLE per
 * request (`?chunk=128|256|512`, default 512) — a scaling knob that
 * drives the same 32768px plane at up to 16× the chunk density. The
 * plane above the chunk is a QUADTREE of cullable quad tiles: the
 * 32768px world splits into four 16384px roots, each subdividing in
 * half per level down to leaves that place 2×2 chunks. Every level
 * materializes its four children only near the viewport, so the
 * placed tree is O(visible chunks + log₂ world) — a viewport costs
 * the same whether the plane is 32768px or a million.
 *
 * All chunk-size-derived numbers come from `worldGeometry(chunkPx)`;
 * `GEOMETRIES` holds the whitelisted family, each with its own spec
 * chain (suffixed catalog ids — the 512 default keeps the unsuffixed
 * ids) and its own pulse cell. Chunk coordinates are signed:
 * cx,cy ∈ [-chunkHalf, chunkHalf), so chunk 0,0's top-left corner is
 * the exact center of the plane — where the scroller starts.
 */
export const TILE_PX = 16

export const WORLD_PX = 32768
/** One quadtree root — a quarter of the plane. */
export const QUAD_ROOT_PX = WORLD_PX / 2 // 16384

/** Plane coordinate of the world center — chunk 0,0's top-left. */
export const CENTER_PX = WORLD_PX / 2

/** Chunk cull-flip runway (IntersectionObserver rootMargin): a tight
 *  band, so you can watch chunks pop in as you scroll — the demo IS
 *  the loading. */
export const CHUNK_FLIP_MARGIN_PX = 100

/** The cold-seed viewport estimate: a 1920×1080 box centered on the
 *  plane's center. Every quad level and the chunks seed off the same
 *  test — a tile renders content before any client measurement iff
 *  its box intersects this estimate. Larger real viewports see the
 *  outer ring as skeletons for one measurement round-trip. */
const SEED_HALF_W = 960
const SEED_HALF_H = 540

/** Does the plane-coordinate box [x, x+size)² intersect the seed
 *  viewport estimate? */
export const seedIntersects = (x: number, y: number, size: number): boolean =>
  x < CENTER_PX + SEED_HALF_W &&
  x + size > CENTER_PX - SEED_HALF_W &&
  y < CENTER_PX + SEED_HALF_H &&
  y + size > CENTER_PX - SEED_HALF_H

/** The whitelisted chunk sizes. 512 is the default (and the only one
 *  a bare URL ever serves); 256/128 are density stress geometries. */
export const CHUNK_SIZES = [512, 256, 128] as const
export type ChunkPx = (typeof CHUNK_SIZES)[number]
export const DEFAULT_CHUNK_PX: ChunkPx = 512

/**
 * One chunk-size geometry — every number and identifier the spec
 * chain, pulse layer, and warm projector derive from the chunk size.
 * The default (512) geometry keeps the historical unsuffixed ids
 * (`world-chunk`, `quad-tile-<size>`, `world.pulse.started`), so its wire and
 * catalog are byte-for-byte what a bare URL always served; the others
 * suffix everything with `-<chunkPx>` — the spec catalog is one flat
 * namespace, so every spec of a chain needs a distinct id.
 */
export interface WorldGeometry {
  chunkPx: ChunkPx
  /** Tiles per chunk edge (the 16px grid is geometry-independent). */
  chunkTiles: number
  /** Chunk coords span [-chunkHalf, chunkHalf). */
  chunkHalf: number
  /** The smallest quad tile; its four children are chunks. */
  quadLeafPx: number
  /** Quad tile sizes, leaf → root (16384). */
  quadSizes: readonly number[]
  /** Catalog-id suffix: `""` for the default, `"-128"` etc. */
  suffix: string
  /** The chunk spec's catalog id (`world-chunk`, `world-chunk-128`). */
  chunkSpecId: string
  /** The pulse ANCHOR cell's id — the row stores a chunk partition's
   *  first-render epoch (see ./pulse.ts). Distinct per geometry so
   *  partitions never collide across chunk sizes. */
  pulseCellId: string
  /** A chunk's plane-coordinate box origin. */
  chunkOrigin(c: number): number
  /**
   * Materialization runway for a quad tile of `size` — STAGGERED per
   * level, because a tile's flip-in is what mounts its children's
   * cull-pairs (their skeletons and observers). Equal margins at
   * parent and child would put every freshly mounted observer already
   * past its own flip line: mount → measure → flip → lane → mount the
   * next level, one single-id statement per frame down the whole
   * spine. With the stagger, a column crosses each flip line with its
   * observers long mounted, and the IntersectionObserver batches the
   * crossing into ONE delivery → one statement carrying all its ids.
   *
   * The arithmetic: the leaf materializes its 2×2 chunks at 2×chunkPx,
   * a wide gap over the chunks' tight 100px pop-in line — generous
   * cover for the leaf lane's round trip + skeleton mount + first
   * measurement at the WASD cruise speed (720px/s) and the validator's
   * 1280px/s warm scroll. Each level above adds one chunkPx: a tile of
   * size S flips at margin(S) and mounts children whose own line is
   * margin(S/2) = margin(S) − chunkPx, so every hop of the spine gets
   * one chunk-column of scroll to complete its lane round trip before
   * the next flip is due.
   */
  quadMaterializeMargin(size: number): number
}

export function worldGeometry(chunkPx: ChunkPx): WorldGeometry {
  const quadLeafPx = chunkPx * 2
  const quadSizes: number[] = []
  for (let size = quadLeafPx; size <= QUAD_ROOT_PX; size *= 2) quadSizes.push(size)
  const suffix = chunkPx === DEFAULT_CHUNK_PX ? "" : `-${chunkPx}`
  return {
    chunkPx,
    chunkTiles: chunkPx / TILE_PX,
    chunkHalf: WORLD_PX / chunkPx / 2,
    quadLeafPx,
    quadSizes,
    suffix,
    chunkSpecId: `world-chunk${suffix}`,
    // `.started` names the anchor semantics (the row is an epoch, not
    // a counter) — a fresh id, so rows persisted under the retired
    // counter shape are never misread as anchors.
    pulseCellId: `world.pulse.started${suffix ? `.${chunkPx}` : ""}`,
    chunkOrigin: (c) => CENTER_PX + c * chunkPx,
    quadMaterializeMargin: (size) => 2 * chunkPx + chunkPx * Math.log2(size / quadLeafPx),
  }
}

/** The whitelisted geometry family — every spec chain registers at
 *  module scope, one per entry. */
export const GEOMETRIES: readonly WorldGeometry[] = CHUNK_SIZES.map(worldGeometry)

/** Resolve a `?chunk=` param against the whitelist — anything else
 *  (including absence) is the 512 default. */
export const geometryFor = (chunkParam: string | null): WorldGeometry =>
  GEOMETRIES.find((g) => String(g.chunkPx) === chunkParam) ??
  (GEOMETRIES.find((g) => g.chunkPx === DEFAULT_CHUNK_PX) as WorldGeometry)
