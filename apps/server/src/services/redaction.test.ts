import { describe, expect, it } from "vitest";

import { isSensitiveFieldName, redactSecretText } from "./redaction.js";

describe("redactSecretText — free text", () => {
  it("redacts sk_device_ tokens while keeping the family prefix", () => {
    const out = redactSecretText("node url ws://h/api/v1/node?token=sk_device_ab12cd_S3cretBody-x_y");
    expect(out).toContain("sk_device_<redacted:secret>");
    expect(out).not.toContain("S3cretBody");
  });

  it("still redacts sk_agent_ and sk_machine_ tokens", () => {
    expect(redactSecretText("k=sk_agent_abc123secret")).toContain("sk_agent_<redacted:secret>");
    expect(redactSecretText("k=sk_machine_abc123secret")).toContain("sk_machine_<redacted:secret>");
  });

  it("redacts a device token embedded in a larger log line", () => {
    const line = "injected ARTOO_NODE_URL with sk_device_deadbeef_AbCdEf012-_ and continued";
    const out = redactSecretText(line);
    expect(out).not.toContain("AbCdEf012");
    expect(out).toContain("sk_device_<redacted:secret>");
  });
});

describe("isSensitiveFieldName — structured token fields", () => {
  it("flags device credential field names", () => {
    expect(isSensitiveFieldName("node_token")).toBe(true);
    expect(isSensitiveFieldName("control_session_token")).toBe(true);
    expect(isSensitiveFieldName("device_token")).toBe(true);
    expect(isSensitiveFieldName("pairing_secret")).toBe(true);
    expect(isSensitiveFieldName("credential")).toBe(true);
  });

  it("does not over-redact benign or non-secret fields", () => {
    expect(isSensitiveFieldName("idempotency_key")).toBe(false);
    expect(isSensitiveFieldName("device_id")).toBe(false);
    expect(isSensitiveFieldName("display_name")).toBe(false);
    // lookup + hash are non-secret (index hint / preimage-resistant digest).
    expect(isSensitiveFieldName("token_lookup")).toBe(false);
    expect(isSensitiveFieldName("token_hash")).toBe(false);
  });
});
