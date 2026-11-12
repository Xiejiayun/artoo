import { expect, test } from "@playwright/test";

test("agent identities and instance filters stay compact and usable", async ({ page }, testInfo) => {
  // Controlled inventory variants exercise long names and multiple identity cards.
  await page.route("**/api/v1/bootstrap", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    const agent = data.agents[0];
    data.agents.push({ ...agent, id: "layout-builder", display_name: "Web Builder" }, { ...agent, id: "layout-reviewer", display_name: "Web Reviewer with a long reusable identity name" });
    await route.fulfill({ response, json: data });
  });
  await page.goto("/agents");
  const library = page.getByRole("region", { name: "Agent library", exact: true });
  const card = library.locator(".agent-library__card").filter({ hasText: "Mock Coder" });
  await expect(library.locator(".agent-library__card")).toHaveCount(3);
  const details = card.locator("details");
  await expect(details).not.toHaveAttribute("open");
  await expect(card.getByRole("link", { name: "Create instance", exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Delete agent", exact: true })).toBeHidden();

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ["dark", "light"] as const) {
      if (theme === "light") await page.getByRole("button", { name: "Switch to light theme" }).click();
      const searchBox = await page.getByRole("searchbox", { name: "Search agents" }).boundingBox();
      const resultCount = await page.locator(".agents-page .resources-count").boundingBox();
      expect(Math.abs(searchBox!.y - resultCount!.y)).toBeLessThan(12);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`agents-${theme}-${width}.png`), fullPage: true });
      await details.locator("summary").focus();
      await page.keyboard.press("Enter");
      await expect(card.getByText("Last active", { exact: true })).toBeVisible();
      await expect(card.getByRole("button", { name: "Delete agent", exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await details.locator("summary").press("Space");
      if (theme === "light") await page.getByRole("button", { name: "Switch to dark theme" }).click();
    }
  }

  await page.getByLabel("Project scope").selectOption("unassigned");
  await expect(page.getByText("No matching resources", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(page.getByRole("article", { name: "Mock Coder", exact: true })).toBeVisible();
  await page.goto("/agents?instance=removed");
  await expect(page.getByText("This instance is no longer available", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Show all instances", exact: true }).click();
  await expect(page.getByRole("article", { name: "Mock Coder", exact: true })).toBeVisible();
});
