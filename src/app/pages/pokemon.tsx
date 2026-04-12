import { raw } from "../../lib/query-compiler.ts";
import { SectionList } from "../../lib/section.tsx";
import { SectionControls } from "../components/section-controls.tsx";
import {
  SearchToggle,
  SearchInput,
  SearchDialog,
} from "../components/search.tsx";
import { LoadMore, PageSentinel } from "../components/load-more.tsx";
import { getSchema, execute } from "../data.ts";
import {
  getQueryRoot,
  getQueryMeta,
  getRequest,
} from "../../framework/context.ts";

const PAGE_SIZE = 12;

export function PokemonPage() {
  const url = new URL(getRequest().url);
  const pokemonMatch = url.pathname.match(/^\/pokemon\/(\d+)$/);
  const pokemonId = pokemonMatch ? Number(pokemonMatch[1]) : undefined;
  const searchOpen = url.searchParams.has("search");
  const searchQuery = url.searchParams.get("q") ?? "";
  const pages = Math.max(1, Number(url.searchParams.get("pages")) || 1);
  // Generate page sections for the list view
  const pageSections =
    pokemonId == null
      ? Array.from({ length: pages }, (_, i) => (
          <PokemonListPage
            key={`page-${i + 1}`}
            offset={i * PAGE_SIZE}
            isFirst={i === 0}
          />
        ))
      : [];

  return (
    <SectionList getSchema={getSchema} execute={execute}>
      <header key="header">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span style={{ color: "#888", fontSize: "0.85rem" }}>
            {new Date().toLocaleString()}
          </span>
          <SearchToggle isOpen={searchOpen} />
        </div>
        {pokemonId != null && <SectionControls />}
      </header>
      {searchOpen && <SearchOverlay key="search" query={searchQuery} />}
      {pokemonId != null
        ? [
            <HeroSection key="hero" pokemonId={pokemonId} />,
            <StatsSection key="stats" pokemonId={pokemonId} />,
            <SpeciesSection key="species" pokemonId={pokemonId} />,
          ]
        : [...pageSections, <LoadMore key="load-more" nextPage={pages + 1} />]}
      <QueryDebug key="debug" />
    </SectionList>
  );
}

function SearchOverlay({ query }: { query: string }) {
  const q = getQueryRoot();

  const pokemonList = query
    ? q.pokemon_v2_pokemon({
        where: raw(`{name: {_ilike: "%${query}%"}}`),
        limit: 20,
        order_by: raw("{id: asc}"),
      })
    : [];

  const results = (pokemonList as any[]).map((pokemon: any) => {
    const id = pokemon.id.value;
    const name = pokemon.name.value as string;
    const sprites = pokemon.pokemon_v2_pokemonsprites.map(
      (s: any) => s.sprites.value,
    );
    const types = pokemon.pokemon_v2_pokemontypes.map(
      (t: any) => t.pokemon_v2_type.name.value as string,
    );
    const spriteUrl =
      sprites[0]?.other?.["official-artwork"]?.front_default ??
      sprites[0]?.front_default ??
      null;
    return { id, name, spriteUrl, types: types as string[] };
  });

  return (
    <SearchDialog open>
      <SearchInput query={query} />
      {query ? (
        results.length > 0 ? (
          <div className="grid" style={{ marginTop: "1rem" }}>
            {results.map((r) => (
              <a
                key={r.id}
                href={`/pokemon/${r.id}`}
                className="card"
                style={{ display: "block" }}
              >
                {r.spriteUrl && (
                  <img
                    src={r.spriteUrl}
                    alt={r.name}
                    style={{
                      width: 64,
                      height: 64,
                      imageRendering: "auto" as const,
                    }}
                  />
                )}
                <h2
                  style={{
                    textTransform: "capitalize" as const,
                    fontSize: "1rem",
                  }}
                >
                  #{r.id} {r.name}
                </h2>
                <div style={{ marginTop: "0.25rem" }}>
                  {r.types.map((t) => (
                    <span
                      key={t}
                      className={`badge badge-${t || "default"}`}
                      style={{ fontSize: "0.7rem" }}
                    >
                      {t}
                    </span>
                  ))}
                </div>
              </a>
            ))}
          </div>
        ) : (
          <p style={{ color: "#888", marginTop: "1rem" }}>
            No pokemon found matching "{query}"
          </p>
        )
      ) : (
        <p style={{ color: "#666", marginTop: "1rem", fontSize: "0.85rem" }}>
          Start typing to search...
        </p>
      )}
    </SearchDialog>
  );
}

