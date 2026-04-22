import path from "node:path";
import react from "@vitejs/plugin-react";
import rsc from "@vitejs/plugin-rsc";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// Skip `@vitejs/plugin-rsc` when vitest is running: its `"use client"`
// transform wraps modules in client-reference proxies, which breaks
// hook rendering in jsdom because the wrapper pulls in its own React
// copy. For dev / build we still want the plugin active.
const isTest = process.env.VITEST === "true";

export default defineConfig({
	plugins: isTest
		? [react(), tailwindcss()]
		: [rsc(), react(), tailwindcss()],
	environments: {
		rsc: {
			build: {
				rollupOptions: {
					input: { index: "./src/framework/entry.rsc.tsx" },
				},
			},
		},
		ssr: {
			build: {
				rollupOptions: {
					input: { index: "./src/framework/entry.ssr.tsx" },
				},
			},
		},
		client: {
			build: {
				rollupOptions: {
					input: { index: "./src/framework/entry.browser.tsx" },
				},
			},
		},
	},
	test: {
		// Three projects, each owning a distinct test tier:
		//   - node:    jsdom, plugin-rsc disabled — fast bulk of the
		//              suite (hook tests, client-only units).
		//   - rsc:     Node + `react-server` condition + plugin-rsc
		//              active — tests that render server trees to
		//              Flight in-process. See `vitest.rsc.config.ts`.
		//   - browser: real Chromium via Playwright provider — tests
		//              that need real DOM primitives jsdom can't fake
		//              (focus, Navigation API, measurement). See
		//              `vitest.browser.config.ts`.
		// `yarn test` runs the fast tiers (node + rsc); browser tier
		// is opt-in via `yarn test:browser` to avoid paying the
		// browser-boot cost on every save. CI runs all three.
		projects: [
			{
				extends: true,
				test: {
					name: "node",
					setupFiles: ["./vitest.setup.ts"],
					include: ["src/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
					// Other tiers own their own globs.
					exclude: [
						"**/node_modules/**",
						"src/**/*.rsc.test.?(c|m)[jt]s?(x)",
						"src/**/*.browser.test.?(c|m)[jt]s?(x)",
					],
					environment: "jsdom",
				},
			},
			"./vitest.rsc.config.ts",
			"./vitest.browser.config.ts",
		],
	},
	resolve: {
		dedupe: ["react", "react-dom"],
		alias: {
			"@": path.resolve(import.meta.dirname, "src"),
		},
	},
});
