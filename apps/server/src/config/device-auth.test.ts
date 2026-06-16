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

  it("does NOT enable the dev escape by default in a dev bootstrap (no silent default)", () => {
    // Regression for #28 3a review: a non-production server bootstrap must not
    // get token=dev acceptance unless ARTOO_ALLOW_DEV_NODE_TOKEN is explicitly
    // "1". A pairing pepper alone (a typical dev env) does NOT enable the escape.
    expect(
      loadDeviceAuthConfig({ NODE_ENV: "development", ARTOO_PAIRING_PEPPER: "p" }).devNodeToken,
    ).toBeNull();
  });

  it("rides the same gate for the control-WS dev escape (#28 3b)", () => {
    const base = { ARTOO_PAIRING_PEPPER: "p" };
    // non-production + flag => anonymous control WS allowed
    expect(
      loadDeviceAuthConfig({ ...base, NODE_ENV: "development", ARTOO_ALLOW_DEV_NODE_TOKEN: "1" })
        .devControlEscape,
    ).toBe(true);
    // flag absent => off (no anonymous control WS even in dev)
    expect(loadDeviceAuthConfig({ ...base, NODE_ENV: "development" }).devControlEscape).toBe(false);
    // production NEVER allows an anonymous control WS, even with the flag
    expect(
      loadDeviceAuthConfig({ ...base, NODE_ENV: "production", ARTOO_ALLOW_DEV_NODE_TOKEN: "1" })
        .devControlEscape,
    ).toBe(false);
  });
});

describe("testDeviceAuthConfig", () => {
  it("defaults to dev escape on with a fixed pepper, and applies overrides", () => {
    expect(testDeviceAuthConfig()).toEqual({
      pairingPepper: "test-pairing-pepper-0123456789",
      devNodeToken: "dev",
      devControlEscape: true,
    });
    expect(testDeviceAuthConfig({ devNodeToken: null }).devNodeToken).toBeNull();
    expect(testDeviceAuthConfig({ devControlEscape: false }).devControlEscape).toBe(false);
  });
});
