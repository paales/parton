import { test, expect, waitForPageInteractive } from "./fixtures"

/**
 * Every parton is addressable — the bare-root case.
 *
 * <BareRootParton/> (src/app/pages/bare-root-parton.tsx) declares no
 * match and is placed directly in root.tsx: no request gate, no
 * ancestor parton. Its identity is its Render name alone, and it ships
 * its fingerprint like any other parton — so it registers, rides the
 * client's cached manifest, and fp-skips across navigations.
 *
 * The contract this pins:
 *  - the parton's ONLY dependency is the cell it resolves, so once its
 *    read set is on record no navigation re-runs its body — the
 *    `time()` stamp holds indefinitely;
 *  - writing that cell (the checkbox) is exactly what re-renders it —
 *    the stamp moves.
 *
 * The settle nav: a body read lands AFTER the render that made it, so
 * against a server that has never rendered this parton the cold fp
 * doesn't carry the cell dep yet and one navigation re-renders to heal
 * it (over-fetch, never stale). Whether that heal is still owed depends
 * on how warm the server already is, so the helper below spends one
 * round trip without asserting on it and takes the settled fp as the
 * baseline. From there the parton fp-skips — that steady state is the
 * claim.
 */

const stamp = (page: import("@playwright/test").Page) => page.getByTestId("bare-root-stamp")

/** Land on /bare-root/a with the parton's read set on record, and
 *  return the settled stamp. */
async function settled(page: import("@playwright/test").Page): Promise<string> {
  await page.goto("/bare-root/a")
  await waitForPageInteractive(page)
  await expect(page.getByTestId("bare-root")).toBeVisible()

  // One round trip spends any cold→warm heal still owed.
  await page.getByTestId("bare-root-nav-b").click()
  await expect(page).toHaveURL(/\/bare-root\/b$/)
  await page.getByTestId("bare-root-nav-a").click()
  await expect(page).toHaveURL(/\/bare-root\/a$/)

  const now = await stamp(page).getAttribute("data-now")
  expect(now).toBeTruthy()
  return now!
}

test("a bare root parton fp-skips across navigations — its stamp holds", async ({ page }) => {
  const first = await settled(page)

  // Away and back, twice: the parton reads nothing from the request, so
  // its fp holds and the server ships a placeholder — the body never
  // re-runs, however many times the URL moves.
  for (const step of ["b", "a", "b", "a"] as const) {
    await page.getByTestId(`bare-root-nav-${step}`).click()
    await expect(page).toHaveURL(new RegExp(`/bare-root/${step}$`))
    expect(await stamp(page).getAttribute("data-now")).toBe(first)
  }
})

test("writing the bare root parton's cell re-renders it — its stamp moves", async ({ page }) => {
  const before = await settled(page)

  // The checkbox's server function writes the cell this parton
  // resolved — its recorded dependency — so the write wakes it.
  await page.getByTestId("bare-root-toggle").click()
  await expect(page.getByTestId("bare-root-toggle")).toBeChecked()
  await expect.poll(() => stamp(page).getAttribute("data-now")).not.toBe(before)

  // A second write moves it again — the cell is the live dependency,
  // not a one-shot.
  const second = await stamp(page).getAttribute("data-now")
  await page.getByTestId("bare-root-toggle").click()
  await expect(page.getByTestId("bare-root-toggle")).not.toBeChecked()
  await expect.poll(() => stamp(page).getAttribute("data-now")).not.toBe(second)
})
