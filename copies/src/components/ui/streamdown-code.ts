import type {
  CodeHighlighterPlugin,
  HighlightOptions,
  HighlightResult,
  ThemeInput,
} from "@streamdown/code"
import type { HighlighterCore } from "shiki/core"
import { createHighlighterCore } from "shiki/core"
import { createJavaScriptRegexEngine } from "shiki/engine/javascript"

import githubDark from "@shikijs/themes/github-dark"
import githubLight from "@shikijs/themes/github-light"

import bash from "@shikijs/langs/bash"
import css from "@shikijs/langs/css"
import graphql from "@shikijs/langs/graphql"
import html from "@shikijs/langs/html"
import javascript from "@shikijs/langs/javascript"
import json from "@shikijs/langs/json"
import jsonc from "@shikijs/langs/jsonc"
import jsx from "@shikijs/langs/jsx"
import markdown from "@shikijs/langs/markdown"
import tsx from "@shikijs/langs/tsx"
import typescript from "@shikijs/langs/typescript"
import yaml from "@shikijs/langs/yaml"

/**
 * A curated Shiki highlighter plugin for Streamdown — the drop-in
 * replacement for `@streamdown/code`'s default `code` singleton.
 *
 * The default plugin hardcodes Shiki's ENTIRE bundled registry
 * (`Object.keys(bundledLanguages)` — ~200 lazy grammar chunks, ~7 MB
 * of dist weight) even though every grammar is loaded on demand. This
 * plugin instead builds one `createHighlighterCore` instance over a
 * fixed set of web-shaped languages plus the two GitHub themes, so the
 * client dist carries only the grammars this app actually renders.
 *
 * The curated set covers the docs corpus (ts/tsx/js/jsx dominate;
 * json/jsonc, bash, html, css, graphql, yaml, markdown) and the chat's
 * common code fences. An UNCURATED language degrades to plain text at
 * runtime — never a throw — exactly as Shiki's built-in `text`/
 * `plaintext` pseudo-language does.
 *
 * Streamdown drives a code plugin through just two members: it calls
 * `getThemes()` once to seed its default `shikiTheme`, then `highlight()`
 * per fence (returning cached tokens synchronously or `null` + a
 * callback while the async highlighter warms). The rest of the
 * `CodeHighlighterPlugin` surface is consumer-facing and implemented
 * for interface parity. The streaming caret path re-invokes `highlight`
 * as a fence grows mid-stream; the token cache keys on the code's
 * length + head/tail so a growing fence re-tokenizes rather than
 * returning stale bytes.
 */

// [light, dark] — the tuple Streamdown reads via `getThemes()` to seed
// its `shikiTheme` context. Names match the loaded theme objects.
const THEMES: [ThemeInput, ThemeInput] = ["github-light", "github-dark"]

// The JavaScript regex engine (no oniguruma WASM), forgiving so a
// grammar rule Shiki's JS engine can't compile is skipped rather than
// throwing — matches `@streamdown/code`'s engine configuration.
const engine = createJavaScriptRegexEngine({ forgiving: true })

// One shared highlighter, created lazily on the first `highlight()` and
// reused for every fence. Each `@shikijs/langs/*` default export is a
// `LanguageRegistration[]` (aliases baked in: `ts`/`cts`/`mts`,
// `sh`/`shell`, `yml`, `md`, …), so `getLoadedLanguages()` resolves them.
let highlighterPromise: Promise<HighlighterCore> | null = null
const highlighter = (): Promise<HighlighterCore> =>
  (highlighterPromise ??= createHighlighterCore({
    engine,
    themes: [githubLight, githubDark],
    langs: [
      typescript,
      tsx,
      javascript,
      jsx,
      json,
      jsonc,
      html,
      css,
      bash,
      graphql,
      yaml,
      markdown,
    ],
  }))

// The primary ids + aliases the curated grammars answer to. Used only
// by the consumer-facing `supportsLanguage` / `getSupportedLanguages`;
// Streamdown's render path never calls them (an unknown language falls
// through to `text` inside `highlight`).
const SUPPORTED = new Set<string>([
  "ts",
  "typescript",
  "tsx",
  "js",
  "javascript",
  "jsx",
  "json",
  "jsonc",
  "html",
  "css",
  "bash",
  "sh",
  "shell",
  "graphql",
  "gql",
  "yaml",
  "yml",
  "markdown",
  "md",
])

const themeName = (theme: ThemeInput): string =>
  typeof theme === "string" ? theme : (theme.name ?? "custom")

// Cache key mirrors `@streamdown/code`: language + theme pair + length +
// head/tail slices. The length + boundaries change as a streamed fence
// grows, so mid-stream re-tokenization is a natural cache miss.
const cacheKey = (code: string, language: string, themes: [string, string]): string => {
  const head = code.slice(0, 100)
  const tail = code.length > 100 ? code.slice(-100) : ""
  return `${language}:${themes[0]}:${themes[1]}:${code.length}:${head}:${tail}`
}

const tokenCache = new Map<string, HighlightResult>()
const subscribers = new Map<string, Set<(result: HighlightResult) => void>>()

const resolveLang = (hl: HighlighterCore, language: string): string =>
  hl.getLoadedLanguages().includes(language) ? language : "text"

const resolveTheme = (hl: HighlighterCore, name: string, fallback: string): string =>
  hl.getLoadedThemes().includes(name) ? name : fallback

export const code: CodeHighlighterPlugin = {
  name: "shiki",
  type: "code-highlighter",

  getThemes: () => THEMES,

  getSupportedLanguages: () =>
    Array.from(SUPPORTED) as ReturnType<CodeHighlighterPlugin["getSupportedLanguages"]>,

  supportsLanguage: (language) => SUPPORTED.has(String(language).trim().toLowerCase()),

  highlight(
    { code: source, language, themes }: HighlightOptions,
    callback?: (result: HighlightResult) => void,
  ): HighlightResult | null {
    const names: [string, string] = [themeName(themes[0]), themeName(themes[1])]
    const key = cacheKey(source, language, names)

    const cached = tokenCache.get(key)
    if (cached) return cached

    if (callback) {
      let subs = subscribers.get(key)
      if (!subs) {
        subs = new Set()
        subscribers.set(key, subs)
      }
      subs.add(callback)
    }

    highlighter()
      // oxlint-disable-next-line eslint-plugin-promise(prefer-await-to-then)
      .then((hl) => {
        const result = hl.codeToTokens(source, {
          lang: resolveLang(hl, language),
          themes: {
            light: resolveTheme(hl, names[0], "github-light"),
            dark: resolveTheme(hl, names[1], "github-dark"),
          },
        })

        tokenCache.set(key, result)

        const subs = subscribers.get(key)
        if (subs) {
          for (const sub of subs) sub(result)
          subscribers.delete(key)
        }
      })
      // oxlint-disable-next-line eslint-plugin-promise(prefer-await-to-then)
      .catch((error) => {
        console.error("[parton streamdown-code] failed to highlight code:", error)
        subscribers.delete(key)
      })

    return null
  },
}
