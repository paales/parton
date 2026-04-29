import { describe, expect, it } from "vitest"
import { hash } from "../hash.ts"

/**
 * Hash properties covered:
 *  - determinism (same input → same output, run-to-run)
 *  - shape (16 hex chars)
 *  - sensitivity (every kind of small change flips most bits)
 *  - distribution (no collisions across 100k pseudo-random inputs)
 *  - boundary cases (empty, unicode, very long)
 */

describe("hash", () => {
  it("is deterministic", () => {
    expect(hash("hello")).toBe(hash("hello"))
    expect(hash("")).toBe(hash(""))
  })

  it("returns 16 lowercase hex chars", () => {
    expect(hash("anything")).toMatch(/^[0-9a-f]{16}$/)
    expect(hash("")).toMatch(/^[0-9a-f]{16}$/)
  })

  it("flips bits on a single-character change (avalanche)", () => {
    const a = hash("partial:a")
    const b = hash("partial:b")
    expect(a).not.toBe(b)
    // Differ in at least 16 of 64 bits — SHA-256 strongly clears
    // this bar, so the test is just a sanity check that the change
    // didn't get masked by truncation.
    let diff = 0
    for (let i = 0; i < 16; i++) {
      const ai = parseInt(a[i], 16)
      const bi = parseInt(b[i], 16)
      diff += popcount4(ai ^ bi)
    }
    expect(diff).toBeGreaterThanOrEqual(16)
  })

  it("distinguishes inputs that djb2 was prone to colliding on", () => {
    // djb2 has known collisions in short ASCII pairs. SHA-256 doesn't.
    // Pick a few that are easy to verify don't collide.
    const samples = ["aa", "bb", "ab", "ba", "", "a", "aaa", "aaaa"]
    const seen = new Set<string>()
    for (const s of samples) {
      const h = hash(s)
      expect(seen.has(h)).toBe(false)
      seen.add(h)
    }
  })

  it("has no collisions across 100k pseudo-random inputs", () => {
    const seen = new Set<string>()
    for (let i = 0; i < 100_000; i++) {
      // Mix counter + cheap pseudo-random suffix so the dataset
      // resembles real cache keys (id-prefixed structured strings).
      const key = `partial-${i}|fp=${(i * 2654435761) >>> 0}|x=${i % 7}`
      const h = hash(key)
      expect(seen.has(h)).toBe(false)
      seen.add(h)
    }
    expect(seen.size).toBe(100_000)
  })

  it("handles unicode and very long inputs", () => {
    expect(hash("café")).toMatch(/^[0-9a-f]{16}$/)
    expect(hash("🎉".repeat(1000))).toMatch(/^[0-9a-f]{16}$/)
    expect(hash("x".repeat(1_000_000))).toMatch(/^[0-9a-f]{16}$/)
  })

  it("treats empty and whitespace-only as distinct", () => {
    expect(hash("")).not.toBe(hash(" "))
    expect(hash(" ")).not.toBe(hash("  "))
    expect(hash("\n")).not.toBe(hash("\t"))
  })
})

function popcount4(n: number): number {
  // popcount on a 4-bit nibble.
  let c = 0
  while (n) {
    c += n & 1
    n >>>= 1
  }
  return c
}
