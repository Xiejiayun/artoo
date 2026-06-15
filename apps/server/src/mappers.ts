import { artifacts, approvals, messages, rooms, runs, taskDependencies, tasks } from "@artoo/db";
import {
  ApprovalSchema,
  ArtifactSchema,
  MessageSchema,
  RoomSchema,
  RunSchema,
  TaskDependencySchema,
  TaskSchema,
  type Approval,
  type Artifact,
  type Message,
  type Room,
  type Run,
  type Task,
  type TaskDependency,
} from "@artoo/domain";

/**
 * Map drizzle rows (camelCase, snapshot of design.md §3.7 columns) to the
 * domain API entities (snake_case). Parsing through the domain Zod schema both
 * validates the mapping and coerces jsonb columns to their typed shapes — this
 * is the single seam where db rows become API snapshots.
 */

export function mapTask(row: typeof tasks.$inferSelect): Task {
  return TaskSchema.parse({
    id: row.id,
    organization_id: row.organizationId,
    project_id: row.projectId,
    parent_task_id: row.parentTaskId,
    room_id: row.roomId,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    assignee_type: row.assigneeType,
    assignee_id: row.assigneeId,
    required_capabilities: row.requiredCapabilities,
    preferred_model_profile_id: row.preferredModelProfileId,
    preferred_effort: row.preferredEffort,
    acceptance_criteria: row.acceptanceCriteria,
    created_by_type: row.createdByType,
    created_by_id: row.createdById,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  });
}

export function mapRoom(row: typeof rooms.$inferSelect): Room {
  return RoomSchema.parse({
    id: row.id,
    organization_id: row.organizationId,
    project_id: row.projectId,
    task_id: row.taskId,
    type: row.type,
    name: row.name,
    created_at: row.createdAt,
  });
}

export function mapRun(row: typeof runs.$inferSelect): Run {
  return RunSchema.parse({
    id: row.id,
    organization_id: row.organizationId,
    task_id: row.taskId,
    computer_id: row.computerId,
    agent_instance_id: row.agentInstanceId,
    runtime_id: row.runtimeId,
    scheduler_decision_id: row.schedulerDecisionId,
    model_profile_id: row.modelProfileId,
    effort_profile_id: row.effortProfileId,
    status: row.status,
    context_pack_id: row.contextPackId,
    started_at: row.startedAt,
    ended_at: row.endedAt,
    failure_reason: row.failureReason,
    sequence: row.sequence,
    created_at: row.createdAt,
  });
}

export function mapApproval(row: typeof approvals.$inferSelect): Approval {
  return ApprovalSchema.parse({
    id: row.id,
    organization_id: row.organizationId,
    task_id: row.taskId,
    run_id: row.runId,
    requested_by_type: row.requestedByType,
    requested_by_id: row.requestedById,
    action: row.action,
    risk: row.risk,
    summary: row.summary,
    payload_ref: row.payloadRef,
    status: row.status,
    resolved_by: row.resolvedBy,
    resolved_at: row.resolvedAt,
    expires_at: row.expiresAt,
    created_at: row.createdAt,
  });
}

export function mapArtifact(row: typeof artifacts.$inferSelect): Artifact {
  return ArtifactSchema.parse({
    id: row.id,
    organization_id: row.organizationId,
    task_id: row.taskId,
    run_id: row.runId,
    type: row.type,
    uri: row.uri,
    metadata: row.metadata,
    checksum: row.checksum,
    created_at: row.createdAt,
  });
}

export function mapMessage(row: typeof messages.$inferSelect): Message {
  return MessageSchema.parse({
    id: row.id,
    organization_id: row.organizationId,
    room_id: row.roomId,
    task_id: row.taskId,
    run_id: row.runId,
    actor_type: row.actorType,
    actor_id: row.actorId,
    kind: row.kind,
    body: row.body,
    payload: row.payload,
    created_at: row.createdAt,
  });
}

export function mapDependency(row: typeof taskDependencies.$inferSelect): TaskDependency {
  return TaskDependencySchema.parse({
    id: row.id,
    organization_id: row.organizationId,
    from_task_id: row.fromTaskId,
    to_task_id: row.toTaskId,
    type: row.type,
    created_at: row.createdAt,
  });
}
