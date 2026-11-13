import { expect, test, type Locator } from "@playwright/test";

async function expectUncoveredSend(button: Locator): Promise<void> {
  await expect(button).toBeInViewport({ ratio: 1 });
  await expect.poll(() => button.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
  })).toBe(true);
}

test("the chat composer reflows enlarged text without overlapping actions", async ({ page, request }, testInfo) => {
  const bootstrap = await (await request.get("/api/v1/bootstrap")).json();
  const created = await request.post("/api/v1/channels", { data: { project_id: bootstrap.projects[0].id, name: `readable-${Date.now()}` } });
  expect(created.ok()).toBe(true);
  const { channel } = await created.json();
  for (const width of [800, 390]) {
    await page.setViewportSize({ width, height: 667 });
    await page.goto(`/channels?room=${channel.id}`);
    const conversation = page.getByRole("region", { name: "Channel conversation", exact: true });
    const input = conversation.getByLabel("Message", { exact: true });
    await expect(input).toBeEnabled();
    // Read all original values before setting any: inherited text must grow
    // exactly once, rather than compounding at each nested element.
    await page.evaluate(() => {
      const original = Array.from(document.querySelectorAll<HTMLElement>("body, body *"), (element) => {
        const style = getComputedStyle(element);
        return { element, font: Number.parseFloat(style.fontSize), line: Number.parseFloat(style.lineHeight) };
      });
      for (const { element, font, line } of original) {
        if (Number.isFinite(font)) element.style.fontSize = `${font * 2}px`;
        if (Number.isFinite(line)) element.style.lineHeight = `${line * 2}px`;
      }
    });
    const body = `Readable message at ${width} pixels`;
    await input.fill(body);
    const send = conversation.getByRole("button", { name: "Send message", exact: true });
    await send.scrollIntoViewIfNeeded();
    await expectUncoveredSend(send);
    const areas = await conversation.locator(".conversation-composer__mentions summary span, .conversation-composer__hint, .conversation-composer__send").evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect()).filter((rect) => rect.width > 0 && rect.height > 0).map((rect) => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })));
    for (const [index, area] of areas.entries()) {
      expect(area.left).toBeGreaterThanOrEqual(0);
      expect(area.right).toBeLessThanOrEqual(width);
      for (const other of areas.slice(index + 1)) {
        expect(Math.min(area.right, other.right) <= Math.max(area.left, other.left) || Math.min(area.bottom, other.bottom) <= Math.max(area.top, other.top)).toBe(true);
      }
    }
    await page.screenshot({ path: testInfo.outputPath(`composer-enlarged-text-${width}.png`) });
    const sent = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/rooms/${channel.id}/messages` && response.request().method() === "POST" && response.request().postDataJSON()?.body === body);
    await send.click();
    expect((await (await sent).json()).message.body).toBe(body);
    await expect(input).toHaveValue("");
  }
});

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
  // The refreshed list can briefly select the new channel before navigation
  // verifies its room. Wait for that check before typing into its composer.
  const openedRoom = page.waitForResponse((response) => response.request().method() === "GET"
    && /^\/api\/v1\/rooms\/[^/]+$/.test(new URL(response.url()).pathname));
  await page.getByRole("button", { name: "Create channel", exact: true }).click();
  expect((await openedRoom).ok()).toBe(true);
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
    await page.getByRole("button", { name: "Toggle navigation", exact: true }).click();
    const navigation = page.getByRole("navigation", { name: "Primary", exact: true });
    await expect(navigation.getByRole("link", { name: "Machines", exact: true })).toBeVisible();
    await expect.poll(async () => (await navigation.boundingBox())?.x).toBe(0);
    const links = navigation.locator(".app-nav__links li");
    const boxes = await links.evaluateAll((items) => items.map((item) => { const rect = item.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }; }));
    for (let index = 1; index < boxes.length; index++) expect(boxes[index]!.top).toBeGreaterThanOrEqual(boxes[index - 1]!.bottom);
    for (const box of boxes) { expect(box.left).toBeGreaterThanOrEqual(0); expect(box.right).toBeLessThanOrEqual(390); }
    await page.getByRole("button", { name: "Close navigation", exact: true }).click();
    await expect(page.getByRole("button", { name: "Toggle navigation", exact: true })).toHaveAttribute("aria-expanded", "false");
  } finally { await secondContext.close(); }
});

test("reconnection reconciles missed replies and removed paginated history without a new root", async ({ page, request }, testInfo) => {
  const bootstrap = await (await request.get("/api/v1/bootstrap")).json();
  expect(bootstrap.message_sync.reconciliation_version).toBe(1);
  const created = await request.post("/api/v1/channels", { data: { project_id: bootstrap.projects[0].id, name: `reconcile-${Date.now()}` } });
  expect(created.status()).toBe(201);
  const { channel } = await created.json();
  const roots: { id: string; body: string }[] = [];
  for (let index = 0; index < 55; index++) {
    const response = await request.post(`/api/v1/rooms/${channel.id}/messages`, { data: { kind: "text", body: `Reconnect history ${index}` } });
    expect(response.status()).toBe(201);
    roots.push((await response.json()).message);
  }
  const connections: (() => void)[] = [];
  let transportBlocked = false;
  await page.routeWebSocket("**/api/v1/ws", (socket) => {
    if (transportBlocked) { socket.close({ code: 1012, reason: "Controlled transport interruption" }); return; }
    const remote = socket.connectToServer(); // Forward real server traffic unchanged.
    connections.push(() => { socket.close({ code: 1012, reason: "Controlled transport interruption" }); remote.close(); });
  });
  await page.goto(`/channels?room=${channel.id}`);
  const main = page.getByRole("region", { name: "Channel conversation", exact: true });
  await expect(main.getByText(roots[54]!.body, { exact: true })).toBeVisible();
  await main.getByRole("button", { name: "Load earlier messages", exact: true }).click();
  await expect(main.getByText(roots[0]!.body, { exact: true })).toBeAttached();
  await expect.poll(() => connections.length).toBeGreaterThan(0);
  transportBlocked = true;
  await page.context().setOffline(true);
  for (const close of connections.splice(0)) close();
  const reply = await request.post(`/api/v1/rooms/${channel.id}/messages`, { data: { kind: "text", body: "Reply while browser is disconnected", thread_root_id: roots[54]!.id } });
  expect(reply.status()).toBe(201);
  const report = await request.post(`/api/v1/messages/${roots[0]!.id}/report`, { data: { reason: "Controlled reconnect moderation regression" } });
  expect(report.status()).toBe(200);
  const removal = await request.post(`/api/v1/moderation/reports/${(await report.json()).id}/resolve`, { data: { action: "remove", note: "Controlled fixture removal" } });
  expect(removal.status()).toBe(200);
  await expect(main.getByRole("button", { name: "1 reply", exact: true })).toHaveCount(0);
  await expect(main.getByText(roots[0]!.body, { exact: true })).toBeAttached();
  const snapshots: string[] = [];
  page.on("request", (sent) => {
    const url = new URL(sent.url());
    if (sent.method() === "GET" && url.pathname === `/api/v1/rooms/${channel.id}/messages` && !url.searchParams.has("after") && !url.searchParams.has("before")) snapshots.push(sent.url());
  });
  const reconciled = page.waitForResponse((response) => response.ok() && new URL(response.url()).pathname === `/api/v1/rooms/${channel.id}/messages/reconcile`);
  transportBlocked = false;
  await page.context().setOffline(false);
  await reconciled;
  await expect(main.getByRole("button", { name: "1 reply", exact: true })).toBeVisible();
  await expect(main.getByText(roots[0]!.body, { exact: true })).toHaveCount(0);
  await expect(main.getByText("This message was removed by a team administrator.", { exact: true })).toBeAttached();
  expect(snapshots).toEqual([]);
  const stored = await (await request.get(`/api/v1/rooms/${channel.id}/messages?limit=100`)).json();
  expect(stored.messages).toHaveLength(55);
  expect(stored.messages.at(-1).reply_count).toBe(1);
  await page.screenshot({ path: testInfo.outputPath("reconciled-history.png") });
  await page.reload();
  await expect(main.getByRole("button", { name: "1 reply", exact: true })).toBeVisible();
  await main.getByRole("button", { name: "Load earlier messages", exact: true }).click();
  await expect(main.getByText("This message was removed by a team administrator.", { exact: true })).toBeAttached();
  await expect(main.getByText(roots[0]!.body, { exact: true })).toHaveCount(0);
});
