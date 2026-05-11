/**
 * Cookie names + other plain constants the CMS layer uses.
 *
 * Kept in its own module with zero imports so `"use client"` files can
 * deep-import constants (e.g. `EDITOR_COOKIE` from
 * `editor-close-link.tsx`) without dragging in the runtime's
 * server-only modules (`session.ts`, `context.ts`, `node:async_hooks`).
 * Importing through `cms-runtime.ts` instead would transitively load
 * `context.ts` → Vite externalises `node:async_hooks` for the browser
 * and throws at module-evaluation time.
 */

export const CMS_DRAFT_COOKIE = "cms-draft"
export const EDITOR_COOKIE = "__editor"
