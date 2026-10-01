import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { installMentionsReadFault } from "./mentions-read-fault.mjs";
import { verifyMentionsResults } from "./mentions-results.mjs";

export const mentionsPeerImageNames = ["mentions-peer-first.png", "mentions-peer-second.png"];
const frozen = (value) => {
  if (value && typeof value === "object") { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
};

export async function readMentionNotifications(request) {
  const notifications = [], cursors = new Set();
  let before, unreadCount;
  for (let page = 0; page < 20; page++) {
    const value = await request(`/api/v1/notifications?limit=100${before ? `&before=${encodeURIComponent(before)}` : ""}`);
    assert.ok(Array.isArray(value.notifications) && value.notifications.every((item) => typeof item?.id === "string" && item.id)
      && typeof value.has_more === "boolean" && Number.isSafeInteger(value.unread_count) && value.unread_count >= 0);
    if (unreadCount === undefined) unreadCount = value.unread_count;
    else assert.equal(value.unread_count, unreadCount, "Notification count changed while reading fixture evidence");
    notifications.push(...value.notifications);
    if (!value.has_more) {
      assert.equal(new Set(notifications.map((item) => item.id)).size, notifications.length);
      return { notifications, unread_count: unreadCount };
    }
    assert.ok(typeof value.next_before === "string" && value.next_before && !cursors.has(value.next_before));
    before = value.next_before; cursors.add(before);
  }
  throw new Error("Mention fixture exceeded its bounded notification inventory");
}

/** Disposable setup and independent sender UI. Recipient navigation, drafts,
 * notification reads and Retry are exclusively owned by the client driver. */
export async function createMentionsScenario({ root, server, origin, browser, ownerHeaders, recipientUserId,
  platform, deviceName, suffix = randomUUID().slice(0, 8), onScreenshot }) {
  assert.ok(["ios", "macos"].includes(platform)); assert.equal(typeof onScreenshot, "function");
  const { expect } = await import("@playwright/test");
  const { provisionUser, createSession } = await import(pathToFileURL(join(root, "apps/server/dist/auth/auth-service.js")).href);
  const abort = new AbortController();
  let peerContext, fault, publication, publicationPromise, requestedDevice, closed = false;
  let publicationStage = "Waiting for recipient readiness";
  const ledger = { expected_messages: [], baseline_notifications: [], initial_project_ids: [], peer_sent_message_ids: [] };
  const request = async (path, body, headers = ownerHeaders) => {
    abort.signal.throwIfAborted();
    const response = await fetch(`${origin}${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json", "Idempotency-Key": randomUUID() }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]) });
    assert.ok(response.ok, `Mention fixture ${body === undefined ? "GET" : "POST"} ${path} failed with HTTP ${response.status}`);
    return response.json();
  };
  const close = async () => {
    if (closed) return;
    closed = true; abort.abort();
    let failure;
    try { await peerContext?.close(); } catch (error) { failure = error; }
    try { await fault?.close(); } catch (error) { failure ??= error; }
    await publicationPromise?.catch(() => {});
    if (failure) throw new Error("Mention fixture context/HTTP restoration cleanup failed");
  };
  try {
    const identity = await request("/auth/session"); assert.equal(identity.user.id, recipientUserId);
    const bootstrap = await request("/api/v1/bootstrap");
    ledger.initial_project_ids = bootstrap.projects.map((project) => project.id);
    const projectA = bootstrap.projects.find((project) => project.id === "proj_artoo"); assert.ok(projectA);
    const baseline = await readMentionNotifications(request);
    ledger.baseline_notifications = structuredClone(baseline.notifications);
    const sender = await provisionUser(server.ctx, { subject: `mentions-sender-${suffix}`, email: "sender@mentions-ui.test",
      emailVerified: true, displayName: `Mention sender ${suffix}` });
    assert.notEqual(sender.userId, recipientUserId);
    const session = await createSession(server.ctx, { ttlMs: 3_600_000 }, { userId: sender.userId });
    const senderHeaders = { Authorization: `Bearer ${session.raw}` };
    const members = (await request("/api/v1/members")).members;
    const recipient = members.find((member) => member.id === recipientUserId); assert.ok(recipient);
    const channelName = `mentions-${suffix}`;
    const channelA = (await request("/api/v1/channels", { project_id: projectA.id, name: channelName, description: "Cross-project draft isolation A" })).channel;
    const post = async (room, body, thread, mention = false) => {
      const message = (await request(`/api/v1/rooms/${room}/messages`, { kind: "text", body, payload: {},
        mentions: mention ? [{ actor_type: "user", actor_id: recipientUserId }] : [], assignments: [],
        ...(thread ? { thread_root_id: thread } : {}) }, senderHeaders)).message;
      ledger.expected_messages.push(structuredClone(message)); return message;
    };
    const rootA = await post(channelA.id, `Project A discussion ${suffix}: keep its draft separate.`);
    const fields = frozen({ project_a_id: projectA.id, project_a_name: projectA.name,
      channel_a_id: channelA.id, channel_a_name: channelA.name, root_a_id: rootA.id, root_a_body: rootA.body,
      recipient_user_id: recipientUserId, recipient_name: recipient.display_name,
      sender_user_id: sender.userId, sender_name: `Mention sender ${suffix}`,
      native_device_name: deviceName ?? `Native mentions iPhone ${suffix}`,
      draft_a: `Unsent project A draft ${suffix}`, draft_b: `Unsent project B draft ${suffix}`,
      first_mention_body: `Historical first mention ${suffix}. Please review the project B decision in this exact thread. This complete reply is deliberately longer than the notification preview, so opening a preview or a newer reply cannot satisfy the check. Preserve the unsent draft while retrying read confirmation. End marker FIRST_${suffix}.`,
      second_mention_body: `Historical second mention ${suffix}. This is another reply in the same project B thread. Opening it must preserve the draft and leave the project A sentinel unread. End marker SECOND_${suffix}.` });
    assert.ok(fields.first_mention_body.length > 240 && fields.first_mention_body.length <= 360);
    ledger.fields = fields;
    // Both complete replies and their shared author must fit in the real
    // conversation viewport when consecutive messages share one header.
    peerContext = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
    await peerContext.addCookies([{ name: "artoo_session", value: session.raw, url: origin, httpOnly: true, sameSite: "Lax" }]);
    const peer = await peerContext.newPage(); peer.setDefaultTimeout(30_000);
    fault = installMentionsReadFault(server.app.server, { origin });
    const publish = ({ deviceId } = {}) => {
      assert.ok(!closed, "Mention scenario is closed");
      if (publicationPromise) { assert.equal(deviceId, requestedDevice, "Publication cannot switch recipient devices"); return publicationPromise; }
      requestedDevice = deviceId;
      publicationPromise = (async () => {
        publicationStage = "Verify the actual paired recipient device and unchanged notification baseline";
        const devices = (await request("/api/v1/devices")).devices;
        const candidates = devices.filter((device) => device.enrolled_by_user_id === recipientUserId && device.platform === platform
          && (deviceId ? device.id === deviceId : device.display_name === fields.native_device_name));
        assert.equal(candidates.length, 1, "Publication must bind one actually paired recipient device");
        const device = candidates[0]; assert.equal(device.revoked_at, null);
        const before = await readMentionNotifications(request);
        assert.deepEqual(before, baseline, "Recipient readiness must not consume or create a notification");
        publicationStage = "Create the late project B, channel and thread through production APIs";
        const projectB = (await request("/api/v1/projects", { name: `Mentions B ${suffix}` })).project;
        assert.ok(!ledger.initial_project_ids.includes(projectB.id), "Project B must be created after the initial bootstrap");
        const channelB = (await request("/api/v1/channels", { project_id: projectB.id, name: channelName, description: "Late-created project B" })).channel;
        const rootB = await post(channelB.id, `Project B discussion ${suffix}: historical replies and read recovery.`);
        // Only the independent peer is navigated directly; the recipient must use UI.
        publicationStage = "Open the independent sender's real Web thread";
        await peer.goto(`${origin}/channels?room=${encodeURIComponent(channelB.id)}&thread=${encodeURIComponent(rootB.id)}`);
        const thread = peer.getByRole("complementary", { name: "Thread", exact: true });
        await expect(thread.getByText(rootB.body, { exact: true })).toBeVisible();
        await expect(peer.getByText("Live updates connected", { exact: true })).toBeVisible();
        const send = async (body, index) => {
          publicationStage = `Send and capture independent peer mention ${index + 1} through Web UI`;
          const form = thread.getByRole("form", { name: "Send room message", exact: true });
          await form.getByLabel("Message", { exact: true }).fill(body);
          const people = form.locator("details");
          if (await people.getAttribute("open") === null) await people.locator("summary").click();
          await form.getByRole("checkbox", { name: `@${recipient.display_name}`, exact: true }).check();
          const received = peer.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/rooms/${channelB.id}/messages`
            && response.request().method() === "POST" && response.request().postDataJSON()?.body === body);
          // A failed click/context close must not leave an unhandled rejection
          // that bypasses the parent's failure report. The original is awaited.
          void received.catch(() => {});
          await form.getByRole("button", { name: "Send message", exact: true }).click();
          const response = await received; assert.ok(response.ok());
          const message = (await response.json()).message;
          assert.equal(message.actor_id, sender.userId); assert.equal(message.body, body); assert.equal(message.thread_root_id, rootB.id);
          assert.deepEqual(message.payload.mentions, [{ actor_type: "user", actor_id: recipientUserId }]);
          ledger.expected_messages.push(structuredClone(message)); ledger.peer_sent_message_ids.push(message.id);
          const messageList = thread.getByRole("list", { name: "Messages", exact: true });
          const row = messageList.getByRole("listitem").filter({ has: peer.getByText(body, { exact: true }) });
          await expect(row).toHaveCount(1);
          if (await people.getAttribute("open") !== null) await people.locator("summary").click();
          const card = row.getByRole("article", { name: "text message", exact: true });
          await expect(messageList.getByRole("listitem")).toHaveCount(index + 1);
          await messageList.scrollIntoViewIfNeeded();
          const text = card.locator(".msg__text"), actor = card.locator(".msg__actor"), mentions = card.getByLabel("Mentioned people", { exact: true });
          const groupActor = messageList.locator(".msg:not(.msg--compact) .msg__actor").last();
          await expect(text).toHaveText(body);
          await expect(actor).toHaveText(`${fields.sender_name} (you)`);
          await expect(groupActor).toHaveText(`${fields.sender_name} (you)`);
          await expect(mentions).toHaveText(`@${recipient.display_name}`);
          // A continuation keeps its author accessible but visually uses the
          // preceding group header. Capture that real header with every complete
          // reply, and reject evidence clipped by either scrollport.
          const visibleContent = [groupActor, ...await messageList.locator(".msg__text, .msg__mentions").all()];
          for (const content of visibleContent) await expect(content).toBeInViewport({ ratio: 1 });
          await onScreenshot({ locator: messageList, name: mentionsPeerImageNames[index],
            caption: `Independent sender browser: ${index === 0 ? "first" : "second"} complete structured mention and its visible author group sent to the recipient` });
          return message;
        };
        const firstMessage = await send(fields.first_mention_body, 0), secondMessage = await send(fields.second_mention_body, 1);
        publicationStage = "Append ordinary history and the independent project A sentinel";
        const later = [];
        for (let index = 0; index < 55; index++) later.push(await post(channelB.id, `Later ordinary project B reply ${index + 1} ${suffix}`, rootB.id));
        const sentinelMessage = await post(channelA.id, `Unread project A sentinel ${suffix}`, rootA.id, true);
        const latest = await request(`/api/v1/rooms/${channelB.id}/messages?thread_root_id=${encodeURIComponent(rootB.id)}&limit=50`);
        assert.equal(latest.messages.length, 50); assert.equal(latest.has_more, true);
        assert.ok(!latest.messages.some((m) => [firstMessage.id, secondMessage.id].includes(m.id)));
        const published = await readMentionNotifications(request);
        assert.equal(published.unread_count, baseline.unread_count + 3);
        const bind = (message, projectId) => {
          const found = published.notifications.filter((notice) => notice.message_id === message.id);
          assert.equal(found.length, 1); const notice = found[0];
          assert.equal(notice.read_at, null); assert.equal(notice.actor_id, sender.userId); assert.equal(notice.project_id, projectId);
          assert.equal(notice.room_id, message.room_id); assert.equal(notice.thread_root_id, message.thread_root_id);
          return { message_id: message.id, notification_id: notice.id, body: message.body, room_id: message.room_id,
            thread_root_id: message.thread_root_id, project_id: projectId, actor_id: sender.userId };
        };
        const first = bind(firstMessage, projectB.id), second = bind(secondMessage, projectB.id), sentinel = bind(sentinelMessage, projectA.id);
        publication = frozen({ project_b: { id: projectB.id, name: projectB.name }, channel_b: { id: channelB.id, name: channelB.name },
          root_b: { id: rootB.id, body: rootB.body }, first, second, sentinel,
          baseline_unread_count: baseline.unread_count, published_unread_count: published.unread_count, recipient_device_id: device.id,
          history: { later_message_ids: later.map((m) => m.id), latest_message_ids: latest.messages.map((m) => m.id), has_more: latest.has_more } });
        ledger.publication = publication;
        publicationStage = "Arm the exact recipient-device pre-handler read failure";
        fault.arm({ notificationId: first.notification_id, notificationIds: [first, second, sentinel].map((m) => m.notification_id),
          userId: recipientUserId, deviceId: device.id });
        publicationStage = "Publication complete; recipient UI owns every read action";
        return publication;
      })();
      return publicationPromise;
    };
    const observe = async () => ({ publication: publication ?? null, ...(await readMentionNotifications(request)),
      baseline_notifications: structuredClone(ledger.baseline_notifications), ...fault.observe() });
    const verify = async () => {
      assert.ok(publication, "A completed mention publication is required");
      const snapshot = await observe(), messages = [];
      for (const [room, threadRoot] of [[fields.channel_a_id, undefined], [fields.channel_a_id, fields.root_a_id],
        [publication.channel_b.id, undefined], [publication.channel_b.id, publication.root_b.id]]) {
        const page = await request(`/api/v1/rooms/${room}/messages?limit=100${threadRoot ? `&thread_root_id=${encodeURIComponent(threadRoot)}` : ""}`);
        assert.equal(page.has_more, false, "The final exercised history must be fully read"); messages.push(...page.messages);
      }
      const latest = await request(`/api/v1/rooms/${publication.channel_b.id}/messages?thread_root_id=${encodeURIComponent(publication.root_b.id)}&limit=50`);
      const identity = await request("/auth/session");
      return verifyMentionsResults({ ledger, snapshot: { ...snapshot, recipient_user_id: identity.user.id, messages, latest_thread: latest } });
    };
    return { fields, publish, observe, verify, close, get publicationStage() { return publicationStage; } };
  } catch (error) { await close(); throw error; }
}
