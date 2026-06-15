import {
  agentRuntimes,
  artifacts,
  approvals,
  eventLog,
  fileLeases,
  messages,
  rooms,
  runs,
  schedulerDecisions,
  taskDependencies,
  tasks,
} from "@artoo/db";
import {
  AgentRuntimeSchema,
  AuditEventSchema,
  ApprovalSchema,
  ArtifactSchema,
  FileLeaseSchema,
  MessageSchema,
  RoomSchema,
  RunSchema,
  SchedulerDecisionSchema,
  TaskDependencySchema,
  TaskSchema,
  type AgentRuntime,
  type AuditEvent,
  type Approval,
  type Artifact,
  type FileLease,
  type Message,
  type Room,
  type Run,
  type SchedulerDecision,
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
    workspace_root: row.workspaceRoot,
    workspace_branch: row.workspaceBranch,
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

export function mapFileLease(row: typeof fileLeases.$inferSelect): FileLease {
  return FileLeaseSchema.parse({
    id: row.id,
    organization_id: row.organizationId,
    project_id: row.projectId,
    task_id: row.taskId,
    run_id: row.runId,
    holder_type: row.holderType,
    holder_id: row.holderId,
    path: row.path,
    mode: row.mode,
    status: row.status,
    acquired_at: row.acquiredAt,
    expires_at: row.expiresAt,
    released_at: row.releasedAt,
    created_at: row.createdAt,
  });
}

export function mapAgentRuntime(row: typeof agentRuntimes.$inferSelect): AgentRuntime {
  return AgentRuntimeSchema.parse({
    id: row.id,
    organization_id: row.organizationId,
    computer_id: row.computerId,
    runtime: row.runtime,
    version: row.version,
    status: row.status,
    capabilities: row.capabilities ?? [],
    last_seen_at: row.lastSeenAt,
  });
}

export function mapSchedulerDecision(row: typeof schedulerDecisions.$inferSelect): SchedulerDecision {
  return SchedulerDecisionSchema.parse({
    id: row.id,
    organization_id: row.organizationId,
    task_id: row.taskId,
    selected_computer_id: row.selectedComputerId,
    selected_agent_instance_id: row.selectedAgentInstanceId,
    selected_model_profile_id: row.selectedModelProfileId,
    selected_effort_profile_id: row.selectedEffortProfileId,
    mode: row.mode,
    score: row.score,
    reason: row.reason,
    candidates: row.candidates,
    created_at: row.createdAt,
  });
}

export function mapAuditEvent(row: typeof eventLog.$inferSelect): AuditEvent {
  return AuditEventSchema.parse({
    position: row.position,
    id: row.id,
    type: row.type,
    schema_version: row.schemaVersion,
    organization_id: row.organizationId,
    project_id: row.projectId,
    task_id: row.taskId,
    room_id: row.roomId,
    run_id: row.runId,
    actor: { type: row.actorType, id: row.actorId },
    occurred_at: row.occurredAt,
    correlation_id: row.correlationId,
    idempotency_key: row.idempotencyKey,
    sequence: row.sequence,
    payload: row.payload,
  });
}
