import { describe, expect, it } from "vitest";

import { loadDeviceAuthConfig, testDeviceAuthConfig } from "./device-auth.js";

describe("loadDeviceAuthConfig", () => {
  it("fails closed when the pairing pepper is missing or blank", () => {
    expect(() => loadDeviceAuthConfig({})).toThrow(/ARTOO_PAIRING_PEPPER is required/);
    expect(() => loadDeviceAuthConfig({ ARTOO_PAIRING_PEPPER: "   " })).toThrow(
      /ARTOO_PAIRING_PEPPER is required/,
    );
  });

  it("trims and keeps the pepper when present", () => {
    expect(loadDeviceAuthConfig({ ARTOO_PAIRING_PEPPER: "  s3cret  " }).pairingPepper).toBe("s3cret");
  });

  it("enables the dev node-token escape only in non-production with the explicit flag", () => {
    const base = { ARTOO_PAIRING_PEPPER: "p" };
    // non-production + flag => escape on (default token 'dev')
    expect(
      loadDeviceAuthConfig({ ...base, NODE_ENV: "development", ARTOO_ALLOW_DEV_NODE_TOKEN: "1" })
        .devNodeToken,
    ).toBe("dev");
    // flag absent => off
    expect(loadDeviceAuthConfig({ ...base, NODE_ENV: "development" }).devNodeToken).toBeNull();
    // production NEVER escapes, even with the flag
    expect(
      loadDeviceAuthConfig({ ...base, NODE_ENV: "production", ARTOO_ALLOW_DEV_NODE_TOKEN: "1" })
        .devNodeToken,
    ).toBeNull();
    // flag must be exactly "1"
    expect(
      loadDeviceAuthConfig({ ...base, NODE_ENV: "test", ARTOO_ALLOW_DEV_NODE_TOKEN: "true" })
        .devNodeToken,
    ).toBeNull();
  });

  it("honors a custom dev node token when the escape is enabled", () => {
    expect(
      loadDeviceAuthConfig({
        ARTOO_PAIRING_PEPPER: "p",
        NODE_ENV: "development",
        ARTOO_ALLOW_DEV_NODE_TOKEN: "1",
        ARTOO_DEV_NODE_TOKEN: "custom-dev",
      }).devNodeToken,
    ).toBe("custom-dev");
  });
});

describe("testDeviceAuthConfig", () => {
  it("defaults to dev escape on with a fixed pepper, and applies overrides", () => {
    expect(testDeviceAuthConfig()).toEqual({
      pairingPepper: "test-pairing-pepper-0123456789",
      devNodeToken: "dev",
    });
    expect(testDeviceAuthConfig({ devNodeToken: null }).devNodeToken).toBeNull();
  });
});
