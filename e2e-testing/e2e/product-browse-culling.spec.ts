import type { Page } from "@playwright/test"
import { test, expect, waitForPageInteractive } from "./fixtures"

/**
 * /magento/browse — the catalog as a `scroller()` collection.
 *
 * The interval tree windows the catalog: leaf partons resolve their
 * slice only in view, culled regions collapse to shells, `?page=` is
 * the anchor (cold seed + silent mirror). These tests assert the
 * behaviors that matter:
 *  - scrolling NEVER jumps backward (shells reserve estimated space);
 *  - culling follows the viewport (products load where you look; only
 *    a viewport-sized neighborhood is ever full);
 *  - the tree WINDOWS the catalog (far regions are collapsed shells,
 *    not one DOM section per page);
 *  - a deep-link `?page=N` lands on N with its products (anchor seed);
 *  - scroll silently mirrors into `?page=` without moving the viewport.
 *
 * Position is ARITHMETIC (the writer's own rule): the wrapper's
 * public `id=browse-grid` plus the grid's resolved row pitch and
 * column count give item-under-center; nothing else about the markup
 * is contract.
 */

const card = '[data-testid^="browse-card-"]'
const marker = '[data-s="browse-grid"]'
const PAGE_SIZE = 12

// Drive the page down via the wheel, sampling scrollY after each notch.
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

// The anchor page under the viewport's center — the writer's own
// arithmetic: rows from the wrapper's top at the grid's resolved
// pitch.
async function centeredPage(page: Page) {
  return page.evaluate((ps) => {
    const wrapper = document.getElementById("browse-grid")
    const grid = wrapper?.querySelector(":scope > .parton-scroller-grid")
    if (!wrapper || !grid) return null
    const cs = getComputedStyle(grid)
    const cols = cs.gridTemplateColumns.split(" ").length
    const rowH =
      Number.parseFloat(cs.getPropertyValue("--scroller-row")) || Number.parseFloat(cs.gridAutoRows)
    if (!(rowH > 0)) return null
    const centerRow = Math.floor(
      (window.innerHeight / 2 - wrapper.getBoundingClientRect().top) / rowH,
    )
    return Math.floor(Math.max(0, centerRow * cols) / ps) + 1
  }, PAGE_SIZE)
}

// How many leaves currently SHOW products. Culled leaves park their
// DOM under a hidden Activity, so a card counts only when actually
// rendered (display:none ancestors give offsetParent === null).
async function fullLeafCount(page: Page) {
  return page.evaluate(
    ({ cardSel, ps }) => {
      let shown = 0
      for (const c of document.querySelectorAll<HTMLElement>(cardSel)) {
        if (c.offsetParent !== null) shown++
      }
      return Math.ceil(shown / ps)
    },
    { cardSel: card, ps: PAGE_SIZE },
  )
}

// Catalog size in items, derived from the wrapper's height at the
// resolved geometry (rows are uniform by contract).
async function totalItems(page: Page) {
  return page.evaluate(() => {
    const wrapper = document.getElementById("browse-grid")
    const grid = wrapper?.querySelector(":scope > .parton-scroller-grid")
    if (!wrapper || !grid) return 0
    const cs = getComputedStyle(grid)
    const cols = cs.gridTemplateColumns.split(" ").length
    const rowH =
      Number.parseFloat(cs.getPropertyValue("--scroller-row")) || Number.parseFloat(cs.gridAutoRows)
    if (!(rowH > 0)) return 0
    return Math.round(wrapper.getBoundingClientRect().height / rowH) * cols
  })
}

test("scrolling down never jumps the viewport backward", async ({ page }) => {
  await page.goto("/magento/browse")
  await page.waitForSelector(card, { timeout: 20000 })
  // The culling machinery (Fragment-ref observers + refetch dispatch)
  // only runs on the hydrated page — scroll after the marker.
  await waitForPageInteractive(page)

  const ys = await wheelDown(page, 18)

  // Every sample must be >= the previous (small tolerance for sub-pixel
  // rounding). A culled region that collapsed its reservation would show
  // as a large negative step.
  let maxBackward = 0
  for (let i = 1; i < ys.length; i++) maxBackward = Math.max(maxBackward, ys[i - 1] - ys[i])
  expect(maxBackward, `scrollY trajectory: ${ys.join(",")}`).toBeLessThan(50)
  expect(ys[ys.length - 1]).toBeGreaterThan(2000)
})

