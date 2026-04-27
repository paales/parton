> **Superseded 2026-04-27** by [`docs/partial.md`](../docs/partial.md)
> § selector. Historical design proposal preserved for context.

---

# Selector API — design note

**Added:** 2026-04-21
**Status:** implemented.
**Files:** `src/lib/partial-component.tsx` (`parseSelector` + `resolveEffectiveId`), `src/lib/partial.tsx` (`resolveSelectorToIds`, `PartialRoot`), `src/lib/partial-client.tsx` (`parseSelectorClient` + nav handles + dispatcher), `src/lib/partial-registry.ts` (`PartialSnapshot.{uniqueTokens,sharedTokens}`), `src/lib/partial-request-state.ts` (`seenUniqueTokens`), `src/lib/cache.tsx` (snapshot reconstruction), `src/framework/entry.rsc.tsx` (action `invalidate`), `src/framework/navigation-api.ts` (`FrameworkNavigateOptions.selector`).
**Supersedes:** the `id` + `tags` prop pair on `<Partial>` and the `{ids, tags}` shape on `reload` / `navigate` / action `invalidate`. No deprecation alias — cut cold; demo pages and tests migrated in the same change.

---

## One-liner

`<Partial>` stops having two naming props. `id` + `tags` collapse into one `selector` prop with CSS-style syntax: `#foo` for a unique name (must appear once per page), `.foo` for a shared label (unions on refetch). The refetch, action-invalidation, and cache-keying paths all use the same selector string.

```tsx
<Partial selector="#cart">                            // unique, was: id="cart"
<Partial selector=".price product">                   // shared labels, was: tags="price product"
<Partial selector="#page-3 pagination">               // unique + shared, was: id="page-3" tags="pagination"
<Partial selector=".ad-slot">                         // anonymous, addressable only via .ad-slot
```

```ts
nav.reload({ selector: "#cart" }); // targeted refetch (single Partial)
nav.reload({ selector: ".price" }); // broadcast refetch (tag union)
nav.reload({ selector: "#cart .price" }); // mix — refreshes #cart AND every .price
nav.navigate(url, { selector: "#search-results" }); // URL change + targeted refetch
return { invalidate: { selector: "#cart .price" } }; // server action
```

## Why

Three friction points with today's `id` / `tags` split:

1. **Two props for one job.** Authors have to decide per-Partial: is this an id, a tag, or both? The distinction matters for uniqueness semantics but the choice is usually made by guessing. `#` vs `.` is the same choice made explicit in the value, not smeared across two props.
2. **Collision-as-default.** A duplicate `id="cart"` throws. In practice most Partials don't _need_ uniqueness — tag-union refetch is nearly always fine — but the id name gets picked because it's shorter. Opt-in uniqueness (`#cart`) makes the hard error match authorial intent.
3. **The CSS prior is already there.** `CLAUDE.md` describes tags as "like DOM `className`". With `#` / `.` prefixes the analogy completes: `.class` selects many, `#id` selects one, space separates tokens the same way `className` does. Devs know this grammar in their fingers.

The rename to `selector` (vs patching `tags`) is deliberate: a prop called `tags` that sometimes takes `#`-prefixed strings is ambiguous ("is the `#` part of my tag?"). `selector` answers that — the prefixes are syntax, always.

## Surface

### `<Partial selector="…">`

```ts
interface PartialProps {
  selector: string | string[];          // required — replaces id + tags
  children: ReactNode;
  fallback?: ReactNode;
  errorWith?: ...;
  defer?: ...;
  cache?: CacheOptions;
  frame?: string;                       // see "Frames — convention kept"
  frameUrl?: string;
}
```

**Syntax.** A selector is a space-separated list of tokens. Each token starts with `#` or `.`:

- `#foo` — a **unique token**. Must appear on exactly one Partial per page; a second occurrence throws synchronously during render.
- `.foo` — a **shared token**. Any number of Partials may carry it; tag-union refetch resolves across them.

The value accepts `string | string[]` (array is space-joined internally, matching the current `tags` ergonomics and the `clsx` pattern). Repeated tokens within a single Partial's selector are de-duplicated.

**Validation (throws at render time):**

- Token without `#` / `.` prefix: _"Unprefixed token `cart` in `<Partial selector>`. Tokens must start with `#` (unique) or `.` (shared). Did you mean `#cart` or `.cart`?"_
- Empty selector (no tokens): _"`<Partial>` requires at least one token in `selector`."_
- Duplicate `#foo` across Partials on the page: _"Duplicate `#cart` selector. Tokens starting with `#` must be unique per page."_

