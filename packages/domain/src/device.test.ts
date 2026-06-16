import { describe, expect, it } from "vitest";

import {
  DEVICE_TOKEN_PREFIX,
  DeviceSchema,
  DeviceTokenSchema,
  PairingCodeSchema,
  derivePresenceState,
  formatDeviceToken,
  parseDeviceToken,
} from "./device.js";

describe("device record schemas", () => {
  it("accepts a well-formed device and rejects a bad platform", () => {
    const device = {
      id: "device_1",
      organization_id: "org_default",
      display_name: "Jeremy's ThinkPad",
      platform: "windows",
      app_version: "2.0.0",
      computer_id: "computer_1",
      enrolled_by_user_id: "user_1",
      trust: "active",
      last_seen_at: null,
      created_at: "2026-06-16T00:00:00Z",
      revoked_at: null,
    };
    expect(DeviceSchema.parse(device).platform).toBe("windows");
    expect(DeviceSchema.safeParse({ ...device, platform: "blackberry" }).success).toBe(false);
    // control-only (mobile) device: computer_id null is allowed.
    expect(DeviceSchema.safeParse({ ...device, computer_id: null }).success).toBe(true);
  });

  it("device-token metadata schema carries kind/status but no secret or hash", () => {
    const token = {
      id: "dtok_1",
      organization_id: "org_default",
      device_id: "device_1",
      kind: "node",
      status: "active",
      created_at: "2026-06-16T00:00:00Z",
      last_used_at: null,
      expires_at: null,
      revoked_at: null,
    };
    const parsed = DeviceTokenSchema.parse(token);
    expect(parsed.kind).toBe("node");
    expect(parsed.status).toBe("active");
    expect(DeviceTokenSchema.safeParse({ ...token, kind: "root" }).success).toBe(false);
  });

  it("pairing-code metadata schema accepts lifecycle states", () => {
    const code = {
      id: "pair_1",
      organization_id: "org_default",
      status: "pending",
      created_by_user_id: "user_1",
      intended_platform: null,
      expires_at: "2026-06-16T00:05:00Z",
      claimed_by_device_id: null,
      created_at: "2026-06-16T00:00:00Z",
      claimed_at: null,
    };
    expect(PairingCodeSchema.parse(code).status).toBe("pending");
    expect(PairingCodeSchema.safeParse({ ...code, status: "burned" }).success).toBe(false);
  });
});

describe("device-token format", () => {
  it("round-trips lookup + secret through format/parse", () => {
    const raw = formatDeviceToken("ab12cd", "s3cr3t-body_value");
    expect(raw).toBe(`${DEVICE_TOKEN_PREFIX}ab12cd_s3cr3t-body_value`);
    expect(parseDeviceToken(raw)).toEqual({ lookup: "ab12cd", secret: "s3cr3t-body_value" });
  });

  it("splits on the first underscore so a secret may contain underscores", () => {
    const raw = formatDeviceToken("lookup1", "aa_bb_cc");
    expect(parseDeviceToken(raw)).toEqual({ lookup: "lookup1", secret: "aa_bb_cc" });
  });

  it("rejects malformed tokens", () => {
    expect(parseDeviceToken("nope")).toBeNull();
    expect(parseDeviceToken("sk_device_")).toBeNull(); // no body
    expect(parseDeviceToken("sk_device_onlylookup")).toBeNull(); // no separator/secret
    expect(parseDeviceToken("sk_device__secret")).toBeNull(); // empty lookup
    expect(parseDeviceToken("sk_device_look_")).toBeNull(); // empty secret
    expect(parseDeviceToken("sk_agent_ab_cd")).toBeNull(); // wrong prefix
    expect(parseDeviceToken("sk_device_bad lookup_secret")).toBeNull(); // space not url-safe
  });
});

describe("derivePresenceState", () => {
  const windows = { onlineWithinMs: 30_000, staleWithinMs: 120_000 };
  const now = "2026-06-16T00:02:00Z";

  it("maps age to online/stale/offline with inclusive boundaries", () => {
    expect(derivePresenceState("2026-06-16T00:01:45Z", now, windows)).toBe("online"); // 15s
    expect(derivePresenceState("2026-06-16T00:01:30Z", now, windows)).toBe("online"); // exactly 30s
    expect(derivePresenceState("2026-06-16T00:01:00Z", now, windows)).toBe("stale"); // 60s
    expect(derivePresenceState("2026-06-16T00:00:00Z", now, windows)).toBe("stale"); // exactly 120s
    expect(derivePresenceState("2026-06-15T23:58:00Z", now, windows)).toBe("offline"); // 240s
  });

  it("treats missing/unparseable timestamps as offline", () => {
    expect(derivePresenceState(null, now, windows)).toBe("offline");
    expect(derivePresenceState(undefined, now, windows)).toBe("offline");
    expect(derivePresenceState("not-a-date", now, windows)).toBe("offline");
  });
});
