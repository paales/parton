// Drives the live editor (`yarn dev`) and dumps screenshots into
// ./live. Pre-req: dev server up — port is auto-detected; override
// with PORT=5179 if needed.
//
// Run from the repo root: `node docs/design/live-screenshot.mjs`.

import { chromium } from "playwright"
import { mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(HERE, "live")
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch()
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
})
const page = await context.newPage()
page.on("pageerror", (e) => console.error("[pageerror]", e.message))
page.on("console", (m) => {
  if (m.type() === "error") console.error("[console.error]", m.text())
})

const BASE = `http://localhost:${process.env.PORT ?? 5179}`

async function shot(name, url, after) {
  await page.goto(`${BASE}${url}`, { waitUntil: "networkidle" })
  await page.waitForTimeout(800)
  if (after) await after()
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false })
  console.log("wrote", name)
}

// Default mode = blur (translucent)
await shot("01-blur-docked", "/cms-demo?editor=1")
await shot("02-blur-floating", "/cms-demo?editor=1&attachment=floating")
await shot("03-blur-jsx", "/cms-demo?editor=1&tree=jsx")
await shot("04-blur-selected", "/cms-demo?editor=1&select=cms-demo-greeting")
await shot("05-blur-settings", "/cms-demo?editor=1&tab=settings")

// Dark
await shot("06-dark-docked", "/cms-demo?editor=1&palette=dark")
await shot("07-dark-floating", "/cms-demo?editor=1&palette=dark&attachment=floating")
await shot("08-dark-selected", "/cms-demo?editor=1&palette=dark&select=cms-demo-greeting")

// Devices
await shot("09-mobile", "/cms-demo?editor=1&device=mobile")
await shot("10-tablet", "/cms-demo?editor=1&device=tablet")

// Open dropdowns
await shot("11-pagenav-open", "/cms-demo?editor=1", async () => {
  await page.locator('button:has-text("Home page")').click()
  await page.waitForTimeout(300)
})
await shot("12-pagenav-open-dark", "/cms-demo?editor=1&palette=dark", async () => {
  await page.locator('button:has-text("Home page")').click()
  await page.waitForTimeout(300)
})
await shot("13-blockpicker", "/cms-demo?editor=1", async () => {
  await page.locator('[data-testid^="cms-edit-slot-add-trigger-"]').first().click()
  await page.waitForTimeout(300)
})
await shot("14-statuspill", "/cms-demo?editor=1", async () => {
  await page.locator('button:has-text("Draft")').click()
  await page.waitForTimeout(300)
})

// Hover
await shot("15-tree-hover", "/cms-demo?editor=1", async () => {
  await page.locator('[data-testid="cms-edit-tree-entry-cms-demo-greeting"]').hover()
  await page.waitForTimeout(300)
})

await browser.close()
console.log("done")
