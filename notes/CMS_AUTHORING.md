# CMS authoring — block + content guide

**Added:** 2026-04-25
**Status:** documents the shipped runtime + editor as of 2026-04-25 (chunks 1–3 + palette + per-config tabs + modified badge).

This doc is the "how do I actually use this" companion to `CMS_VISION.md` (why) / `CMS_MANIFEST.md` (data model) / `CMS_EDITOR.md` (UX design). If you're reading code at the file level, start with this one.

---

## The author / dev split

- **Devs** write block components + register them + place `<Children>` slots on page templates. They control the *grammar* — what's possible.
- **Authors** open `/cms-edit` and edit content within that grammar — fill fields, add/remove/reorder blocks, scope values per request dimension.
- **The editor never writes `.tsx`.** All authoring lands in `src/cms/draft.json`; publishing copies into `src/cms/content.json`. Code stays code.

---

## Adding a new block type

Three files:

1. **The block component** — a server component that reads its fields via accessors:

   ```tsx
   // src/app/blocks/promo.tsx
   import { getEnum, getNumber, getText } from "../../framework/context.ts";

   export function PromoBlock() {
     const headline = getText("headline");
     const body = getText("body");
     const tone = getEnum("tone", ["info", "warning"] as const);
     const dismissAfter = getNumber("dismissAfter");
     return (
       <div data-tone={tone} data-dismiss-after={dismissAfter}>
         <h3>{headline}</h3>
         <p>{body}</p>
       </div>
     );
   }
   ```

   - Read accessors at the top of the body, before any `await` (hoisting rule — same as cache manifest + frame scope).
   - Every field accessor returns a safe default (`""`, `0`, `false`, `values[0]`) when the store has nothing — no need to defend against missing data.
   - Don't take props. The component runs inside a `<Partial cmsId={…}>` wrapper, and its CMS scope is keyed by that id.

2. **Register it in the catalog** (`src/app/blocks/catalog.ts`):

   ```ts
   import { registerBlock } from "../../framework/cms-runtime.ts";
   import { PromoBlock } from "./promo.tsx";

   registerBlock("promo", {
     tags: [".promo", ".demo-block"],   // shared selectors, no `#`
     component: PromoBlock,
   });
   ```

   - `tags` are class-only selectors. The slot wrapper (`<Children>`) auto-prefixes a `#${cmsId}` unique-token per instance, so you don't need a `#`-token in `tags`.
   - The dev-time prerender (`src/framework/cms-prerender.ts`) runs your component once at editor startup with no real data and captures the field manifest. That's how the editor knows your block has `headline / body / tone / dismissAfter` without you declaring a schema.

3. **Optional: seed it on a page** by editing `src/cms/content.json` directly, or just open `/cms-edit` and add an instance via the slot palette.

You're done. The block now appears in the editor's add-block palette anywhere a `<Children>` slot exists.

---

## Where content lives

| File | Role | Committed? |
|---|---|---|
| `src/cms/content.json` | Published content. Source of truth for production reads. | **Yes** |
| `src/cms/draft.json` | Author's unsaved edits. Read only when `cms-draft=1` cookie or query-param is set. | **No** (`.gitignore`) |

Both files share the same shape:

```jsonc
{
  "partials": {
    "<cmsId>": {
      "id": "<cmsId>",
      "type": "<blockType>",      // optional; set when this is a block instance
      "displayName": "#header",   // optional; what the editor tree shows
      "configs": [
        {
          "match": { /* zero or more dimension keys */ },
          "fields": { /* field name → value */ }
        }
      ],
      "slots": {                  // optional; recursive child blocks
        "<slotName>": [
          { "id": "...", "type": "...", "configs": [...], "slots": {...} }
        ]
      }
    }
  }
}
```

### Match clauses

Each config's `match` is a record of dimension key → predicate. Empty match = "always matches" (the cascade default).

