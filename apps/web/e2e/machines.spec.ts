import { expect, test } from "@playwright/test";

test("machines keep routine work visible and reveal maintenance details on demand", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/computers");
  const computer = page.getByRole("article", { name: "Local Mock", exact: true });
  const details = computer.locator("details.machine-details");
  const summary = details.locator("summary");
  await expect(computer.getByRole("link", { name: "Mock Coder", exact: true })).toBeVisible();
  await expect(computer.getByRole("button", { name: "Create instance", exact: true })).toBeVisible();
  await expect(details).not.toHaveAttribute("open");
  await expect(details.getByText("Last active", { exact: true })).toBeHidden();
  await expect(details.getByRole("button", { name: "Delete computer", exact: true })).toBeHidden();

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ["dark", "light"] as const) {
      if (theme === "light") await page.getByRole("button", { name: "Switch to light theme" }).click();
      await expect(computer.getByRole("button", { name: "Create instance", exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`machines-${theme}-${width}.png`), fullPage: true });
      await summary.focus();
      await page.keyboard.press("Enter");
      await expect(details).toHaveAttribute("open");
      await expect(details.getByText("Last active", { exact: true })).toBeVisible();
      await expect(details.getByText("Mock Coder workspace", { exact: true })).toBeVisible();
      await expect(details.getByRole("button", { name: "Delete computer", exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`machines-details-${theme}-${width}.png`), fullPage: true });
      await summary.focus();
      await page.keyboard.press("Space");
      await expect(details).not.toHaveAttribute("open");
      if (theme === "light") await page.getByRole("button", { name: "Switch to dark theme" }).click();
    }
  }

  await computer.getByRole("button", { name: "Create instance", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Create agent instance" })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search computers" }).fill("no-such-machine");
  await expect(page.getByText("No matching resources", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(computer).toBeVisible();
  await page.goto("/computers?create=computer_local_mock");
  await expect(page.getByRole("dialog", { name: "Create agent instance" })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("region", { name: "Computers", exact: true }).getByRole("button", { name: "Connect Local Node", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Connect Local Node", exact: true })).toBeVisible();
});
