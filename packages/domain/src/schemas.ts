/**
 * Core entity schemas — API snapshot shapes mirroring the v0.1 columns in
 * design.md §3.7. Statuses reuse the state-machine enums so there is one source
 * of truth. Optional/nullable columns use `.nullish()`.
 */
import { z } from "zod";

import { CapabilitySchema } from "./capabilities.js";
import { EventEnvelopeSchema } from "./events.js";
import { ArtifactTypeSchema } from "./node-payloads.js";
import { ApprovalStatusSchema, RunStatusSchema, TaskStatusSchema } from "./state.js";

export const PrioritySchema = z.enum(["p0", "p1", "p2", "p3"]);
export const PRIORITIES = PrioritySchema.options;
export type Priority = z.infer<typeof PrioritySchema>;

export const EffortSchema = z.enum(["low", "medium", "high", "max"]);
export type Effort = z.infer<typeof EffortSchema>;

export const AssigneeTypeSchema = z.enum(["user", "agent", "agent_team"]);
export const CreatedByTypeSchema = z.enum(["user", "agent", "system"]);
export const DependencyTypeSchema = z.enum([
  "blocks",
  "artifact_required",
  "contract_required",
  "review_required",
  "soft_context",
]);
export const DEPENDENCY_TYPES = DependencyTypeSchema.options;
export type DependencyType = z.infer<typeof DependencyTypeSchema>;

/** A file lease is a read- or write-scoped claim over a workspace path (#12). */
export const LeaseModeSchema = z.enum(["read", "write"]);
export type LeaseMode = z.infer<typeof LeaseModeSchema>;
export const LeaseStatusSchema = z.enum(["held", "released", "expired"]);
export type LeaseStatus = z.infer<typeof LeaseStatusSchema>;
/** Who owns a lease. Defaults to run/task; agent/system reserved for Phase B. */
export const LeaseHolderTypeSchema = z.enum(["run", "task", "agent", "system"]);
export type LeaseHolderType = z.infer<typeof LeaseHolderTypeSchema>;
export const IntegrationQueueStatusSchema = z.enum([
  "queued",
  "integrating",
  "done",
  "failed",
]);
export type IntegrationQueueStatus = z.infer<typeof IntegrationQueueStatusSchema>;

export const RiskSchema = z.enum(["low", "medium", "high"]);
export const RoomTypeSchema = z.enum(["dm", "project", "sprint", "task", "agent_team", "incident"]);

export const TaskSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  project_id: z.string(),
  parent_task_id: z.string().nullish(),
  room_id: z.string().nullish(),
  title: z.string(),
  description: z.string().default(""),
  status: TaskStatusSchema,
  priority: PrioritySchema.default("p2"),
  assignee_type: AssigneeTypeSchema.nullish(),
  assignee_id: z.string().nullish(),
  required_capabilities: z.array(CapabilitySchema).default([]),
  preferred_model_profile_id: z.string().nullish(),
  preferred_effort: EffortSchema.nullish(),
  acceptance_criteria: z.array(z.string()).default([]),
  created_by_type: CreatedByTypeSchema,
  created_by_id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Task = z.infer<typeof TaskSchema>;

export const TaskDependencySchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  from_task_id: z.string(),
  to_task_id: z.string(),
  type: DependencyTypeSchema,
  created_at: z.string(),
});
export type TaskDependency = z.infer<typeof TaskDependencySchema>;

export const FileLeaseSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  project_id: z.string(),
  task_id: z.string(),
  run_id: z.string().nullish(),
  holder_type: LeaseHolderTypeSchema,
  holder_id: z.string(),
  path: z.string(),
  mode: LeaseModeSchema,
  status: LeaseStatusSchema,
  acquired_at: z.string(),
  expires_at: z.string().nullish(),
  released_at: z.string().nullish(),
  created_at: z.string(),
});
export type FileLease = z.infer<typeof FileLeaseSchema>;

export const IntegrationQueueEntrySchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  project_id: z.string(),
  task_id: z.string(),
  run_id: z.string().nullish(),
  status: IntegrationQueueStatusSchema,
  sequence: z.number().int(),
  artifact_ref: z.string().nullish(),
  enqueued_at: z.string(),
  started_at: z.string().nullish(),
  ended_at: z.string().nullish(),
  created_at: z.string(),
});
export type IntegrationQueueEntry = z.infer<typeof IntegrationQueueEntrySchema>;