test("culling follows the viewport — products load where you scroll, far regions stay shells", async ({
  page,
}) => {
  await page.goto("/magento/browse")
  await page.waitForSelector(card, { timeout: 20000 })
  await waitForPageInteractive(page)

  await wheelDown(page, 18)
  const centered = await centeredPage(page)
  expect(centered, "should have scrolled several pages down").toBeGreaterThan(4)

  // The viewport neighborhood fills — culled IN where you look. The
  // tree materializes level by level (each flip-in is a lane), so
  // poll for convergence rather than racing the cascade.
  await expect.poll(() => fullLeafCount(page), { timeout: 25000 }).toBeGreaterThan(0)
  const full = await fullLeafCount(page)

  // Culling is real: only a viewport-sized neighborhood is full, not
  // the whole catalog.
  const total = await totalItems(page)
  expect(full).toBeLessThan(16)
  expect(full * PAGE_SIZE).toBeLessThan(total)
})

test("the tree windows the catalog — far regions are collapsed shells, not per-page DOM", async ({
  page,
}) => {
  await page.goto("/magento/browse")
  await page.waitForSelector('[data-testid="browse-list"]', { timeout: 20000 })
  await waitForPageInteractive(page)

  // Data-driven size (from total_count), well over any hardcoded pool.
  const total = await totalItems(page)
  expect(total).toBeGreaterThan(40 * PAGE_SIZE)

  // WINDOWING: only the placed span's leaves exist as DOM — the
  // attached card count is bounded by the span, far below the
  // catalog.
  const attached = await page.locator(card).count()
  expect(attached, `attached=${attached} of total=${total}`).toBeLessThan(total / 4)

  // The whole catalog is still reachable: the document reserves
  // estimated space for every item.
  const docH = await page.evaluate(() => document.documentElement.scrollHeight)
  expect(docH).toBeGreaterThan((total / PAGE_SIZE) * 400)
})

test("deep-link ?page=50 lands on page 50 with its products", async ({ page }) => {
  await page.goto("/magento/browse?page=50")
  await page.waitForSelector(card, { timeout: 30000 })
  await waitForPageInteractive(page, { timeout: 30000 })

  // The anchor seed renders page 50's neighborhood full on the cold
  // paint; the pre-hydration script lands the viewport there (poll —
  // don't race it).
  await expect.poll(() => centeredPage(page), { timeout: 10000 }).toBeGreaterThanOrEqual(48)
  expect(await centeredPage(page)).toBeLessThanOrEqual(52)
  // The anchored leaf's products are rendered — visible cards at the
  // landing (poll: under full-suite load the seeded content's commit
  // can trail the landing scroll).
  await expect
    .poll(
      () =>
        page.evaluate((cardSel) => {
          for (const c of document.querySelectorAll<HTMLElement>(cardSel)) {
            const r = c.getBoundingClientRect()
            if (r.bottom > 0 && r.top < window.innerHeight && c.offsetParent !== null) return true
          }
          return false
        }, card),
      { timeout: 10000 },
    )
    .toBe(true)
})

