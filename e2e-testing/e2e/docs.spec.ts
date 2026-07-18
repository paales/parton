import { test, expect } from "./fixtures"

/**
 * /docs{/:filepath*} — the docs viewer.
 *
 * One wrapper spec serves the repo's `docs/` tree: a file-tree sidebar
 * plus a content pane that Streamdown-renders markdown, fences code,
 * and shows directory indexes. Images are served as raw bytes by
 * `serveDocAsset` in the RSC entry. These specs pin the load-bearing
 * behaviors: the index links into the tree, markdown renders to HTML,
 * relative in-doc cross-links resolve against the document path, code
 * files render their contents, the image byte-route works, and the
 * sidebar navigates in-app.
 *
 * Markdown renders through Streamdown (shiki highlighting), whose
 * client bundle is large; on a cold dev server under parallel-worker
 * load its first render + hydration settle can take several seconds, so
 * markdown-content assertions get a generous timeout. The rendered
 * content itself is stable once present — see the cold-start analysis.
 */

const MD = { timeout: 15000 }

// Serial: the markdown content renders through Streamdown's large shiki
// client bundle. Run in one worker so that bundle transpiles once (on
// the first markdown test) instead of being cold-hammered by every
// parallel worker at the same time — which starves the dev server and
// pushes the first renders past the assertion window.
test.describe.configure({ mode: "serial" })

test.beforeEach(async ({ page }) => {
  await page.goto("/__test/clear-caches")
})

test("index links into the tree", async ({ page }) => {
  await page.goto("/docs")
  await expect(page.locator('[data-testid="docs-content"] a[href="/docs/reference"]')).toBeVisible()
})

test("renders a markdown file as HTML", async ({ page }) => {
  await page.goto("/docs/reference/intro.md")
  // `# Introduction` → a real <h1>, proving Streamdown ran.
  await expect(page.getByRole("heading", { level: 1, name: "Introduction" })).toBeVisible(MD)
  await expect(page.locator('nav a[href="/docs/reference"]')).toBeVisible()
  await expect(page).toHaveTitle(/reference\/intro\.md/)
})

test("relative in-doc links resolve against the document path", async ({ page }) => {
  await page.goto("/docs/reference/intro.md")
  await expect(page.getByRole("heading", { level: 1, name: "Introduction" })).toBeVisible(MD)
  const content = page.locator('[data-testid="docs-content"]')
  // `[block](./block.md)` is rewritten to an absolute /docs path so it
  // resolves from the nested doc URL instead of the site root…
  await expect(content.locator('a[href="/docs/reference/block.md"]').first()).toBeAttached(MD)
  // …and `../`-relative links climb out of the directory correctly.
  await expect(content.locator('a[href="/docs/reference/perspectives.md"]').first()).toBeAttached(MD)
  // (in-app navigation on click is covered by the sidebar test, whose
  // links sit above the fold and aren't subject to code-highlight shift.)
})

test("renders a code file's contents", async ({ page }) => {
  await page.goto("/docs/package.json")
  // Shiki emits paired light/dark spans; assert at least one is present.
  await expect(page.getByText('"@parton/docs"').first()).toBeVisible(MD)
})

test("serves image bytes for linked screenshots", async ({ page, baseURL }) => {
  const res = await page.request.get(`${baseURL}/docs/archive/design/v6-screenshots/01-default.png`)
  expect(res.status()).toBe(200)
  expect(res.headers()["content-type"]).toBe("image/png")
  expect((await res.body()).length).toBeGreaterThan(0)
})

test("the file-tree sidebar navigates in-app", async ({ page }) => {
  await page.goto("/docs/reference/intro.md")
  const sidebar = page.locator('[data-testid="docs-sidebar"]')
  await expect(sidebar.locator('[role="tree"]')).toBeVisible(MD)
  // The current file's ancestors start expanded, so a sibling link is
  // reachable; clicking it navigates without a full reload.
  await sidebar.locator('a[href="/docs/reference/block.md"]').first().click()
  await expect(page).toHaveURL(/\/docs\/reference\/block\.md$/)
  await expect(page.getByRole("heading", { level: 1 })).toContainText("block", MD)
})

test("the app nav exposes a Docs link", async ({ page }) => {
  await page.goto("/")
  await expect(page.locator('nav a[href="/docs"]')).toBeVisible()
})
