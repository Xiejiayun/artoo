import assert from "node:assert/strict";
import test from "node:test";
import { verifyMentionsResults } from "./mentions-results.mjs";

// Pure evidence fixtures, never a claim that a real client was exercised.
function sample() {
  const fields = { project_a_id: "project_a", channel_a_id: "room_a", root_a_id: "root_a", root_a_body: "A root",
    recipient_user_id: "recipient", sender_user_id: "sender", draft_a: "UNSENT A", draft_b: "UNSENT B",
    first_mention_body: "Historical first reply exceeds the preview. ".repeat(7), second_mention_body: "Second historical reply" };
  const makeMessage = (id, room, body, root, mentioned = false) => ({ id, organization_id: "org", room_id: room,
    thread_root_id: root ?? null, actor_type: "user", actor_id: "sender", kind: "text", body,
    payload: mentioned ? { mentions: [{ actor_type: "user", actor_id: "recipient" }] } : {}, created_at: "2026-10-01T00:00:00.000Z" });
  const messages = [makeMessage("root_a", "room_a", "A root"), makeMessage("root_b", "room_b", "B root"),
    makeMessage("first", "room_b", fields.first_mention_body, "root_b", true), makeMessage("second", "room_b", fields.second_mention_body, "root_b", true),
    ...Array.from({ length: 55 }, (_, index) => makeMessage(`later_${index}`, "room_b", `Ordinary reply ${index}`, "root_b")),
    makeMessage("sentinel", "room_a", "Unread guard", "root_a", true)];
  const target = (messageId, project) => {
    const message = messages.find((m) => m.id === messageId);
    return { message_id: messageId, notification_id: `notice_${messageId}`, body: message.body, room_id: message.room_id,
      thread_root_id: message.thread_root_id, project_id: project, actor_id: "sender" };
  };
  const later = messages.filter((m) => m.id.startsWith("later_"));
  const publication = { project_b: { id: "project_b", name: "B" }, channel_b: { id: "room_b", name: "same-channel" }, root_b: { id: "root_b", body: "B root" },
    first: target("first", "project_b"), second: target("second", "project_b"), sentinel: target("sentinel", "project_a"),
    baseline_unread_count: 1, published_unread_count: 4, recipient_device_id: "device",
    history: { later_message_ids: later.map((m) => m.id), latest_message_ids: later.slice(-50).map((m) => m.id), has_more: true } };
  const baseline = [{ id: "old_unread", read_at: null }, { id: "old_read", read_at: "2026-09-30T00:00:00Z" }];
  const notices = [publication.first, publication.second, publication.sentinel].map((t, index) => ({ id: t.notification_id,
    message_id: t.message_id, room_id: t.room_id, thread_root_id: t.thread_root_id, project_id: t.project_id,
    actor_id: t.actor_id, body_preview: t.body.slice(0, 240), read_at: index < 2 ? "2026-10-01T00:01:00Z" : null }));
  const attempts = ["notice_first", "notice_first", "notice_second", "notice_first"].map((notification_id, index) => ({
    sequence: index + 1, method: "POST", path: `/api/v1/notifications/${notification_id}/read`, notification_id,
    user_id: "recipient", device_id: "device", status: index ? 200 : 503, injected: !index, forwarded: !!index, response_finished: true }));
  const ledger = { fields, publication, expected_messages: structuredClone(messages), baseline_notifications: structuredClone(baseline),
    initial_project_ids: ["project_a"], peer_sent_message_ids: ["first", "second"] };
  messages[0].reply_count = 1; messages[1].reply_count = 57;
  return { ledger, snapshot: { publication: structuredClone(publication), recipient_user_id: "recipient", baseline_notifications: baseline,
    notifications: [...baseline, ...notices], unread_count: 2, observation_errors: [], messages,
    latest_thread: { messages: later.slice(-50), has_more: true }, read_attempts: attempts } };
}

test("production-record verification preserves baseline unread, exact targets and later idempotent reads", () => {
  const input = sample(), before = structuredClone(input);
  const result = verifyMentionsResults(input);
  assert.equal(result.passed, true); assert.equal(result.counters.retained_messages, 60);
  assert.equal(result.counters.final_unread, 2); assert.equal(result.counters.injected_failures, 1);
  assert.equal(result.targets.length, 3); assert.match(result.targets[0].body_sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.drafts.absent_from_exercised_rooms, true); assert.deepEqual(input, before);
});

for (const [name, mutate] of [
  ["project B already existed during initial bootstrap", (f) => f.ledger.initial_project_ids.push("project_b")],
  ["wrong authenticated recipient", (f) => { f.snapshot.recipient_user_id = "different"; }],
  ["sender and recipient collapse", (f) => { f.ledger.fields.sender_user_id = "recipient"; }],
  ["peer receipt missing", (f) => f.ledger.peer_sent_message_ids.pop()],
  ["replaced target reply", (f) => { f.snapshot.messages[2].body = "newer reply"; }],
  ["wrong thread", (f) => { f.snapshot.messages[2].thread_root_id = "root_a"; }],
  ["wrong sender", (f) => { f.snapshot.messages[2].actor_id = "recipient"; }],
  ["missing structured mention", (f) => { f.snapshot.messages[2].payload = {}; }],
  ["extra posted draft", (f) => f.snapshot.messages.push({ ...f.snapshot.messages[2], id: "draft", body: "UNSENT B" })],
  ["rewritten ordinary reply became a draft", (f) => { f.snapshot.messages[4].body = "UNSENT A"; }],
  ["missing history", (f) => f.snapshot.messages.splice(4, 1)],
  ["unexpected root reply count", (f) => { f.snapshot.messages[1].reply_count = 56; }],
  ["target appears in latest page", (f) => { f.snapshot.latest_thread.messages[0] = f.snapshot.messages[2]; }],
  ["latest page no longer has history", (f) => { f.snapshot.latest_thread.has_more = false; }],
  ["changed baseline notification", (f) => { f.snapshot.notifications[0].read_at = "2026-10-01T00:01:00Z"; }],
  ["sentinel was consumed", (f) => { f.snapshot.notifications.at(-1).read_at = "2026-10-01T00:01:00Z"; }],
  ["second target remains unread", (f) => { f.snapshot.notifications[3].read_at = null; }],
  ["wrong global unread count", (f) => { f.snapshot.unread_count = 0; }],
  ["wrong notification identity", (f) => { f.snapshot.notifications[2].message_id = "second"; }],
  ["successful mutation hidden behind the 503", (f) => { f.snapshot.read_attempts[0].forwarded = true; }],
  ["failure was injected twice", (f) => { f.snapshot.read_attempts[1].injected = true; }],
  ["retry belongs to another device", (f) => { f.snapshot.read_attempts[1].device_id = "other"; }],
  ["retry belongs to another notification", (f) => { f.snapshot.read_attempts[1].notification_id = "notice_second"; }],
  ["response has not completed", (f) => { f.snapshot.read_attempts[1].response_finished = false; }],
  ["auth observation is uncertain", (f) => f.snapshot.observation_errors.push("unverified")],
]) test(`refuses ${name}`, () => { const f = sample(); mutate(f); assert.throws(() => verifyMentionsResults(f)); });