function PokemonListPage({
  offset,
  isFirst,
}: {
  offset: number;
  isFirst: boolean;
}) {
  const page = offset / PAGE_SIZE + 1;
  const q = getQueryRoot();
  const pokemonList = q.pokemon_v2_pokemon({
    limit: PAGE_SIZE,
    offset,
    order_by: raw("{id: asc}"),
  });
  return (
    <div>
      <PageSentinel page={page} />
      {isFirst && (
        <>
          <h1>Pokedex — Proxy Data Layer PoC</h1>
          <p style={{ color: "#888", marginBottom: "1.5rem" }}>
            Each card below was rendered by a component that just accesses{" "}
            <code
              style={{
                background: "#2d3748",
                padding: "0.15rem 0.4rem",
                borderRadius: 4,
              }}
            >
              pokemon.name.value
            </code>{" "}
            — the query was generated automatically from those access patterns.
          </p>
        </>
      )}
      <div className="grid">
        {pokemonList.map((pokemon: any) => (
          <PokemonCard key={pokemon.id.value} pokemon={pokemon} />
        ))}
      </div>
    </div>
  );
}

function PokemonCard({ pokemon }: { pokemon: any }) {
  const id = pokemon.id.value;
  const name = pokemon.name.value as string;
  const sprites = pokemon.pokemon_v2_pokemonsprites.map(
    (s: any) => s.sprites.value,
  );
  const types = pokemon.pokemon_v2_pokemontypes.map(
    (t: any) => t.pokemon_v2_type.name.value as string,
  );

  const spriteUrl =
    sprites[0]?.other?.["official-artwork"]?.front_default ??
    sprites[0]?.front_default ??
    null;

  return (
    <a href={`/pokemon/${id}`} className="card" style={{ display: "block" }}>
      {spriteUrl && (
        <img
          src={spriteUrl}
          alt={name}
          style={{ width: 96, height: 96, imageRendering: "auto" as const }}
        />
      )}
      <h2 style={{ textTransform: "capitalize" as const }}>
        #{id} {name}
      </h2>
      <div style={{ marginTop: "0.5rem" }}>
        {(types as string[]).map((t) => (
          <span key={t} className={`badge badge-${t || "default"}`}>
            {t}
          </span>
        ))}
      </div>
    </a>
  );
}

function HeroSection({ pokemonId }: { pokemonId: number }) {
  const q = getQueryRoot();
  const pokemon = q.pokemon_v2_pokemon({
    where: raw(`{id: {_eq: ${pokemonId}}}`),
    limit: 1,
  })[0];
  const id = pokemon.id.value;
  const name = pokemon.name.value as string;
  const height = pokemon.height.value as number;
  const weight = pokemon.weight.value as number;
  const sprites = pokemon.pokemon_v2_pokemonsprites.map(
    (s: any) => s.sprites.value,
  );
  const types = pokemon.pokemon_v2_pokemontypes.map((t: any) => ({
    slot: t.slot.value as number,
    name: t.pokemon_v2_type.name.value as string,
  }));

  const spriteUrl =
    sprites[0]?.other?.["official-artwork"]?.front_default ??
    sprites[0]?.front_default;

  return (
    <div
      className="card"
      style={{ display: "flex", gap: "2rem", alignItems: "center" }}
    >
      {spriteUrl && (
        <img src={spriteUrl} alt={name} style={{ width: 200, height: 200 }} />
      )}
      <div>
        <h1 style={{ textTransform: "capitalize" as const, fontSize: "2rem" }}>
          #{id} {name}
        </h1>
        <div style={{ marginTop: "0.75rem" }}>
          {types.map((t: { slot: number; name: string }) => (
            <span key={t.slot} className={`badge badge-${t.name || "default"}`}>
              {t.name}
            </span>
          ))}
        </div>
        <div className="meta" style={{ marginTop: "1rem" }}>
          Height: {height / 10}m · Weight: {weight / 10}kg
        </div>
      </div>
    </div>
  );
}