test("?page= mirrors scroll without resetting it", async ({ page }) => {
  await page.goto("/magento/browse")
  await page.waitForSelector('[data-testid="browse-list"]', { timeout: 20000 })
  await waitForPageInteractive(page)

  await wheelDown(page, 16)
  const yScrolled = await page.evaluate(() => Math.round(window.scrollY))
  expect(yScrolled, "actually scrolled down").toBeGreaterThan(3000)

  // The centered page is mirrored into ?page= once the scroll settles —
  // silent (no refetch), and it must NOT yank the viewport back to the
  // top (the silent-navigate scroll-reset bug).
  await expect
    .poll(() => Number(new URL(page.url()).searchParams.get("page") || "0"), {
      timeout: 5000,
    })
    .toBeGreaterThan(3)
  const param = Number(new URL(page.url()).searchParams.get("page"))
  expect(Math.abs(param - ((await centeredPage(page)) ?? 0))).toBeLessThanOrEqual(2)
  const yAfter = await page.evaluate(() => Math.round(window.scrollY))
  expect(Math.abs(yAfter - yScrolled), "silent ?page= write kept the viewport put").toBeLessThan(
    120,
  )
})

test("client-side nav from home swaps to browse, not a torn page", async ({ page }) => {
  // The e2e's other tests `goto` the page; the bug only shows on a CLIENT
  // nav: the cull controller, firing its refetch as browse's cold partons
  // mount mid-navigation, superseded the route swap and left the home route
  // visible on top. The controller now defers culling until the navigation
  // settles.
  await page.goto("/")
  await waitForPageInteractive(page)
  await page.locator('a[href="/magento/browse"][data-hydrated]').first().click()
  // The visible page heading becomes browse's, and its first leaf
  // renders — home is swapped out (keepalive-hidden), not torn on top.
  await expect(page.locator("h1:visible").first()).toHaveText("Browse Products", { timeout: 20000 })
  await expect(page.locator(card).first()).toBeVisible({ timeout: 20000 })
})

test("?page= follows along DURING sustained scrolling, not only at the stop", async ({ page }) => {
  // A sustained scroll (inertial wheel, scrollbar drag) never stops
  // emitting events. The writer throttles instead of debouncing, so
  // the param advances THROUGH the gesture (94 → 95 → 96…), and the
  // window can move ahead of the user mid-scroll instead of waiting
  // for a full stop (the "always scroll into skeletons" bug).
  await page.goto("/magento/browse")
  await page.waitForSelector(card, { timeout: 20000 })
  await waitForPageInteractive(page)

  await page.mouse.move(550, 400)
  const midScrollPages: number[] = []
  for (let i = 0; i < 26; i++) {
    await page.mouse.wheel(0, 400)
    // Gaps SHORTER than the settle interval — a trailing debounce
    // would never fire inside this loop.
    await page.waitForTimeout(120)
    midScrollPages.push(Number(new URL(page.url()).searchParams.get("page") || "1"))
  }
  const distinct = [...new Set(midScrollPages.filter((p) => p > 1))]
  expect(
    distinct.length,
    `pages sampled mid-scroll: ${midScrollPages.join(",")}`,
  ).toBeGreaterThanOrEqual(3)
  // Following along means consecutive values, not one catch-up jump:
  // the largest step between successive samples stays small.
  let maxStep = 0
  for (let i = 1; i < midScrollPages.length; i++) {
    maxStep = Math.max(maxStep, midScrollPages[i] - midScrollPages[i - 1])
  }
  expect(maxStep, `pages sampled mid-scroll: ${midScrollPages.join(",")}`).toBeLessThanOrEqual(3)
})

