import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

export const macMentionsImageNames = [
  "macos-mentions-a-draft.png", "mentions-peer-first.png", "mentions-peer-second.png",
  "macos-mentions-historical-reply.png", "macos-mentions-read-failed.png", "macos-mentions-b-draft.png",
  "macos-mentions-read-retried.png", "macos-mentions-second-reply.png",
  "macos-mentions-a-restored.png", "macos-mentions-b-restored.png",
];

export function installedMentionRoute(url) {
  const page = new URL(url);
  assert.equal(page.protocol, "file:", "Mention navigation must stay in the installed renderer");
  assert.ok(page.hash.startsWith("#/"), "Installed navigation must use its real hash router");
  const route = new URL(page.hash.slice(1), "https://installed.invalid");
  return { pathname: route.pathname, search: Object.fromEntries(route.searchParams) };
}

/** This boundary checks observations only. Neither the helper nor the verifier
 * can acknowledge a notification in place of the installed recipient UI. */
export function assertMacMentionBoundary({ observation, publication, recipientUserId, firstRead = false, secondRead = false, firstAttempts }) {
  const targets = [publication.first, publication.second, publication.sentinel];
  const expectedRead = [firstRead, secondRead, false];
  assert.equal(observation.notifications.length, observation.baseline_notifications.length + 3);
  for (const [index, target] of targets.entries()) {
    const matches = observation.notifications.filter((item) => item.id === target.notification_id);
    assert.equal(matches.length, 1);
    const notice = matches[0];
    for (const field of ["message_id", "room_id", "thread_root_id", "project_id", "actor_id"]) assert.equal(notice[field], target[field]);
    if (expectedRead[index]) assert.ok(typeof notice.read_at === "string" && notice.read_at.length > 0);
    else assert.equal(notice.read_at, null);
  }
  for (const baseline of observation.baseline_notifications) {
    assert.deepEqual(observation.notifications.find((item) => item.id === baseline.id), baseline, "Existing notifications must remain unchanged");
  }
  assert.equal(observation.unread_count, publication.baseline_unread_count + 3 - Number(firstRead) - Number(secondRead));
  const attempts = observation.read_attempts.filter((item) => item.notification_id === publication.first.notification_id);
  if (firstAttempts !== undefined) assert.equal(attempts.length, firstAttempts);
  assert.ok(attempts.length >= (firstRead ? 2 : 1), "The installed client must have performed each claimed acknowledgement");
  for (const [index, attempt] of attempts.entries()) {
    assert.equal(attempt.method, "POST"); assert.equal(attempt.path, `/api/v1/notifications/${publication.first.notification_id}/read`);
    assert.equal(attempt.device_id, publication.recipient_device_id); assert.equal(attempt.user_id, recipientUserId);
    assert.equal(attempt.response_finished, true);
    assert.equal(attempt.status, index === 0 ? 503 : 200);
    assert.equal(attempt.injected, index === 0); assert.equal(attempt.forwarded, index !== 0);
  }
  const secondAttempts = observation.read_attempts.filter((item) => item.notification_id === publication.second.notification_id);
  assert.ok(secondRead ? secondAttempts.length > 0 : secondAttempts.length === 0);
  for (const attempt of secondAttempts) {
    assert.equal(attempt.method, "POST"); assert.equal(attempt.path, `/api/v1/notifications/${publication.second.notification_id}/read`);
    assert.equal(attempt.device_id, publication.recipient_device_id); assert.equal(attempt.user_id, recipientUserId);
    assert.equal(attempt.response_finished, true); assert.equal(attempt.status, 200);
    assert.equal(attempt.injected, false); assert.equal(attempt.forwarded, true);
  }
  assert.equal(observation.read_attempts.filter((item) => item.injected).length, 1);
  assert.equal(observation.read_attempts.filter((item) => item.notification_id === publication.sentinel.notification_id).length, 0);
  return { unread_count: observation.unread_count,
    notifications: targets.map((target) => ({ notification_id: target.notification_id,
      read_at: observation.notifications.find((item) => item.id === target.notification_id).read_at })),
    first_read_attempts: attempts.map((item) => ({ ...item })) };
}