Multiple `#`-tokens on one Partial are allowed; each must still be unique page-wide. This is rare but legal (`selector="#cart #header-cart"` for a Partial reachable by two names).

### `FrameworkNavigateOptions` / `FrameworkReloadOptions`

```ts
interface FrameworkNavigateOptions extends NavigationNavigateOptions {
  disableTransition?: boolean;
  selector?: string | string[]; // replaces ids + tags
  silent?: boolean;
}
```

`reload`'s options are the same minus `silent`. `navigate` / `reload` still return `FrameworkNavigationResult`; microtask-batching of multiple calls still applies (multiple `reload({selector: ...})` calls in the same tick merge into one request).

Frame handles continue to ignore `selector` on `navigate` — a frame refetch rerenders its subtree wholesale by design.

### Server action invalidation

```ts
return { invalidate: { selector: "#cart .price" } };
return { revalidate: { selector: "#cart" } }; // alias, same semantics
```

The legacy shapes are removed:

- `{ invalidate: ["cart"] }` — was array-as-ids; gone.
- `{ invalidate: { ids, tags } }` — gone.

### Anonymous Partials

Same idea as today's `__anon:<sorted-tags>` synthesis, but based on sorted `.class` tokens (the `#` case synthesizes nothing because the token _is_ the name). A Partial with `selector=".ad-slot .below-fold"` and no `#`-token gets an internal id of `__anon:.ad-slot,.below-fold` — stable across renders, addressable via `reload({ selector: ".ad-slot" })`, non-addressable by any unique name.

Two anonymous Partials with the same sorted `.class` token set still throw the "distinguishable" error, same as today — the dedup is on sorted tokens, so order in the source doesn't matter.

## Wire format

Internal only — no user writes these. Two equally viable shapes:

**Option A (recommended): split wire, parsed client-side.** The client dispatcher parses the selector string into `{ids, tags}` before assembling the URL, and sends:

```
/foo?partials=cart,header&tags=price,product&cached=…
```

Server parser (`parseRequestedIds`, `resolveTagsToIds` in `partial.tsx`) is unchanged. Devtools stay readable (no `%23`). The selector is a developer-facing concept; the wire can keep its typed split.

**Option B: unified wire.** Send `?selector=%23cart+.price+%23header` and parse once on the server. Fewer moving parts at the cost of percent-encoded `#` and a new server parser.

Pick **A**. The selector is vocabulary; the wire is plumbing. Existing server-side tag→id resolution doesn't need rewriting.

## Cache keys

Today (`cache.tsx:620`):

```ts
const baseKey = `${id}:${fingerprint}:${djb2(ids.join(","))}`;
```

Two roles for the `id` there: (a) stable namespace for the Partial, (b) cache-key prefix. In a selector world, both collapse to the Partial's **effective id**, which is:

- The single `#`-token if the Partial has exactly one `#`-token.
- If multiple `#`-tokens: the sorted `#`-tokens joined (`#a.#b` → `"#a,#b"`).
- If no `#`-token: `__anon:<sorted-classes>` (same as today's anon synthesis).

Cache key becomes:

```ts
const baseKey = `${effectiveId}:${fingerprint}:${djb2(innerEffectiveIds.join(","))}`;
```

The inner-ids-hash invalidation story from `CLAUDE.md` §Caching is unchanged — adding or removing a nested Partial still changes the inner-ids hash, which busts stale cache entries automatically.

## Frames — convention kept

The "frame name = root Partial's `#`-token" convention stays. Decoupling was explored (server inferring the frame root via a registry scan) but it broke the browser-traverse path in `entry.browser.tsx`: that handler appends `__frame/__frameUrl` pairs to a URL-changed refetch expecting a **full** render with session updates, not a narrowed filter. If the server auto-added a frame-name-derived id to the filter, it would silently narrow the refetch and suppress unrelated page content (e.g. `MainContent` switching on `?product=`).

Concretely:

- `frame="cart"` still names the frame's session-backed URL scope. `PartialProps.frame` stays `string`.
- `_dispatchFrameRefetch` still sends `?partials=<frameName>` to narrow frame-nav refetches. The server's direct-lookup on effective id resolves it when the Partial's selector contains `#<frameName>`.
- The `urlChanged` traverse handler in `entry.browser.tsx` deliberately omits `?partials=` so the server does a full streaming render (MainContent picks up the new URL) while `__frame` updates frame sessions.
- `?__frame=<name>&__frameUrl=<url>` is session-update-only on the server. It does NOT contribute to the partial filter.

The practical implication: a frame's root Partial should carry a `#<frameName>` token in its selector (e.g. `<Partial selector="#cart" frame="cart">`). An anonymous root (`<Partial selector=".cart-frame" frame="cart">`) isn't addressable via the `partials=<frameName>` hint, so frame-nav refetches couldn't narrow to it — they'd full-render the page. Workable, but uncommon; the convention is the happy path.

## Authoring parallel

`selector` lines up with `className` the way CSS lines up with DOM:

| React                                   | Partials                                 |
| --------------------------------------- | ---------------------------------------- |
| `<div className="btn btn-primary">`     | `<Partial selector=".btn .btn-primary">` |
| `<div className="card" id="hero">`      | `<Partial selector="#hero .card">`       |
| `document.querySelector(".btn, #hero")` | `nav.reload({ selector: "#hero .btn" })` |

One difference from CSS worth naming: space is union here (both on the Partial and in the refetch selector), not the descendant combinator. Partials are flat — there's no tree to descend through — so space-as-union is the only reading that makes sense. Comma is not part of the grammar.

## Migration

Cut cold. No alias. One-shot codemod across `src/app/` and the test suites.

| Old                                                  | New                                            |
| ---------------------------------------------------- | ---------------------------------------------- |
| `<Partial selector="#cart">`                                | `<Partial selector="#cart">`                   |
| `<Partial selector=".price .product">`                     | `<Partial selector=".price .product">`         |
| `<Partial selector="#price-abc" tags="price">`              | `<Partial selector="#price-abc .price">`       |
| `<Partial tags={["ad-slot"]}>`                       | `<Partial selector=".ad-slot">`                |
| `nav.reload({ ids: ["cart"] })`                      | `nav.reload({ selector: "#cart" })`            |
| `nav.reload({ tags: ["price"] })`                    | `nav.reload({ selector: ".price" })`           |
| `nav.reload({ ids: ["a"], tags: ["b"] })`            | `nav.reload({ selector: "#a .b" })`            |
| `nav.navigate(u, { tags: ["search"] })`              | `nav.navigate(u, { selector: ".search" })`     |
| `return { invalidate: ["cart"] }`                    | `return { invalidate: { selector: "#cart" } }` |
| `return { invalidate: { tags: ["cart"] } }`          | `return { invalidate: { selector: ".cart" } }` |
| `return { invalidate: { ids: ["a"], tags: ["b"] } }` | `return { invalidate: { selector: "#a .b" } }` |

Codemod rules:

1. If a Partial has both `id` and `tags`: new selector is `"#${id} .${tag1} .${tag2}…"`.
2. If only `id`: `"#${id}"`.
3. If only `tags` (string): prefix each space-separated token with `.`.
4. If only `tags` (array): prefix each element with `.` and join with space.
5. For refetch / invalidate call sites: concatenate `#`-prefixed ids and `.`-prefixed tags into one space-separated string.

## Decisions pinned

From conversation, 2026-04-21:

- **Rename `tags` → `selector`.** Required `#`/`.` prefixes, bare tokens throw. Commits to the CSS framing; eliminates ambiguity about whether `#` is part of a tag name.
- **Space-separated, not comma-separated.** Matches `className` authoring, which is the hot path. The CSS-querySelector comma-for-union convention is not adopted — it would add unnecessary syntax for the common case.
- **Multiple `#`-tokens per Partial are allowed.** Each must still be unique page-wide. Rare, but legal; no special validation beyond per-token uniqueness.
- **No deprecation alias for `id` / `tags`.** Cut cold. Codemod runs once. Tests migrate in lock-step.
- **No single-arg shorthand for `reload`.** `reload("#cart")` was considered and declined. Keep `reload({ selector: "#cart" })` — matches the invalidate shape and the navigate options.
- **Wire format stays similar-ish.** Split wire (Option A above): client parses the selector into `{ids, tags}` before dispatch; server-side parsers (`parseRequestedIds`, `resolveTagsToIds`) stay untouched. Devtools logs stay readable.
- **No `frame={true}` sugar.** Frame name is always explicit. `PartialProps.frame` is `string`, not `string | true`.
- **Multi-`#` lookup uses the simple path.** The registry scan function handles both `#` and `.` matches in one pass; there is no direct O(1) `#`-token index. `lookupPartial` stays keyed on the effective id for the registry-miss fallback check — that's the only direct lookup. Everything else scans.

## Sharp edges

1. **`#` is subtle in a text editor.** A dev who writes `selector="cart"` expecting uniqueness gets a render-time throw ("unprefixed token"), which is the right failure — but only at render time, not in the type. Worth considering a template-literal type (`SelectorString<...>`) once the API settles, so `selector="cart"` is a TS error. Out of scope for first pass.

2. **URL encoding in action-dispatch logs.** When the server action dispatcher builds a filter URL from an `invalidate` directive, we go through the same split-wire path (parse selector → set `partials=` + `tags=`). Devtools / server logs stay readable.

3. **Frame name / `#`-token drift.** If you write `<Partial selector="#cart" frame="basket">` the frame's session entry is keyed `basket`, but the Partial's effective id is `cart`. Legal — but a refetch `reload({ selector: "#cart" })` targets the Partial (and thus also its frame subtree via the wrapper), while a frame navigate `useNavigation("basket").navigate(...)` targets the frame URL scope. Two addressing mechanisms for two different concerns; worth one line of docs in `FRAMES.md` after the rename.

4. **Registry key lookup on the server.** Snapshots now store `uniqueTokens[]` (the `#`-tokens) + `sharedTokens[]` (the `.`-tokens). Resolution is a single scan: for each snapshot, match requested tokens against both sets with union semantics. `lookupPartial(route, effectiveId)` stays for the registry-miss fallback but is not used for refetch filtering — the scan subsumes the direct lookup for multi-`#` correctness. Same complexity class as today's tag scan; route-scoped snapshot sets are small.

## Implementation pointers (skeleton — fleshed out when coding)

| Piece                   | File                                                                                                            | What it does                                                                                                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Selector parser         | `src/lib/partial-component.tsx`                                                                                 | `parseSelector(input: string \| string[]): {uniqueTokens: string[], sharedTokens: string[]}`. Throws on unprefixed tokens. Used by `<Partial>` body and by the client-side refetch dispatcher. |
| `resolveEffectiveId`    | `src/lib/partial-component.tsx`                                                                                 | Rewritten: single `#` → that token; multiple `#` → sorted-join; zero `#` → `__anon:<sorted-classes>`.                                                                                          |
| Duplicate check         | `src/lib/partial-component.tsx`                                                                                 | Walks every `#`-token against `state.seenUniqueTokens` (currently `state.seenIds`). Renames state set.                                                                                         |
| Refetch dispatcher      | `src/lib/partial-client.tsx`                                                                                    | `enqueueRefetch({selector})` parses once, splits into `ids` / `tags`, uses existing wire params.                                                                                               |
| Action invalidation     | `src/framework/entry.rsc.tsx`                                                                                   | Replace legacy shapes. New parser handles `{invalidate: {selector}}` only.                                                                                                                     |
| Registry snapshot shape | `src/lib/partial-registry.ts`                                                                                   | Store `uniqueTokens[]` + `sharedTokens[]` instead of `tags[]`. `resolveTagsToIds` becomes `resolveSelectorToIds` (matches unique OR shared).                                                   |
| Cache base key          | `src/lib/cache.tsx:620`                                                                                         | Use `effectiveId` (same derivation as the Partial body) instead of raw id.                                                                                                                     |
| Frame refetch           | `src/lib/partial-client.tsx`                                                                                    | Drop the `partials=<frameName>` param from frame dispatch; rely on `__frame` + `__frameUrl` alone. Frame scope filtering in `FrameWrapper` already re-renders the subtree.                     |
| Error messages          | everywhere that throws today                                                                                    | Reference `#`/`.` in the message, not id/tag.                                                                                                                                                  |
| Tests                   | `src/lib/__tests__/partial.test.tsx`, `e2e/*`                                                                   | Mechanical: rewrite all `id="…"` / `tags="…"` to selectors; rewrite `reload({ids                                                                                                               | tags})`to`reload({selector})`. |
| Demo pages              | `src/app/**/*.tsx`                                                                                              | Same rewrite. Commit in the same PR.                                                                                                                                                           |
| Docs                    | `CLAUDE.md`, `notes/README.md`, `notes/NAVIGATE_UNIFIED.md`, `notes/FRAMES.md`, `notes/PARTIAL_ARCHITECTURE.md` | Rewrite the `<Partial>` and `reload` examples; add `selector` to the top-level API summary; cross-link this note.                                                                              |

## Open questions (follow-ups, not first-pass)

1. **Should `cache`-backed Partials require a `#`-token?** A cache entry without a stable name is keyed by its anon-synthesized `__anon:<sorted-classes>` id. Legal today, legal under selectors. Worth flagging in dev if a `cache={...}` Partial has no `#`-token (silent stability bug risk), but not a hard error.
2. **Template-literal type for `selector`?** `type Selector = \`${"#" | "."}${string}\`` on a single token, extended to a space-separated list. Possible but fiddly; could land as a follow-up after the runtime parser settles.
