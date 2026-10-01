import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const ids = (items) => items.map((item) => item.id);
const unique = (items, label) => assert.equal(new Set(items).size, items.length, `${label} must be unique`);

/** Final production records cannot prove UI actions or intermediate timing.
 * Each native/Mac driver additionally requires real navigation/draft/Retry
 * actions, visible exact text and the unchanged pre-Retry failure window. */
export function verifyMentionsResults({ ledger, snapshot }) {
  const { fields: f, publication: p, expected_messages: expected, baseline_notifications: baseline } = ledger;
  assert.ok(p && f && Array.isArray(expected) && Array.isArray(baseline));
  assert.notEqual(f.recipient_user_id, f.sender_user_id);
  assert.notEqual(f.project_a_id, p.project_b.id); assert.notEqual(f.channel_a_id, p.channel_b.id);
  assert.ok(ledger.initial_project_ids.includes(f.project_a_id) && !ledger.initial_project_ids.includes(p.project_b.id),
    "Project B must be absent from the initial authorized bootstrap");
  assert.equal(snapshot.recipient_user_id, f.recipient_user_id);
  assert.deepEqual(snapshot.publication, p); assert.deepEqual(snapshot.baseline_notifications, baseline);
  assert.deepEqual(snapshot.observation_errors, [], "Fault observation must remain independently reliable");
  const targets = [p.first, p.second, p.sentinel];
  unique(targets.map((target) => target.message_id), "Mention messages");
  unique(targets.map((target) => target.notification_id), "Mention notifications");
  assert.deepEqual(ledger.peer_sent_message_ids, [p.first.message_id, p.second.message_id], "Both target mentions must come from the peer UI receipts");
  assert.equal(p.first.body, f.first_mention_body); assert.equal(p.second.body, f.second_mention_body);
  assert.ok(p.first.body.length > 240, "The full first target must exceed its notification preview");
  const actual = snapshot.messages;
  assert.ok(Array.isArray(actual)); unique(ids(actual), "Retained messages"); unique(ids(expected), "Expected messages");
  assert.equal(expected.length, 60, "Two roots, two target replies, 55 later replies and one sentinel are required");
  assert.deepEqual([...ids(actual)].sort(), [...ids(expected)].sort(), "Both exercised rooms and threads must preserve every message without extras");
  for (const original of expected) {
    const message = actual.find((item) => item.id === original.id);
    for (const key of ["id", "organization_id", "room_id", "actor_type", "actor_id", "kind", "body", "payload"]) {
      assert.deepEqual(message[key], original[key], `Stored message ${key} differs from its original production receipt`);
    }
    assert.equal(message.thread_root_id ?? null, original.thread_root_id ?? null);
    assert.ok(Number.isFinite(Date.parse(original.created_at)) && Date.parse(message.created_at) === Date.parse(original.created_at));
    assert.ok(message.body !== f.draft_a && message.body !== f.draft_b, "Neither client draft may become a message in either exercised room/thread");
  }
  for (const [index, target] of targets.entries()) {
    const room = index < 2 ? p.channel_b.id : f.channel_a_id, root = index < 2 ? p.root_b.id : f.root_a_id;
    const project = index < 2 ? p.project_b.id : f.project_a_id;
    assert.deepEqual([target.room_id, target.thread_root_id, target.project_id, target.actor_id], [room, root, project, f.sender_user_id]);
    const message = actual.find((item) => item.id === target.message_id);
    assert.deepEqual([message.room_id, message.thread_root_id, message.actor_type, message.actor_id, message.kind, message.body],
      [room, root, "user", f.sender_user_id, "text", target.body]);
    assert.deepEqual(message.payload.mentions, [{ actor_type: "user", actor_id: f.recipient_user_id }]);
  }
  for (const [rootId, room, body, replies] of [[f.root_a_id, f.channel_a_id, f.root_a_body, 1], [p.root_b.id, p.channel_b.id, p.root_b.body, 57]]) {
    const message = actual.find((item) => item.id === rootId);
    assert.ok(message && !message.thread_root_id); assert.equal(message.room_id, room); assert.equal(message.body, body);
    assert.equal(message.reply_count, replies);
  }
  const later = p.history.later_message_ids; unique(later, "Later replies"); assert.equal(later.length, 55);
  assert.equal(p.history.has_more, true); assert.equal(p.history.latest_message_ids.length, 50);
  for (const messageId of later) {
    const message = actual.find((item) => item.id === messageId);
    assert.ok(message && message.room_id === p.channel_b.id && message.thread_root_id === p.root_b.id);
    assert.ok(!message.payload.mentions?.length, "Ordinary later replies cannot manufacture more mentions");
  }
  const latest = snapshot.latest_thread;
  assert.equal(latest.has_more, true); assert.equal(latest.messages.length, 50); unique(ids(latest.messages), "Latest page replies");
  assert.deepEqual(ids(latest.messages), p.history.latest_message_ids);
  assert.ok(latest.messages.every((message) => later.includes(message.id)));
  assert.ok(!ids(latest.messages).some((value) => [p.first.message_id, p.second.message_id].includes(value)), "Targets must really be outside the latest 50");
  for (const message of latest.messages) assert.deepEqual(message, actual.find((item) => item.id === message.id));

  unique(ids(baseline), "Baseline notifications"); unique(ids(snapshot.notifications), "Final notifications");
  assert.equal(p.baseline_unread_count, baseline.filter((notice) => notice.read_at === null).length);
  assert.equal(p.published_unread_count, p.baseline_unread_count + 3);
  assert.deepEqual([...ids(snapshot.notifications)].sort(), [...ids(baseline), ...targets.map((target) => target.notification_id)].sort());
  for (const original of baseline) assert.deepEqual(snapshot.notifications.find((notice) => notice.id === original.id), original, "Pre-existing notifications must remain unchanged");
  for (const [index, target] of targets.entries()) {
    const notice = snapshot.notifications.find((item) => item.id === target.notification_id);
    assert.deepEqual([notice.message_id, notice.room_id, notice.thread_root_id, notice.project_id, notice.actor_id],
      [target.message_id, target.room_id, target.thread_root_id, target.project_id, f.sender_user_id]);
    if (index < 2) assert.ok(typeof notice.read_at === "string" && Number.isFinite(Date.parse(notice.read_at)));
    else assert.equal(notice.read_at, null, "The independent project A sentinel must remain unread");
    assert.ok(notice.body_preview && target.body.startsWith(notice.body_preview));
  }
  assert.equal(snapshot.unread_count, p.baseline_unread_count + 1);
  assert.equal(snapshot.notifications.filter((notice) => notice.read_at === null).length, snapshot.unread_count);
  const attempts = snapshot.read_attempts;
  assert.ok(Array.isArray(attempts) && attempts.length >= 3);
  assert.equal(attempts[0].notification_id, p.first.notification_id);
  assert.equal(attempts.filter((entry) => entry.injected).length, 1);
  for (const [index, entry] of attempts.entries()) {
    assert.equal(entry.sequence, index + 1); assert.equal(entry.method, "POST"); assert.equal(entry.response_finished, true);
    assert.equal(entry.user_id, f.recipient_user_id); assert.equal(entry.device_id, p.recipient_device_id);
    assert.ok([p.first.notification_id, p.second.notification_id].includes(entry.notification_id), "The sentinel must never be read through UI");
    assert.equal(entry.path, `/api/v1/notifications/${entry.notification_id}/read`);
    assert.deepEqual([entry.injected, entry.forwarded, entry.status], index === 0 ? [true, false, 503] : [false, true, 200]);
  }
  assert.equal(attempts[1].notification_id, p.first.notification_id, "The first recovery must retry the original notification");
  assert.ok(attempts.some((entry) => entry.notification_id === p.second.notification_id));
  return { passed: true, scope: "Read-only production mention identities/history/read state and exact pre-handler HTTP observations; fixture identities, no real OAuth login claim",
    driver_observations_required: ["Project B created only after recipient readiness", "Exact historical targets and selected project visible through UI",
      "At least 3.1 seconds without successful read before explicit Retry", "Drafts survive Retry, target/project switches and client reload/relaunch"],
    recipient_user_id: f.recipient_user_id, recipient_device_id: p.recipient_device_id, sender_user_id: f.sender_user_id,
    project_ids: [f.project_a_id, p.project_b.id], root_ids: [f.root_a_id, p.root_b.id],
    counters: { target_mentions: 2, unread_sentinels: 1, later_replies: 55, latest_page: 50, retained_messages: actual.length,
      baseline_unread: p.baseline_unread_count, published_unread: p.published_unread_count, final_unread: snapshot.unread_count,
      injected_failures: 1, observed_reads: attempts.length },
    targets: targets.map((target) => ({ ...target, body_sha256: hash(target.body),
      read_at: snapshot.notifications.find((item) => item.id === target.notification_id).read_at })),
    drafts: { project_a_sha256: hash(f.draft_a), project_b_sha256: hash(f.draft_b), absent_from_exercised_rooms: true } };
}
