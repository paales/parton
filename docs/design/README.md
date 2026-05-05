# Design bundle — V6 floating block editor

A handoff bundle from Claude Design (claude.ai/design) that drove the
CMS editor redesign. Lives here as reference material — the
implementation lives in `cms/src/editor/`.

## What's in here

- `chats/chat1.md` — the design conversation. The intent lives here;
  the HTML is just the output. Read this before changing the editor
  if you need to know *why* something looks the way it does.
- `project/` — the V6 prototype. `Final Design.html` is the entry;
  it loads `final-app.jsx`, which mounts `parts/v6-consolidated.jsx`
  scaled to 1440×900. Treat as reference only — these are
  prototypes, not production code. The earlier explorations (v1–v5
  under `parts/`, `Floating Block Editor.html`) show the variations
  the user iterated through before landing on V6.
- `v6-screenshots/` — rendered captures of the prototype across
  modes (default, JSX, floating, dark, page-navigator open). Used to
  validate the implementation matched.
- `live/` — captures of the live editor (`yarn dev`) at the same
  modes for side-by-side comparison.
- `screenshot.mjs` / `live-screenshot.mjs` — the playwright drivers
  that produced those captures. Re-run when you change the editor;
  details below.
- `project/uploads/` and `project/scraps/` — reference imagery the
  user fed to the design tool.

## Regenerating screenshots

Both scripts use the workspace `playwright` install. Run from the
repo root:

```bash
# V6 prototype reference shots (depend on a static server over project/)
cd docs/design/project && python3 -m http.server 8765 &
node docs/design/screenshot.mjs

# Live editor shots (depend on `yarn dev` running)
yarn dev   # or note the port it picks
PORT=5175 node docs/design/live-screenshot.mjs
```

`live-screenshot.mjs` defaults to port 5179 (the Playwright e2e
default); pass `PORT=…` if your dev session picked another port.

## Where the implementation lives

| File | Role |
|---|---|
| `cms/src/editor/shell.tsx` | `EditorShell` partial — sibling overlay, `position: fixed` chrome only. |
| `cms/src/editor/editor-styles.tsx` | Inline `<style>` with all chrome CSS (light + dark + translucent + docked variants). |
| `cms/src/editor/components/icon.tsx` | Icon set used across the chrome. |
| `cms/src/editor/components/chrome-tab.tsx` | Chrome-shoulder SVG tab (light/solid surface). |
| `cms/src/editor/components/panel-tab-bar.tsx` | Picks between chrome tabs and segmented pill per surface. |
| `cms/src/editor/components/page-navigator.tsx` | Shopify-style page dropdown attached to the toolbar's "Home page" pill. |
| `cms/src/editor/components/status-pill.tsx` | Draft / Preview / Published toggle. |
| `cms/src/editor/components/add-block.tsx` | BlockPicker with search + categorized sections. |
| `cms/src/editor/components/tree-link.tsx` | Selector-targeted nav anchor. |

The editor is placed in `e2e-testing/src/app/root.tsx` as a sibling
of the page partials — not a wrapper. `<EditorShell parent={ROOT} />`
returns `null` when editor mode is off and emits chrome only when
on; the page renders untouched in either case.
