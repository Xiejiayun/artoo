import { expect, test } from "@playwright/test";

test("computer connection uses the official npm package on every platform", async ({ page, context }, testInfo) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/computers");
  for (const platform of ["windows", "linux", "macos"]) {
    await page.getByRole("region", { name: "Computers", exact: true }).getByRole("button", { name: "Connect Local Node", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Connect Local Node", exact: true });
    await expect(dialog.getByText(/Requires Node.js 24\+ and npm 11\+/)).toContainText("official npm package");
    await dialog.getByLabel("Target operating system").selectOption(platform);
    const response = page.waitForResponse(item => item.url().endsWith("/api/v1/devices/pairings") && item.request().method() === "POST");
    await dialog.getByRole("button", { name: "Generate connection command", exact: true }).click();
    const paired = await response;
    expect(paired.ok()).toBe(true);
    expect(paired.request().postDataJSON()).toEqual({ intended_platform: platform });
    const { code } = await paired.json();
    const command = dialog.getByLabel("Connection command");
    const expected = `npx -y @jiayunxie/artood@0.1.0-rc.6 connect --server ${new URL(page.url()).origin} --code ${code}`;
    await expect(command).toHaveText(expected);
    await dialog.getByRole("button", { name: "Copy command", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(expected);
    await expect(dialog.getByRole("status")).toHaveText("Waiting for your machine…");
    for (const width of [1440, 320]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`connect-${platform}-${width}.png`), fullPage: true, mask: [command] });
    }
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
  }
});
