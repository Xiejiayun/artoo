import { expect, test, type Locator } from "@playwright/test";

async function expectUncoveredSend(button: Locator): Promise<void> {
  await expect(button).toBeInViewport({ ratio: 1 });
  await expect.poll(() => button.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
  })).toBe(true);
}

test("short mobile conversations keep history separate and multiline messages can be sent", async ({ page, request }, testInfo) => {
  const bootstrap = await (await request.get("/api/v1/bootstrap")).json();
  const created = await request.post("/api/v1/channels", { data: { project_id: bootstrap.projects[0].id, name: `compact-${Date.now()}`, description: "Compact conversation regression" } });
  expect(created.ok()).toBe(true);
  const { channel } = await created.json();
  let rootId = "";
  for (const surface of ["channel", "thread"]) {
    for (let index = 0; index < 12; index++) {
      const response = await request.post(`/api/v1/rooms/${channel.id}/messages`, { data: { kind: "text", body: `${surface} history ${index}: review the experience and keep the discussion readable.`, ...(surface === "thread" ? { thread_root_id: rootId } : {}) } });
      expect(response.ok()).toBe(true);
      if (!rootId) rootId = (await response.json()).message.id;
    }
  }
  for (const surface of ["channel", "thread"]) {
    await page.setViewportSize(surface === "channel" ? { width: 1280, height: 600 } : { width: 390, height: 667 });
    await page.goto(`/channels?room=${channel.id}${surface === "thread" ? `&thread=${rootId}` : ""}`);
    const conversation = page.getByRole("region", { name: surface === "channel" ? "Channel conversation" : "Thread replies", exact: true });
    const history = conversation.getByRole("region", { name: "Message history", exact: true });
    const composer = conversation.getByRole("form", { name: "Send room message", exact: true });
    const input = composer.getByLabel("Message", { exact: true });
    const send = composer.getByRole("button", { name: "Send message", exact: true });
    await input.fill("A short draft");
    if (surface === "channel") {
      const before = await send.boundingBox();
      await history.focus();
      await history.press("Home");
      await expect.poll(() => history.evaluate((element) => element.scrollTop)).toBe(0);
      await history.press("End");
      await expect.poll(() => history.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      expect((await send.boundingBox())!.y).toBeCloseTo(before!.y, 0);
      await expectUncoveredSend(send);
      await page.setViewportSize({ width: 390, height: 667 });
      await input.fill("A short draft");
    }
    // A visible control can still be covered by the overflowing history.
    const historyBounds = await history.boundingBox(), composerBounds = await composer.boundingBox();
    expect(historyBounds!.y + historyBounds!.height).toBeLessThanOrEqual(composerBounds!.y + 1);
    if (surface === "channel") await expectUncoveredSend(send);
    await page.screenshot({ path: testInfo.outputPath(`${surface}-short-mobile.png`) });

    await page.setViewportSize({ width: 390, height: 400 });
    const body = Array.from({ length: 12 }, (_, index) => `${surface} detailed feedback line ${index + 1}`).join("\n");
    await input.fill(body);
    await history.scrollIntoViewIfNeeded();
    await history.focus();
    await history.press("Home");
    await expect.poll(() => history.evaluate((element) => element.scrollTop)).toBe(0);
    await history.press("End");
    await expect.poll(() => history.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    expect((await history.boundingBox())!.height).toBeGreaterThanOrEqual(80);
    await send.scrollIntoViewIfNeeded();
    await expectUncoveredSend(send);
    await page.screenshot({ path: testInfo.outputPath(`${surface}-multiline-short-mobile.png`) });
    const sent = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/rooms/${channel.id}/messages` && response.request().method() === "POST" && response.request().postDataJSON()?.body === body);
    await send.click();
    const response = await sent;
    expect(response.ok()).toBe(true);
    const { message } = await response.json();
    expect(message.body).toBe(body);
    expect(message.thread_root_id).toBe(surface === "thread" ? rootId : null);
    await expect(input).toHaveValue("");
    const delivered = await request.get(`/api/v1/rooms/${channel.id}/messages/${message.id}`);
    expect((await delivered.json()).message.body).toBe(body);
  }
});

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
  await main.getByRole("article", { name: "text message", exact: true }).hover();
  await main.getByRole("button", { name: "Reply in thread", exact: true }).click();
  const thread = page.getByRole("complementary", { name: "Thread", exact: true });
  await thread.getByLabel("Message", { exact: true }).fill("Verification should depend on implementation.");
  await thread.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(thread.getByRole("list", { name: "Messages" })).toContainText("Verification should depend");
  await expect(main.getByRole("button", { name: "1 reply", exact: true })).toBeVisible();
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
    await thread.getByRole("button", { name: "Close thread", exact: true }).click();
    await expect(main.getByLabel("Message", { exact: true })).toBeVisible();
    await main.getByLabel("Message", { exact: true }).fill("A keyboard-friendly follow-up.");
    await main.getByLabel("Message", { exact: true }).press("Enter");
    await expect(main.getByRole("list", { name: "Messages" })).toContainText("A keyboard-friendly follow-up.");
    const links = page.getByRole("navigation", { name: "Primary", exact: true }).locator(".app-nav__links li");
    const boxes = await links.evaluateAll((items) => items.map((item) => { const rect = item.getBoundingClientRect(); return { left: rect.left, right: rect.right }; }));
    for (let index = 1; index < boxes.length; index++) expect(boxes[index]!.left).toBeGreaterThanOrEqual(boxes[index - 1]!.right);
  } finally { await secondContext.close(); }
});
