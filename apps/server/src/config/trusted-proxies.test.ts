import { describe, expect, it } from "vitest";
import { loadTrustedProxies } from "./trusted-proxies.js";

describe("trusted proxy configuration", () => {
  it.each([undefined, "", "  "])("ignores forwarded headers when configuration is %j", (value) => {
    expect(loadTrustedProxies({ ARTOO_TRUSTED_PROXIES: value })).toEqual([]);
  });

  it("accepts explicit IPv4 and IPv6 peers and removes duplicate entries", () => {
    expect(loadTrustedProxies({ ARTOO_TRUSTED_PROXIES: " 127.0.0.1, ::1, 127.0.0.1, ::ffff:192.0.2.10 " }))
      .toEqual(["127.0.0.1", "::1", "::ffff:192.0.2.10"]);
  });

  it.each([
    "true", "false", "1", "*", "loopback", "localhost", "0.0.0.0/0", "::/0", "10.0.0.0/8",
    "127.0.0.1,", ",127.0.0.1", "127.0.0.1, ,::1", "127.0.0.1:4000",
  ])("rejects unsafe or ambiguous configuration %j", (value) => {
    expect(() => loadTrustedProxies({ ARTOO_TRUSTED_PROXIES: value })).toThrow("ARTOO_TRUSTED_PROXIES");
  });
});
