import { describe, expect, it } from "vitest";

import {
  NODE_ERROR_CODES,
  isNodeErrorCode,
  nodeErrorCodeSchema
} from "./errors.js";

describe("node error codes", () => {
  it("is the exact closed set from the node protocol contract", () => {
    expect([...NODE_ERROR_CODES].sort()).toEqual(
      [
        "artifact_not_found",
        "internal_error",
        "permission_denied",
        "process_exited",
        "process_start_failed",
        "runtime_missing",
        "timeout",
        "workspace_missing"
      ].sort()
    );
  });

  it("accepts a valid code and rejects an unknown one", () => {
    expect(nodeErrorCodeSchema.safeParse("permission_denied").success).toBe(true);
    expect(nodeErrorCodeSchema.safeParse("not_a_code").success).toBe(false);
  });

  it("type guard narrows membership", () => {
    expect(isNodeErrorCode("timeout")).toBe(true);
    expect(isNodeErrorCode("definitely_not")).toBe(false);
  });
});