```jsonc
{}                                              // always matches
{ "url:variant": "A" }                          // exact
{ "url:variant": { "in": ["A", "B"] } }         // membership
{ "cookie:locale": "fr" }                       // cookie value
{ "header:x-region": "eu" }                     // header
{ "pathname:/p/:slug": { "slug": "alpha" } }    // path pattern + param
{ "pathname:/p/:slug": { "slug": { "in": ["a", "b"] } } }
```

Multi-dimension matches AND together (every key must match).

### Cascade

The resolver picks every config whose match clause is satisfied, sorts by specificity (most matched dimensions first), and merges fields least-specific-first. So the most-specific match wins per field, and any field it doesn't set inherits from less-specific matches.

```jsonc
"configs": [
  { "match": { "url:variant": "A" }, "fields": { "headline": "Variant A" } },
  { "match": {},                     "fields": { "headline": "Default", "body": "Always" } }
]
// Resolved on ?variant=A → { headline: "Variant A", body: "Always" }
// Resolved on ?variant=B → { headline: "Default",   body: "Always" }
```

### Slots

`slots[name]` is an ordered array of child nodes. Each child has the same node shape recursively. The slot's `<Children name="…" allow="…">` declaration in JSX controls what the editor's add-block palette offers; it's not enforced at render time.

Slot children are **addressable by `cmsId`** the same way root entries are — `lookupCmsNode("composed-hero-1")` works whether `composed-hero-1` lives at `partials["composed-hero-1"]` (top level) or nested in some parent's `slots["body"]` array. The runtime builds a flat index on load.

---

## Draft / published mechanics

The runtime checks `cms-draft=1` on every request:

