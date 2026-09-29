import { expect, test } from "@playwright/test";

test("channels and threads synchronize between independent browser clients and survive reload", async ({ page, browser, request }, testInfo) => {
  const name = `shared-${Date.now()}`;
  await page.goto("/channels");
  await page.getByRole("button", { name: "New channel", exact: true }).click();
  await page.getByLabel("Channel name", { exact: true }).fill(name);
  await page.getByLabel("Channel description").fill("Cross-client planning discussion");
  await page.getByRole("button", { name: "Create channel", exact: true }).click();
  await expect(page.getByRole("heading", { name: `# ${name}`, exact: true })).toBeVisible();
  const main = page.getByRole("region", { name: "Channel conversation", exact: true });
  await main.getByLabel("Message", { exact: true }).fill("Split the release into implementation and verification.");
  await main.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(main.getByRole("list", { name: "Messages" })).toContainText("Split the release");
  await main.getByRole("button", { name: "Reply in thread", exact: true }).click();
  const thread = page.getByRole("complementary", { name: "Thread", exact: true });
  await thread.getByLabel("Message", { exact: true }).fill("Verification should depend on implementation.");
  await thread.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(thread.getByRole("list", { name: "Messages" })).toContainText("Verification should depend");
  await expect(main.getByRole("button", { name: "1 replies", exact: true })).toBeVisible();
  const secondContext = await browser.newContext();
  try {
    const second = await secondContext.newPage();
    await second.goto(page.url());
    const secondThread = second.getByRole("complementary", { name: "Thread", exact: true });
    await expect(secondThread.getByRole("list", { name: "Messages" })).toContainText("Verification should depend");
    await secondThread.getByLabel("Message", { exact: true }).fill("Agreed from the second device.");
    await secondThread.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(thread.getByRole("list", { name: "Messages" })).toContainText("Agreed from the second device.");
    await page.reload();
    await expect(page.getByRole("complementary", { name: "Thread" }).getByRole("list", { name: "Messages" })).toContainText("Agreed from the second device.");
    const url = new URL(page.url()), room = url.searchParams.get("room")!, root = url.searchParams.get("thread")!;
    const roots = (await (await request.get(`/api/v1/rooms/${room}/messages`)).json()).messages;
    expect(roots).toHaveLength(1); expect(roots[0].reply_count).toBe(2);
    const replies = (await (await request.get(`/api/v1/rooms/${room}/messages?thread_root_id=${root}`)).json()).messages;
    expect(replies).toHaveLength(2); expect(replies.every((item: { thread_root_id: string }) => item.thread_root_id === root)).toBe(true);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.getByRole("complementary", { name: "Thread" }).getByRole("button", { name: "Send message", exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`channels-${width}.png`), fullPage: true });
    }
  } finally { await secondContext.close(); }
});
