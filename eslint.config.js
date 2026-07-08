import tsParser from "@typescript-eslint/parser"
import reactHooks from "eslint-plugin-react-hooks"

// ESLint is scoped to ONE job here: the React Compiler / rules-of-hooks
// diagnostics. The "recommended-latest" preset of eslint-plugin-react-hooks
// bundles rules-of-hooks + exhaustive-deps plus the compiler rules (purity,
// refs, immutability, set-state-in-render, …) that tell you why a component
// can't be safely compiled. Formatting is Prettier's job (see .prettierrc);
// there is no separate general linter.
const reactHooksRecommended = reactHooks.configs.flat["recommended-latest"]

export default [
  {
    ignores: [
      "**/dist/**",
      "**/.vite/**",
      "**/test-results/**",
      "**/.tmp/**",
      ".yarn/**",
      "bench/**",
      "scripts/**",
      "**/fuzz/**",
      "**/*.d.ts",
      // Non-TS source (configs, the yarn release, fuzz scripts) — not components.
      "**/*.{js,cjs,mjs}",
      // Tests and e2e specs call hooks from harness helpers; the compiler only
      // ever sees production components, so lint those.
      "**/__tests__/**",
      "**/*.test.{ts,tsx}",
      "**/e2e/**",
      // Vendored shadcn — upstream code we don't modify, so don't lint it:
      // the AI-elements (also unused), the UI primitives, and use-mobile.
      "copies/src/components/ai-elements/**",
      "copies/src/components/ui/**",
      "copies/src/hooks/use-mobile.ts",
    ],
  },
  {
    ...reactHooksRecommended,
    files: ["{framework,cms,copies,e2e-testing,e2e-magento}/src/**/*.{ts,tsx}"],
    languageOptions: {
      ...reactHooksRecommended.languageOptions,
      parser: tsParser,
      parserOptions: {
        ...reactHooksRecommended.languageOptions?.parserOptions,
        ecmaFeatures: { jsx: true },
        sourceType: "module",
      },
    },
  },
]
