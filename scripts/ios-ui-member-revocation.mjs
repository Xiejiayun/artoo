import assert from "node:assert/strict";

/** Disposable setup only. Native pairing and messages are performed by XCUITest;
 * the owner browser, never this helper, performs the tested revocation. */
export async function createMemberRevocationFixture({ request, memberSession, memberUserId, ownerDeviceId, suffix }) {
  const identity = await request("/auth/session", undefined, memberSession);
  assert.equal(identity.user.id, memberUserId, "The fixture session must belong to the member");
  assert.equal(identity.user.role, "member", "The fixture role must be member");
  const claim = async (platform, displayName) => {
    const pairing = await request("/api/v1/devices/pairings", { intended_platform: platform }, memberSession);
    const value = await request("/api/v1/devices/claim", { code: pairing.code, platform, display_name: displayName, app_version: "member-ui-fixture" }, memberSession);
    assert.equal(value.device.enrolled_by_user_id, memberUserId);
    assert.equal(value.device.computer_id, null, "Pairing alone must not register a computer");
    assert.equal(value.device.trust, "active");
    return value;
  };
  const peer = await claim("ios", `Member API peer ${suffix}`);
  const peerIdentity = await request("/auth/session", undefined, peer.control_token);
  assert.equal(peerIdentity.user.id, memberUserId, "The paired peer must retain the member account");
  assert.equal(peerIdentity.user.role, "member", "The paired peer role must remain member");
  const pendingMacName = `Member Mac awaiting enrollment ${suffix}`;
  const mac = await claim("macos", pendingMacName);
  const { devices } = await request("/api/v1/devices");
  const unchangedDevices = [ownerDeviceId, peer.device.id, mac.device.id].map((id) => {
    const matches = devices.filter((item) => item.id === id);
    assert.equal(matches.length, 1, "Every sentinel must exist exactly once");
    assert.equal(matches[0].trust, "active");
    return deviceState(matches[0]);
  });
  assert.notEqual(unchangedDevices[0].enrolled_by_user_id, memberUserId, "The owner sentinel must belong to another account");
  return {
    fields: {
      member_user_id: memberUserId, member_name: identity.user.name, member_peer_control_token: peer.control_token,
      member_native_device_name: `Member iPhone before revocation ${suffix}`,
      member_recovery_device_name: `Member iPhone after fresh pairing ${suffix}`,
      member_pending_mac_id: mac.device.id, member_pending_mac_name: pendingMacName, owner_device_id: ownerDeviceId,
      member_revocation_ready_message: `Member ready for owner revocation ${suffix}`,
      member_recovery_message: `Member restored through fresh pairing ${suffix}`,
    },
    unchangedDevices,
  };
}

export function findMemberMessage(messages, body, userId) {
  const matches = messages.filter((item) => item.body === body);
  if (matches.length === 0) return undefined;
  assert.equal(matches.length, 1, "The native member message must be persisted exactly once");
  const message = matches[0];
  assert.equal(message.actor_type, "user");
  assert.equal(message.actor_id, userId, "The message must retain the member's identity");
  assert.equal(message.thread_root_id, null, "The readiness/recovery message must be a channel root");
  return message;
}

export function selectMemberDevice(devices, fields, displayName) {
  const matches = devices.filter((item) => item.display_name === displayName);
  assert.equal(matches.length, 1, "There must be exactly one native phone with the selected display name");
  const device = matches[0];
  assert.equal(device.enrolled_by_user_id, fields.member_user_id, "The selected phone must belong to the member");
  assert.equal(device.platform, "ios");
  assert.equal(device.computer_id, null, "The native iPhone must not become an execution computer");
  return device;
}

function deviceState(device) {
  const { id, enrolled_by_user_id, platform, trust, computer_id, revoked_at } = device;
  return { id, enrolled_by_user_id, platform, trust, computer_id, revoked_at };
}

/** Read-only evidence after the native and owner UI have finished. No token or
 * pairing code enters the returned report. Last-seen timestamps may advance. */
export async function verifyMemberRevocationResults({ fixture, unchangedDevices, request }) {
  const { devices } = await request("/api/v1/devices");
  const revoked = selectMemberDevice(devices, fixture, fixture.member_native_device_name);
  const recovered = selectMemberDevice(devices, fixture, fixture.member_recovery_device_name);
  assert.equal(revoked.trust, "revoked");
  assert.ok(revoked.revoked_at, "Owner revocation must be persisted");
  // Later native cases may sign out of this session. /auth/logout revokes only
  // its control credential; the recovered device itself must remain active.
  assert.equal(recovered.trust, "active");
  assert.equal(recovered.revoked_at, null);
  assert.notEqual(revoked.id, recovered.id, "Fresh pairing must create a new device identity");
  for (const before of unchangedDevices) {
    const current = devices.filter((item) => item.id === before.id);
    assert.equal(current.length, 1, "The unaffected device must remain present");
    assert.deepEqual(deviceState(current[0]), deviceState(before), "Member recovery must not enroll or revoke another device");
  }
  const { messages } = await request(`/api/v1/rooms/${fixture.channel_id}/messages?limit=100`);
  const ready = findMemberMessage(messages, fixture.member_revocation_ready_message, fixture.member_user_id);
  const recovery = findMemberMessage(messages, fixture.member_recovery_message, fixture.member_user_id);
  assert.ok(ready, "Native member readiness message is missing");
  assert.ok(recovery, "Native member recovery message is missing");
  return { member_user_id: fixture.member_user_id, revoked_device_id: revoked.id, recovered_device_id: recovered.id,
    revoked_at: revoked.revoked_at, readiness_message_id: ready.id, recovery_message_id: recovery.id,
    unchanged_device_ids: unchangedDevices.map((item) => item.id) };
}
