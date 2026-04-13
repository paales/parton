import React from "react";
import { describe, expect, it, vi } from "vitest";
import { Partials } from "../partial.tsx";
import { runWithRequestAsync, getQueryRoot } from "../../framework/context.ts";

vi.mock("../partial-client.tsx", () => ({
	PartialsClient: ({ children }: { children: React.ReactNode }) => children,
}));

import { fetchSchema, type SchemaGraph } from "../schema.ts";

const POKEAPI_ENDPOINT = "https://beta.pokeapi.co/graphql/v1beta";

async function executeQuery<T>(query: string): Promise<T> {
	const response = await fetch(POKEAPI_ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ query }),
	});
	return ((await response.json()) as { data: T }).data;
}

let schema: SchemaGraph;
const getSchema = async () => (schema ??= await fetchSchema(POKEAPI_ENDPOINT));

function NamePartial() {
	const q = getQueryRoot();
	const pokemon = q.pokemon_v2_pokemon({ limit: 1 })[0];
	return <h1>{pokemon.name.value}</h1>;
}

function HeightPartial() {
	const q = getQueryRoot();
	const pokemon = q.pokemon_v2_pokemon({ limit: 1 })[0];
	return <span>{pokemon.height.value}</span>;
}

describe("Partials + resolve() integration", { timeout: 15000 }, () => {
	it("renders all partials when no filter", async () => {
		const { result } = await runWithRequestAsync(
			new Request("http://localhost/test"),
			async () =>
				Partials({
					namespace: "pokemon",
					getSchema,
					execute: executeQuery,
					children: [
						<NamePartial key="name" />,
						<HeightPartial key="height" />,
					],
				}),
		);
		const str = JSON.stringify(result);
		expect(str).toContain("name");
		expect(str).toContain("height");
	});

	it("filters to requested partials", async () => {
		const { result } = await runWithRequestAsync(
			new Request("http://localhost/test?partials=pokemon/name"),
			async () =>
				Partials({
					namespace: "pokemon",
					getSchema,
					execute: executeQuery,
					children: [
						<NamePartial key="name" />,
						<HeightPartial key="height" />,
					],
				}),
		);
		const str = JSON.stringify(result);
		expect(str).toContain('"name"');
	});
});
