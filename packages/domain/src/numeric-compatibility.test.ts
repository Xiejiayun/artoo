import { describe, expect, it } from "vitest";

import { CreateGoalRequestSchema } from "./api.js";
import { NotificationPageSchema } from "./channels.js";
import { CheckpointRefsSchema } from "./goal.js";
import { AuditEventSchema, MessageSchema, RunSchema } from "./schemas.js";
import { TaskReviewSchema } from "./task-review.js";

const beyondSafeInteger = 9007199254740992;
const occurredAt = "2026-11-07T00:00:00.000Z";

describe("existing goal budget request compatibility", () => {
  const request = { project_id: "project_1", title: "Preserve a manual goal" };

  it("retains finite JSON integers and the existing per-field limits", () => {
    for (const field of ["max_elapsed_ms", "max_retries", "max_concurrent_runs"] as const) {
      for (const value of [1, 42, beyondSafeInteger]) {
        const wire = JSON.parse(JSON.stringify({ ...request, budgets: { [field]: value } }));
        expect(CreateGoalRequestSchema.parse(wire).budgets?.[field]).toBe(value);
      }
      for (const value of [-1, -beyondSafeInteger, 1.5, NaN, Infinity, -Infinity, "42"]) {
        expect(CreateGoalRequestSchema.safeParse({ ...request, budgets: { [field]: value } }).success).toBe(false);
      }
      expect(CreateGoalRequestSchema.safeParse({ ...request, budgets: { [field]: 0 } }).success).toBe(field === "max_retries");
      expect(CreateGoalRequestSchema.parse({ ...request, budgets: { [field]: null } }).budgets?.[field]).toBeNull();
    }
  });

  it("keeps omitted budgets absent and defaults fields only when the object exists", () => {
    expect(CreateGoalRequestSchema.parse(request)).not.toHaveProperty("budgets");
    expect(CreateGoalRequestSchema.parse({ ...request, budgets: {} }).budgets).toEqual({
      max_elapsed_ms: null, max_cost_usd: null, max_retries: null, max_concurrent_runs: null, allowed_runtimes: null,
    });
  });
});

// Exercise the public records read from BIGINT/BIGSERIAL, JSONB, and SQL count(),
// including their surrounding fields and defaults rather than a numeric helper.
const records = [
  { name: "checkpoint cursor", schema: CheckpointRefsSchema, field: "event_cursor",
    base: { goal_status: "draft", plan_version: 0 }, zero: true, negative: false, absent: "required" },
  { name: "notification count", schema: NotificationPageSchema, field: "unread_count",
    base: { notifications: [], next_before: null, has_more: false }, zero: true, negative: false, absent: "required" },
  { name: "run sequence", schema: RunSchema, field: "sequence",
    base: { id: "run_1", organization_id: "org_1", task_id: "task_1", computer_id: "computer_1",
      agent_instance_id: "instance_1", runtime_id: "runtime_1", status: "running", created_at: occurredAt },
    zero: true, negative: true, absent: "zero" },
  { name: "message sequence", schema: MessageSchema, field: "sequence",
    base: { id: "message_1", organization_id: "org_1", room_id: "room_1", actor_type: "user", actor_id: "user_1",
      kind: "text", body: "A durable message", created_at: occurredAt }, zero: false, negative: false, absent: "optional" },
  { name: "audit position", schema: AuditEventSchema, field: "position",
    base: { id: "event_1", type: "task.reviewed", schema_version: "1", organization_id: "org_1",
      actor: { type: "user", id: "user_1" }, occurred_at: occurredAt, correlation_id: "task_1" },
    zero: true, negative: true, absent: "required" },
  { name: "review position", schema: TaskReviewSchema, field: "position",
    base: { event_id: "event_1", task_id: "task_1", outcome: "accepted", comment: null,
      actor: { type: "user", id: "user_1" }, actor_name: null, occurred_at: occurredAt, artifact_ids: null },
    zero: false, negative: false, absent: "required" },
] as const;

describe.each(records)("existing $name compatibility", ({ schema, field, base, zero, negative, absent }) => {
  it("preserves ordinary and large finite integers through JSON", () => {
    for (const value of [1, 42, beyondSafeInteger]) {
      const wire = JSON.parse(JSON.stringify({ ...base, [field]: value }));
      expect(schema.parse(wire)).toMatchObject({ [field]: value });
    }
    for (const value of [-1, -beyondSafeInteger]) {
      const wire = JSON.parse(JSON.stringify({ ...base, [field]: value }));
      expect(schema.safeParse(wire).success).toBe(negative);
    }
    expect(schema.safeParse({ ...base, [field]: 0 }).success).toBe(zero);
  });

  it("rejects fractions, non-finite numbers, strings and null", () => {
    for (const value of [1.5, NaN, Infinity, -Infinity, "42", null]) {
      expect(schema.safeParse({ ...base, [field]: value }).success).toBe(false);
    }
  });

  it("keeps the existing missing-field behavior", () => {
    if (absent === "required") expect(schema.safeParse(base).success).toBe(false);
    else if (absent === "zero") expect(schema.parse(base)).toMatchObject({ [field]: 0 });
    else expect(schema.parse(base)).not.toHaveProperty(field);
  });
});
