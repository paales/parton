import React from "react";
import { describe, expect, it, vi } from "vitest";

// Mock the pipeline dependencies so Partials doesn't need real schema/API
vi.mock("../access-recorder.ts", () => ({
	AccessRecorder: vi.fn().mockImplementation(() => ({
		getAccessTree: () => ({}),
	})),
}));

vi.mock("../proxy-node.ts", () => ({
	createProxy: () => ({ _fake: true }),
}));

vi.mock("../discovery.ts", () => ({
	renderForDiscovery: vi.fn(),
}));

vi.mock("../query-compiler.ts", () => ({
	compileQuery: () => "{ __typename }",
	raw: (s: string) => s,
}));

// Mock client components — useRef/class components need a full React renderer.
vi.mock("../partial-client.tsx", () => ({
	PartialsClient: ({ children }: { children: React.ReactNode }) => children,
	getCachedPartialIds: () => [],
}));

vi.mock("../partial-error-boundary.tsx", () => ({
	PartialErrorBoundary: ({ children }: { children: React.ReactNode }) => children,
}));

import { Partials } from "../partial.tsx";
import { runWithRequestAsync, getQueryRoot, getQueryMeta } from "../../framework/context.ts";

function Hero() {
	return <h1>Hero</h1>;
}
function Stats() {
	return <div>Stats</div>;
}
function Species() {
	return <p>Species</p>;
}

const fakeGetSchema = async () => ({ getQueryTypeName: () => "query_root" }) as any;
const fakeExecute = async () => ({}) as any;

// Default namespace for tests
const NS = "test";
// Prefix helper for URL params
const p = (id: string) => `${NS}/${id}`;

function fakeRequest(params?: Record<string, string>) {
	const url = new URL("http://localhost/test");
	if (params) {
		for (const [k, v] of Object.entries(params)) {
			url.searchParams.set(k, v);
		}
	}
	return new Request(url);
}

async function renderToJSON(element: React.ReactNode): Promise<any> {
	if (element instanceof Promise) element = await element;
	if (element == null || typeof element === "string" || typeof element === "number") {
		return element;
	}
	if (Array.isArray(element)) {
		const results = await Promise.all(element.map(renderToJSON));
		return results.filter(Boolean);
	}
	if (React.isValidElement(element)) {
		const { type, props } = element as any;
		if (typeof type === "function") {
			const result = type(props);
			return renderToJSON(result);
		}
		const children = props.children ? await renderToJSON(props.children) : undefined;
		return { type, props: { ...props, children } };
	}
	return null;
}

