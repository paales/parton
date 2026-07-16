# `@parton/framework/graphql`

The GraphQL data layer. One `graphqlBackend(...)` call per backend binds
the client, the [gql.tada](https://gql.tada.rs) tag, and the cell
constructors — fully typed end-to-end. Your app depends only on
`@parton/framework`; gql.tada and graphql-request live under the
framework.

Follow these steps to wire a typed GraphQL backend for an endpoint
`$URL`, from zero.

## 1. Generate the introspection

From your app workspace (the one whose `src/app/` holds your pages):

```bash
yarn parton gql $URL --name $NAME
```

Example:

```bash
yarn parton gql https://beta.pokeapi.co/graphql/v1beta --name pokeapi
```

This fetches the endpoint's schema and writes
**`src/app/$NAME-env.d.ts`** — the introspection types your backend
module imports. It is machine-generated (matched by `.prettierignore`'s
`**/*-env.d.ts`, so Prettier leaves it alone); re-run the command to
refresh it when the schema changes.

Options:

| Flag                    | Effect                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `--name <name>`         | Backend name — names the env file and the scaffold. Defaults to the endpoint host's registrable label. |
| `--dir <dir>`           | Output directory. Default `src/app`.                                                                   |
| `--header "Key: Value"` | Auth header for the introspection fetch. Repeatable.                                                   |
| `--scaffold`            | Also write `src/app/$NAME.ts` (the backend module below) if absent.                                    |

## 2. Write the backend module

Create **`src/app/$NAME.ts`** (or pass `--scaffold` in step 1 to have it
written for you):

```ts
import { graphqlBackend } from "@parton/framework/graphql"
import type { introspection } from "./pokeapi-env.d.ts"

export const POKEAPI_ENDPOINT = "https://beta.pokeapi.co/graphql/v1beta"

export const pokeapi = graphqlBackend<{
  introspection: introspection
  // Map the endpoint's custom scalars to TS types (see step 5). Built-in
  // scalars (Int/String/Boolean/…) are inferred — leave them out.
  scalars: {}
}>({ endpoint: POKEAPI_ENDPOINT })

// The tag + client, for mutations and direct `client.request(doc)` reads:
export const { graphql, client } = pokeapi
export { readFragment } from "@parton/framework/graphql"
export type { ResultOf, FragmentOf, VariablesOf } from "@parton/framework/graphql"
```

`graphqlBackend<Setup>(config)` mirrors gql.tada's
`initGraphQLTada<Setup>()`: `Setup` is `{ introspection; scalars }`.
It returns:

| Member          | Use                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------- |
| `query`         | Build a cell from a query string. Wire id auto-derives from the operation name.                   |
| `fragment`      | Build an identity-keyed fragment cell from a fragment string.                                     |
| `graphql`       | The gql.tada tag — for mutations and direct queries. Typed end-to-end.                            |
| `client`        | The executing client. `client.request(doc, vars)`.                                                |
| `runQuery`      | Run a typed query, auto-hydrating fragment-cell spreads. For custom `localCell` loaders.          |
| `withClient(c)` | The same backend (tag + prefix) over a different client — a second endpoint, or a wrapped client. |

`config` takes `{ endpoint }` (the client is built for you) **or**
`{ client }` (you built it — wrap it, point it elsewhere). `prefix`
namespaces every cell's wire id (`"magento"` → `magento.cart`).

## 3. Build cells and queries

Cells are the unit — GraphQL-backed state that crosses Flight to
clients. Module-scope your queries; the raw `graphql()` call stays
hidden.

```ts
// src/app/pages/pokemon-cells.ts
import { pokeapi } from "../pokeapi.ts"

// A query cell — `.with(args)` is typed from the query's variables.
export const heroCell = pokeapi.query(`
  query PokemonHero($id: Int!) {
    pokemon_v2_pokemon(where: { id: { _eq: $id } }, limit: 1) { id name }
  }
`) // wire id → "pokemon-hero"

// A fragment cell — identity-keyed, auto-hydrated where a query spreads it.
export const cardCell = pokeapi.fragment(`
  fragment PokemonCard on pokemon_v2_pokemon { id name }
`) // key defaults to (d) => ({ id: d.id })

// A query that COMPOSES the fragment — pass the CELL, never a raw doc.
export const listCell = pokeapi.query(
  `
    query PokemonList($limit: Int!) {
      pokemon_v2_pokemon(limit: $limit, order_by: { id: asc }) { ...PokemonCard }
    }
  `,
  [cardCell],
)
```

Resolve a cell in a parton body, or bind it as a JSX prop — see
[`docs/reference/cells.md`](../../../docs/reference/cells.md).

### Mutations and direct queries

Use the `graphql` tag + `client` directly:

```ts
"use server"
import { client, graphql } from "../magento.ts"

const AddToCart = graphql(`
  mutation AddToCart($cartId: String!, $sku: String!) {
    addProductsToCart(cartId: $cartId, cartItems: [{ sku: $sku, quantity: 1 }]) {
      cart {
        total_quantity
      }
    }
  }
`)

export async function addToCart(cartId: string, sku: string) {
  const data = await client.request(AddToCart, { cartId, sku })
  return data.addProductsToCart?.cart.total_quantity ?? 0
}
```

Infer types from any document with the re-exported helpers:
`ResultOf<typeof AddToCart>`, `VariablesOf<…>`, `FragmentOf<…>`, and
`readFragment(fragment, maskedRef)`.

## 4. Custom scalars

gql.tada infers built-in scalars. Map an endpoint's **custom** scalars
to TS types in `Setup["scalars"]`:

```ts
export const magento = graphqlBackend<{
  introspection: introspection
  scalars: {
    DateTime: string
    Date: string
  }
}>({ endpoint: MAGENTO_ENDPOINT, prefix: "magento" })
```

An unmapped custom scalar resolves to `unknown`.

## 5. A second backend

Repeat steps 1–2 with a new `$NAME`. Give it a `prefix` so cell wire ids
never collide:

```bash
yarn parton gql https://graphcommerce.vercel.app/api/graphql --name magento
```

```ts
// src/app/magento.ts
import { graphqlBackend } from "@parton/framework/graphql"
import type { introspection } from "./magento-env.d.ts"

export const MAGENTO_ENDPOINT = "https://graphcommerce.vercel.app/api/graphql"

export const magento = graphqlBackend<{
  introspection: introspection
  scalars: { DateTime: string; Date: string }
}>({ endpoint: MAGENTO_ENDPOINT, prefix: "magento" })

export const { graphql, client } = magento
```

Two backends never share a document (one schema per document).

### A second client, same backend

When one backend needs two clients — a live endpoint plus a
record/replay or read-only variant — build the extra client and derive a
cell builder with `withClient`. Both share the tag and `prefix`:

```ts
export const magento = graphqlBackend<{ introspection; scalars: {} }>({
  client: liveClient,
  prefix: "magento",
})
export const magentoCatalog = magento.withClient(cachedClient)
// magentoCatalog.query(...) → cells with the same `magento.` id prefix
```

## Editor support (optional)

For inline GraphQL validation and autocomplete in your query strings,
add gql.tada's language-service plugin to your app `tsconfig.json`
(it resolves through the framework — no app dependency needed):

```jsonc
{
  "compilerOptions": {
    "plugins": [
      {
        "name": "gql.tada/ts-plugin",
        "schemas": [
          {
            "name": "pokeapi",
            "schema": "$URL",
            "tadaOutputLocation": "./src/app/pokeapi-env.d.ts",
          },
        ],
      },
    ],
  },
}
```

This is editor-only — `tsc` and the build ignore it.
