import { computers, devices, deviceTokens, pairingCodes } from "@artoo/db";
import { parseDeviceToken } from "@artoo/domain";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTestServer, fixedClock, type TestServer } from "../test-support.js";
import { sha256Hex, type RandomSource } from "./device-credential.js";
import {
  type DevicePairingConfig,
  claimPairing,
  createPairing,
  enrollDeviceComputer,
  resolveControlToken,
  resolveNodeToken,
  revokeDevice,
} from "./device-service.js";

/** Deterministic byte source so token lookups/secrets are stable across calls. */
function seqRandom(start = 0): RandomSource {
  let counter = start;
  return {
    bytes(n: number): Buffer {
      const b = Buffer.alloc(n);
      for (let i = 0; i < n; i += 1) {
        b[i] = counter & 0xff;
        counter += 1;
      }
      return b;
    },
  };
}

const PEPPER = "test-pepper-0123456789abcdef";

describe("device-service", () => {
  let server: TestServer;
  let config: DevicePairingConfig;

  beforeEach(async () => {
    server = await buildTestServer();
    config = { pepper: PEPPER, ttlMs: 600_000, random: seqRandom() };
  });

  afterEach(async () => {
    await server.close();
  });

  it("createPairing returns a raw code once and stores only its HMAC", async () => {
    const { ctx, db } = server;
    const { pairing, code } = await createPairing(ctx, config, { createdByUserId: "user_owner" });
    expect(pairing.status).toBe("pending");
    expect(code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ-]+$/);
    // Neither the raw code nor a hash is exposed in the pairing metadata.
    expect(JSON.stringify(pairing)).not.toContain(code);
    const row = (await db.db.select().from(pairingCodes).where(eq(pairingCodes.id, pairing.id)))[0]!;
    expect(row.codeHash).not.toBe(code);
    expect(row.codeHash).toHaveLength(64);
  });

  it("claimPairing creates a device with two resolvable, distinct credentials", async () => {
    const { ctx } = server;
    const { code } = await createPairing(ctx, config, { createdByUserId: "user_owner" });
    const { device, controlToken, nodeToken } = await claimPairing(ctx, config, {
      code,
      platform: "windows",
      appVersion: "2.0.0",
      displayName: "  Jeremy's ThinkPad  ",
    });
    expect(device.trust).toBe("active");
    expect(device.display_name).toBe("Jeremy's ThinkPad"); // trimmed
    expect(controlToken).not.toBe(nodeToken);
    expect(controlToken.startsWith("sk_device_")).toBe(true);
    expect(nodeToken.startsWith("sk_device_")).toBe(true);
    expect(await resolveNodeToken(ctx, nodeToken)).toMatchObject({ deviceId: device.id, kind: "node" });
    expect(await resolveControlToken(ctx, controlToken)).toMatchObject({
      deviceId: device.id,
      kind: "control_session",
    });
  });

  it("rejects wrong and already-claimed codes uniformly (single-use)", async () => {
    const { ctx } = server;
    const { code } = await createPairing(ctx, config, { createdByUserId: "user_owner" });
    await expect(
      claimPairing(ctx, config, { code: "WRON-GCOD", platform: "ios", appVersion: "1", displayName: "x" }),
    ).rejects.toThrow(/invalid or expired/);
    await claimPairing(ctx, config, { code, platform: "windows", appVersion: "2", displayName: "d" });
    // Second claim of the same code is rejected by the atomic pending->claimed guard.
    await expect(
      claimPairing(ctx, config, { code, platform: "windows", appVersion: "2", displayName: "d" }),
    ).rejects.toThrow(/invalid or expired/);
  });

  it("rejects an expired code and marks it expired", async () => {
    const { ctx } = server;
    const { code, pairing } = await createPairing(ctx, config, { createdByUserId: "user_owner" });
    // Claim an hour later — well past the 10-minute TTL.
    const laterCtx = { ...ctx, clock: fixedClock("2026-06-13T02:00:00.000Z") };
    await expect(
      claimPairing(laterCtx, config, { code, platform: "android", appVersion: "1", displayName: "d" }),
    ).rejects.toThrow(/invalid or expired/);
    const row = (await server.db.db.select().from(pairingCodes).where(eq(pairingCodes.id, pairing.id)))[0]!;
    expect(row.status).toBe("expired");
  });

  it("enforces intended_platform: a mismatched claim is rejected and leaves the code pending", async () => {
    const { ctx } = server;
    const { code, pairing } = await createPairing(ctx, config, {
      createdByUserId: "user_owner",
      intendedPlatform: "ios",
    });
    await expect(
      claimPairing(ctx, config, { code, platform: "windows", appVersion: "2", displayName: "d" }),
    ).rejects.toThrow(/invalid or expired/);
    // The code is neither consumed nor expired — it stays pending for a retry.
    const row = (await server.db.db.select().from(pairingCodes).where(eq(pairingCodes.id, pairing.id)))[0]!;
    expect(row.status).toBe("pending");
    // A correct-platform claim then succeeds.
    const { device } = await claimPairing(ctx, config, {
      code,
      platform: "ios",
      appVersion: "2",
      displayName: "d",
    });
    expect(device.platform).toBe("ios");
  });

  it("resolve rejects malformed, wrong-kind, and tampered tokens", async () => {
    const { ctx } = server;
    const { code } = await createPairing(ctx, config, { createdByUserId: "user_owner" });
    const { nodeToken, controlToken } = await claimPairing(ctx, config, {
      code,
      platform: "windows",
      appVersion: "2",
      displayName: "d",
    });
    expect(await resolveNodeToken(ctx, "garbage")).toBeNull();
    expect(await resolveNodeToken(ctx, controlToken)).toBeNull(); // wrong kind
    expect(await resolveControlToken(ctx, nodeToken)).toBeNull(); // wrong kind
    // tampered secret with the real lookup
    const parsed = parseDeviceToken(nodeToken)!;
    expect(await resolveNodeToken(ctx, `sk_device_${parsed.lookup}_${parsed.secret}x`)).toBeNull();
  });

  it("revokeDevice revokes both credentials and is idempotent", async () => {
    const { ctx } = server;
    const { code } = await createPairing(ctx, config, { createdByUserId: "user_owner" });
    const { device, controlToken, nodeToken } = await claimPairing(ctx, config, {
      code,
      platform: "windows",
      appVersion: "2",
      displayName: "d",
    });
    const r1 = await revokeDevice(ctx, device.id);
    expect(r1.revoked).toBe(true);
    expect(await resolveNodeToken(ctx, nodeToken)).toBeNull();
    expect(await resolveControlToken(ctx, controlToken)).toBeNull();
    const drow = (await server.db.db.select().from(devices).where(eq(devices.id, device.id)))[0]!;
    expect(drow.trust).toBe("revoked");
    const toks = await server.db.db.select().from(deviceTokens).where(eq(deviceTokens.deviceId, device.id));
    expect(toks.length).toBe(2);
    expect(toks.every((t) => t.status === "revoked")).toBe(true);
    // idempotent
    expect((await revokeDevice(ctx, device.id)).revoked).toBe(false);
  });

  it("never persists the raw token secret (stores only its sha256 hash)", async () => {
    const { ctx } = server;
    const { code } = await createPairing(ctx, config, { createdByUserId: "user_owner" });
    const { device, nodeToken } = await claimPairing(ctx, config, {
      code,
      platform: "windows",
      appVersion: "2",
      displayName: "d",
    });
    const parsed = parseDeviceToken(nodeToken)!;
    const toks = await server.db.db.select().from(deviceTokens).where(eq(deviceTokens.deviceId, device.id));
    for (const t of toks) {
      expect(JSON.stringify(t)).not.toContain(parsed.secret);
    }
    const nodeTok = toks.find((t) => t.kind === "node")!;
    expect(nodeTok.tokenHash).toBe(sha256Hex(parsed.secret));
  });

  // -------------------------------------------------------------------------
  // Enrollment: device <-> computer binding (#28 slice 4a). claimPairing leaves
  // computer_id null; a real node token is fail-closed by node-ws until this
  // binding exists. Enrollment links a desktop device to an `enrolling` computer.
  // -------------------------------------------------------------------------

  async function claimDesktop(displayName = "Jeremy's ThinkPad") {
    const { ctx } = server;
    const { code } = await createPairing(ctx, config, { createdByUserId: "user_owner" });
    return claimPairing(ctx, config, {
      code,
      platform: "windows",
      appVersion: "2.0.0",
      displayName,
    });
  }

  it("enrolls a desktop device: creates an enrolling computer, links it, node token resolves with the computer id", async () => {
    const { ctx, db } = server;
    const { device, nodeToken } = await claimDesktop();
    // Pre-enrollment: device has no computer and the node token, while valid,
    // does not yet resolve a computer (node-ws fails closed on null computerId).
    expect(device.computer_id).toBeNull();
    expect(await resolveNodeToken(ctx, nodeToken)).toMatchObject({ deviceId: device.id, computerId: null });

    const result = await enrollDeviceComputer(ctx, { deviceId: device.id });
    expect(result.created).toBe(true);
    expect(result.deviceId).toBe(device.id);
    expect(result.computerId).toMatch(/^computer_/);

    // The device row is now linked.
    const drow = (await db.db.select().from(devices).where(eq(devices.id, device.id)))[0]!;
    expect(drow.computerId).toBe(result.computerId);

    // A real `enrolling` computer row exists in the same org.
    const crow = (await db.db.select().from(computers).where(eq(computers.id, result.computerId)))[0]!;
    expect(crow.status).toBe("enrolling");
    expect(crow.organizationId).toBe(ctx.organizationId);
    expect(crow.os).toBe("windows");

    // The node token now resolves WITH the computer id — this is exactly what
    // node-ws gates on, so a real node connection can finally bind.
    expect(await resolveNodeToken(ctx, nodeToken)).toMatchObject({
      deviceId: device.id,
      computerId: result.computerId,
      kind: "node",
    });
  });

  it("is idempotent: re-enrolling returns the same computer and does not create a second", async () => {
    const { ctx, db } = server;
    const { device } = await claimDesktop();
    const first = await enrollDeviceComputer(ctx, { deviceId: device.id });
    const second = await enrollDeviceComputer(ctx, { deviceId: device.id });
    expect(second.created).toBe(false);
    expect(second.computerId).toBe(first.computerId);
    const all = await db.db.select().from(computers).where(eq(computers.organizationId, ctx.organizationId));
    // Only the seeded computer + the one we enrolled — no duplicate.
    expect(all.filter((c) => c.id === first.computerId)).toHaveLength(1);
  });

  it("concurrent enrollments converge: both return the same computer and only one is created", async () => {
    const { ctx, db } = server;
    const { device } = await claimDesktop();
    const before = (
      await db.db.select().from(computers).where(eq(computers.organizationId, ctx.organizationId))
    ).length;

    // Fire two enrollments at once. The atomic `computer_id IS NULL` link guard
    // must let exactly one win; the loser drops its candidate and returns the
    // winner's computer — no orphan computers row.
    const [a, b] = await Promise.all([
      enrollDeviceComputer(ctx, { deviceId: device.id }),
      enrollDeviceComputer(ctx, { deviceId: device.id }),
    ]);
    expect(a.computerId).toBe(b.computerId);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1); // exactly one created

    const after = await db.db.select().from(computers).where(eq(computers.organizationId, ctx.organizationId));
    // Exactly one new computer overall — no orphan from the losing call.
    expect(after.length).toBe(before + 1);
    expect(after.filter((c) => c.id === a.computerId)).toHaveLength(1);
    // The device points at the shared computer.
    const drow = (await db.db.select().from(devices).where(eq(devices.id, device.id)))[0]!;
    expect(drow.computerId).toBe(a.computerId);
  });

  it("rejects mobile platforms — phones are remote control surfaces, not node hosts", async () => {
    const { ctx } = server;
    const { code } = await createPairing(ctx, config, { createdByUserId: "user_owner" });
    const { device } = await claimPairing(ctx, config, {
      code,
      platform: "android",
      appVersion: "1.0.0",
      displayName: "Pixel",
    });
    await expect(enrollDeviceComputer(ctx, { deviceId: device.id })).rejects.toThrow(/cannot host a local node/);
  });

  it("rejects a revoked device", async () => {
    const { ctx } = server;
    const { device } = await claimDesktop();
    await revokeDevice(ctx, device.id);
    await expect(enrollDeviceComputer(ctx, { deviceId: device.id })).rejects.toThrow(/revoked/);
  });

  it("after revoke, the node token is refused even though a computer was linked (refuse-after-revoke at the node plane)", async () => {
    const { ctx } = server;
    const { device, nodeToken } = await claimDesktop();
    await enrollDeviceComputer(ctx, { deviceId: device.id });
    expect(await resolveNodeToken(ctx, nodeToken)).not.toBeNull();
    await revokeDevice(ctx, device.id);
    expect(await resolveNodeToken(ctx, nodeToken)).toBeNull();
  });

  it("rejects an unknown device id", async () => {
    const { ctx } = server;
    await expect(enrollDeviceComputer(ctx, { deviceId: "device_nonexistent" })).rejects.toThrow(/not found/);
  });
});
