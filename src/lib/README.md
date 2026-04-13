# Proxy Data Layer — Library

Backend-agnostic GraphQL data layer for React Server Components. Instead of writing queries, components access properties on proxy objects. The library records access patterns, compiles them into GraphQL queries, fetches data, and renders with real values.

## Core API

### `resolve(getSchema, execute, renderFn)`

The primary entry point. Pass a schema source, a query executor, and a render function that receives a query root proxy.

```tsx
import { resolve, fetchSchema } from "./lib";

const getSchema = () => fetchSchema("https://beta.pokeapi.co/graphql/v1beta");
const execute = async (query: string) => {
  const res = await fetch("https://beta.pokeapi.co/graphql/v1beta", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  return (await res.json()).data;
};

// Single query — just access fields on the query root
resolve(getSchema, execute, (q) => {
  const pokemon = q.pokemon_v2_pokemon({ limit: 12, order_by: raw("{id: asc}") });
  return pokemon.map(p => <Card name={p.name.value} />);
});

// Multi-query — access multiple root fields
resolve(getSchema, execute, (q) => {
  const products = q.products({ filter: {}, pageSize: 12 }).items;
  const cart = q.cart({ cart_id: id });
  return <>
    <ProductGrid products={products} />
    <CartDrawer cart={cart} />
  </>;
});
```

### `resolveData(getSchema, execute, accessFn)`

Data-only mode — returns `{ data, query }` without rendering. Touch fields in the access function to define the query shape.

Returns `{ data, query }` instead of the bare proxy because proxies are thenable — `await proxy` would unwrap it.

```tsx
const { data, query } = await resolveData(getSchema, execute, (q) => {
  q.products({ filter: {} }).items.map(p => { p.name.value; p.sku.value; });
});
```

### `getQueryRoot()`

Access the current query root proxy from anywhere in the component tree (via AsyncLocalStorage). Works during both discovery and data passes.

```tsx
function CartPartial() {
  const q = getQueryRoot();
  return <span>{q.cart({ cart_id }).total_quantity.value}</span>;
}
```

## The `.value` Accessor

Every property access on a proxy returns another proxy. `.value` is the explicit unwrap point that returns the actual data (or a mock during discovery).

```tsx
pokemon.name;       // → Proxy (not yet unwrapped)
pokemon.name.value; // → "bulbasaur" (actual string)
pokemon.id.value;   // → 1
```

### Schema-Aware `.value`

When a GraphQL type has a field literally named `value` (e.g., Magento's `Money.value`), the proxy traverses to that field instead of unwrapping. Use `.$value` as an escape hatch to force unwrap.

```tsx
// Magento Money type has { value: Float, currency: String }
product.price_range.minimum_price.regular_price.value.value;
//      ^-- traverses to Money.value ------^      ^-- unwraps the scalar
```

### Thenable Proxies

Every proxy is thenable — `use(proxy)` works with React's `use()` hook for Suspense integration.

## Partial Architecture

Pages are flat lists of independently re-renderable partials. Inspired by Shopify's section rendering model.

### Namespace (required)

Every `<Partials>` must have a `namespace` prop. The namespace prefixes partial IDs to avoid collisions between nested instances.

```tsx
import { Partials } from "./lib";

<Partials namespace="pokemon">
  <HeroPartial key="hero" pokemonId={1} />
  <StatsPartial key="stats" pokemonId={1} />
</Partials>
```

The `key` of each child is its partial ID. Keyless elements like `<main>` and `<footer>` are structural wrappers — preserved in layout but transparent to the partial system.

### Partial Filtering

`Partials` reads `?partials=` from the request URL and filters children:

- Full page render: all partials render
- `?partials=pokemon/hero`: only `hero` renders in the `pokemon` namespace
- Unmatched namespace: pass-through (renders enough for inner instances to execute)

### Tags and Cache

Partials can declare tags and cache TTL via reserved props:

```tsx
<CartBadge key="cart" tags={["cart"]} cache={60} />
```

- `tags` — group partials for bulk invalidation
- `cache` — server-side data cache TTL in seconds (keyed by compiled GraphQL query)

Use the `PartialProps<T>` type to allow these on your component:

```tsx
function CartBadge(props: PartialProps<{ quantity: number }>) { ... }
```

### `usePartial(id)` — Client-Side Refetch

```tsx
"use client";
import { usePartial } from "./lib";

function RefreshButton() {
  const stats = usePartial("stats");

  return (
    <button onClick={() => stats.refetch()} disabled={stats.isPending}>
      {stats.isPending ? "Refreshing..." : "Refresh Stats"}
    </button>
  );
}
```

Returns `{ refetch, isPending }`:
- `refetch()` — invalidation: re-render with current props
- `refetch({ query: "bulbasaur" })` — re-render with overridden props (via `__inputs`)

The hook reads the namespace from context — component authors never write the namespace prefix.

### Server Action Invalidation

Server actions return invalidation instructions. Prefer tags over IDs — tags are namespace-agnostic:

```ts
"use server";

export async function addToCart(sku: string, quantity: number) {
  await executeMutation(`mutation { addProductsToCart(...) { ... } }`);
  // By tag (preferred — namespace-agnostic)
  return { invalidate: { tags: ["cart"] } };
}
```

Other invalidation forms:
```ts
// By ID (must include namespace prefix)
return { invalidate: ["magento/cart"] };
// Mixed
return { invalidate: { ids: ["layout/nav"], tags: ["cart"] } };
```

### Nesting Partials

Partials instances can be nested. The outer instance wraps the page shell, the inner wraps page-specific content:

```tsx
<Partials namespace="layout">
  <head key="head">...</head>
  <nav key="nav">...</nav>
  <PokemonPage key="page" />  {/* contains inner <Partials namespace="pokemon"> */}
</Partials>
```

When `?partials=pokemon/hero` is requested, the outer instance passes through (no matching IDs) while the inner instance filters to just `hero`.

## How It Works

1. **Discovery.** Creates a phantom proxy with mock values, runs the render function. Property accesses are recorded.
2. **Compile.** The access tree compiles into a GraphQL query.
3. **Fetch.** The query runs against the backend.
4. **Render.** The render function runs again with data-backed proxies. Same code, real values.

## Exports

```ts
// Core proxy + schema
export { SchemaGraph, fetchSchema } from "./schema";
export { AccessRecorder } from "./access-recorder";
export { compileQuery, compileSelectionSet, raw } from "./query-compiler";
export { createProxy } from "./proxy-node";
export { renderForDiscovery } from "./discovery";

// Primary resolve API
export { resolve, resolveData, getQueryRoot, type ResolveMeta } from "./resolve";

// Partial architecture
export { Partials, type PartialProps } from "./partial";
export { PartialsClient, getCachedPartialIds, usePartial, type PartialDebugEntry } from "./partial-client";
export { PartialErrorBoundary } from "./partial-error-boundary";

// Caching
export { invalidateByTags, clearCache, getCacheStats } from "./partial-cache";

// Lower-level orchestrator
export { orchestrate, createLazyProxy, clearPatternCache, getPatternCache, type QueryConfig } from "./orchestrator";
```
