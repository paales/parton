/**
 * Per-author editor preferences, modeled as cells. Each tweak
 * (palette / surface / attachment / device / tree style / left tab)
 * partitions per-session (`partition: ({session}) => ({sid: session.id})`)
 * so users carry their own settings across reloads via the session
 * cookie.
 *
 * With cells:
 *
 *   - A parton's Render resolves the value it needs
 *     (`await editorPalette.resolve()`) and reads `.value`.
 *   - The toggle component receives the cell handle as a prop and
 *     calls `palette.set("dark")` — same Flight-serialized server-
 *     action ref as everywhere else.
 *   - Cell-stamped `cell:<id>` labels flow through the existing
 *     invalidation registry; specs reading the cell auto-refetch
 *     on mutation, no per-key snapshot walk.
 */

import { localCell } from "@parton/framework"

// Each `initial` is widened to the enum union so the handle's value
// type is the full enum, not the initial literal.
export const editorLeftTab = localCell({
  id: "editor-left-tab",
  shape: { enum: ["layers", "settings"] as const },
  partition: ({ session }) => ({ sid: session.id }),
  initial: "layers" as "layers" | "settings",
})

export const editorTreeStyle = localCell({
  id: "editor-tree-style",
  shape: { enum: ["jsx", "plain"] as const },
  partition: ({ session }) => ({ sid: session.id }),
  initial: "plain" as "jsx" | "plain",
})

export const editorPalette = localCell({
  id: "editor-palette",
  shape: { enum: ["light", "dark"] as const },
  partition: ({ session }) => ({ sid: session.id }),
  initial: "light" as "light" | "dark",
})

export const editorSurface = localCell({
  id: "editor-surface",
  shape: { enum: ["light", "translucent", "solid"] as const },
  partition: ({ session }) => ({ sid: session.id }),
  initial: "translucent" as "light" | "translucent" | "solid",
})

export const editorAttachment = localCell({
  id: "editor-attachment",
  shape: { enum: ["floating", "docked"] as const },
  partition: ({ session }) => ({ sid: session.id }),
  initial: "docked" as "floating" | "docked",
})

export const editorDevice = localCell({
  id: "editor-device",
  shape: { enum: ["desktop", "tablet", "mobile"] as const },
  partition: ({ session }) => ({ sid: session.id }),
  initial: "desktop" as "desktop" | "tablet" | "mobile",
})