test("up-scroll from a deep link never cascades back to the top", async ({ page }) => {
  // The staircase bug: scrolling up from ?page=100 into the
  // before-reservation, a window move materializes content above at
  // real heights ≠ estimate; with no reference to correct against
  // (reservations carry no boundary ids) the viewport displaces
  // upward, the writer reads a smaller page, states another move —
  // and cascades to page 1. The backstop's below-the-top fallback ref
  // breaks the chain. Inject height variance so real ≠ estimate.
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const s = document.createElement("style")
      s.textContent = `
        [data-testid^="browse-card-"]:nth-of-type(3n) { min-height: 340px !important; }
        [data-testid^="browse-card-"]:nth-of-type(7n) { min-height: 300px !important; }
      `
      document.head.appendChild(s)
    })
  })
  await page.goto("/magento/browse?page=100")
  await page.waitForSelector(card, { timeout: 30000 })
  await waitForPageInteractive(page, { timeout: 30000 })
  await page.waitForTimeout(1200)

  // Scroll up through the span edge into the reservation, with pauses
  // so window moves + materialization land mid-journey.
  await page.mouse.move(640, 400)
  for (let round = 0; round < 7; round++) {
    for (let i = 0; i < 5; i++) {
      await page.mouse.wheel(0, -600)
      await page.waitForTimeout(80)
    }
    await page.waitForTimeout(900)
  }
  await page.waitForTimeout(1500)

  // 35 wheel notches x 600px ≈ 21000px ≈ 28 estimate-pages of travel
  // from page 100 — the honest landing is ~72, variance-shifted. A
  // cascade collapses toward page 1; assert the landing stayed in the
  // arithmetic neighborhood.
  const finalPage = await centeredPage(page)
  expect(finalPage, "viewport stayed where the user scrolled").toBeGreaterThan(60)
  const param = Number(new URL(page.url()).searchParams.get("page") || "1")
  expect(param, "the param followed the viewport, not a cascade").toBeGreaterThan(60)
})

test("the page's projections join the scroller's query — facets, pagination, streaming prices", async ({
  page,
}) => {
  // FilterBar (aggregations) and Pagination (total) are plain partons
  // resolving the same browseProductsCell partition the slice path
  // uses — three projections of one result, no scroller API. Prices
  // stream per card behind Suspense (the /magento LivePricePartial).
  await page.goto("/magento/browse")
  await page.waitForSelector(card, { timeout: 20000 })
  await waitForPageInteractive(page)

  // Facets rendered with counts from the shared query.
  await expect
    .poll(() => page.locator('[data-testid="browse-facet-option"]').count(), { timeout: 15000 })
    .toBeGreaterThan(0)
  // Pagination rendered from the same total.
  await expect(page.locator('[data-testid="browse-pagination"]')).toBeVisible({ timeout: 15000 })
  // A price streams in on a visible card (fallback → live).
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            document.querySelectorAll('[data-testid^="live-price-"]:not([data-testid*="fallback"])')
              .length,
        ),
      { timeout: 20000 },
    )
    .toBeGreaterThan(0)
})

test("facets FILTER: a click states the filter, counts follow the active query, the option universe stays unfiltered", async ({
  page,
}) => {
  await page.goto("/magento/browse")
  await page.waitForSelector(card, { timeout: 20000 })
  await waitForPageInteractive(page)

  const option = '[data-testid="browse-facet-option"]'
  await expect.poll(() => page.locator(option).count(), { timeout: 15000 }).toBeGreaterThan(0)
  const universeBefore = await page.locator(option).count()
  const lastLink = () =>
    page
      .locator('[data-testid="browse-pagination"] [data-testid^="browse-page-link-"]')
      .last()
      .textContent()
  const pagesBefore = Number(await lastLink())
  expect(pagesBefore).toBeGreaterThan(1)

  // Click a CATEGORY facet — a strict subset of the catalog.
  await page.locator(`${option}[href*="f_category_uid"]`).first().click()
  await expect
    .poll(() => new URL(page.url()).searchParams.get("f_category_uid"), { timeout: 10000 })
    .not.toBeNull()

  // The active-filters section appears, the option is marked active.
  await expect(page.locator('[data-testid="browse-active-filters"]')).toBeVisible({
    timeout: 15000,
  })
  await expect(page.locator(`${option}[data-active]`)).toHaveCount(1, { timeout: 15000 })

  // The grid + pagination follow the ACTIVE query: fewer pages.
  await expect
    .poll(async () => Number(await lastLink()), { timeout: 15000 })
    .toBeLessThan(pagesBefore)
  // The option UNIVERSE stays the unfiltered one — nothing vanished.
  expect(await page.locator(option).count()).toBe(universeBefore)

  // Removing the active chip restores the unfiltered collection.
  await page.locator('[data-testid^="browse-active-filter-"]').first().click()
  await expect
    .poll(() => new URL(page.url()).searchParams.get("f_category_uid"), { timeout: 10000 })
    .toBeNull()
  await expect.poll(async () => Number(await lastLink()), { timeout: 15000 }).toBe(pagesBefore)
})

