import { z } from "zod";
import { RunSchema, TaskSchema } from "./schemas.js";
import { SchedulerQueueMetadataV1Schema } from "./scheduler-queue-metadata.js";
import { SchedulerProjectPolicyV1Schema } from "./scheduler-policy.js";
import { RunStatusSchema, TaskStatusSchema } from "./state.js";

const count = z.number().int().nonnegative();
const identity = z.string().min(1).max(128);

/** Observations only. These fields cannot authorize launch, renewal or Stop. */
export const ProjectControlTaskV1Schema = z.object({
  task: TaskSchema,
  latest_run: RunSchema.nullable(),
  execution_lease: z.object({
    id: identity,
    run_id: identity,
    computer_id: identity,
    epoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    state: z.enum(["active", "expired", "revoked"]),
    /** Durable intent only. It does not assert that a process has exited. */
    stop_requested: z.boolean().optional(),
    claimed_at: z.string().datetime(),
    observed_at: z.string().datetime(),
    expires_at: z.string().datetime(),
    closed_at: z.string().datetime().nullable(),
  }).strict().nullable(),
  execution_request: z.object({
    id: identity,
    state: z.enum(["pending", "consumed", "cancelled"]),
    consumed_run_id: identity.nullable(),
    created_at: z.string().datetime(),
  }).strict().nullable(),
  queue_metadata: z.object({
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    metadata: SchedulerQueueMetadataV1Schema,
  }).strict().nullable(),
  /** Historical explanation for this attempt, never current eligibility. */
  last_assignment: z.object({
    run_id: identity,
    reason: z.string(),
    mode: z.enum(["auto", "manual"]),
    created_at: z.string().datetime(),
  }).strict().nullable(),
}).strict();
export type ProjectControlTaskV1 = z.infer<typeof ProjectControlTaskV1Schema>;

export const ProjectControlViewV1Schema = z.object({
  version: z.literal(1),
  project_id: identity,
  observed_at: z.string().datetime(),
  tasks: z.array(ProjectControlTaskV1Schema).max(100),
  page: z.object({
    limit: z.number().int().min(1).max(100),
    next_after: z.string().nullable(),
    has_more: z.boolean(),
    order: z.literal("task_id_desc"),
  }).strict(),
  summary: z.object({
    total_tasks: count,
    tasks_by_status: z.record(TaskStatusSchema, count),
    runs_by_status: z.record(RunStatusSchema, count),
    active_execution_leases: count,
    pending_execution_requests: count,
  }).strict(),
  project_policy: SchedulerProjectPolicyV1Schema.nullable(),
  capacity: z.object({
    shared_quotas_enabled: z.boolean(),
    project_quota_enabled: z.boolean(),
    /** Includes retained reservations and uncertainty; not only active Runs. */
    occupied: count.nullable(),
    source: z.enum(["reservation_snapshot", "not_requested"]),
  }).strict(),
  rollout: z.record(z.string(), z.boolean()),
  cost_budget_enabled: z.literal(false),
}).strict();
export type ProjectControlViewV1 = z.infer<typeof ProjectControlViewV1Schema>;

export interface ProjectControlViewOptions {
  limit?: number;
  after?: string;
  /** Expensive complete reservation observation; use on demand, not per card. */
  capacity?: boolean;
}
