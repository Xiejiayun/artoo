import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

test("successful writes and a real evidence download announce once without taking focus", async ({ page }, testInfo) => {
  const title = `Feedback task ${Date.now()}`;
  await page.goto("/");
  await page.getByRole("button", { name: "New task", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create task", exact: true });
  await dialog.getByLabel("Title", { exact: true }).fill(title);
  await dialog.getByRole("button", { name: "Create task", exact: true }).click();
  const notifications = page.getByRole("region", { name: "Notifications", exact: true });
  await expect(notifications.getByRole("status")).toHaveText("Task created.");
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  expect(await notifications.evaluate((element) => element.contains(document.activeElement))).toBe(false);

  await page.goto("/runs");
  await page.getByRole("navigation", { name: "Tasks", exact: true }).getByRole("button", { name: new RegExp(title) }).click();
  const ready = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export task evidence", exact: true }).click();
  const downloaded = await ready;
  await expect(notifications.getByRole("status")).toHaveText("Task evidence download started.");
  expect(downloaded.suggestedFilename()).toMatch(/-audit\.json$/);
  expect(await downloaded.failure()).toBeNull();
  const file = await downloaded.path();
  expect(file).toBeTruthy();
  const exported = JSON.parse(await readFile(file!, "utf8"));
  expect(exported.bundle.task.title).toBe(title);

  await page.goto("/settings");
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const save = page.getByRole("form", { name: "Edit project", exact: true }).getByRole("button", { name: "Save project", exact: true });
    await save.click(); // Save the same values; other workflows retain their project name.
    await expect(notifications.getByRole("status")).toHaveText("Project saved.");
    await expect(page.getByText("Project saved.", { exact: true })).toHaveCount(1);
    expect(await notifications.evaluate((element) => element.contains(document.activeElement))).toBe(false);
    const bounds = await notifications.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: testInfo.outputPath(`feedback-${width}.png`) });
    const dismiss = notifications.getByRole("button", { name: "Dismiss", exact: true });
    await dismiss.focus();
    await page.keyboard.press("Enter");
    await expect(notifications).toHaveCount(0);
  }
});