test("clicking a pagination link moves the viewport to that page", async ({ page }) => {
  // The anchor param is a public surface: a link stating ?page=N is
  // an EXTERNAL anchor statement — the sync must move the viewport
  // there (never just re-render the span in place).
  await page.goto("/magento/browse")
  await page.waitForSelector(card, { timeout: 20000 })
  await waitForPageInteractive(page)

  // Reach the pagination at the collection's foot; the scroll there
  // mirrors into ?page=, so the link window re-centers — "1" is
  // always rendered.
  await page.evaluate(() => {
    document.querySelector('[data-testid="browse-pagination"]')?.scrollIntoView()
  })
  await page.waitForTimeout(800)
  const fromPage = await centeredPage(page)
  expect(fromPage, "scrolled deep before clicking").toBeGreaterThan(10)
  await page.locator('[data-testid="browse-page-link-1"]').click()

  // Page 1 clears the param; the viewport must travel there.
  await expect
    .poll(() => Number(new URL(page.url()).searchParams.get("page") || "1"), { timeout: 10000 })
    .toBe(1)
  await expect.poll(() => centeredPage(page), { timeout: 10000 }).toBeLessThanOrEqual(2)
  // The landing shows products (the anchored neighborhood loads).
  await expect
    .poll(
      () =>
        page.evaluate((cardSel) => {
          for (const c of document.querySelectorAll<HTMLElement>(cardSel)) {
            const r = c.getBoundingClientRect()
            if (r.bottom > 0 && r.top < window.innerHeight && c.offsetParent !== null) return true
          }
          return false
        }, card),
      { timeout: 15000 },
    )
    .toBe(true)
})

test("variable item heights: up-scroll through swaps and materialization never jumps", async ({
  page,
}) => {
  // Items OWN their height (--scroller-row is the estimate/floor).
  // Inject real variance, then run the settle-pause up-scroll
  // gauntlet from a deep anchor: spans move, leaves materialize above
  // the viewport at heights ≠ estimate. Native scroll anchoring
  // covers kept-node growth; the id-referenced backstop covers node
  // replacement (swaps, skeleton→content) — the viewport must never
  // move except by the user's hand.
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const s = document.createElement("style")
      s.textContent = `
        [data-testid^="browse-card-"]:nth-of-type(3n) { min-height: 340px !important; }
        [data-testid^="browse-card-"]:nth-of-type(7n) { min-height: 300px !important; }
      `
      document.head.appendChild(s)
    })
    ;(window as unknown as { __jumps: number[]; __armed: boolean }).__jumps = []
    ;(window as unknown as { __armed: boolean }).__armed = false
    let lastY = 0
    window.addEventListener(
      "scroll",
      () => {
        const d = window.scrollY - lastY
        const w = window as unknown as { __jumps: number[]; __armed: boolean }
        if (w.__armed && Math.abs(d) > 700) w.__jumps.push(Math.round(d))
        lastY = window.scrollY
      },
      { passive: true, capture: true },
    )
  })
  await page.goto("/magento/browse?page=60")
  await page.waitForSelector(card, { timeout: 30000 })
  await waitForPageInteractive(page, { timeout: 30000 })
  await page.waitForTimeout(1200)
  await page.evaluate(() => {
    ;(window as unknown as { __armed: boolean }).__armed = true
  })

  await page.mouse.move(640, 400)
  for (let round = 0; round < 8; round++) {
    for (let i = 0; i < 5; i++) {
      await page.mouse.wheel(0, -600)
      await page.waitForTimeout(80)
    }
    await page.waitForTimeout(900)
  }
  const jumps = await page.evaluate(() => (window as unknown as { __jumps: number[] }).__jumps)
  expect(jumps, `spontaneous scroll moves: ${jumps.join(",")}`).toEqual([])
})