/** A runtime advertised by a computer's node heartbeat (#15 Part 2). */
export const AgentRuntimeStatusSchema = z.enum(["detected", "available", "missing", "disabled"]);
export type AgentRuntimeStatus = z.infer<typeof AgentRuntimeStatusSchema>;
export const AgentRuntimeSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  computer_id: z.string(),
  runtime: z.string(),
  version: z.string().nullish(),
  status: AgentRuntimeStatusSchema,
  capabilities: z.array(z.string()).default([]),
  last_seen_at: z.string().nullish(),
});
export type AgentRuntime = z.infer<typeof AgentRuntimeSchema>;

export const RunSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  task_id: z.string(),
  computer_id: z.string(),
  agent_instance_id: z.string(),
  runtime_id: z.string(),
  scheduler_decision_id: z.string().nullish(),
  model_profile_id: z.string().nullish(),
  effort_profile_id: z.string().nullish(),
  status: RunStatusSchema,
  context_pack_id: z.string().nullish(),
  started_at: z.string().nullish(),
  ended_at: z.string().nullish(),
  failure_reason: z.string().nullish(),
  sequence: z.number().int().default(0),
  created_at: z.string(),
});
export type Run = z.infer<typeof RunSchema>;

export const ApprovalSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  task_id: z.string(),
  run_id: z.string().nullish(),
  requested_by_type: z.enum(["agent", "system"]),
  requested_by_id: z.string(),
  action: z.string(),
  risk: RiskSchema,
  summary: z.string(),
  payload_ref: z.string().nullish(),
  status: ApprovalStatusSchema,
  resolved_by: z.string().nullish(),
  resolved_at: z.string().nullish(),
  expires_at: z.string().nullish(),
  created_at: z.string(),
});
export type Approval = z.infer<typeof ApprovalSchema>;

export const RoomSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  project_id: z.string().nullish(),
  task_id: z.string().nullish(),
  type: RoomTypeSchema,
  name: z.string(),
  created_at: z.string(),
});
export type Room = z.infer<typeof RoomSchema>;

export const MessageSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  room_id: z.string(),
  task_id: z.string().nullish(),
  run_id: z.string().nullish(),
  actor_type: z.enum(["user", "agent", "system", "bridge"]),
  actor_id: z.string(),
  // Free-form for forward-compat; render via normalizeMessageKind.
  kind: z.string(),
  body: z.string().default(""),
  payload: z.record(z.unknown()).default({}),
  created_at: z.string(),
});
export type Message = z.infer<typeof MessageSchema>;

export const ArtifactSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  task_id: z.string(),
  run_id: z.string().nullish(),
  type: ArtifactTypeSchema,
  uri: z.string(),
  metadata: z.record(z.unknown()).default({}),
  checksum: z.string().nullish(),
  created_at: z.string(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const SchedulerDecisionSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  task_id: z.string(),
  selected_computer_id: z.string(),
  selected_agent_instance_id: z.string(),
  selected_model_profile_id: z.string().nullish(),
  selected_effort_profile_id: z.string().nullish(),
  mode: z.enum(["auto", "manual"]),
  score: z.number().int(),
  reason: z.string(),
  candidates: z.array(z.record(z.unknown())).default([]),
  created_at: z.string(),
});
export type SchedulerDecision = z.infer<typeof SchedulerDecisionSchema>;

export const AuditEventSchema = EventEnvelopeSchema.extend({
  position: z.number().int(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export const TaskAuditBundleSchema = z.object({
  task: TaskSchema,
  room: RoomSchema.nullable(),
  messages: z.array(MessageSchema),
  runs: z.array(RunSchema),
  artifacts: z.array(ArtifactSchema),
  approvals: z.array(ApprovalSchema),
  scheduler_decisions: z.array(SchedulerDecisionSchema),
  events: z.array(AuditEventSchema),
});
export type TaskAuditBundle = z.infer<typeof TaskAuditBundleSchema>;
