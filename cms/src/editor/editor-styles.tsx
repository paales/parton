/**
 * Editor chrome stylesheet, server-rendered as a `<style>` tag inside
 * `<EditorShell>`. Lives only when the editor is mounted — no global
 * cost when previewing the site outside design mode.
 *
 * Visual vocabulary: light "paper" surface with floating panels,
 * chrome-style tab strips, devtools-flavored stripes for margin /
 * padding visualization, and shadcn-ish form primitives (wf-field
 * / wf-segment / wf-slider).
 *
 * Mode matrix (driven by `data-*` attributes on `.cms-editor`):
 *   data-attachment=floating | docked
 *   data-surface=light | translucent | solid
 *   data-dark (boolean)
 */

const CSS = String.raw`
.cms-editor {
  --cms-ink: #1a1a1f;
  --cms-ink-2: #4a4a52;
  --cms-ink-3: #8b8b92;
  --cms-paper: #f3eee2;
  --cms-paper-2: #e9e4d8;
  --cms-line: rgba(0,0,0,0.10);
  --cms-line-soft: rgba(0,0,0,0.06);
  --cms-panel-bg: #ffffff;
  --cms-panel-strip: #f3f3f3;
  --cms-toolbar-bg: #f3f3f3;
  --cms-toolbar-pill-bg: #ffffff;
  --cms-accent: #2c7fd6;
  --cms-accent-soft: rgba(44,127,214,0.12);
  --cms-sel: #881280;
  --cms-sel-strong: #6e0e68;
  --cms-sel-soft: rgba(136,18,128,0.10);
  --cms-amber: #e0a91b;
  --cms-amber-soft: rgba(224,169,27,0.18);
  --cms-shadow: 0 12px 30px rgba(60,50,30,0.16), 0 2px 6px rgba(60,50,30,0.06);
  --cms-input-bg: #ffffff;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: var(--cms-ink);
  font-size: 13px;
}

/* ── Dark palette ──────────────────────────────────────────────── */
.cms-editor[data-dark] {
  --cms-ink: #f1f1f4;
  --cms-ink-2: rgba(241,241,244,0.78);
  --cms-ink-3: rgba(241,241,244,0.50);
  --cms-paper: #1c1c20;
  --cms-paper-2: #26262c;
  --cms-line: rgba(255,255,255,0.10);
  --cms-line-soft: rgba(255,255,255,0.06);
  --cms-panel-bg: #1c1c20;
  --cms-panel-strip: #1c1c20;
  --cms-toolbar-bg: #1c1c20;
  --cms-toolbar-pill-bg: rgba(255,255,255,0.10);
  --cms-sel: #d3a4ff;
  --cms-sel-strong: #e6c2ff;
  --cms-sel-soft: rgba(211,164,255,0.12);
  --cms-shadow: 0 16px 40px rgba(0,0,0,0.55);
  --cms-input-bg: rgba(255,255,255,0.06);
}

/* ── Translucent surface ───────────────────────────────────────── */
.cms-editor[data-surface="translucent"] {
  --cms-panel-bg: rgba(255,255,255,0.78);
  --cms-panel-strip: transparent;
  --cms-toolbar-bg: rgba(252,250,245,0.72);
  --cms-toolbar-pill-bg: rgba(255,255,255,0.65);
}
.cms-editor[data-surface="translucent"][data-dark] {
  --cms-panel-bg: rgba(28,28,32,0.78);
  --cms-toolbar-bg: rgba(28,28,32,0.78);
  --cms-toolbar-pill-bg: rgba(255,255,255,0.10);
}
.cms-editor[data-surface="translucent"] .cms-panel,
.cms-editor[data-surface="translucent"] .cms-toolbar {
  backdrop-filter: blur(24px) saturate(180%);
  -webkit-backdrop-filter: blur(24px) saturate(180%);
}

/* ── Canvas wrapper ─────────────────────────────────────────────── */
/* Editor chrome (toolbar + side panels) is purely overlay: position-
   fixed over the page below, never reserving layout space. The page
   renders full viewport width + height regardless of attachment mode.
   Docked vs floating only changes the chrome's own visual style —
   panels flush to edges + a square toolbar bar — not the page area. */
.cms-editor-canvas {
  position: relative;
  min-height: 100vh;
}

.cms-editor[data-attachment="docked"] .cms-panel {
  top: 0;
  bottom: 0;
  height: auto;
  max-height: none;
  border-radius: 0;
  box-shadow: none;
  border-top: 0;
  border-bottom: 0;
}
.cms-editor[data-attachment="docked"] .cms-panel--left {
  left: 0;
  border-left: 0;
}
.cms-editor[data-attachment="docked"] .cms-panel--right {
  right: 0;
  border-right: 0;
}
.cms-editor[data-attachment="docked"] .cms-toolbar {
  left: 320px;
  right: 320px;
  top: 0;
  transform: none;
  width: auto;
  height: 48px;
  max-width: none;
  border-radius: 0;
  box-shadow: none;
  border: 0;
  border-bottom: 1px solid var(--cms-line);
  justify-content: center;
}

/* Preview pane = the page itself. The chrome panels are position-
   fixed and reserve no layout space — the page fills the full
   viewport width, and the panels overlay on top. Device toggle is
   the only thing that clamps the page width (tablet / mobile). */
.cms-editor-preview {
  position: relative;
  min-height: 100vh;
  margin: 0 auto;
  width: 100%;
  background: transparent;
}
.cms-editor[data-device="tablet"] .cms-editor-preview { max-width: 820px; }
.cms-editor[data-device="mobile"] .cms-editor-preview { max-width: 390px; }

/* ── Floating panels ───────────────────────────────────────────── */
.cms-panel {
  position: fixed;
  top: 76px;
  width: 320px;
  max-height: calc(100vh - 96px);
  background: var(--cms-panel-bg);
  border: 1px solid var(--cms-line);
  border-radius: 10px;
  box-shadow: var(--cms-shadow);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  z-index: 5;
  color: var(--cms-ink);
}
.cms-panel--left { left: 18px; }
.cms-panel--right { right: 18px; }
.cms-panel-body {
  padding: 4px 14px 14px;
  overflow-y: auto;
  flex: 1;
}
.cms-panel-body--tree { padding: 6px; }
.cms-panel-resize {
  position: absolute;
  right: 3px;
  bottom: 3px;
  width: 12px;
  height: 12px;
  color: rgba(0,0,0,0.32);
  cursor: nwse-resize;
}
.cms-editor[data-dark] .cms-panel-resize { color: rgba(255,255,255,0.30); }

/* ── Chrome tab strip ──────────────────────────────────────────── */
.cms-chrome-strip {
  position: relative;
  background: var(--cms-panel-strip);
  border-bottom: 1px solid var(--cms-line-soft);
}
.cms-editor[data-attachment="docked"] .cms-chrome-strip {
  border-bottom: 0;
  height: 48px !important;
  padding-top: 12px !important;
}
.cms-editor[data-surface="translucent"] .cms-chrome-strip {
  background: transparent;
}

/* ── Top toolbar ───────────────────────────────────────────────── */
.cms-toolbar {
  position: fixed;
  top: 14px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 4px;
  height: 44px;
  padding: 0 6px;
  border-radius: 10px;
  background: var(--cms-toolbar-bg);
  border: 1px solid var(--cms-line);
  box-shadow: 0 12px 30px rgba(60,50,30,0.12);
  z-index: 10;
  font-size: 13px;
  color: var(--cms-ink);
  max-width: calc(100vw - 36px);
}
.cms-toolbar-icon {
  width: 30px;
  height: 30px;
  border-radius: 6px;
  display: grid;
  place-items: center;
  color: var(--cms-ink-2);
  cursor: pointer;
  background: transparent;
  border: 0;
  padding: 0;
  text-decoration: none;
}
.cms-toolbar-icon:hover { background: rgba(0,0,0,0.05); }
.cms-editor[data-dark] .cms-toolbar-icon:hover { background: rgba(255,255,255,0.08); }
.cms-toolbar-icon[data-active] {
  background: var(--cms-toolbar-pill-bg);
  color: var(--cms-ink);
  box-shadow: 0 1px 2px rgba(0,0,0,0.05);
}
.cms-editor[data-dark] .cms-toolbar-icon[data-active] {
  box-shadow: none;
}
.cms-toolbar-icon[data-disabled] {
  color: var(--cms-ink-3);
  opacity: 0.4;
  cursor: default;
}
.cms-toolbar-pill {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 10px;
  border-radius: 6px;
  background: var(--cms-toolbar-pill-bg);
  box-shadow: 0 1px 2px rgba(0,0,0,0.05);
  cursor: pointer;
  text-decoration: none;
  color: var(--cms-ink);
}
.cms-editor[data-dark] .cms-toolbar-pill { box-shadow: none; }
.cms-toolbar-pill--ghost {
  background: transparent;
  box-shadow: none;
}
.cms-toolbar-sep {
  width: 1px;
  height: 20px;
  background: rgba(0,0,0,0.18);
  flex-shrink: 0;
  display: inline-block;
}
.cms-editor[data-dark] .cms-toolbar-sep { background: rgba(255,255,255,0.18); }
.cms-toolbar-save {
  height: 30px;
  padding: 0 12px;
  display: flex;
  align-items: center;
  border-radius: 5px;
  background: var(--cms-ink);
  color: var(--cms-paper);
  font-weight: 400;
  border: 0;
  cursor: pointer;
  font-size: 13px;
}
.cms-toolbar-save:hover { opacity: 0.9; }
.cms-toolbar-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--cms-amber);
  box-shadow: 0 0 0 2px var(--cms-amber-soft);
  display: inline-block;
}
.cms-toolbar-status-dot[data-tone="green"] {
  background: #22a06b;
  box-shadow: 0 0 0 2px rgba(34,160,107,0.18);
}
.cms-toolbar-status-dot[data-tone="blue"] {
  background: var(--cms-accent);
  box-shadow: 0 0 0 2px var(--cms-accent-soft);
}

/* ── Address bar ───────────────────────────────────────────────── */
.cms-address-input {
  flex: 1;
  height: 24px;
  border-radius: 4px;
  border: 1px solid transparent;
  background: transparent;
  padding: 0 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: var(--cms-ink);
  min-width: 160px;
  outline: none;
}
.cms-address-input:focus {
  background: rgba(0,0,0,0.04);
  border-color: var(--cms-accent);
  box-shadow: 0 0 0 2px var(--cms-accent-soft);
}
.cms-editor[data-dark] .cms-address-input:focus {
  background: rgba(255,255,255,0.08);
}

/* ── Form primitives (Row / SectionHead / wf-*) ────────────────── */
.cms-section-head {
  font-size: 11px;
  color: var(--cms-ink-3);
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  margin: 14px 0 8px;
}
.cms-row {
  display: grid;
  grid-template-columns: 88px 1fr;
  gap: 10px;
  align-items: center;
  margin-bottom: 10px;
}
.cms-row-label {
  font-size: 13px;
  color: var(--cms-ink-2);
}
.cms-wf-field {
  background: var(--cms-input-bg);
  border: 1px solid var(--cms-line);
  border-radius: 6px;
  height: 28px;
  display: flex;
  align-items: center;
  padding: 0 10px;
  font-size: 13px;
  color: var(--cms-ink);
  width: 100%;
  outline: none;
  box-sizing: border-box;
}
.cms-wf-field:focus {
  border-color: var(--cms-accent);
  box-shadow: 0 0 0 2px var(--cms-accent-soft);
}
.cms-wf-textarea {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  height: auto;
  min-height: 84px;
  padding: 6px 10px;
  line-height: 1.45;
  resize: vertical;
}
.cms-wf-segment {
  display: flex;
  background: rgba(0,0,0,0.04);
  border-radius: 6px;
  padding: 2px;
  height: 26px;
  font-size: 13px;
  gap: 2px;
}
.cms-editor[data-dark] .cms-wf-segment { background: rgba(255,255,255,0.06); }
.cms-wf-segment a,
.cms-wf-segment > span {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 8px;
  border-radius: 4px;
  color: var(--cms-ink-2);
  text-decoration: none;
  font-weight: 400;
}
.cms-wf-segment a[data-active],
.cms-wf-segment > span[data-active] {
  background: var(--cms-input-bg);
  color: var(--cms-ink);
  box-shadow: 0 1px 2px rgba(0,0,0,0.06);
}
.cms-editor[data-dark] .cms-wf-segment a[data-active],
.cms-editor[data-dark] .cms-wf-segment > span[data-active] {
  background: rgba(255,255,255,0.18);
  box-shadow: none;
}
.cms-wf-toggle {
  width: 28px;
  height: 16px;
  border-radius: 999px;
  background: rgba(0,0,0,0.15);
  position: relative;
  display: inline-block;
  cursor: pointer;
}
.cms-editor[data-dark] .cms-wf-toggle { background: rgba(255,255,255,0.18); }
.cms-wf-toggle[data-on] { background: var(--cms-ink); }
.cms-wf-toggle::after {
  content: "";
  position: absolute;
  left: 2px;
  top: 2px;
  width: 12px;
  height: 12px;
  background: #fff;
  border-radius: 50%;
  box-shadow: 0 1px 2px rgba(0,0,0,0.2);
  transition: left 120ms ease;
}
.cms-wf-toggle[data-on]::after { left: 14px; }

/* ── Slider field (Polaris-flavored) ───────────────────────────── */
.cms-wf-slider-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.cms-wf-slider {
  flex: 1;
  height: 6px;
  background: rgba(0,0,0,0.06);
  border-radius: 999px;
  position: relative;
  box-shadow: inset 0 1px 1px rgba(0,0,0,0.04);
}
.cms-editor[data-dark] .cms-wf-slider { background: rgba(255,255,255,0.08); }
.cms-wf-slider-fill {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  background: var(--cms-ink);
  border-radius: 999px;
}
.cms-wf-slider-thumb {
  position: absolute;
  top: 50%;
  transform: translate(-50%,-50%);
  width: 16px;
  height: 16px;
  background: #fff;
  border-radius: 50%;
  box-shadow: 0 0 0 1px rgba(0,0,0,0.18), 0 1px 2px rgba(0,0,0,0.18), 0 2px 4px rgba(0,0,0,0.06);
}
.cms-wf-slider-num {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 5px 0 6px;
  background: var(--cms-input-bg);
  border: 1px solid var(--cms-line);
  border-radius: 5px;
  font-size: 13px;
  color: var(--cms-ink);
  min-width: 48px;
}
.cms-wf-slider-num input {
  border: 0;
  outline: 0;
  background: transparent;
  font-size: 13px;
  color: var(--cms-ink);
  width: 32px;
  text-align: right;
  font-family: inherit;
}
.cms-wf-slider-num span.suffix {
  color: var(--cms-ink-3);
  font-size: 11px;
}

/* ── Buttons ───────────────────────────────────────────────────── */
.cms-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border-radius: 6px;
  background: var(--cms-ink);
  color: #fff;
  font-size: 13px;
  border: 0;
  cursor: pointer;
  text-decoration: none;
}
.cms-btn:hover { opacity: 0.9; }
.cms-btn--ghost {
  background: transparent;
  color: var(--cms-ink-2);
  border: 1px solid var(--cms-line);
}
.cms-btn--ghost:hover {
  background: rgba(0,0,0,0.04);
  color: var(--cms-ink);
}

/* ── Layers tree ───────────────────────────────────────────────── */
/* Each row lives in a .cms-tree-row-wrapper flex container that also
   holds the trailing tools (trash + eye). The wrapper is the hover
   target — both the chev/grip swap and the tools visibility key off
   it, so all the affordances reveal in lockstep when you mouse the
   row. */
.cms-tree-row-wrapper {
  display: flex;
  align-items: center;
  border-radius: 4px;
}
.cms-tree-row-wrapper:hover { background: rgba(0,0,0,0.04); }
.cms-editor[data-dark] .cms-tree-row-wrapper:hover {
  background: rgba(255,255,255,0.06);
}
.cms-tree-row {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  padding-right: 4px;
  height: 28px;
  border-radius: 4px;
  text-decoration: none;
  color: var(--cms-ink);
  min-width: 0;
}
.cms-tree-row[data-selected="true"] {
  background: rgba(0,0,0,0.07);
  font-weight: 500;
}
.cms-editor[data-dark] .cms-tree-row[data-selected="true"] {
  background: rgba(255,255,255,0.10);
}
.cms-tree-row[data-hidden="true"] { opacity: 0.5; }
.cms-tree-leading {
  width: 14px;
  height: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--cms-ink-3);
  flex-shrink: 0;
}
.cms-tree-leading .chev,
.cms-tree-leading .grip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.cms-tree-leading .grip { display: none; }
.cms-tree-row-wrapper:hover .cms-tree-leading .chev { display: none; }
.cms-tree-row-wrapper:hover .cms-tree-leading .grip {
  display: inline-flex;
  cursor: grab;
}
.cms-tree-row-icon {
  width: 14px;
  display: grid;
  place-items: center;
  color: var(--cms-ink-2);
  flex-shrink: 0;
}
.cms-tree-row-name {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  overflow: hidden;
}
.cms-tree-row-name span.label { overflow: hidden; text-overflow: ellipsis; }
.cms-tree-row-name span.tag {
  color: var(--cms-sel);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.cms-tree-row-name span.attr {
  color: #994500;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  margin-left: 4px;
}
.cms-editor[data-dark] .cms-tree-row-name span.attr { color: #f4b66a; }
.cms-tree-row-name span.modified {
  color: var(--cms-ink-3);
  font-size: 11px;
  margin-left: 6px;
}
.cms-tree-row-name .rename-input {
  background: var(--cms-input-bg);
  border: 1px solid var(--cms-line);
  border-radius: 3px;
  padding: 1px 5px;
  font-size: 12px;
  color: var(--cms-ink);
  outline: none;
  font-weight: 500;
  min-width: 80px;
}
.cms-tree-row-name .rename-input:focus {
  border-color: var(--cms-accent);
  box-shadow: 0 0 0 2px var(--cms-accent-soft);
}
.cms-tree-tools {
  display: flex;
  align-items: center;
  gap: 2px;
  visibility: hidden;
  flex-shrink: 0;
}
.cms-tree-row-wrapper:hover .cms-tree-tools,
.cms-tree-row-wrapper[data-hidden="true"] .cms-tree-tools {
  visibility: visible;
}
.cms-tree-tools button,
.cms-tree-tools a {
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border: 0;
  background: transparent;
  color: var(--cms-ink-2);
  border-radius: 4px;
  cursor: pointer;
  text-decoration: none;
}
.cms-tree-tools button:hover,
.cms-tree-tools a:hover { background: rgba(0,0,0,0.06); }
.cms-editor[data-dark] .cms-tree-tools button:hover,
.cms-editor[data-dark] .cms-tree-tools a:hover { background: rgba(255,255,255,0.08); }
.cms-tree-tools button[disabled] {
  color: var(--cms-ink-3);
  opacity: 0.35;
  cursor: default;
}
.cms-tree-slot-label {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 8px;
  font-size: 12px;
  font-style: italic;
  color: var(--cms-ink-3);
}
.cms-tree-add-row {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 6px;
  color: var(--cms-accent);
  font-size: 13px;
  border-radius: 4px;
  background: transparent;
  border: 0;
  text-align: left;
  cursor: pointer;
  font: inherit;
  width: 100%;
}
.cms-tree-add-row:hover { background: rgba(44,127,214,0.08); }
.cms-tree-add-row svg { stroke-width: 2.2; }

/* ── BlockPicker popover ───────────────────────────────────────── */
.cms-blockpicker {
  position: absolute;
  top: 32px;
  left: 28px;
  z-index: 20;
  width: 280px;
  background: var(--cms-panel-bg);
  border: 1px solid var(--cms-line);
  border-radius: 8px;
  box-shadow: 0 12px 30px rgba(0,0,0,0.18), 0 0 0 1px rgba(0,0,0,0.04);
  font-size: 13px;
  color: var(--cms-ink);
  overflow: hidden;
}
.cms-blockpicker-search {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--cms-line-soft);
  color: var(--cms-ink-3);
}
.cms-blockpicker-list {
  max-height: 320px;
  overflow-y: auto;
  padding: 4px;
}
.cms-blockpicker-section {
  font-size: 11px;
  color: var(--cms-ink-3);
  text-transform: uppercase;
  letter-spacing: 0.6px;
  padding: 8px 8px 4px;
  font-weight: 500;
}
.cms-blockpicker-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 8px;
  border-radius: 5px;
  background: transparent;
  border: 0;
  width: 100%;
  text-align: left;
  cursor: pointer;
  color: var(--cms-ink);
  font-size: 13px;
}
.cms-blockpicker-item:hover,
.cms-blockpicker-item[data-active] { background: rgba(0,0,0,0.04); }
.cms-editor[data-dark] .cms-blockpicker-item:hover,
.cms-editor[data-dark] .cms-blockpicker-item[data-active] { background: rgba(255,255,255,0.08); }
.cms-blockpicker-item-icon {
  width: 26px;
  height: 26px;
  border-radius: 4px;
  background: rgba(0,0,0,0.04);
  display: grid;
  place-items: center;
  color: var(--cms-ink-2);
  flex-shrink: 0;
}
.cms-editor[data-dark] .cms-blockpicker-item-icon { background: rgba(255,255,255,0.08); }
.cms-blockpicker-item-text { flex: 1; min-width: 0; }
.cms-blockpicker-item-text .name { font-weight: 400; color: var(--cms-ink); }
.cms-blockpicker-item-text .desc {
  font-size: 11px;
  color: var(--cms-ink-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cms-blockpicker-footer {
  padding: 6px 10px;
  border-top: 1px solid var(--cms-line-soft);
  font-size: 11px;
  color: var(--cms-ink-3);
  display: flex;
  gap: 8px;
}

/* ── Page-navigator dropdown ───────────────────────────────────── */
.cms-page-nav {
  position: fixed;
  left: 50%;
  top: 64px;
  transform: translateX(-50%);
  width: 320px;
  background: var(--cms-panel-bg);
  border: 1px solid var(--cms-line);
  border-radius: 10px;
  box-shadow: 0 16px 40px rgba(0,0,0,0.18);
  z-index: 12;
  padding: 6px;
  font-size: 13px;
  color: var(--cms-ink);
}
.cms-page-nav-search {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  background: rgba(0,0,0,0.04);
  margin-bottom: 4px;
  color: var(--cms-ink-3);
}
.cms-editor[data-dark] .cms-page-nav-search { background: rgba(255,255,255,0.06); }
.cms-page-nav-search input {
  flex: 1;
  border: 0;
  outline: 0;
  background: transparent;
  font-size: 13px;
  color: var(--cms-ink);
  font-family: inherit;
}
.cms-page-nav-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 10px;
  border-radius: 6px;
  text-decoration: none;
  color: var(--cms-ink);
}
.cms-page-nav-item:hover { background: rgba(0,0,0,0.04); }
.cms-editor[data-dark] .cms-page-nav-item:hover { background: rgba(255,255,255,0.08); }
.cms-page-nav-item[data-active] {
  background: rgba(0,0,0,0.05);
}
.cms-editor[data-dark] .cms-page-nav-item[data-active] {
  background: rgba(255,255,255,0.10);
}
.cms-page-nav-divider {
  height: 1px;
  background: var(--cms-line);
  margin: 6px 6px;
}
.cms-page-nav-backdrop {
  position: fixed;
  inset: 0;
  z-index: 11;
}

/* ── Status pill dropdown ──────────────────────────────────────── */
.cms-status-menu {
  position: absolute;
  top: 38px;
  right: 0;
  width: 200px;
  background: var(--cms-panel-bg);
  border: 1px solid var(--cms-line);
  border-radius: 8px;
  box-shadow: 0 12px 30px rgba(0,0,0,0.18);
  padding: 4px;
  z-index: 12;
}
.cms-status-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 6px;
  text-decoration: none;
  color: var(--cms-ink);
  font-size: 13px;
}
.cms-status-menu-item:hover { background: rgba(0,0,0,0.04); }
.cms-editor[data-dark] .cms-status-menu-item:hover { background: rgba(255,255,255,0.08); }

/* ── Stripes (margin / padding visualization) ──────────────────── */
.cms-stripes-margin {
  background-color: rgba(245,185,185,0.22);
  background-image: repeating-linear-gradient(45deg, transparent 0 7px, rgba(180,60,60,0.55) 7px 8px);
  border: 1px solid rgba(180,60,60,0.5);
}
.cms-stripes-padding {
  background-color: rgba(182,217,154,0.25);
  background-image: repeating-linear-gradient(45deg, transparent 0 7px, rgba(60,120,40,0.55) 7px 8px);
  border: 1px solid rgba(60,120,40,0.45);
}
.cms-stripes-content {
  background-color: rgba(108,177,240,0.16);
  background-image: repeating-linear-gradient(45deg, transparent 0 7px, rgba(40,90,180,0.5) 7px 8px);
}

/* ── Selection rect (canvas chrome) ────────────────────────────── */
.cms-canvas-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 4;
}
.cms-selection-rect {
  position: absolute;
  outline: 1.5px dashed var(--cms-sel);
  outline-offset: -1px;
  background: var(--cms-sel-soft);
}
.cms-selection-corner {
  position: absolute;
  width: 7px;
  height: 7px;
  background: var(--cms-panel-bg);
  border: 1.5px solid var(--cms-sel-strong);
  border-radius: 1px;
}
.cms-selection-tag {
  position: absolute;
  background: var(--cms-panel-bg);
  border: 1px solid var(--cms-sel);
  border-radius: 3px;
  padding: 3px 7px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  box-shadow: 0 2px 6px rgba(0,0,0,0.12);
  white-space: nowrap;
}
.cms-selection-tag .tag { color: var(--cms-sel); }
.cms-selection-tag .dim { color: var(--cms-ink-3); }
.cms-insertion-line {
  position: absolute;
  left: 0;
  right: 0;
  height: 22px;
  display: flex;
  align-items: center;
  gap: 6px;
  pointer-events: none;
}
.cms-insertion-line::before,
.cms-insertion-line::after {
  content: "";
  flex: 1;
  height: 1px;
  background: var(--cms-accent);
  opacity: 0.35;
}
.cms-insertion-line .plus {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--cms-accent);
  color: #fff;
  display: grid;
  place-items: center;
  box-shadow: 0 4px 10px rgba(44,127,214,0.4);
}

/* ── Spacing visualizer ────────────────────────────────────────── */
.cms-spacing {
  position: relative;
  height: 120px;
  background: var(--cms-input-bg);
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid var(--cms-line);
}
.cms-spacing-margin {
  position: absolute;
  inset: 0;
  clip-path: polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 0, 16px 16px, 16px calc(100% - 16px), calc(100% - 16px) calc(100% - 16px), calc(100% - 16px) 16px, 16px 16px);
}
.cms-spacing-padding {
  position: absolute;
  inset: 16px;
  clip-path: polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 0, 16px 16px, 16px calc(100% - 16px), calc(100% - 16px) calc(100% - 16px), calc(100% - 16px) 16px, 16px 16px);
}
.cms-spacing-content {
  position: absolute;
  inset: 32px;
  background: var(--cms-sel-soft);
  outline: 1px dashed var(--cms-sel);
}
.cms-spacing-num {
  position: absolute;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: var(--cms-ink);
  background: var(--cms-input-bg);
  padding: 1px 5px;
  border-radius: 2px;
  border: 1px solid var(--cms-line);
}

/* ── Source field with dynamic-source pill ─────────────────────── */
.cms-source-field {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px 0 10px;
}
.cms-source-field .pill-dynamic {
  color: var(--cms-accent);
  background: var(--cms-accent-soft);
  padding: 1px 5px;
  border-radius: 3px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  white-space: nowrap;
}
.cms-source-field .db {
  display: grid;
  place-items: center;
  color: var(--cms-accent);
  flex-shrink: 0;
}

/* ── Right panel: selected element header strip ────────────────── */
.cms-selected-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

/* ── Page-shell wrapper for non-editor mode ────────────────────── */
.cms-page-shell {
  margin: 0 auto;
  min-height: 100vh;
  max-width: 56rem;
  padding: 32px;
}

/* ── Diagonal stripes for canvas margin band ───────────────────── */
.cms-canvas-margin-band {
  position: absolute;
  left: 0;
  right: 0;
  height: 12px;
  pointer-events: none;
}
.cms-canvas-margin-band--top { top: -12px; }
.cms-canvas-margin-band--bottom { bottom: -12px; }
`

export function EditorChromeStyles() {
  return <style dangerouslySetInnerHTML={{ __html: CSS }} />
}
