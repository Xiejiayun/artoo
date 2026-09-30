import assert from "node:assert/strict";
import test from "node:test";
import { createMemberRevocationFixture, findMemberMessage, selectMemberDevice, verifyMemberRevocationResults } from "./ios-ui-member-revocation.mjs";

const fields = {
  member_user_id: "member", member_peer_control_token: "runner-only-member-secret",
  member_native_device_name: "Member phone before revoke", member_recovery_device_name: "Member phone recovered",
  member_pending_mac_id: "pending-mac", owner_device_id: "owner-peer", channel_id: "channel",
  member_revocation_ready_message: "Member ready", member_recovery_message: "Member recovered",
};
const device = (id, displayName, patch = {}) => ({ id, display_name: displayName, enrolled_by_user_id: "member", platform: "ios", trust: "active", computer_id: null, revoked_at: null, ...patch });
const sentinels = [device("owner-peer", "Owner peer", { enrolled_by_user_id: "owner" }), device("pending-mac", "Member Mac", { platform: "macos" })];
const message = (id, body, patch = {}) => ({ id, body, actor_type: "user", actor_id: "member", thread_root_id: null, ...patch });

test("fixture pairs member-owned peers through production routes without enrollment or revocation", async () => {
  const calls = [];
  const devices = [sentinels[0]];
  const request = async (path, body, token) => {
    calls.push({ path, body, token });
    if (path === "/auth/session") return { user: { id: "member", name: "Native member", role: "member" } };
    if (path === "/api/v1/devices/pairings") return { code: `code-${calls.length}` };
    if (path === "/api/v1/devices/claim") {
      const created = device(`device-${devices.length}`, body.display_name, { platform: body.platform });
      devices.push(created);
      return { device: created, control_token: "member-peer-secret", node_token: "unused-node-secret" };
    }
    if (path === "/api/v1/devices") return { devices };
    throw new Error("Unexpected fixture operation");
  };
  const result = await createMemberRevocationFixture({ request, memberSession: "member-session", memberUserId: "member", ownerDeviceId: "owner-peer", suffix: "abc" });
  assert.equal(result.fields.member_user_id, "member");
  assert.equal(result.fields.member_peer_control_token, "member-peer-secret");
  assert.equal(result.fields.member_pending_mac_id, "device-2");
  assert.equal(result.unchangedDevices.length, 3);
  assert.equal(calls.filter(({ path }) => path.endsWith("/pairings")).length, 2);
  assert.equal(calls.filter(({ path }) => path.endsWith("/claim")).length, 2);
  assert.ok(calls.filter(({ path }) => path.endsWith("/pairings")).every(({ token }) => token === "member-session"));
  assert.deepEqual(calls.filter(({ path }) => path === "/auth/session").map(({ token }) => token), ["member-session", "member-peer-secret"]);
  assert.ok(calls.every(({ path }) => !/\/(enroll|revoke)$/.test(path)));
  assert.equal(JSON.stringify(result.fields).includes("unused-node-secret"), false);
});

test("fixture refuses an administrator masquerading as the member", async () => {
  await assert.rejects(createMemberRevocationFixture({ request: async () => ({ user: { id: "member", role: "owner" } }), memberSession: "s", memberUserId: "member", ownerDeviceId: "owner-peer", suffix: "abc" }), /role/);
});

test("fixture verifies the paired member credential before giving it to the native runner", async () => {
  const request = async (path, body, token) => {
    if (path === "/auth/session") return { user: { id: "member", name: "Native member", role: token === "member-session" ? "member" : "owner" } };
    if (path === "/api/v1/devices/pairings") return { code: "setup-code" };
    if (path === "/api/v1/devices/claim") return { device: device("peer", "Peer"), control_token: "wrong-role" };
    throw new Error("Must reject before preparing more fixture devices");
  };
  await assert.rejects(createMemberRevocationFixture({ request, memberSession: "member-session", memberUserId: "member", ownerDeviceId: "owner-peer", suffix: "abc" }), /role must remain member/);
});

