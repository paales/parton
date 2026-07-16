import {
  clearCaches,
  test,
  expect,
  waitForLiveConnection,
  waitForPageInteractive,
} from "./fixtures"

/**
 * /tag-demo — verify tag-driven refresh semantics (the event-shaped
 * author signal: `tag(name)` subscribes, `refreshSelector(name)`
 * wakes every reader).
 *
 *   bump "tag-demo:product"  → one reader (the product parton)
 *   bump "tag-demo:price"    → three (price-a, price-b, price-c)
 *   bump "tag-demo:featured" → two (price-b, price-c)
 *   bump "tag-demo:price-a"  → single reader
 *
 * Each parton renders a server timestamp. After a bump, only the
 * subscribed timestamps should change; non-readers stay pinned.
 */

// A tag name is a process-wide address: a bump wakes its readers on
// every page held open in the process, so two of these tests running
// at once against their own /tag-demo pages would each see the other's
// fanout. Serial mode gives each bump the page to itself — the demo
// page's `tag-demo:` prefix keeps the rest of the suite out.
test.describe.configure({ mode: "serial" })

test.beforeEach(async ({ baseURL }) => {
  await clearCaches(baseURL)
})

async function readTimestamps(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const labels = ["product", "price-a", "price-b", "price-c"]
    const out: Record<string, string> = {}
    for (const l of labels) {
      const el = document.querySelector(`[data-testid="time-${l}"]`)
      out[l] = el?.textContent ?? ""
    }
    return out
  })
}

/** Load the demo with its live subscription provably open — a bump
 *  reaches its readers over the held connection, so firing one before
 *  the subscription is established has nothing to wake. */
async function openTagDemo(page: import("@playwright/test").Page) {
  await page.goto("/tag-demo")
  await waitForPageInteractive(page)
  await waitForLiveConnection(page)
}

test.describe("tag-driven refresh", () => {
  test("bumping `product` refreshes only its one reader", async ({ page }) => {
    await openTagDemo(page)

    const before = await readTimestamps(page)
    // Ensure enough time passes so a fresh render produces a different ISO string.
    await page.waitForTimeout(50)
    await page.locator('[data-testid="refresh-product"][data-hydrated]').click()
    // Wait until the "product" timestamp text changes.
    await expect.poll(async () => (await readTimestamps(page))["product"]).not.toBe(before.product)
    const after = await readTimestamps(page)

    // product changed, price-* unchanged.
    expect(after.product).not.toBe(before.product)
    expect(after["price-a"]).toBe(before["price-a"])
    expect(after["price-b"]).toBe(before["price-b"])
    expect(after["price-c"]).toBe(before["price-c"])
  })

  test("bumping `price` refreshes all three readers", async ({ page }) => {
    await openTagDemo(page)

    const before = await readTimestamps(page)
    await page.waitForTimeout(50)
    await page.locator('[data-testid="refresh-price"][data-hydrated]').click()
    await expect
      .poll(async () => (await readTimestamps(page))["price-a"])
      .not.toBe(before["price-a"])
    const after = await readTimestamps(page)

    expect(after["price-a"]).not.toBe(before["price-a"])
    expect(after["price-b"]).not.toBe(before["price-b"])
    expect(after["price-c"]).not.toBe(before["price-c"])
    // The product parton doesn't read `price` — stays pinned.
    expect(after.product).toBe(before.product)
  })

  test("bumping `featured` refreshes only the two featured readers", async ({ page }) => {
    await openTagDemo(page)

    const before = await readTimestamps(page)
    await page.waitForTimeout(50)
    await page.locator('[data-testid="refresh-price-featured"][data-hydrated]').click()
    await expect
      .poll(async () => (await readTimestamps(page))["price-b"])
      .not.toBe(before["price-b"])
    const after = await readTimestamps(page)

    expect(after["price-b"]).not.toBe(before["price-b"])
    expect(after["price-c"]).not.toBe(before["price-c"])
    // price-a doesn't read `featured`, stays pinned.
    expect(after["price-a"]).toBe(before["price-a"])
    expect(after.product).toBe(before.product)
  })

  test("bumping `price-a` refreshes a single reader", async ({ page }) => {
    await openTagDemo(page)

    const before = await readTimestamps(page)
    await page.waitForTimeout(50)
    await page.locator('[data-testid="refresh-price-a"][data-hydrated]').click()
    await expect
      .poll(async () => (await readTimestamps(page))["price-a"])
      .not.toBe(before["price-a"])
    const after = await readTimestamps(page)

    expect(after["price-a"]).not.toBe(before["price-a"])
    expect(after["price-b"]).toBe(before["price-b"])
    expect(after["price-c"]).toBe(before["price-c"])
    expect(after.product).toBe(before.product)
  })
})
