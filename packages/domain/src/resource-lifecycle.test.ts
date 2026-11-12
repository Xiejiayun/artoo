import { describe, expect, it } from "vitest";
import { DEFAULT_RESOURCE_EXPIRY_MS, deriveResourceLifecycle, ResourceLifecycleSchema } from "./resource-lifecycle.js";

const created = "2026-01-01T00:00:00.000Z";
describe("resource inactivity lifetime", () => {
  it("expires exactly at the inactivity deadline, including never-connected resources", () => {
    expect(deriveResourceLifecycle(null, created, "2026-01-30T23:59:59.999Z", false).state).toBe("active");
    const expired = deriveResourceLifecycle(null, created, "2026-01-31T00:00:00.000Z", false);
    expect(expired).toEqual({ version: 1, state: "expired", last_seen_at: null, expires_at: "2026-01-31T00:00:00.000Z", inactivity_timeout_ms: DEFAULT_RESOURCE_EXPIRY_MS });
    expect(ResourceLifecycleSchema.parse(expired)).toEqual(expired);
  });
  it("restores on reconnection and slides the deadline after genuine activity", () => {
    expect(deriveResourceLifecycle(created, created, "2026-03-01T00:00:00.000Z", true).state).toBe("active");
    expect(deriveResourceLifecycle("2026-03-01T00:00:00Z", created, "2026-03-01T00:00:00Z", false).expires_at).toBe("2026-03-31T00:00:00.000Z");
  });
  it("gives newly created instances a full window and supports configured lifetimes", () => {
    expect(deriveResourceLifecycle(created, "2026-02-01T00:00:00Z", "2026-02-01T00:00:00Z", false, 86400000).expires_at).toBe("2026-02-02T00:00:00.000Z");
  });
});
