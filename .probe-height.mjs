import { chromium } from "@playwright/test"
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
await page.goto("http://localhost:5399/magento/browse")
await page.waitForSelector('[data-testid^="browse-card-"]', { timeout: 30000 })
await page.waitForTimeout(4000) // let prices stream in
const h = await page.evaluate(() => {
  const hs = [...document.querySelectorAll('[data-testid^="browse-card-"]')]
    .filter((c) => c.offsetParent !== null)
    .map((c) => Math.round(c.getBoundingClientRect().height))
  return { min: Math.min(...hs), max: Math.max(...hs), median: hs.sort((a, b) => a - b)[hs.length >> 1], n: hs.length }
})
console.log(JSON.stringify(h))
await browser.close()
