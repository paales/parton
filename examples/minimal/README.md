# @parton/example-minimal

The smallest possible parton app — three thin entry files delegating
to the framework's entry factories, and one page demonstrating the
core mental model: a `parton` with a tracked read (`searchParam`), a
cell (`localCell`) holding server-owned state, and a plain
`"use server"` function that writes it.

```
src/entry.rsc.tsx      the RSC request handler
src/entry.ssr.tsx       HTML rendering
src/entry.browser.tsx   hydration + client runtime
src/app/root.tsx        the html shell + the one demo parton
src/app/greeting-state.ts    the cell
src/app/greeting-actions.ts  the "use server" write
src/app/greeting-form.tsx    the "use client" input
```

## Running it

From the repo root:

```bash
yarn install
yarn dev:minimal
```

Open `http://localhost:5177`. Try `http://localhost:5177/?name=you` —
the greeting line updates from a tracked `searchParam` read. Type into
the form and save — that round-trips through a server-owned cell.

## Next steps

This example is deliberately bare: no CMS, no GraphQL, no slots. For
the full picture, read
[`docs/reference/intro.md`](../../docs/reference/intro.md) and work
through the rest of `docs/reference/` — `partial.md`, `block.md`,
`cells.md`, `cache.md`, `cms.md`, `frames-navigation.md`,
`remote-frame.md`.
