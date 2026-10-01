import assert from "node:assert/strict";
import test from "node:test";
import { readMentionNotifications } from "./mentions-scenario.mjs";

test("notification evidence traverses actual cursors without losing global unread count", async () => {
  const routes = [], pages = [{ notifications: [{ id: "new" }], unread_count: 3, has_more: true, next_before: "cursor value" },
    { notifications: [{ id: "old" }], unread_count: 3, has_more: false, next_before: "last" }];
  const result = await readMentionNotifications(async (route) => { routes.push(route); return pages.shift(); });
  assert.deepEqual(result, { notifications: [{ id: "new" }, { id: "old" }], unread_count: 3 });
  assert.deepEqual(routes, ["/api/v1/notifications?limit=100", "/api/v1/notifications?limit=100&before=cursor%20value"]);
});

for (const [name, pages] of [
  ["duplicate IDs", [{ notifications: [{ id: "same" }, { id: "same" }], unread_count: 1, has_more: false }]],
  ["missing pagination cursor", [{ notifications: [], unread_count: 1, has_more: true }]],
  ["changing unread count", [{ notifications: [], unread_count: 1, has_more: true, next_before: "next" }, { notifications: [], unread_count: 2, has_more: false }]],
  ["invalid count", [{ notifications: [], unread_count: -1, has_more: false }]],
  ["missing pagination state", [{ notifications: [], unread_count: 0 }]],
  ["missing notification ID", [{ notifications: [{}], unread_count: 1, has_more: false }]],
  ["looping cursor", [{ notifications: [], unread_count: 1, has_more: true, next_before: "same" }, { notifications: [], unread_count: 1, has_more: true, next_before: "same" }]],
]) test(`inventory refuses ${name}`, async () => {
  const queue = structuredClone(pages); await assert.rejects(readMentionNotifications(async () => queue.shift()));
});
