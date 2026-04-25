import { expect, test, request as apiRequest } from "./fixtures.ts";

test.beforeEach(async ({ baseURL }) => {
  const ctx = await apiRequest.newContext({ baseURL });
  // Clear the draft file so each test gets a clean slate. Caches
  // reset too; Partial registry included.
  await ctx.get("/__test/clear-caches?all=1");
  await ctx.dispose();
});

test.describe("CMS editor — smoke", () => {
  test("tree lists every node in the store", async ({ page }) => {
    await page.goto("/cms-edit");
    await expect(
      page.getByTestId("cms-edit-tree-entry-cms-demo-hero"),
    ).toBeVisible();
    await expect(
      page.getByTestId("cms-edit-tree-entry-cms-demo-greeting"),
    ).toBeVisible();
    await expect(
      page.getByTestId("cms-edit-tree-entry-cms-demo-composed"),
    ).toBeVisible();
    await expect(
      page.getByTestId("cms-edit-tree-entry-composed-hero-1"),
    ).toBeVisible();
    await expect(
      page.getByTestId("cms-edit-tree-entry-composed-text-1"),
    ).toBeVisible();
    await expect(
      page.getByTestId("cms-edit-tree-entry-composed-hero-2"),
    ).toBeVisible();
  });

  test("field pane prompts when nothing is selected", async ({ page }) => {
    await page.goto("/cms-edit");
    await expect(page.getByTestId("cms-edit-field-pane")).toContainText(
      "Select a Partial",
    );
  });

  test("selecting a block-typed entry shows its fields from the catalog", async ({
    page,
  }) => {
    await page.goto("/cms-edit?select=composed-hero-1");
    await expect(
      page.getByTestId("cms-edit-selected-id"),
    ).toContainText("composed-hero-1");
    // Hero block registers headline / subhead / tone via accessor
    // reads; the catalog prerender captures them.
    await expect(
      page.getByTestId("cms-edit-field-input-headline"),
    ).toBeVisible();
    await expect(
      page.getByTestId("cms-edit-field-input-subhead"),
    ).toBeVisible();
    await expect(
      page.getByTestId("cms-edit-field-input-tone"),
    ).toBeVisible();
  });

  test("preview frame renders the demo content inside the editor", async ({
    page,
  }) => {
    await page.goto("/cms-edit");
    const preview = page.getByTestId("cms-edit-preview-pane");
    await expect(preview).toContainText("Welcome to the CMS demo");
  });

  test("tree entry shows block type badge for slot children", async ({
    page,
  }) => {
    await page.goto("/cms-edit");
    const heroEntry = page.getByTestId(
      "cms-edit-tree-entry-composed-hero-1",
    );
    await expect(heroEntry).toContainText("hero");
  });

  test("config tabs list every match clause on a node with cascade", async ({
    page,
  }) => {
    await page.goto("/cms-edit?select=cms-demo-greeting");
    const tabs = page.getByTestId("cms-edit-config-tabs");
    await expect(tabs).toBeVisible();
    // cms-demo-greeting has three configs: slug=alpha, slug∈beta,gamma,
    // and default. Labels are derived from the match clauses.
    await expect(tabs).toContainText("slug=alpha");
    await expect(tabs).toContainText("slug∈beta,gamma");
    await expect(tabs).toContainText("Default");
  });

  test("default config is pre-selected on a Partial with a default entry", async ({
    page,
  }) => {
    await page.goto("/cms-edit?select=cms-demo-greeting");
    // The tab with match:{} (Default) should be the active one.
    const defaultTab = page.locator(
      '[data-testid^="cms-edit-config-tab-"][data-active="true"]',
    );
    await expect(defaultTab).toHaveText("Default");
    // Form shows the default config's fields.
    await expect(
      page.getByTestId("cms-edit-field-input-headline"),
    ).toHaveValue("Default greeting");
  });

  test("switching tabs shows that configuration's fields", async ({
    page,
  }) => {
    await page.goto(
      "/cms-edit?select=cms-demo-greeting&config=0",
    );
    // Tab index 0 is the slug=alpha config.
    await expect(
      page.getByTestId("cms-edit-field-input-headline"),
    ).toHaveValue("Hello, Alpha!");

    await page.goto(
      "/cms-edit?select=cms-demo-greeting&config=2",
    );
    // Tab index 2 is the default config (match:{}).
    await expect(
      page.getByTestId("cms-edit-field-input-headline"),
    ).toHaveValue("Default greeting");
  });

  test("saving in one config doesn't bleed into another", async ({
    page,
  }) => {
    await page.goto(
      "/cms-edit?select=cms-demo-greeting&config=0",
    );
    await page
      .getByTestId("cms-edit-field-input-headline")
      .fill("Only-alpha override");

    const preview = page.getByTestId("cms-edit-preview-pane");
    // Preview is at /cms-demo (no slug). The default config isn't
    // what we're editing, so its rendered headline should stay put
    // across the save round-trip.
    await expect(preview).toContainText("Default greeting");
    await page.getByRole("button", { name: "Save to draft" }).click();
    // After the invalidate-driven refetch completes, the preview
    // still shows the default value — confirming the edit didn't
    // bleed into the default config.
    await expect(preview).toContainText("Default greeting");

    // And on a slug that matches config 0, the edited value shows
    // via the draft cookie that persists across navigation.
    await page.goto("/cms-demo/alpha");
    await expect(
      page.getByTestId("cms-demo-greeting-headline"),
    ).toHaveText("Only-alpha override");

    // Default slug still shows the original published headline —
    // the save wrote only to configs[0], not configs[2].
    await page.goto("/cms-demo");
    await expect(
      page.getByTestId("cms-demo-greeting-headline"),
    ).toHaveText("Default greeting");
  });

  test("save writes to draft and the preview picks up the new value", async ({
    page,
  }) => {
    await page.goto("/cms-edit?select=composed-hero-1");

    const preview = page.getByTestId("cms-edit-preview-pane");
    // Baseline: published default content is visible in the preview.
    await expect(preview).toContainText("First hero in the body slot");

    await page
      .getByTestId("cms-edit-field-input-headline")
      .fill("Edited via the editor");
    await page.getByRole("button", { name: "Save to draft" }).click();

    // Preview refetches via invalidate directive and shows the draft.
    await expect(preview).toContainText("Edited via the editor");
    // Tree now marks the edited entry as draft-only? No — it was
    // already in published; the draft write just overrides. Badge
    // doesn't render because `draftOnly` is false in that case.
    // (Adding a separate badge for "has a draft overlay" is future
    // work.)
  });
});
