import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"

/**
 * /magento/browse — the view-culled scroller.
 *
 * These tests assert the things that actually broke in practice, not just
 * DOM presence:
 *  - scrolling down NEVER jumps the viewport backward (the document height
 *    is stable — culled pages keep their space);
 *  - the RING follows the viewport (products load where you look);
 *  - a deep-link `?page=N` cold-starts centered on N with products;
 *  - the page count is DATA-DRIVEN (from total_count), not a fixed pool.
 */

const card = '[data-testid^="browse-card-"]'

// Drive the window down via the wheel, sampling scrollY after each notch.
async function wheelDown(page: Page, notches: number, dy = 400) {
  await page.mouse.move(550, 400)
  const ys: number[] = []
  for (let i = 0; i < notches; i++) {
    await page.mouse.wheel(0, dy)
    await page.waitForTimeout(180)
    ys.push(await page.evaluate(() => Math.round(window.scrollY)))
  }
  return ys
}

// The page section whose box contains the vertical center of the viewport.
async function centeredPage(page: Page) {
  return page.evaluate(() => {
    const cy = window.innerHeight / 2
    for (const s of document.querySelectorAll("[data-page]")) {
      const r = s.getBoundingClientRect()
      if (r.top <= cy && r.bottom >= cy) return Number(s.getAttribute("data-page"))
    }
    return null
  })
}

test("scrolling down never jumps the viewport backward", async ({ page }) => {
  await page.goto("/magento/browse")
  await page.waitForSelector(card, { timeout: 20000 })

  const ys = await wheelDown(page, 18)

  // Every sample must be >= the previous (within a small tolerance for
  // sub-pixel rounding). A culled page that shifted content would show up
  // as a large negative step here — the bug this guards.
  let maxBackward = 0
  for (let i = 1; i < ys.length; i++) maxBackward = Math.max(maxBackward, ys[i - 1] - ys[i])
  expect(maxBackward, `scrollY trajectory: ${ys.join(",")}`).toBeLessThan(50)
  // And it actually moved.
  expect(ys[ys.length - 1]).toBeGreaterThan(2000)
})

test("the ring follows the viewport — products load where you scroll", async ({ page }) => {
  await page.goto("/magento/browse")
  await page.waitForSelector(card, { timeout: 20000 })

  await wheelDown(page, 18)
  const centered = await centeredPage(page)
  expect(centered, "should have scrolled several pages down").toBeGreaterThan(4)

  // The page at the viewport center has its products (not a skeleton).
  await expect(
    page.locator(`[data-page="${centered}"] ${card}`).first(),
    "the centered page should have product cards (the ring followed)",
  ).toBeVisible({ timeout: 15000 })
})

test("deep-link ?page=50 cold-starts centered on page 50 with products", async ({ page }) => {
  await page.goto("/magento/browse?page=50")
  await page.waitForSelector(card, { timeout: 20000 })

  await expect(page.locator('[data-page="50"]')).toBeVisible({ timeout: 20000 })
  await expect(page.locator(`[data-page="50"] ${card}`).first()).toBeVisible({ timeout: 15000 })

  // The viewport actually landed on (or very near) page 50, not the top.
  const centered = await centeredPage(page)
  expect(centered).toBeGreaterThanOrEqual(48)
  expect(centered).toBeLessThanOrEqual(52)
})

test("?page= updates to a sharable anchor once scrolling settles", async ({ page }) => {
  await page.goto("/magento/browse")
  await page.waitForSelector(card, { timeout: 20000 })

  // Mid-scroll the url stays clean (the cookie drives the ring); the
  // `?page=` shadow lands only after the scroll settles.
  await wheelDown(page, 14)
  await page.waitForTimeout(1000)

  const pageParam = Number(new URL(page.url()).searchParams.get("page") || "0")
  const centered = await centeredPage(page)
  expect(pageParam).toBeGreaterThan(3)
  // ...and it points roughly where the viewport is.
  expect(Math.abs(pageParam - (centered ?? 0))).toBeLessThanOrEqual(3)
})

test("renders only a window — count is data-driven, the rest is spacers", async ({ page }) => {
  await page.goto("/magento/browse")
  await page.waitForSelector('[data-testid="browse-list"]', { timeout: 20000 })

  const totalPages = Number(
    await page.locator('[data-testid="browse-list"]').getAttribute("data-total-pages"),
  )
  const rendered = await page.locator("[data-page]").count()

  // The total is well over any small hardcoded pool — it came from
  // total_count. But only a small WINDOW of pages is actually rendered;
  // the rest of the catalog's height is held by the bottom spacer.
  expect(totalPages).toBeGreaterThan(40)
  expect(rendered).toBeLessThan(20)
  expect(rendered).toBeLessThan(totalPages)
  await expect(page.locator('[data-testid="browse-spacer-bottom"]')).toBeAttached()
})