test("readiness requires one member-authored root message", () => {
  assert.equal(findMemberMessage([], "Member ready", "member"), undefined);
  const ready = message("ready", "Member ready");
  assert.equal(findMemberMessage([ready], "Member ready", "member"), ready);
  for (const patch of [{ actor_id: "owner" }, { actor_type: "agent" }, { thread_root_id: "other-root" }]) {
    assert.throws(() => findMemberMessage([message("wrong", "Member ready", patch)], "Member ready", "member"));
  }
  assert.throws(() => findMemberMessage([ready, { ...ready, id: "duplicate" }], "Member ready", "member"), /exactly once/);
});

test("owner target selection rejects duplicates, another owner and a non-iOS device", () => {
  const phone = device("old", fields.member_native_device_name);
  assert.equal(selectMemberDevice([phone], fields, fields.member_native_device_name), phone);
  assert.throws(() => selectMemberDevice([], fields, fields.member_native_device_name), /exactly one/);
  assert.throws(() => selectMemberDevice([phone, { ...phone, id: "duplicate" }], fields, fields.member_native_device_name), /exactly one/);
  for (const patch of [{ enrolled_by_user_id: "owner" }, { platform: "macos" }, { computer_id: "computer" }]) {
    assert.throws(() => selectMemberDevice([{ ...phone, ...patch }], fields, fields.member_native_device_name));
  }
});

function completed(patchDevices = (devices) => devices, patchMessages = (messages) => messages) {
  const devices = patchDevices([...structuredClone(sentinels),
    device("old", fields.member_native_device_name, { trust: "revoked", revoked_at: "2026-10-01T00:00:00Z" }),
    device("new", fields.member_recovery_device_name)]);
  const messages = patchMessages([message("ready", fields.member_revocation_ready_message), message("recovery", fields.member_recovery_message)]);
  const calls = [];
  return { calls, request: async (path, body) => {
    calls.push({ path, body });
    if (path === "/api/v1/devices") return { devices };
    if (path.includes("/messages")) return { messages };
    throw new Error("Unexpected verification operation");
  } };
}

test("verification uses only reads and returns credential-free revoked/recovered evidence", async () => {
  const fixture = completed();
  const result = await verifyMemberRevocationResults({ fixture: fields, unchangedDevices: sentinels, request: fixture.request });
  assert.deepEqual([result.revoked_device_id, result.recovered_device_id, result.member_user_id], ["old", "new", "member"]);
  assert.equal(result.readiness_message_id, "ready");
  assert.equal(result.recovery_message_id, "recovery");
  assert.ok(fixture.calls.every(({ body }) => body === undefined));
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("verification rejects an active old phone, reused identity or changed sentinel", async () => {
  for (const mutate of [
    (devices) => devices.map((item) => item.id === "old" ? { ...item, trust: "active", revoked_at: null } : item),
    (devices) => devices.map((item) => item.id === "new" ? { ...item, id: "old" } : item),
    (devices) => devices.map((item) => item.id === "new" ? { ...item, trust: "revoked", revoked_at: "2026-10-01T00:01:00Z" } : item),
    (devices) => devices.map((item) => item.id === "pending-mac" ? { ...item, computer_id: "unauthorized-computer" } : item),
    (devices) => devices.map((item) => item.id === "owner-peer" ? { ...item, trust: "revoked" } : item),
  ]) {
    const harness = completed(mutate);
    await assert.rejects(verifyMemberRevocationResults({ fixture: fields, unchangedDevices: sentinels, request: harness.request }));
  }
});

test("verification rejects recovery attributed to owner or missing native recovery", async () => {
  for (const mutate of [(messages) => messages.slice(0, 1), (messages) => messages.map((item) => item.id === "recovery" ? { ...item, actor_id: "owner" } : item)]) {
    const harness = completed(undefined, mutate);
    await assert.rejects(verifyMemberRevocationResults({ fixture: fields, unchangedDevices: sentinels, request: harness.request }));
  }
});
