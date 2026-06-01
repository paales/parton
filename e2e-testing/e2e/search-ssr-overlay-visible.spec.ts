import { test, expect } from "./fixtures"

/**
 * Regression guard: the search overlay must be visible in the SSR HTML
 * for `?search=1&q=…`, not pop in on hydration.
 *
 * The native <dialog> is `display:none` until it has the `open`
 * attribute. `showModal()` runs only in a client effect, so a
 * showModal-only dialog stays invisible until hydration and the content
 * appears to "load in from the server stream". `SearchDialog` renders
 * the `open` attribute so the overlay paints with the first HTML byte;
 * the effect upgrades it to modal on hydration.
 *
 * Asserting with JS disabled isolates the SSR paint from hydration — if
 * the dialog is visible here, it was in the HTML response.
 */
test.describe("search overlay SSR visibility (no JS)", () => {
  test.use({ javaScriptEnabled: false })

  test("overlay is visible in the server HTML without hydration", async ({ page }) => {
    await page.goto("/?search=1&q=po")

    const dialog = page.locator("dialog")
    await expect(dialog).toBeVisible()
    // Native <dialog> only renders (and is visible) when it has `open`.
    await expect(dialog).toHaveAttribute("open", "")

    // The search input and the instant stage-1 results are part of the
    // same server paint — not streamed in later.
    await expect(page.locator('dialog input[type="text"]')).toBeVisible()
    await expect(page.getByTestId("search-body")).toHaveAttribute("data-search-q", "po")
    await expect(page.getByTestId("stage-1-content")).toBeVisible()
  })
})

/**
 * The JS path: rendering the `open` attribute server-side and upgrading
 * to modal in an effect must hydrate cleanly. The upgrade does
 * `dialog.close()` → `showModal()`; routing the close-navigation through
 * `onClose` (which `.close()` fires) would dispatch a spurious "remove
 * ?search" nav on hydration, abort the in-flight render, and tear the
 * page down into a `PartialErrorBoundary` card. The close-nav hangs off
 * `onCancel` instead, so hydration is silent. Guard both: no error card
 * on load, and Escape still closes.
 */
test.describe("search overlay hydration (JS enabled)", () => {
  test("hydrating an open overlay does not error or self-close", async ({ page }) => {
    const errors: string[] = []
    page.on("pageerror", (e) => errors.push(e.message))

    await page.goto("/?search=url")
    const dialog = page.locator("dialog")
    await expect(dialog).toBeVisible()
    // The hydration effect upgrades the SSR-open dialog to a real modal
    // (poll — `toBeVisible` resolves on the SSR `open` attribute before
    // the effect has run).
    await expect
      .poll(() => dialog.evaluate((d) => d.matches(":modal")), { timeout: 5000 })
      .toBe(true)

    // It must NOT have closed itself, and the URL must still carry ?search.
    await page.waitForTimeout(500)
    await expect(page.locator("dialog[open]")).toHaveCount(1)
    expect(new URL(page.url()).searchParams.has("search")).toBe(true)
    // No error-boundary card (the BodyStreamBuffer-aborted regression).
    await expect(page.locator("text=/failed to render/")).toHaveCount(0)
    expect(errors, `page errors: ${JSON.stringify(errors)}`).toHaveLength(0)

    // Escape still closes it (onCancel path) and removes ?search.
    await page.keyboard.press("Escape")
    await expect(page.locator("dialog[open]")).toHaveCount(0)
    expect(new URL(page.url()).searchParams.has("search")).toBe(false)
  })
})
