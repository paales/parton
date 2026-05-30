/**
 * Pokemon cells — every PokeAPI read flows through a gqlCell built by
 * the per-backend `pokemonQuery` constructor. Storage caches per args;
 * effectively-immutable data so no TTL. Each cell's wire id auto-derives
 * from its operation name (`query PokemonHero` → `pokemon-hero`).
 *
 * `pokemonHero / Stats / Species` — placement-bound per id from
 * the detail page.
 *
 * `pokemonList` — placement-bound per page (limit/offset). One
 * cell instance, 10 partitions for the 10 list pages.
 *
 * `pokemonSearch` — placement-bound per (pattern, offset, limit).
 * Each search Stage binds different offsets.
 */

import { gqlCellBuilder } from "@parton/framework"
import { client } from "../data.ts"
import { graphql } from "../pokeapi-graphql.ts"

const pokemonQuery = gqlCellBuilder({ client, graphql })

export const pokemonHeroCell = pokemonQuery(`
  query PokemonHero($id: Int!) {
    pokemon_v2_pokemon(where: { id: { _eq: $id } }, limit: 1) {
      id
      name
      height
      weight
      pokemon_v2_pokemonsprites {
        sprites
      }
      pokemon_v2_pokemontypes {
        slot
        pokemon_v2_type {
          name
        }
      }
    }
  }
`)

export const pokemonStatsCell = pokemonQuery(`
  query PokemonStats($id: Int!) {
    pokemon_v2_pokemon(where: { id: { _eq: $id } }, limit: 1) {
      pokemon_v2_pokemonstats {
        base_stat
        pokemon_v2_stat {
          name
        }
      }
    }
  }
`)

export const pokemonSpeciesCell = pokemonQuery(`
  query PokemonSpecies($id: Int!) {
    pokemon_v2_pokemon(where: { id: { _eq: $id } }, limit: 1) {
      pokemon_v2_pokemonspecy {
        name
        base_happiness
        capture_rate
        pokemon_v2_generation {
          name
        }
        pokemon_v2_pokemonspeciesflavortexts(
          where: { pokemon_v2_language: { name: { _eq: "en" } } }
          limit: 1
        ) {
          flavor_text
        }
      }
    }
  }
`)

// ─── List + search cells (shared with pokemon.tsx) ─────────────────────

export const PokemonListFields = graphql(`
  fragment PokemonListFields on pokemon_v2_pokemon {
    id
    name
    pokemon_v2_pokemonsprites {
      sprites
    }
    pokemon_v2_pokemontypes {
      pokemon_v2_type {
        name
      }
    }
  }
`)

export const pokemonListCell = pokemonQuery(
  `
    query PokemonList($limit: Int!, $offset: Int!) {
      pokemon_v2_pokemon(limit: $limit, offset: $offset, order_by: { id: asc }) {
        ...PokemonListFields
      }
    }
  `,
  [PokemonListFields],
)

export const pokemonSearchCell = pokemonQuery(
  `
    query PokemonSearch($pattern: String!, $offset: Int!, $limit: Int!) {
      pokemon_v2_pokemon(
        where: { name: { _ilike: $pattern } }
        limit: $limit
        offset: $offset
        order_by: { id: asc }
      ) {
        ...PokemonListFields
      }
    }
  `,
  [PokemonListFields],
)
