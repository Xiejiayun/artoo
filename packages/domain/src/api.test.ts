import { describe, expect, it } from "vitest";

import {
  ApiErrorSchema,
  CreateTaskRequestSchema,
  ResolveApprovalRequestSchema,
  RetryRequestSchema,
  ReviewRequestSchema,
  apiError,
} from "./api.js";

describe("api contracts", () => {
  it("error envelope has the fixed { error: { code, message, details } } shape", () => {
    const err = apiError("validation_error", "title is required", { field: "title" });
    const parsed = ApiErrorSchema.parse(err);
    expect(parsed.error.code).toBe("validation_error");
    expect(parsed.error.details).toEqual({ field: "title" });
  });

  it("review outcome is accepted | changes_requested", () => {
    expect(ReviewRequestSchema.parse({ outcome: "changes_requested" }).outcome).toBe(
      "changes_requested",
    );
    expect(ReviewRequestSchema.safeParse({ outcome: "nope" }).success).toBe(false);
  });

  it("retry request accepts an optional reason", () => {
    expect(RetryRequestSchema.parse({}).reason ?? null).toBe(null);
    expect(RetryRequestSchema.parse({ reason: "flaky run" }).reason).toBe("flaky run");
  });

  it("resolve approval decision is constrained", () => {
    expect(ResolveApprovalRequestSchema.parse({ decision: "approved" }).decision).toBe("approved");
    expect(ResolveApprovalRequestSchema.safeParse({ decision: "maybe" }).success).toBe(false);
  });

  it("create task applies defaults", () => {
    const req = CreateTaskRequestSchema.parse({ project_id: "proj_1", title: "x" });
    expect(req.priority).toBe("p2");
    expect(req.acceptance_criteria).toEqual([]);
    expect(req.required_capabilities).toEqual([]);
  });
});
