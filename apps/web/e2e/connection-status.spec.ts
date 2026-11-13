import { expect, test } from "@playwright/test";

test("healthy connection stays in the header while offline and pending commands remain actionable", async ({ page, context, request }, testInfo) => {
  await page.goto("/");
  const header = page.getByRole("banner");
  const indicator = header.getByRole("status", { name: "Live updates connected", exact: true });
  const banner = page.getByRole("status", { name: "Connection status", exact: true });
  await expect(indicator).toBeVisible();
  await expect(banner).toHaveCount(0);
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await indicator.focus();
    await expect(indicator).toBeFocused();
    const bounds = await indicator.boundingBox();
    expect(bounds!.width).toBeLessThanOrEqual(30);
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect.poll(() => indicator.evaluate(element => getComputedStyle(element.parentElement!, "::after").opacity)).toBe("1");
    await page.screenshot({ path: testInfo.outputPath(`connection-healthy-${width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const title = `Connection queue ${Date.now()}`;
  await page.getByRole("button", { name: "New task", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create task", exact: true });
  await dialog.getByLabel("Title", { exact: true }).fill(title);
  await dialog.getByLabel("Acceptance criteria (one per line)").fill("Ready command survives a transport failure");
  await dialog.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();

  const readyUrl = "**/api/v1/tasks/*/ready";
  const keys: string[] = [];
  let taskId = "";
  page.on("request", item => {
    if (item.method() === "POST" && /\/api\/v1\/tasks\/[^/]+\/ready$/.test(new URL(item.url()).pathname)) {
      keys.push(item.headers()["idempotency-key"]!);
      taskId = new URL(item.url()).pathname.split("/").at(-2)!;
    }
  });
  await page.route(readyUrl, route => route.abort("failed")); // Authorized transport failure; real server remains unchanged.
  await page.getByRole("button", { name: "Mark ready", exact: true }).click();
  await expect(banner).toContainText("1 pending command. Keep this window open until sent.");
  await expect(banner).toContainText("Live updates connected");
  await expect(indicator).toHaveCount(0);
  expect(taskId).not.toBe("");
  expect((await (await request.get(`/api/v1/tasks/${taskId}`)).json()).task.status).toBe("backlog");
  await context.setOffline(true);
  await expect(banner).toContainText("Offline");
  await expect(banner.getByRole("button", { name: "Retry pending", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 900 });
  await page.screenshot({ path: testInfo.outputPath("connection-offline-pending-320.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.unroute(readyUrl);
  await context.setOffline(false);
  await expect(banner).toHaveCount(0);
  await expect(indicator).toBeVisible();
  await expect.poll(async () => (await (await request.get(`/api/v1/tasks/${taskId}`)).json()).task.status).toBe("ready");
  expect(keys.length).toBeGreaterThanOrEqual(2);
  expect(keys.every(key => typeof key === "string" && key.length > 0)).toBe(true);
  expect(new Set(keys).size).toBe(1);
});
