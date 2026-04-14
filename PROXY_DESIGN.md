# Proxy Data Layer — Legacy Design

> **Status: Legacy.** This design is preserved for reference. The application no longer uses the proxy data layer — components write GraphQL queries directly and fetch them with `graphql-request` (see `CLAUDE.md`). The proxy implementation still exists in `src/lib/` (`resolve.ts`, `proxy-node.ts`, `access-recorder.ts`, `query-compiler.ts`, `discovery.ts`, `schema.ts`) but has zero call sites in `src/app/`.

## Thesis

Data resolution strategy should be a property of the data, not the component.

## How it works

Schema-aware JavaScript Proxies record property accesses during a phantom render, compile them into GraphQL queries, fetch data, and re-render with real values. Components never write queries.

```
Discovery (phantom proxy) → Compile (access tree → GraphQL) → Fetch → Render (data proxies)
```

## Key API: `resolve()`

The render function receives a **query root proxy**. Accessing fields on it — including with arguments — defines the GraphQL query automatically. No config objects, no rootField, no selectionPath.

```tsx
// Single query
resolve((q) => {
  const pokemon = q.pokemon_v2_pokemon({ limit: 12, order_by: raw("{id: asc}") });
  return pokemon.map(p => <Card name={p.name.value} />);
});

// Multi-query — just access multiple root fields
resolve((q) => {
  const products = q.products({ filter: {}, pageSize: 12 }).items;
  const cart = q.cart({ cart_id: id });
  return <>
    <ProductGrid products={products} />
    <CartDrawer cart={cart} />
  </>;
});

// Data-only mode (returns { data, query })
const { data } = await resolve.data((q) => {
  q.products({ filter: {} }).items.map(p => { p.name.value; p.sku.value; });
});
```

`resolve.data` returns `{ data, query }` (not the bare proxy) because proxies are thenable — `await proxy` would unwrap it.

## Key Conventions

### `.value` accessor
Every proxy field returns another proxy. `.value` unwraps to the actual value.
- `.value` is **schema-aware**: if the type has a real field called `value` (e.g., Magento `Money.value`), it traverses. Otherwise it unwraps.
- `.$value` — escape hatch to force unwrap when type has a `value` field.
- Every proxy is thenable — `use(proxy)` works with React's `use()` hook.

### `__typename` injection
The query compiler automatically injects `__typename` into every object selection. The proxy uses `__typename` from response data to resolve concrete types at runtime (e.g., `ConfigurableProduct` from `ProductInterface`).

### Backend-agnostic
The library works with any GraphQL schema. The schema introspection discovers the query root type name automatically (e.g., `query_root` for Hasura, `Query` for standard GraphQL).
