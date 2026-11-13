import { expect, test } from "@playwright/test";

test("inline member selection keeps keyboard, pointer, recipients and the narrow composer usable", async ({ page, request }, testInfo) => {
  const membersResponse = await request.get("/api/v1/members");
  expect(membersResponse.ok()).toBe(true);
  const { members } = await membersResponse.json();
  expect(members.length).toBeGreaterThan(0);
  const person = members[0];
  const created = await request.post("/api/v1/channels", { data: { project_id: "proj_artoo", name: `inline-${Date.now()}`, description: "Controlled member suggestion check" } });
  expect(created.ok()).toBe(true);
  const { channel } = await created.json();
  const validated = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/rooms/${channel.id}`);
  await page.goto(`/channels?room=${encodeURIComponent(channel.id)}`);
  expect((await validated).ok()).toBe(true);
  const composer = page.getByRole("region", { name: "Channel conversation", exact: true }).getByRole("form", { name: "Send room message", exact: true });
  const input = composer.getByLabel("Message", { exact: true });
  let posts = 0;
  page.on("request", item => { if (item.method() === "POST" && new URL(item.url()).pathname === `/api/v1/rooms/${channel.id}/messages`) posts++; });
  for (const [width, theme] of [[1440, "dark"], [320, "dark"], [320, "light"]] as const) {
    await page.setViewportSize({ width, height: width === 320 ? 667 : 900 });
    if (theme === "light") await page.getByRole("button", { name: "Switch to light theme", exact: true }).click();
    await input.scrollIntoViewIfNeeded();
    await input.fill(`@${person.display_name.slice(0, 1)}`);
    const list = composer.getByRole("listbox", { name: "People to mention", exact: true });
    const option = list.getByRole("option", { name: `@${person.display_name}`, exact: true });
    await expect(option).toBeVisible();
    const bounds = await list.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const before = posts;
    if (width === 1440) {
      await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowUp");
      await expect(option).toHaveAttribute("aria-selected", "true");
      await page.screenshot({ path: testInfo.outputPath(`inline-mentions-${theme}-${width}.png`) });
      await page.keyboard.press("Enter");
    } else {
      await option.scrollIntoViewIfNeeded();
      expect(await option.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
      })).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`inline-mentions-${theme}-${width}.png`) });
      await option.click();
    }
    await expect(input).toHaveValue(`@${person.display_name} `);
    await expect(input).toBeFocused();
    await expect(list).toHaveCount(0);
    expect(posts).toBe(before);
    const fallback = composer.locator(".conversation-composer__mentions");
    await fallback.locator("summary").click();
    await expect(fallback.getByRole("checkbox", { name: `@${person.display_name}`, exact: true })).toBeChecked();
    await fallback.locator("summary").click();
    await input.focus();
    const sent = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/v1/rooms/${channel.id}/messages`);
    await page.keyboard.press("Enter");
    const response = await sent;
    expect(response.ok()).toBe(true);
    expect(response.request().postDataJSON().mentions).toEqual([{ actor_type: "user", actor_id: person.id }]);
    expect((await response.json()).message.body).toBe(`@${person.display_name}`);
    await expect(input).toHaveValue("");
    expect(posts).toBe(before + 1);
  }
});
