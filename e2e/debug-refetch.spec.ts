import { test, expect } from "./fixtures";

test("debug: search refetch behavior", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));

  // Log console messages
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warn") {
      console.log(`[${msg.type()}] ${msg.text()}`);
    }
  });

  // 1. Load page with search open
  await page.goto("/?search=url&q=a");
  await page.waitForSelector('[data-testid="stage-1-content"]', { timeout: 15000 });
  console.log("✓ Initial SSR loaded with stage-1-content");

  // Check all stages
  for (let i = 1; i <= 3; i++) {
    const el = await page.$(`[data-testid="stage-${i}-content"]`);
    console.log(`  Stage ${i}: ${el ? "present" : "absent"}`);
  }

  // 2. Type a character
  const input = page.locator("input[type=text]");
  const valueBefore = await input.inputValue();
  console.log(`Input value before: "${valueBefore}"`);
  await input.focus();
  await input.press("End");
  await input.press("b");
  const valueAfter = await input.inputValue();
  console.log(`Input value after: "${valueAfter}"`);

  // 3. Wait and check what happens
  console.log("Waiting 8s for refetch...");
  await page.waitForTimeout(8000);

  // Check stages after refetch
  for (let i = 1; i <= 3; i++) {
    const content = await page.$(`[data-testid="stage-${i}-content"]`);
    const fallback = await page.$(`[data-testid="stage-${i}-fallback"]`);
    console.log(`  Stage ${i}: content=${!!content}, fallback=${!!fallback}`);
  }

  if (errors.length > 0) {
    console.log("\n=== Page Errors ===");
    for (const e of errors) console.log(`  ${e.slice(0, 300)}`);
  }

  // Check if the search dialog is still visible
  const dialog = await page.$("dialog[open]");
  console.log(`Dialog open: ${!!dialog}`);

  // Check dialog content
  if (dialog) {
    const dialogText = await dialog.textContent();
    console.log(`Dialog text (first 200): ${dialogText?.slice(0, 200)}`);
  }

  // This test is diagnostic only
  expect(true).toBe(true);
});