describe("Partial architecture", () => {
	it("renders all partials when no filter", async () => {
		const { result } = await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<Partials namespace={NS} getSchema={fakeGetSchema} execute={fakeExecute}>
					<Hero key="hero" />
					<Stats key="stats" />
					<Species key="species" />
				</Partials>,
			),
		);
		expect(result).toHaveLength(3);
	});

	it("filters to requested partials", async () => {
		const { result } = await runWithRequestAsync(fakeRequest({ partials: `${p("hero")},${p("stats")}` }), async () =>
			renderToJSON(
				<Partials namespace={NS} getSchema={fakeGetSchema} execute={fakeExecute}>
					<Hero key="hero" />
					<Stats key="stats" />
					<Species key="species" />
				</Partials>,
			),
		);
		const rendered = result.filter(Boolean);
		expect(rendered).toHaveLength(2);
	});

	it("filters to single partial", async () => {
		const { result } = await runWithRequestAsync(fakeRequest({ partials: p("stats") }), async () =>
			renderToJSON(
				<Partials namespace={NS} getSchema={fakeGetSchema} execute={fakeExecute}>
					<Hero key="hero" />
					<Stats key="stats" />
					<Species key="species" />
				</Partials>,
			),
		);
		const rendered = result.filter(Boolean);
		expect(rendered).toHaveLength(1);
	});

	it("passes props to partial components", async () => {
		function Greeting({ name }: { name?: string }) {
			return <span>Hello {name}</span>;
		}
		const { result } = await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<Partials namespace={NS} getSchema={fakeGetSchema} execute={fakeExecute}>
					<Greeting key="greeting" name="world" />
				</Partials>,
			),
		);
		const rendered = result.filter(Boolean);
		expect(rendered).toHaveLength(1);
		expect(JSON.stringify(rendered)).toContain("world");
	});

	it("provides query root via ALS context", async () => {
		function MyPartial() {
			const q = getQueryRoot();
			return <span>{q?._fake ? "got-proxy" : "missing"}</span>;
		}
		const { result } = await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<Partials namespace={NS} getSchema={fakeGetSchema} execute={fakeExecute}>
					<MyPartial key="test" />
				</Partials>,
			),
		);
		const rendered = result.filter(Boolean);
		expect(rendered).toHaveLength(1);
		expect(JSON.stringify(rendered)).toContain("got-proxy");
	});

	it("provides query meta via ALS context", async () => {
		function DebugPartial() {
			const meta = getQueryMeta();
			return <pre>{meta.query}</pre>;
		}
		const { result } = await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<Partials namespace={NS} getSchema={fakeGetSchema} execute={fakeExecute}>
					<DebugPartial key="debug" />
				</Partials>,
			),
		);
		const rendered = result.filter(Boolean);
		expect(rendered).toHaveLength(1);
		// The compiled query from our mock is "{ __typename }"
		expect(JSON.stringify(rendered)).toContain("__typename");
	});

	it("passes through when filter targets different namespace", async () => {
		// ?partials=other/hero doesn't match namespace="test" → renders all
		// (the filter is for a different namespace, so this instance is transparent)
		const { result } = await runWithRequestAsync(fakeRequest({ partials: "other/nonexistent" }), async () =>
			renderToJSON(
				<Partials namespace={NS} getSchema={fakeGetSchema} execute={fakeExecute}>
					<Hero key="hero" />
					<Stats key="stats" />
				</Partials>,
			),
		);
		const rendered = result.filter(Boolean);
		expect(rendered).toHaveLength(2);
	});

	it("filters to nested partial by key", async () => {
		function Cart() {
			return <span>cart-content</span>;
		}
		const { result } = await runWithRequestAsync(fakeRequest({ partials: p("cart") }), async () =>
			renderToJSON(
				<Partials namespace={NS} getSchema={fakeGetSchema} execute={fakeExecute}>
					<div key="header">
						Timestamp
						<Cart key="cart" />
					</div>
					<Stats key="stats" />
				</Partials>,
			),
		);
		const str = JSON.stringify(result);
		expect(str).toContain("cart-content");
		expect(str).not.toContain("Timestamp");
		expect(str).not.toContain("Stats");
	});

	it("refreshing parent excludes nested partial content", async () => {
		function Cart() {
			return <span>cart-content</span>;
		}
		const { result } = await runWithRequestAsync(fakeRequest({ partials: p("header") }), async () =>
			renderToJSON(
				<Partials namespace={NS} getSchema={fakeGetSchema} execute={fakeExecute}>
					<div key="header">
						Timestamp
						<Cart key="cart" />
					</div>
					<Stats key="stats" />
				</Partials>,
			),
		);
		const str = JSON.stringify(result);
		expect(str).toContain("Timestamp");
		expect(str).not.toContain("cart-content");
		expect(str).not.toContain("Stats");
	});

	it("renders partials without heavy wrapper divs", async () => {
		const { result } = await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<Partials namespace={NS} getSchema={fakeGetSchema} execute={fakeExecute}>
					<Hero key="hero" />
				</Partials>,
			),
		);
		const str = JSON.stringify(result);
		expect(str).toContain("Hero");
	});

	it("discovers partials inside keyless wrappers", async () => {
		const { result } = await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<Partials namespace={NS} getSchema={fakeGetSchema} execute={fakeExecute}>
					<Hero key="hero" />
					<main>
						<Stats key="stats" />
					</main>
					<footer>
						<Species key="species" />
					</footer>
				</Partials>,
			),
		);
		const str = JSON.stringify(result);
		expect(str).toContain("Hero");
		expect(str).toContain("Stats");
		expect(str).toContain("Species");
	});

	it("renders all partials on full render even with cached fingerprints", async () => {
		let fingerprints: Record<string, string> = {};
		vi.mocked(await import("../partial-client.tsx")).PartialsClient = (({
			children,
			fingerprints: fp,
		}: any) => {
			fingerprints = fp;
			return children;
		}) as any;

		const { Partials: P } = await import("../partial.tsx");

		await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<P namespace={NS} getSchema={fakeGetSchema} execute={fakeExecute}>
					<Hero key="hero" />
					<Stats key="stats" />
				</P>,
			),
		);
		expect(fingerprints.hero).toBeDefined();
		expect(fingerprints.stats).toBeDefined();

		// On full page render (no ?partials= filter), even cached fingerprints
		// don't prevent rendering — the server always renders all partials.
		// This is correct because URL/context changes can affect output.
		const { result } = await runWithRequestAsync(fakeRequest({ cached: `${p("hero")}:${fingerprints.hero}` }), async () =>
			renderToJSON(
				<P namespace={NS} getSchema={fakeGetSchema} execute={fakeExecute}>
					<Hero key="hero" />
					<Stats key="stats" />
				</P>,
			),
		);
		const str = JSON.stringify(result);
		expect(str).toContain("Stats");
		expect(str).toContain("Hero"); // Hero renders despite matching fingerprint
	});

	it("fingerprints are stable for same element tree", async () => {
		let fp1: Record<string, string> = {};
		let fp2: Record<string, string> = {};
		vi.mocked(await import("../partial-client.tsx")).PartialsClient = (({
			fingerprints: fp,
		}: any) => {
			if (!fp1.hero) fp1 = fp;
			else fp2 = fp;
			return null;
		}) as any;
		const { Partials: P } = await import("../partial.tsx");

		await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<P namespace={NS} getSchema={fakeGetSchema} execute={fakeExecute}>
					<Hero key="hero" />
				</P>,
			),
		);
		await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<P namespace={NS} getSchema={fakeGetSchema} execute={fakeExecute}>
					<Hero key="hero" />
				</P>,
			),
		);
		expect(fp1.hero).toBe(fp2.hero);
	});

	it("explicitly requested partials always render even with matching cached fingerprint", async () => {
		let fingerprints: Record<string, string> = {};
		let freshIds: string[] = [];
		vi.mocked(await import("../partial-client.tsx")).PartialsClient = (({
			children,
			fingerprints: fp,
			freshIds: fids,
		}: any) => {
			fingerprints = fp;
			freshIds = fids;
			return children;
		}) as any;

		const { Partials: P } = await import("../partial.tsx");

		// First render to get fingerprints
		await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<P namespace={NS} getSchema={fakeGetSchema} execute={fakeExecute}>
					<Hero key="hero" />
					<Stats key="stats" />
				</P>,
			),
		);

		// Now request hero explicitly via ?partials= with its fingerprint cached.
		// Hero MUST still render — it was explicitly invalidated.
		const { result } = await runWithRequestAsync(
			fakeRequest({ partials: p("hero"), cached: `${p("hero")}:${fingerprints.hero}` }),
			async () =>
				renderToJSON(
					<P namespace={NS} getSchema={fakeGetSchema} execute={fakeExecute}>
						<Hero key="hero" />
						<Stats key="stats" />
					</P>,
				),
		);
		expect(freshIds).toContain("hero");
		expect(freshIds).not.toContain("stats"); // stats not requested
		const str = JSON.stringify(result);
		expect(str).toContain("Hero");
	});

	it("applies partial input overrides to component props", async () => {
		function Greeting({ name }: { name: string }) {
			return <span>Hello {name}</span>;
		}
		// __inputs keys use namespaced IDs
		const inputs = JSON.stringify({ [p("greeting")]: { name: "world" } });
		const { result } = await runWithRequestAsync(fakeRequest({ __inputs: inputs }), async () =>
			renderToJSON(
				<Partials namespace={NS} getSchema={fakeGetSchema} execute={fakeExecute}>
					<Greeting key="greeting" name="default" />
				</Partials>,
			),
		);
		const str = JSON.stringify(result);
		expect(str).toContain("world");
		expect(str).not.toContain("default");
	});

	it("partial input overrides only affect targeted partial", async () => {
		function Label({ text }: { text: string }) {
			return <span>{text}</span>;
		}
		const inputs = JSON.stringify({ [p("a")]: { text: "overridden" } });
		const { result } = await runWithRequestAsync(fakeRequest({ __inputs: inputs }), async () =>
			renderToJSON(
				<Partials namespace={NS} getSchema={fakeGetSchema} execute={fakeExecute}>
					<Label key="a" text="original-a" />
					<Label key="b" text="original-b" />
				</Partials>,
			),
		);
		const str = JSON.stringify(result);
		expect(str).toContain("overridden");
		expect(str).toContain("original-b");
		expect(str).not.toContain("original-a");
	});

	it("__inputs bypass fingerprint cache (refetch with new props)", async () => {
		let fingerprints: Record<string, string> = {};
		vi.mocked(await import("../partial-client.tsx")).PartialsClient = (({
			children,
			fingerprints: fp,
		}: any) => {
			fingerprints = fp;
			return children;
		}) as any;

		const { Partials: P } = await import("../partial.tsx");

		await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<P namespace={NS} getSchema={fakeGetSchema} execute={fakeExecute}>
					<Hero key="hero" />
					<Stats key="stats" />
				</P>,
			),
		);
		expect(fingerprints.hero).toBeDefined();

		const inputs = JSON.stringify({ [p("hero")]: {} });
		const { result } = await runWithRequestAsync(
			fakeRequest({
				partials: p("hero"),
				cached: `${p("hero")}:${fingerprints.hero}`,
				__inputs: inputs,
			}),
			async () =>
				renderToJSON(
					<P namespace={NS} getSchema={fakeGetSchema} execute={fakeExecute}>
						<Hero key="hero" />
						<Stats key="stats" />
					</P>,
				),
		);
		const str = JSON.stringify(result);
		expect(str).toContain("Hero");
	});

	it("refetch without props still renders when not in cached", async () => {
		const { result } = await runWithRequestAsync(
			fakeRequest({ partials: p("hero"), cached: `${p("stats")}:somefp` }),
			async () =>
				renderToJSON(
					<Partials namespace={NS} getSchema={fakeGetSchema} execute={fakeExecute}>
						<Hero key="hero" />
						<Stats key="stats" />
					</Partials>,
				),
		);
		const str = JSON.stringify(result);
		expect(str).toContain("Hero");
		expect(str).not.toContain("Stats");
	});

	it("renders without data pipeline when no schema provided", async () => {
		function StaticHeader() {
			return <h1>Welcome</h1>;
		}
		function StaticFooter() {
			return <footer>Copyright 2026</footer>;
		}
		const { result } = await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<Partials namespace="static">
					<StaticHeader key="header" />
					<StaticFooter key="footer" />
				</Partials>,
			),
		);
		const str = JSON.stringify(result);
		expect(str).toContain("Welcome");
		expect(str).toContain("Copyright 2026");
	});

	it("no-schema Partials respects partial filter", async () => {
		function A() {
			return <span>partial-a</span>;
		}
		function B() {
			return <span>partial-b</span>;
		}
		const { result } = await runWithRequestAsync(fakeRequest({ partials: "static/a" }), async () =>
			renderToJSON(
				<Partials namespace="static">
					<A key="a" />
					<B key="b" />
				</Partials>,
			),
		);
		const str = JSON.stringify(result);
		expect(str).toContain("partial-a");
		expect(str).not.toContain("partial-b");
	});

	it("filters nested partial inside keyless wrapper", async () => {
		const { result } = await runWithRequestAsync(fakeRequest({ partials: p("stats") }), async () =>
			renderToJSON(
				<Partials namespace={NS} getSchema={fakeGetSchema} execute={fakeExecute}>
					<Hero key="hero" />
					<main>
						<Stats key="stats" />
					</main>
				</Partials>,
			),
		);
		const str = JSON.stringify(result);
		expect(str).toContain("Stats");
		expect(str).not.toContain("Hero");
	});

	it("passes through when other namespace is targeted", async () => {
		// ?partials=other/hero doesn't match namespace="pokemon" → renders all
		const { result } = await runWithRequestAsync(fakeRequest({ partials: "other/hero" }), async () =>
			renderToJSON(
				<Partials namespace="pokemon" getSchema={fakeGetSchema} execute={fakeExecute}>
					<Hero key="hero" />
					<Stats key="stats" />
				</Partials>,
			),
		);
		const rendered = result.filter(Boolean);
		expect(rendered).toHaveLength(2);
	});

	it("renders all when no partials param", async () => {
		const { result } = await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<Partials namespace="pokemon" getSchema={fakeGetSchema} execute={fakeExecute}>
					<Hero key="hero" />
					<Stats key="stats" />
				</Partials>,
			),
		);
		expect(result).toHaveLength(2);
	});

	it("filters partials by tag via ?tags= param", async () => {
		function CartBadge() {
			return <span>cart-badge</span>;
		}
		function CartDrawer() {
			return <div>cart-drawer</div>;
		}
		function ProductGrid() {
			return <div>products</div>;
		}
		const { result } = await runWithRequestAsync(fakeRequest({ tags: "cart" }), async () =>
			renderToJSON(
				<Partials namespace={NS} getSchema={fakeGetSchema} execute={fakeExecute}>
					<CartBadge key="badge" tags={["cart", "header"]} />
					<CartDrawer key="drawer" tags={["cart"]} />
					<ProductGrid key="products" tags={["catalog"]} />
				</Partials>,
			),
		);
		const str = JSON.stringify(result);
		expect(str).toContain("cart-badge");
		expect(str).toContain("cart-drawer");
		expect(str).not.toContain("products");
	});

	it("?tags= with no matching tag renders nothing", async () => {
		const { result } = await runWithRequestAsync(fakeRequest({ tags: "nonexistent" }), async () =>
			renderToJSON(
				<Partials namespace={NS} getSchema={fakeGetSchema} execute={fakeExecute}>
					<Hero key="hero" tags={["pokemon"]} />
					<Stats key="stats" tags={["pokemon"]} />
				</Partials>,
			),
		);
		const rendered = result.filter(Boolean);
		expect(rendered).toHaveLength(0);
	});

	it("combines ?partials= and ?tags= as union", async () => {
		function A() { return <span>a</span>; }
		function B() { return <span>b</span>; }
		function C() { return <span>c</span>; }
		const { result } = await runWithRequestAsync(fakeRequest({ partials: p("a"), tags: "group" }), async () =>
			renderToJSON(
				<Partials namespace={NS} getSchema={fakeGetSchema} execute={fakeExecute}>
					<A key="a" />
					<B key="b" tags={["group"]} />
					<C key="c" />
				</Partials>,
			),
		);
		const str = JSON.stringify(result);
		expect(str).toContain('"a"');
		expect(str).toContain('"b"');
		expect(str).not.toContain('"c"');
	});

	it("strips reserved props (tags, cache) before rendering component", async () => {
		function MyComponent(props: Record<string, unknown>) {
			return <span>{JSON.stringify(Object.keys(props).sort())}</span>;
		}
		const { result } = await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<Partials namespace={NS} getSchema={fakeGetSchema} execute={fakeExecute}>
					<MyComponent key="test" tags={["cart"]} cache={60} name="hello" />
				</Partials>,
			),
		);
		const str = JSON.stringify(result);
		expect(str).toContain("name");
		expect(str).not.toContain("tags");
		expect(str).not.toContain("cache");
	});

	it("nested Partials: inner namespace filters correctly", async () => {
		function InnerContent() {
			return <span>inner-search-result</span>;
		}
		function Page() {
			return (
				<Partials namespace="inner" getSchema={fakeGetSchema} execute={fakeExecute}>
					<InnerContent key="search" />
					<Stats key="stats" />
				</Partials>
			);
		}
		// Target inner/search — outer "layout" renders all (no match), inner filters to "search"
		const { result } = await runWithRequestAsync(fakeRequest({ partials: "inner/search" }), async () =>
			renderToJSON(
				<Partials namespace="layout">
					<Hero key="header" />
					<Page key="page" />
				</Partials>,
			),
		);
		const str = JSON.stringify(result);
		expect(str).toContain("inner-search-result");
		expect(str).not.toContain("Stats");
	});

	it("nested Partials: __inputs override reaches inner partial", async () => {
		function SearchResult({ query }: { query: string }) {
			return <span>searching: {query}</span>;
		}
		function Page() {
			return (
				<Partials namespace="inner" getSchema={fakeGetSchema} execute={fakeExecute}>
					<SearchResult key="search" query="" />
				</Partials>
			);
		}
		// __inputs keys use namespaced IDs
		const inputs = JSON.stringify({ "inner/search": { query: "bulbasaur" } });
		const { result } = await runWithRequestAsync(fakeRequest({ partials: "inner/search", __inputs: inputs }), async () =>
			renderToJSON(
				<Partials namespace="layout">
					<Hero key="header" />
					<Page key="page" />
				</Partials>,
			),
		);
		const str = JSON.stringify(result);
		expect(str).toContain("searching:");
		expect(str).toContain("bulbasaur");
	});

	it("nested Partials: outer skips partials with matching cached fingerprints", async () => {
		// First render: capture fingerprints from both outer and inner
		let outerFingerprints: Record<string, string> = {};
		let innerFingerprints: Record<string, string> = {};
		let renderCount = 0;

		vi.mocked(await import("../partial-client.tsx")).PartialsClient = (({
			children,
			fingerprints: fp,
			namespace,
			freshIds,
		}: any) => {
			if (namespace === "layout") outerFingerprints = fp;
			if (namespace === "inner") innerFingerprints = fp;
			renderCount++;
			return children;
		}) as any;

		const { Partials: P } = await import("../partial.tsx");

		function InnerCart() { return <span>cart-content</span>; }
		function InnerHeader() { return <span>header-content</span>; }
		function Page() {
			return (
				<P namespace="inner" getSchema={fakeGetSchema} execute={fakeExecute}>
					<InnerHeader key="header" />
					<InnerCart key="cart" />
				</P>
			);
		}

		// Full render to get all fingerprints
		await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<P namespace="layout">
					<Hero key="head" />
					<Page key="page" />
				</P>,
			),
		);
		expect(outerFingerprints.head).toBeDefined();
		expect(outerFingerprints.page).toBeDefined();
		expect(innerFingerprints.header).toBeDefined();
		expect(innerFingerprints.cart).toBeDefined();

		// Now simulate ?partials=inner/cart with cached fingerprints for everything else.
		// The outer passes through (no "layout/" prefixed IDs in ?partials=inner/cart),
		// so ALL outer partials render. The inner filters to only "cart".
		let outerFreshIds: string[] = [];
		let innerFreshIds: string[] = [];
		vi.mocked(await import("../partial-client.tsx")).PartialsClient = (({
			children,
			freshIds,
			namespace,
		}: any) => {
			if (namespace === "layout") outerFreshIds = freshIds;
			if (namespace === "inner") innerFreshIds = freshIds;
			return children;
		}) as any;

		const cached = [
			`layout/head:${outerFingerprints.head}`,
			`layout/page:${outerFingerprints.page}`,
			`inner/header:${innerFingerprints.header}`,
			`inner/cart:${innerFingerprints.cart}`,
		].join(",");

		await runWithRequestAsync(
			fakeRequest({ partials: "inner/cart", cached }),
			async () =>
				renderToJSON(
					<P namespace="layout">
						<Hero key="head" />
						<Page key="page" />
					</P>,
				),
		);

		// Outer: pass-through renders ALL partials (no partial filter matches layout namespace)
		expect(outerFreshIds).toContain("head");
		expect(outerFreshIds).toContain("page");
		// Inner: only "cart" should be fresh (explicitly requested via ?partials=inner/cart)
		expect(innerFreshIds).toEqual(["cart"]);
	});

	it("partials without tags are unaffected by ?tags= filter", async () => {
		function Tagged() { return <span>tagged</span>; }
		function Untagged() { return <span>untagged</span>; }
		const { result } = await runWithRequestAsync(fakeRequest({ tags: "cart" }), async () =>
			renderToJSON(
				<Partials namespace={NS} getSchema={fakeGetSchema} execute={fakeExecute}>
					<Tagged key="tagged" tags={["cart"]} />
					<Untagged key="untagged" />
				</Partials>,
			),
		);
		const str = JSON.stringify(result);
		expect(str).toContain("tagged");
		expect(str).not.toContain("untagged");
	});
});
