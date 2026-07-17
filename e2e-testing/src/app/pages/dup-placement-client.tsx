"use client"

// Duplicate-placement fixture — see dup-placement.tsx. The button
// drives a real document reload via the ambient Navigation API — the
// framework's own `reload()` is an in-place refetch, so a genuine
// document load (the post-reload attach catch-up path the spec drives)
// goes through `window.navigation.reload()`.

export function DupReload() {
  return (
    <button data-testid="dup-reload" onClick={() => window.navigation.reload()}>
      reload
    </button>
  )
}