export async function observeMacMentionFailure(read, { now = () => performance.now(), pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const started = now(); let samples = 0;
  do {
    await read(); samples += 1;
    if (now() - started >= 3100 && samples >= 2) break;
    await pause(250);
  } while (true);
  return { minimum_ms: 3100, observed_ms: now() - started, samples };
}

export async function captureMacMentionScreenshot(target, { artifactDir, filename, caption, evidence, onScreenshot }) {
  assert.ok(macMentionsImageNames.includes(filename), "Unknown mention evidence image");
  const path = join(artifactDir, filename);
  await target.screenshot({ path, timeout: 30_000, animations: "disabled" });
  assert.ok(existsSync(path));
  const image = { path, caption };
  evidence.screenshots.push(image); onScreenshot(image);
}

export async function runInstalledMacMentions({ page, root, server, browser, baseUrl, ownerCookie, artifactDir, onEvidence, onScreenshot }) {
  assert.equal(process.platform, "darwin");
  const { expect } = await import("@playwright/test");
  const { createMentionsScenario } = await import("../../../scripts/fixtures/mentions-scenario.mjs");
  const evidence = { result: "fail", scope: "Installed Mac recipient and independent sender browser; historical cross-project mentions with one exact pre-handler read failure",
    checks: [], screenshots: [], observations: {} };
  onEvidence(evidence);
  const capture = (target, filename, caption) => captureMacMentionScreenshot(target, { artifactDir, filename, caption, evidence, onScreenshot });
  const viewport = async (target, filename, caption) => {
    await target.scrollIntoViewIfNeeded();
    await expect(target).toBeVisible(); await expect(target).toBeInViewport({ ratio: 1 });
    await capture(page, filename, caption);
  };
  const check = (name) => { evidence.checks.push(name); console.log(`[mac-mentions] PASS ${name}`); };
  const hash = (body) => createHash("sha256").update(body).digest("hex");
  let scenario, publication, failure;
  let stage = "prepare the shared scenario after real Mac pairing";
  try {
    for (const filename of macMentionsImageNames) rmSync(join(artifactDir, filename), { force: true });
    scenario = await createMentionsScenario({ root, server, origin: baseUrl, browser, ownerHeaders: { Cookie: ownerCookie },
      recipientUserId: "user_owner", platform: "macos", suffix: randomUUID().slice(0, 8),
      onScreenshot: async ({ locator, name, caption }) => capture(locator, name, caption),
    });
    const fields = scenario.fields;
    const projectPicker = page.getByLabel("Project", { exact: true });
    const channelList = page.getByRole("navigation", { name: "Channel list", exact: true });
    const conversation = page.getByRole("region", { name: "Channel conversation", exact: true });
    const thread = page.getByRole("complementary", { name: "Thread", exact: true });
    const draft = () => thread.getByLabel("Message", { exact: true });
    const openAThread = async () => {
      await channelList.getByRole("button", { name: `# ${fields.channel_a_name}`, exact: true }).click();
      const row = conversation.getByRole("list", { name: "Messages", exact: true }).getByRole("listitem")
        .filter({ has: page.getByText(fields.root_a_body, { exact: true }) });
      await expect(row).toHaveCount(1);
      await row.getByRole("button", { name: /^(Reply in thread|\d+ replies)$/ }).click();
      await expect(thread.getByText(fields.root_a_body, { exact: true })).toBeVisible();
      assert.equal(installedMentionRoute(page.url()).search.thread, fields.root_a_id);
    };
    const unread = (count) => page.getByRole("button", { name: `Mentions, ${count} unread`, exact: true });
    const notificationPanel = page.locator("details.notifications-panel");
    const openInlineMentions = async () => {
      if (await notificationPanel.getAttribute("open") === null) await notificationPanel.locator("summary").click();
    };
    const notificationButton = (target) => notificationPanel.getByRole("button")
      .filter({ has: page.getByText(target.body.slice(0, 240), { exact: true }) });
    const mentionedReply = () => thread.getByRole("region", { name: "Mentioned reply", exact: true });
    const destination = async (target) => {
      await expect(projectPicker).toHaveValue(publication.project_b.id);
      await expect(page.getByRole("heading", { name: `# ${publication.channel_b.name}`, exact: true })).toBeVisible();
      await expect(thread.getByText(publication.root_b.body, { exact: true })).toBeVisible();
      await expect(mentionedReply().getByText(target.body, { exact: true })).toBeVisible();
      await expect(mentionedReply().getByText(fields.sender_name, { exact: true })).toBeVisible();
      const route = installedMentionRoute(page.url());
      assert.equal(route.pathname, "/channels");
      assert.deepEqual(route.search, { room: publication.channel_b.id, thread: publication.root_b.id,
        message: target.message_id, project: publication.project_b.id,
        ...(route.search.notification ? { notification: target.notification_id } : {}) });
    };
    const boundary = async (options) => assertMacMentionBoundary({ observation: await scenario.observe(), publication,
      recipientUserId: fields.recipient_user_id, ...options });
    const waitBoundary = async (options) => {
      let result;
      await expect(async () => { result = await boundary(options); }).toPass({ timeout: 30_000, intervals: [100, 250, 500] });
      return result;
    };

    stage = "retain an A-thread draft before another client creates project B";
    await page.getByRole("link", { name: "Channels", exact: true }).click();
    await projectPicker.selectOption(fields.project_a_id);
    await openAThread();
    await draft().fill(fields.draft_a); await expect(draft()).toHaveValue(fields.draft_a);
    const originalProjectIds = await projectPicker.locator("option").evaluateAll((options) => options.map((option) => option.value));
    await expect(projectPicker).toHaveValue(fields.project_a_id);
    await viewport(draft(), "macos-mentions-a-draft.png", "Installed Mac: the unsent project A thread draft is present before project B exists");
    const connection = await page.evaluate(() => window.artooDesktop.getConnection());
    assert.ok(connection.deviceId, "The scenario must bind the actual paired Mac device");
    publication = await scenario.publish({ deviceId: connection.deviceId });
    assert.ok(!originalProjectIds.includes(publication.project_b.id));
    assert.equal(publication.published_unread_count, publication.baseline_unread_count + 3);
    assert.equal(publication.history.later_message_ids.length, 55); assert.equal(publication.history.latest_message_ids.length, 50);
    assert.equal(publication.history.has_more, true);
    assert.ok([publication.first, publication.second].every((item) => !publication.history.latest_message_ids.includes(item.message_id)));
    assert.ok(publication.first.body.length > 240, "Exact navigation must reveal more than the notification preview");
    await expect(projectPicker).toHaveValue(fields.project_a_id); await expect(draft()).toHaveValue(fields.draft_a);
    await expect(unread(publication.published_unread_count)).toBeVisible();
    evidence.publication = { project_a_id: fields.project_a_id, project_b_id: publication.project_b.id,
      channel_b_id: publication.channel_b.id, root_b_id: publication.root_b.id, recipient_device_id: publication.recipient_device_id,
      first_message_id: publication.first.message_id, second_message_id: publication.second.message_id,
      baseline_unread_count: publication.baseline_unread_count, history: publication.history };
    check("An independent browser sent both mentions after A was open; 55 later replies exclude both exact targets from the latest 50");

    stage = "open the full historical reply and retain the actual failed read acknowledgement";
    await unread(publication.published_unread_count).click();
    const firstReadPath = `/api/v1/notifications/${publication.first.notification_id}/read`;
    const responseFor = (status) => {
      const pending = page.waitForResponse((response) => new URL(response.url()).pathname === firstReadPath
        && response.request().method() === "POST" && response.status() === status, { timeout: 30_000 });
      // If the UI click itself fails, its pending waiter must not interrupt
      // the enclosing harness's cleanup and retained failure report.
      void pending.catch(() => {});
      return pending;
    };
    const failedRead = responseFor(503);
    await notificationButton(publication.first).click(); await failedRead;
    await destination(publication.first);
    const retry = thread.getByRole("button", { name: "Retry marking notification read", exact: true });
    await expect(retry).toBeVisible();
    await waitBoundary({ firstAttempts: 1 });
    await viewport(mentionedReply(), "macos-mentions-historical-reply.png", "Installed Mac: the complete historical reply and sender are visible in project B, beyond the notification preview");
    await viewport(retry, "macos-mentions-read-failed.png", "Installed Mac: the exact read acknowledgement failed and offers an explicit Retry; all three new notifications remain unread");
    await draft().fill(fields.draft_b); await expect(draft()).toHaveValue(fields.draft_b);
    await viewport(draft(), "macos-mentions-b-draft.png", "Installed Mac: a separate unsent B-thread draft survives while the read acknowledgement remains failed");
    evidence.observations.failed_before_retry = await observeMacMentionFailure(async () => {
      await boundary({ firstAttempts: 1 }); await expect(draft()).toHaveValue(fields.draft_b);
    });
    evidence.observations.failed_boundary = await boundary({ firstAttempts: 1 });
    check("Exact project, room, root and full reply rendered before a device-bound 503; no automatic read retry occurred for at least 3.1 seconds");

    stage = "retry the failed acknowledgement through its existing UI control";
    const successfulRead = responseFor(200);
    await retry.click(); await successfulRead;
    evidence.observations.after_retry = await waitBoundary({ firstRead: true, firstAttempts: 2 });
    await expect(retry).toHaveCount(0); await expect(draft()).toHaveValue(fields.draft_b);
    await expect(unread(publication.baseline_unread_count + 2)).toBeVisible();
    await viewport(mentionedReply(), "macos-mentions-read-retried.png", `Installed Mac: the first historical reply after explicit Retry; the mention badge now reports ${publication.baseline_unread_count + 2} unread`);

    stage = "open the second mention without consuming A's sentinel or losing the B draft";
    await openInlineMentions(); await notificationButton(publication.second).click();
    await destination(publication.second);
    evidence.observations.after_second = await waitBoundary({ firstRead: true, secondRead: true });
    assert.equal(evidence.observations.after_second.notifications[0].read_at, evidence.observations.after_retry.notifications[0].read_at);
    await expect(unread(publication.baseline_unread_count + 1)).toBeVisible(); await expect(draft()).toHaveValue(fields.draft_b);
    await viewport(mentionedReply(), "macos-mentions-second-reply.png", "Installed Mac: the second exact historical reply and its sender after read confirmation");
    await openInlineMentions(); await notificationButton(publication.first).click(); await destination(publication.first);
    await expect(draft()).toHaveValue(fields.draft_b);
    check("UI Retry performed the production read; the second mention changed unread by exactly one and the unrelated sentinel stayed unread");

    stage = "restore both thread drafts across project switching and installed renderer reload";
    await projectPicker.selectOption(fields.project_a_id);
    await expect(thread).toHaveCount(0);
    const switched = installedMentionRoute(page.url());
    for (const key of ["room", "thread", "message", "notification", "project"]) assert.ok(!(key in switched.search));
    await openAThread(); await expect(draft()).toHaveValue(fields.draft_a);
    await viewport(draft(), "macos-mentions-a-restored.png", "Installed Mac: switching back to project A restores its own unsent thread draft");
    await page.reload();
    await unread(publication.baseline_unread_count + 1).click();
    await notificationButton(publication.first).click(); await destination(publication.first);
    await expect(draft()).toHaveValue(fields.draft_b);
    await viewport(draft(), "macos-mentions-b-restored.png", "Installed Mac: after a real renderer reload, reopening the B mention restores its separate unsent draft");
    evidence.observations.final = await waitBoundary({ firstRead: true, secondRead: true });
    evidence.observations.drafts = { project_a_sha256: hash(fields.draft_a), project_b_sha256: hash(fields.draft_b), renderer_reloaded: true };
    evidence.verification = await scenario.verify();
    check("Project navigation clears the old thread, both drafts persist, and read-only server verification confirms neither was sent");
    evidence.result = "pass";
  } catch (error) {
    evidence.result = "fail"; evidence.failed_stage = stage;
    evidence.publication_stage = scenario?.publicationStage ?? null;
    evidence.error = `Installed Mac mention verification failed during: ${stage}`;
    failure = new Error(evidence.error, { cause: error });
  } finally {
    try { await scenario?.close(); evidence.cleanup = { scenario_close_attempted: !!scenario, scenario_closed: scenario ? true : null }; }
    catch {
      evidence.result = "fail"; evidence.cleanup = { scenario_closed: false };
      evidence.error ??= "Installed Mac mention scenario cleanup failed";
      failure ??= new Error(evidence.error);
    }
  }
  if (failure) throw failure;
  return evidence;
}
