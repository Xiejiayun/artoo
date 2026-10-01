import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { writeE2EReport } from "../../../scripts/e2e-report.mjs";
import { assertMacMentionBoundary, captureMacMentionScreenshot, installedMentionRoute, macMentionsImageNames, observeMacMentionFailure } from "./installed-mac-mentions.mjs";

test("installed routes read the hash destination rather than file URL search parameters", () => {
  assert.deepEqual(installedMentionRoute("file:///Applications/Artoo.app/app.asar/renderer/index.html?room=wrong#/channels?room=right&thread=root%2Fone&message=target&project=B"),
    { pathname: "/channels", search: { room: "right", thread: "root/one", message: "target", project: "B" } });
  for (const url of ["https://example.test/channels?room=right", "file:///tmp/index.html?room=right"]) assert.throws(() => installedMentionRoute(url));
});

function boundaryFixture({ firstRead = false, secondRead = false } = {}) {
  const target = (name, project) => ({ notification_id: `notice-${name}`, message_id: `message-${name}`,
    room_id: `room-${project}`, thread_root_id: `root-${project}`, project_id: project, actor_id: "sender", body: name });
  const publication = { first: target("first", "B"), second: target("second", "B"), sentinel: target("sentinel", "A"),
    recipient_device_id: "owned-mac", baseline_unread_count: 1 };
  const old = { id: "baseline", read_at: null };
  const notifications = [old, ...[publication.first, publication.second, publication.sentinel].map((item, index) => ({
    id: item.notification_id, message_id: item.message_id, room_id: item.room_id, thread_root_id: item.thread_root_id,
    project_id: item.project_id, actor_id: item.actor_id, read_at: (index === 0 ? firstRead : index === 1 && secondRead) ? "2026-10-01" : null,
  }))];
  const attempt = (sequence) => ({ sequence, method: "POST", path: "/api/v1/notifications/notice-first/read",
    status: sequence === 1 ? 503 : 200, injected: sequence === 1, forwarded: sequence !== 1,
    response_finished: true, notification_id: "notice-first", user_id: "recipient", device_id: "owned-mac" });
  const observation = { notifications, baseline_notifications: [structuredClone(old)], unread_count: 4 - Number(firstRead) - Number(secondRead),
    read_attempts: firstRead ? [attempt(1), attempt(2)] : [attempt(1)] };
  if (secondRead) observation.read_attempts.push({ ...attempt(3), notification_id: "notice-second", path: "/api/v1/notifications/notice-second/read" });
  return { publication, observation, recipientUserId: "recipient", firstRead, secondRead, firstAttempts: firstRead ? 2 : 1 };
}

test("the failed and explicitly retried boundaries retain exact counts and the unread sentinel", () => {
  for (const state of [{}, { firstRead: true }, { firstRead: true, secondRead: true }]) {
    const input = boundaryFixture(state), result = assertMacMentionBoundary(input);
    assert.equal(result.unread_count, input.observation.unread_count);
    assert.equal(result.notifications[2].read_at, null);
  }
});

test("premature reads, unrelated notification changes and automatic retries cannot pass the failed boundary", () => {
  for (const change of [
    (input) => { input.observation.notifications[1].read_at = "premature"; },
    (input) => { input.observation.notifications[3].read_at = "sentinel consumed"; },
    (input) => { input.observation.notifications[0].read_at = "baseline changed"; },
    (input) => { input.observation.unread_count--; },
    (input) => { input.observation.notifications[1].room_id = "wrong-room"; },
    (input) => { input.observation.read_attempts.push({ ...input.observation.read_attempts[0], sequence: 2, status: 200, injected: false, forwarded: true }); },
  ]) {
    const input = boundaryFixture(); change(input); assert.throws(() => assertMacMentionBoundary(input));
  }
});

test("read evidence must bind the actual recipient device and a finished exact HTTP request", () => {
  for (const change of [{ device_id: "another-device" }, { user_id: "another-user" }, { method: "GET" },
    { path: "/api/v1/notifications/unrelated/read" }, { response_finished: false }, { forwarded: true }, { injected: false }]) {
    const input = boundaryFixture(); Object.assign(input.observation.read_attempts[0], change);
    assert.throws(() => assertMacMentionBoundary(input));
  }
});

test("later idempotent successful reads are permitted without repeating the injected failure", () => {
  const input = boundaryFixture({ firstRead: true, secondRead: true });
  input.firstAttempts = undefined;
  input.observation.read_attempts.push({ ...input.observation.read_attempts[1], sequence: 3 });
  assert.equal(assertMacMentionBoundary(input).first_read_attempts.length, 3);
  input.observation.read_attempts.at(-1).injected = true;
  assert.throws(() => assertMacMentionBoundary(input));
});

test("failed read stability requires repeated unchanged observations for at least 3.1 seconds", async () => {
  let time = 0, reads = 0;
  const result = await observeMacMentionFailure(async () => { reads++; assertMacMentionBoundary(boundaryFixture()); }, {
    now: () => time, pause: async (ms) => { time += ms; },
  });
  assert.ok(result.observed_ms >= 3100); assert.ok(reads > 2); assert.equal(result.samples, reads);
  time = 0; reads = 0;
  await assert.rejects(observeMacMentionFailure(async () => {
    if (++reads === 3) throw new Error("Unexpected acknowledgement");
  }, { now: () => time, pause: async (ms) => { time += ms; } }), /Unexpected acknowledgement/);
});

test("each approved capture is published immediately and retained in failed HTML if a later image fails", async (t) => {
  // Synthetic unit image only; this test does not establish Mac/browser UI evidence.
  const artifactDir = mkdtempSync(join(tmpdir(), "artoo-mac-mentions-unit-"));
  t.after(() => rmSync(artifactDir, { recursive: true, force: true }));
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
  const screenshots = [], evidence = { screenshots: [] }, options = { artifactDir, evidence, onScreenshot: (item) => screenshots.push(item) };
  assert.equal(new Set(macMentionsImageNames).size, 10);
  assert.ok(macMentionsImageNames.includes("mentions-peer-first.png") && macMentionsImageNames.includes("macos-mentions-historical-reply.png"));
  await captureMacMentionScreenshot({ screenshot: async ({ path }) => writeFileSync(path, png) }, {
    ...options, filename: "mentions-peer-first.png", caption: "Synthetic independent-sender unit image" });
  assert.equal(screenshots.length, 1);
  await assert.rejects(captureMacMentionScreenshot({ screenshot: async () => { throw new Error("capture failed"); } }, {
    ...options, filename: "macos-mentions-historical-reply.png", caption: "Synthetic failed unit capture" }), /capture failed/);
  let invoked = false;
  await assert.rejects(captureMacMentionScreenshot({ screenshot: async () => { invoked = true; } }, {
    ...options, filename: "../unrelated.png", caption: "Unapproved unit filename" }));
  assert.equal(invoked, false); assert.deepEqual(evidence.screenshots, screenshots);
  const report = writeE2EReport({ outputPath: join(artifactDir, "failed-unit-report.html"), title: "Mention evidence retention unit test",
    report: { passed: false, finished_at: new Date().toISOString(), scope: "Synthetic unit evidence, no installed application" }, screenshots });
  assert.ok(readFileSync(report, "utf8").includes(`data:image/png;base64,${png.toString("base64")}`));
});
