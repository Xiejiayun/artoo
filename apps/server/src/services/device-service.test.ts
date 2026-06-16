import { devices, deviceTokens, pairingCodes } from "@artoo/db";
import { parseDeviceToken } from "@artoo/domain";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTestServer, fixedClock, type TestServer } from "../test-support.js";
import { sha256Hex, type RandomSource } from "./device-credential.js";
import {
  type DevicePairingConfig,
  claimPairing,
  createPairing,
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
});
