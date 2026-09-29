import { expect, test, type APIRequestContext } from "@playwright/test";
import type { Channel, Message, Notification, NotificationPage } from "@artoo/domain";

async function post<T>(request: APIRequestContext, url: string, data: unknown): Promise<T> {
  const response = await request.post(`/api/v1${url}`, { data });
  expect(response.ok(), `${url}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}
async function createChannel(request: APIRequestContext, project: string, name: string): Promise<Channel> {
  return (await post<{ channel: Channel }>(request, "/channels", { project_id: project, name, description: "Notification navigation regression" })).channel;
}
async function send(request: APIRequestContext, room: string, body: string, thread?: string, recipient?: string): Promise<Message> {
  return (await post<{ message: Message }>(request, `/rooms/${room}/messages`, { kind: "text", body, ...(thread ? { thread_root_id: thread } : {}), ...(recipient ? { mentions: [{ actor_type: "user", actor_id: recipient }] } : {}) })).message;
}
async function inbox(request: APIRequestContext): Promise<Notification[]> {
  const notifications: Notification[] = [];
  let before: string | null = null;
  do {
    const query = new URLSearchParams({ limit: "100", ...(before ? { before } : {}) });
    const response = await request.get(`/api/v1/notifications?${query}`);
    expect(response.ok()).toBe(true);
    const page = await response.json() as NotificationPage;
    notifications.push(...page.notifications);
    before = page.has_more ? page.next_before : null;
  } while (before);
  return notifications;
}

test("old unread notifications remain reachable beyond 100 and display the exact reply before becoming read", async ({ page, request }, testInfo) => {
  test.setTimeout(120_000);
  const bootstrap = await (await request.get("/api/v1/bootstrap")).json();
  const channel = await createChannel(request, bootstrap.projects[0].id, `history-${Date.now()}`);
  const root = await send(request, channel.id, "Historical notification thread root");
  const mentioned = await send(request, channel.id, "Exact historical reply that still needs your review", root.id, bootstrap.user.id);
  for (let index = 0; index < 55; index++) await send(request, channel.id, `Later thread reply ${index}`, root.id);
  for (let index = 0; index < 105; index++) await send(request, channel.id, `Newer already-read mention ${index}`, undefined, bootstrap.user.id);
  const notifications = await inbox(request);
  const old = notifications.find((item) => item.message_id === mentioned.id)!;
  expect(notifications.indexOf(old)).toBeGreaterThan(100);
  for (const notification of notifications) if (notification.id !== old.id && !notification.read_at) await post(request, `/notifications/${notification.id}/read`, {});
  const newest = await (await request.get("/api/v1/notifications?limit=50")).json() as NotificationPage;
  expect(newest.unread_count).toBe(1);
  expect(newest.notifications.every((item) => item.read_at !== null)).toBe(true);
  const latestReplies = await (await request.get(`/api/v1/rooms/${channel.id}/messages?thread_root_id=${root.id}&limit=50`)).json();
  expect(latestReplies.messages.some((message: Message) => message.id === mentioned.id)).toBe(false);

  // The ordinary server seeds and serves every message. Only the exact lookup
  // is temporarily failed to prove a failed navigation cannot consume a notice.
  const targetUrl = `**/api/v1/rooms/${channel.id}/messages/${mentioned.id}`;
  let failedLookups = 0;
  await page.route(targetUrl, async (route) => {
    const retryClicked = await page.evaluate(() => document.documentElement.dataset.notificationRetryClicked === "true");
    if (retryClicked) await route.continue();
    else {
      failedLookups++;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "unavailable", message: "Temporary message lookup failure" } }) });
    }
  });
  await page.goto("/channels?mentions=1");
  await expect(page.getByRole("button", { name: "Mentions, 1 unread", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Exact historical reply/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Load earlier notifications", exact: true }).click();
  await expect(page.getByRole("button", { name: "Newer already-read mention 5", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Load earlier notifications", exact: true }).click();
  await page.getByRole("button", { name: /Exact historical reply that still needs your review/ }).click();
  const thread = page.getByRole("complementary", { name: "Thread", exact: true });
  await expect(thread.getByRole("button", { name: "Retry opening message", exact: true })).toBeVisible();
  expect((await inbox(request)).find((item) => item.id === old.id)?.read_at).toBeNull();
  await expect(page.getByRole("button", { name: "Mentions, 1 unread", exact: true })).toBeVisible();
  // Reconnection may refetch an errored query before Playwright activates its
  // retry button. Keep the fault active through that background request.
  const failuresBeforeReconnect = failedLookups;
  await page.context().setOffline(true);
  await page.context().setOffline(false);
  await expect.poll(() => failedLookups).toBeGreaterThan(failuresBeforeReconnect);
  await expect(thread.getByRole("button", { name: "Retry opening message", exact: true })).toBeVisible();
  expect((await inbox(request)).find((item) => item.id === old.id)?.read_at).toBeNull();
  // Release the fault in the actual click event, before React starts the lookup.
  // A delegated listener survives a background refetch replacing the button.
  await page.evaluate(() => {
    document.addEventListener("click", (event) => {
      const button = event.target instanceof Element ? event.target.closest("button") : null;
      if (button?.textContent?.trim() === "Retry opening message") document.documentElement.dataset.notificationRetryClicked = "true";
    }, { capture: true });
  });
  await thread.getByRole("button", { name: "Retry opening message", exact: true }).click();
  await expect(thread.getByRole("region", { name: "Mentioned reply", exact: true })).toContainText(mentioned.body!);
  await page.unroute(targetUrl);
  await expect(thread.getByRole("list", { name: "Messages", exact: true })).not.toContainText(mentioned.body!);
  await expect.poll(async () => (await inbox(request)).find((item) => item.id === old.id)?.read_at).not.toBeNull();
  await expect(page.getByRole("button", { name: "Mentions, 0 unread", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("region", { name: "Mentioned reply", exact: true })).toContainText(mentioned.body!);
  await page.screenshot({ path: testInfo.outputPath("historical-mention.png"), fullPage: true });
});

test("project switching clears the old thread and cross-project mentions restore the correct destination", async ({ page, request }) => {
  const bootstrap = await (await request.get("/api/v1/bootstrap")).json();
  const suffix = Date.now();
  const first = (await post<{ project: { id: string } }>(request, "/projects", { name: `Notification project A ${suffix}` })).project;
  const second = (await post<{ project: { id: string } }>(request, "/projects", { name: `Notification project B ${suffix}` })).project;
  const firstChannel = await createChannel(request, first.id, "project-a");
  const secondChannel = await createChannel(request, second.id, "project-b");
  const firstRoot = await send(request, firstChannel.id, "First project's discussion");
  const secondRoot = await send(request, secondChannel.id, "Second project's discussion");
  const mention = await send(request, secondChannel.id, "Please review project B specifically", secondRoot.id, bootstrap.user.id);
  const notification = (await inbox(request)).find((item) => item.message_id === mention.id)!;
  expect(notification.project_id).toBe(second.id);
  // A conflicting URL hint must be corrected from the room API before a
  // composer is enabled; the displayed project must match the destination.
  await page.goto(`/channels?room=${firstChannel.id}&thread=${firstRoot.id}&project=${second.id}`);
  await expect(page.getByLabel("Project", { exact: true })).toHaveValue(first.id);
  await expect(page.getByRole("complementary", { name: "Thread", exact: true })).toContainText(firstRoot.body!);
  await page.getByLabel("Project", { exact: true }).selectOption(second.id);
  await expect(page.getByRole("heading", { name: "# project-b", exact: true })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Thread", exact: true })).toHaveCount(0);
  for (const key of ["room", "thread", "message", "notification", "project"]) expect(new URL(page.url()).searchParams.has(key)).toBe(false);
  const conversation = page.getByRole("region", { name: "Channel conversation", exact: true });
  await conversation.getByLabel("Message", { exact: true }).fill("This must only reach project B");
  await conversation.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(conversation.getByRole("list", { name: "Messages", exact: true })).toContainText("This must only reach project B");
  const firstMessages = await (await request.get(`/api/v1/rooms/${firstChannel.id}/messages`)).json();
  expect(firstMessages.messages.some((message: Message) => message.body === "This must only reach project B")).toBe(false);
  const secondMessages = await (await request.get(`/api/v1/rooms/${secondChannel.id}/messages`)).json();
  expect(secondMessages.messages.some((message: Message) => message.body === "This must only reach project B")).toBe(true);

  // Legacy links without a project also resolve from authoritative room data.
  await page.goto(`/channels?room=${firstChannel.id}`);
  await expect(page.getByLabel("Project", { exact: true })).toHaveValue(first.id);
  await expect(page.getByRole("heading", { name: "# project-a", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Mentions,/ }).click();
  await page.getByRole("button", { name: /Please review project B specifically/ }).click();
  await expect(page.getByLabel("Project", { exact: true })).toHaveValue(second.id);
  const thread = page.getByRole("complementary", { name: "Thread", exact: true });
  await expect(thread.getByRole("region", { name: "Mentioned reply", exact: true })).toContainText(mention.body!);
  expect(new URL(page.url()).searchParams.get("room")).toBe(secondChannel.id);
  expect(new URL(page.url()).searchParams.get("project")).toBe(second.id);
  await expect.poll(async () => (await inbox(request)).find((item) => item.id === notification.id)?.read_at).not.toBeNull();
});

test("a failed read can recover after visiting another notification in the same thread", async ({ page, request }) => {
  const bootstrap = await (await request.get("/api/v1/bootstrap")).json();
  const channel = await createChannel(request, bootstrap.projects[0].id, `read-retry-${Date.now()}`);
  const root = await send(request, channel.id, "One thread with two independent mentions");
  const first = await send(request, channel.id, "Mention A must recover after a failed read", root.id, bootstrap.user.id);
  const second = await send(request, channel.id, "Mention B can be read independently", root.id, bootstrap.user.id);
  const notices = await inbox(request);
  const firstNotice = notices.find((item) => item.message_id === first.id)!;
  const secondNotice = notices.find((item) => item.message_id === second.id)!;
  let firstReadRequests = 0;
  await page.route(`**/api/v1/notifications/${firstNotice.id}/read`, async (route) => {
    firstReadRequests++;
    if (firstReadRequests === 1) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "unavailable", message: "Temporary read failure" } }) });
    else await route.continue();
  });
  await page.goto("/channels?mentions=1");
  await page.getByRole("button", { name: /Mention A must recover/ }).click();
  const thread = page.getByRole("complementary", { name: "Thread", exact: true });
  await expect(thread.getByRole("region", { name: "Mentioned reply", exact: true })).toContainText(first.body!);
  await expect(thread.getByRole("button", { name: "Retry marking notification read", exact: true })).toBeVisible();
  expect((await inbox(request)).find((item) => item.id === firstNotice.id)?.read_at).toBeNull();
  await thread.getByLabel("Message", { exact: true }).fill("Draft must survive notification navigation");
  const openMentions = async (): Promise<void> => {
    const panel = page.locator("details.notifications-panel");
    if (await panel.getAttribute("open") === null) await panel.locator("summary").click();
  };
  // Use the inline list without leaving this room/thread. A full page or route
  // reset would hide the failed-notification state leak this test guards.
  await openMentions();
  await page.getByRole("button", { name: /Mention B can be read independently/ }).click();
  await expect(thread.getByRole("region", { name: "Mentioned reply", exact: true })).toContainText(second.body!);
  await expect.poll(async () => (await inbox(request)).find((item) => item.id === secondNotice.id)?.read_at).not.toBeNull();
  expect((await inbox(request)).find((item) => item.id === firstNotice.id)?.read_at).toBeNull();
  await expect(thread.getByLabel("Message", { exact: true })).toHaveValue("Draft must survive notification navigation");
  await openMentions();
  await page.getByRole("button", { name: /Mention A must recover/ }).click();
  await expect(thread.getByRole("region", { name: "Mentioned reply", exact: true })).toContainText(first.body!);
  await expect.poll(async () => (await inbox(request)).find((item) => item.id === firstNotice.id)?.read_at).not.toBeNull();
  expect(firstReadRequests).toBe(2);
  await expect(thread.getByRole("button", { name: "Retry marking notification read", exact: true })).toHaveCount(0);
  await expect(thread.getByLabel("Message", { exact: true })).toHaveValue("Draft must survive notification navigation");
});