1. **Query param wins.** A request URL with `?cms-draft=1` reads draft (used by the editor's preview frame on initial load).
2. **Cookie fallback.** A request with `Cookie: cms-draft=1` reads draft (set by the editor page on first response; covers all subsequent requests including action POSTs and cache-mode refetches).
3. **No marker → published.** Production traffic without either signal sees only `content.json`.

Draft writes go through:

- **`writeDraftNode(cmsId, node)`** (`cms-runtime.ts`) — overwrites the top-level entry for `cmsId` in `draft.json`. Whole-node overrides; slot children of the parent are NOT pulled out into top-level entries automatically.
- The editor's actions (`saveCmsFields`, `addBlockToSlot`, `removeBlockFromSlot`, `moveBlockInSlot`) all call `writeDraftNode` after computing the new shape.

Top-level entries take precedence over slot-nested copies of the same id when the flat index is built — so editing a slot child via `saveCmsFields` (which writes a top-level entry) shadows whatever the parent's slot array still says.

Publishing copies every draft entry into published, then clears the draft. No partial publish in v1.

---

## Editor mental model

**Tree (left).** Every CMS node in the merged store, depth-indented by slot nesting. Click to select. Badges:
- **draft** (amber) — id exists only in draft (added but never published).
- **modified** (blue) — id is in published *and* has a draft override (your edits aren't live yet).

**Preview (center).** A `<Partial frame="preview" frameUrl="/cms-demo?cms-draft=1">` rendering the actual demo page in draft mode. Navigation inside the frame uses the framework's frame nav primitive — no iframe, single React tree.

**Fields (right).** Form for the selected node:
- One tab per `CmsConfig` (Default + each `match` clause). Tab labels collapse to a short form: `slug=alpha`, `variant∈A,B`, etc.
- Inputs derive from the catalog manifest's content fields, unioned with whatever's already stored.
- Save targets the active tab's config index — edits never bleed into other configurations.
- The slot palette below the form (when the selected node has slots) lists each slot's children with reorder + remove buttons, plus an add-block picker.

Saves invalidate `#${cmsId} #cms-edit-tree #cms-edit-fields` so the preview, tree, and form all refetch in sync. Publish invalidates the tree (broad — refines as a follow-up).

---

## Layout note: container queries, not viewport breakpoints

The editor's preview pane is a `<Partial frame>` rendering inside a 3-column grid, not a viewport-sized window. Block CSS that uses `@media (max-width:…)` will look weird in the editor (it'll think it's on a desktop because the *browser* is desktop-sized, but the *block's* container is much narrower).

Use CSS `@container` queries instead. Set a containment context on the block's root and query against that:

```css
.my-block { container-type: inline-size; }
@container (max-width: 600px) { .my-block .grid { grid-template-columns: 1fr; } }
```

This is good practice for responsive blocks regardless — the editor preview is just the most visible reason to bother.

---

## Common errors + debugging

**"No fields on this configuration yet."** in the editor's field panel — the block has no catalog manifest yet (failed prerender? not registered?) AND the current config's fields are empty. Check `src/app/blocks/catalog.ts` for the `registerBlock` call.

**Accessor reads return empty values in the rendered page.** Check that the read happens BEFORE any `await` in your block body (hoisting rule). After an await the per-request CMS scope cell may have drifted to a sibling Partial's scope.

**Edits don't show in the preview after save.** Confirm the cookie is set: DevTools → Application → Cookies → `cms-draft=1`. If absent, the editor's first response sets it; reload the page once. The preview frame's URL also has `?cms-draft=1` as a fallback for the initial render.

**Hydration warning on /cms-demo or /cms-edit's preview.** This was a real bug fixed by wrapping the page's static slug nav in a `<Partial>`. If you're seeing it on a new page, give any large static-but-streamed sub-tree (a long nav, a list of cards) its own Partial boundary — React's SSR can otherwise commit early and produce a server-vs-client tree mismatch.

**Editor server actions seem to do nothing.** In Playwright tests, `await page.click(button)` returns before the action's POST resolves. Wait for the response explicitly:
```ts
const responseP = page.waitForResponse(r => r.request().method() === "POST" && r.ok());
await page.getByRole("button", { name: "Save" }).click();
await responseP;
await page.reload();   // optional, forces fresh state on the next assertion
```

**Tests break each other's state.** The draft file is process-global; concurrent tests writing to it conflict. cms-edit specs run serially via `test.describe.configure({mode: "serial"})`. If you add another spec that writes to draft, do the same.

---

## File map (where each piece lives)

| Concern | File |
|---|---|
| `<Partial cmsId>` + scope cell + content accessors | `src/framework/context.ts` |
| Store loaders, lookup, draft cookie, write/publish, block registry, fingerprint contribution | `src/framework/cms-runtime.ts` |
| Catalog prerender (block manifest extraction) | `src/framework/cms-prerender.ts` |
| `<Children>` / `<Child>` slot primitives | `src/lib/slot.tsx` |
| Editor route + tree + preview + field panel + slot palette | `src/app/pages/cms-edit.tsx` |
| Editor server actions (save / publish / add / remove / move) | `src/app/actions/cms.ts` |
| Demo blocks | `src/app/blocks/{hero,rich-text,catalog}.tsx` |
| Demo loader (entity reference resolution) | `src/app/loaders/pokemon.ts` |
| Published content (committed) | `src/cms/content.json` |
| Draft content (gitignored) | `src/cms/draft.json` |

## Test map

| Concern | File |
|---|---|
| Resolver cascade + match evaluation | `src/framework/__tests__/cms-runtime.test.ts` |
| Block registry surface | `src/framework/__tests__/block-registry.test.ts` |
| Catalog prerender | `src/framework/__tests__/cms-prerender.test.ts` |
| Draft / published fork + lookup precedence | `src/framework/__tests__/cms-draft.test.ts` |
| Content accessors inside Partials | `src/lib/__tests__/cms-accessors.rsc.test.tsx` |
| Slot rendering | `src/lib/__tests__/cms-slots.rsc.test.tsx` |
| `provides` / `getClosest` / `getReference` | `src/lib/__tests__/cms-closest-reference.rsc.test.tsx` |
| Editor server actions (unit) | `src/app/actions/__tests__/cms.test.ts` |
| Editor end-to-end (Playwright) | `e2e/cms-edit.spec.ts` |
| CMS demo (cascade + slots + nav) | `e2e/cms-demo.spec.ts`, `e2e/cms-demo-slots.spec.ts` |