function StatsSection({ pokemonId }: { pokemonId: number }) {
  const q = getQueryRoot();
  const pokemon = q.pokemon_v2_pokemon({
    where: raw(`{id: {_eq: ${pokemonId}}}`),
    limit: 1,
  })[0];
  const stats = pokemon.pokemon_v2_pokemonstats.map((s: any) => ({
    name: s.pokemon_v2_stat.name.value as string,
    value: s.base_stat.value as number,
  }));

  const maxStat = 255;

  return (
    <div className="card">
      <h2>Base Stats</h2>
      <div style={{ marginTop: "0.75rem" }}>
        {(stats as Array<{ name: string; value: number }>).map((stat) => (
          <div
            key={stat.name}
            style={{
              display: "flex",
              alignItems: "center",
              marginBottom: "0.5rem",
              gap: "0.75rem",
            }}
          >
            <span
              style={{
                width: 120,
                fontSize: "0.85rem",
                textTransform: "capitalize" as const,
                color: "#aaa",
              }}
            >
              {stat.name.replace("-", " ")}
            </span>
            <span
              style={{
                width: 35,
                fontSize: "0.85rem",
                textAlign: "right" as const,
              }}
            >
              {stat.value}
            </span>
            <div
              style={{
                flex: 1,
                height: 8,
                background: "#2d3748",
                borderRadius: 4,
                overflow: "hidden" as const,
              }}
            >
              <div
                style={{
                  width: `${(stat.value / maxStat) * 100}%`,
                  height: "100%",
                  background:
                    stat.value >= 100
                      ? "#48bb78"
                      : stat.value >= 60
                        ? "#ecc94b"
                        : "#f56565",
                  borderRadius: 4,
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SpeciesSection({ pokemonId }: { pokemonId: number }) {
  const q = getQueryRoot();
  const pokemon = q.pokemon_v2_pokemon({
    where: raw(`{id: {_eq: ${pokemonId}}}`),
    limit: 1,
  })[0];
  const species = pokemon.pokemon_v2_pokemonspecy;
  const speciesName = species.name.value as string;
  const happiness = species.base_happiness.value;
  const captureRate = species.capture_rate.value;
  const generation = species.pokemon_v2_generation.name.value;
  const flavorTexts = species.pokemon_v2_pokemonspeciesflavortexts.map(
    (ft: any) => ({
      text: ft.flavor_text.value as string,
      language: ft.pokemon_v2_language.name.value as string,
    }),
  );

  const englishEntry = (
    flavorTexts as Array<{ text: string; language: string }>
  ).find((ft) => ft.language === "en");

  return (
    <div className="card">
      <h2 style={{ textTransform: "capitalize" as const }}>
        Species: {speciesName}
      </h2>
      {englishEntry && (
        <p style={{ marginTop: "0.75rem", lineHeight: 1.6, color: "#ccc" }}>
          {englishEntry.text.replace(/\f|\n/g, " ")}
        </p>
      )}
      <div className="meta" style={{ marginTop: "1rem" }}>
        Generation: <code>{generation}</code> · Base Happiness:{" "}
        <code>{happiness}</code> · Capture Rate: <code>{captureRate}</code>
      </div>
    </div>
  );
}

function QueryDebug() {
  const meta = getQueryMeta();
  return (
    <details className="query-debug">
      <summary
        style={{ cursor: "pointer", color: "#888", fontSize: "0.85rem" }}
      >
        Generated GraphQL Query (auto-compiled from proxy access patterns)
      </summary>
      <pre>{meta.query}</pre>
    </details>
  );
}
