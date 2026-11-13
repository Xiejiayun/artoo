import { expect, test } from "@playwright/test";

test("searches older roots and replies, pages matches, removes moderated hits and opens the verified thread", async ({
  page,
  request,
}, testInfo) => {
  const keyErrors: string[] = [];
  page.on("console", (event) => {
    if (event.type() === "error" && event.text().includes("same key")) keyErrors.push(event.text());
  });
  const created = await request.post("/api/v1/channels", {
    data: { project_id: "proj_artoo", name: `search-${Date.now()}` },
  });
  expect(created.ok()).toBe(true);
  const { channel } = await created.json();
  const send = async (body: string, thread_root_id?: string) => {
    const result = await request.post(`/api/v1/rooms/${channel.id}/messages`, {
      data: { body, ...(thread_root_id ? { thread_root_id } : {}) },
    });
    expect(result.ok()).toBe(true);
    return (await result.json()).message;
  };
  const root = await send("Needle oldest root 中文 100%_\\");
  const reply = await send("Needle historic reply", root.id);
  for (let i = 0; i < 51; i++) await send(`Needle match ${i}`);
  for (let i = 0; i < 51; i++) await send(`Ordinary recent message ${i}`);
  const validated = page.waitForResponse(
    (response) => new URL(response.url()).pathname === `/api/v1/rooms/${channel.id}`,
  );
  await page.goto(`/channels?room=${encodeURIComponent(channel.id)}`);
  expect((await validated).ok()).toBe(true);
  await page.getByRole("button", { name: "Search messages", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Search messages", exact: true });
  await dialog.getByLabel("Search message text").fill("needle");
  await dialog.getByRole("button", { name: "Search", exact: true }).click();
  const results = dialog.getByRole("list", { name: "Search results" });
  await expect(results.getByRole("listitem")).toHaveCount(50);
  await expect(dialog.getByText(root.body, { exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Load older matches", exact: true }).click();
  await expect(results.getByRole("listitem")).toHaveCount(53);
  await expect(results.getByText(reply.body, { exact: true })).toBeVisible();
  const report = await request.post(`/api/v1/messages/${root.id}/report`, {
    data: { reason: "Controlled removal regression" },
  });
  expect(report.ok()).toBe(true);
  const resolved = await request.post(`/api/v1/moderation/reports/${(await report.json()).id}/resolve`, {
    data: { action: "remove", note: "Controlled fixture" },
  });
  expect(resolved.ok()).toBe(true);
  await expect(results.getByText(root.body, { exact: true })).toHaveCount(0);
  await results
    .getByRole("listitem")
    .filter({ hasText: reply.body })
    .getByRole("link", { name: "Open reply", exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`thread=${root.id}.*message=${reply.id}`));
  await expect(
    page.getByRole("region", { name: "Mentioned reply", exact: true }).getByText(reply.body, { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Search replies", exact: true }).click();
  const threadSearch = page.getByRole("dialog", { name: "Search replies", exact: true });
  await threadSearch.getByLabel("Search message text").fill("needle");
  await threadSearch.getByRole("button", { name: "Search", exact: true }).click();
  await expect(threadSearch.getByRole("listitem")).toHaveCount(1);
  await expect(threadSearch.getByText(reply.body, { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("search-thread-desktop.png") });
  await page.keyboard.press("Escape");
  await expect(threadSearch).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Search replies", exact: true })).toBeFocused();
  expect(keyErrors).toEqual([]);
});

test("keeps literal search, empty/error recovery and keyboard dismissal usable at 320px", async ({
  page,
  request,
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 667 });
  const created = await request.post("/api/v1/channels", {
    data: { project_id: "proj_artoo", name: `search-mobile-${Date.now()}` },
  });
  const { channel } = await created.json();
  const body = `Literal 中文 100%_\\ ${"longword".repeat(60)}`;
  expect((await request.post(`/api/v1/rooms/${channel.id}/messages`, { data: { body } })).ok()).toBe(true);
  const validated = page.waitForResponse(
    (response) => new URL(response.url()).pathname === `/api/v1/rooms/${channel.id}`,
  );
  await page.goto(`/channels?room=${encodeURIComponent(channel.id)}`);
  expect((await validated).ok()).toBe(true);
  await page.getByRole("button", { name: "Search messages", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Search messages", exact: true });
  const input = dialog.getByLabel("Search message text");
  const submit = dialog.getByRole("button", { name: "Search", exact: true });
  await input.fill("100%_\\");
  await submit.click();
  await expect(dialog.getByRole("listitem")).toHaveCount(1);
  await expect(dialog.getByText(body, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
  await page.screenshot({ path: testInfo.outputPath("search-mobile-320.png") });
  await input.fill("missing-search-text");
  await submit.click();
  await expect(dialog.getByText("No matching messages.", { exact: true })).toBeVisible();
  await page.route(`**/api/v1/rooms/${channel.id}/messages?*`, (route) => {
    if (new URL(route.request().url()).searchParams.has("q"))
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "unavailable", message: "Controlled search outage" } }),
      });
    return route.continue();
  });
  await input.fill("Literal");
  await submit.click();
  await expect(dialog.getByText("Controlled search outage", { exact: true })).toBeVisible();
  await page.unrouteAll({ behavior: "wait" });
  await dialog.getByRole("button", { name: "Retry search", exact: true }).click();
  await expect(dialog.getByRole("listitem")).toHaveCount(1);
  await page.keyboard.press("Tab");
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Search messages", exact: true })).toBeFocused();
});
