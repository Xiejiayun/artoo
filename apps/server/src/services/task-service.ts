import {
  appendEvent,
  agentRuntimes,
  agentInstances,
  agents,
  approvals,
  artifacts,
  autonomousReviews,
  computers,
  effortProfiles,
  eventLog,
  modelProfiles,
  organizations,
  projects,
  rooms,
  runs,
  tasks,
  users,
} from "@artoo/db";
import {
  ID_PREFIXES,
  deriveResourceLifecycle,
  type PreparedGoalEntryV1,
  type Agent,
  type AgentInstance,
  type Computer,
  type CreateTaskRequest,
  type EffortProfile,
  type ModelProfile,
  type Room,
  type Task,
  type TaskReview,
} from "@artoo/domain";
import { and, asc, desc, eq, isNull } from "drizzle-orm";

import type { ServerContext } from "../context.js";
import { preparedGoalEntrySnapshot } from "../config/goal-entry.js";
import { resourceExpiryMs } from "../config/resource-lifecycle.js";
import { effectiveTeamRole } from "../auth/request-auth.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { listTaskReviews } from "./review-history-service.js";
import { loadWorkspaceRetentions } from "./workspace-retention-service.js";
import {
  mapAgent,
  mapAgentInstance,
  mapApproval,
  mapArtifact,
  mapComputer,
  mapEffortProfile,
  mapModelProfile,
  mapRoom,
  mapRun,
  mapTask,
} from "../mappers.js";

export interface BootstrapResponse {
  goal_entry?: PreparedGoalEntryV1;
  organization: { id: string; name: string };
  user: { id: string; email: string; display_name: string; role: string };
  projects: { id: string; name: string; default_workspace: string | null }[];
  computers: Computer[];
  agents: Agent[];
  agent_instances: AgentInstance[];
  model_profiles: ModelProfile[];
  effort_profiles: EffortProfile[];
  actor: { type: "user"; id: string };
}

/** GET /api/v1/bootstrap — organization resources and the authenticated actor. */
export async function bootstrap(ctx: ServerContext, isLive: (computerId: string) => boolean = () => false): Promise<BootstrapResponse> {
  const db = ctx.db.db;
  const orgRow = (await db.select().from(organizations).where(eq(organizations.id, ctx.organizationId)))[0];
  const userRow = (await db.select().from(users).where(eq(users.id, ctx.actorUserId)))[0];
  if (orgRow === undefined || userRow === undefined) {
    throw AppError.notFound("bootstrap data missing; database not seeded");
  }
  const projectRows = await db
    .select()
    .from(projects)
    .where(eq(projects.organizationId, ctx.organizationId))
    .orderBy(asc(projects.name), asc(projects.id));
  const computerRows = await db
    .select()
    .from(computers)
    .where(and(eq(computers.organizationId, ctx.organizationId), isNull(computers.deletedAt)))
    .orderBy(asc(computers.displayName), asc(computers.id));
  const agentRows = await db
    .select()
    .from(agents)
    .where(and(eq(agents.organizationId, ctx.organizationId), isNull(agents.deletedAt)))
    .orderBy(asc(agents.displayName), asc(agents.id));
  const instanceRows = await db
    .select()
    .from(agentInstances)
    .where(and(eq(agentInstances.organizationId, ctx.organizationId), isNull(agentInstances.deletedAt)))
    .orderBy(asc(agentInstances.id));
  const modelRows = await db
    .select()
    .from(modelProfiles)
    .where(eq(modelProfiles.organizationId, ctx.organizationId))
    .orderBy(asc(modelProfiles.name), asc(modelProfiles.id));
  const effortRows = await db
    .select()
    .from(effortProfiles)
    .where(eq(effortProfiles.organizationId, ctx.organizationId))
    .orderBy(asc(effortProfiles.name), asc(effortProfiles.id));
  const goalEntry = await preparedGoalEntrySnapshot(ctx);
  const timeoutMs = resourceExpiryMs();
  const now = ctx.clock.nowIso();
  const runtimes = await db.select().from(agentRuntimes).where(eq(agentRuntimes.organizationId, ctx.organizationId));
  const mappedComputers = computerRows.map((row) => ({ ...mapComputer(row),
    lifecycle: deriveResourceLifecycle(row.lastHeartbeatAt, row.createdAt, now, isLive(row.id), timeoutMs) }));
  const mappedInstances = instanceRows.map((row) => {
    const computer = computerRows.find((item) => item.id === row.computerId);
    const runtime = runtimes.find((item) => item.computerId === row.computerId && item.runtime === row.runtime);
    // Older daemons without a runtime row retain computer-heartbeat compatibility.
    const lastSeen = runtime ? runtime.lastSeenAt : computer?.lastHeartbeatAt ?? null;
    return { ...mapAgentInstance(row), lifecycle: deriveResourceLifecycle(lastSeen, row.createdAt, now,
      isLive(row.computerId) && (!runtime || runtime.status === "available"), timeoutMs) };
  });
  const mappedAgents = agentRows.map((row) => {
    const instances = mappedInstances.filter((item) => item.agent_id === row.id);
    const latest = instances.flatMap((item) => [item.lifecycle.last_seen_at, item.created_at]).filter((item): item is string => item !== null)
      .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
    const lifecycle = deriveResourceLifecycle(latest, row.createdAt, now,
      instances.some((item) => item.lifecycle.state === "active"), timeoutMs);
    lifecycle.last_seen_at = instances.flatMap((item) => item.lifecycle.last_seen_at ? [item.lifecycle.last_seen_at] : [])
      .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
    return { ...mapAgent(row), lifecycle };
  });
  return {
    ...(goalEntry ? { goal_entry: goalEntry } : {}),
    organization: { id: orgRow.id, name: orgRow.name },
    user: {
      id: userRow.id,
      email: userRow.email,
      display_name: userRow.displayName,
      role: effectiveTeamRole(ctx, userRow.email, userRow.role),
    },
    projects: projectRows.map((p) => ({
      id: p.id,
      name: p.name,
      default_workspace: p.defaultWorkspace,
    })),
    computers: mappedComputers,
    agents: mappedAgents,
    agent_instances: mappedInstances,
    model_profiles: modelRows.map(mapModelProfile),
    effort_profiles: effortRows.map(mapEffortProfile),
    actor: { type: "user", id: userRow.id },
  };
}

/**
 * GET /api/v1/tasks?project_id=<id> — project-scoped task list for the web left
 * rail. Stable order (created_at, id) so rendering is deterministic; web derives
 * no lifecycle, it just renders these snapshots.
 */
export async function listTasks(ctx: ServerContext, projectId: string): Promise<Task[]> {
  const rows = await ctx.db.db
    .select()
    .from(tasks)
    .where(and(eq(tasks.organizationId, ctx.organizationId), eq(tasks.projectId, projectId)))
    .orderBy(asc(tasks.createdAt), asc(tasks.id));
  // Review tasks deliberately have no scheduling goalId. Expose their original
  // task's provenance in this read model without changing reconciliation.
  const reviewLinks = await ctx.db.db.select({
    taskId: autonomousReviews.reviewTaskId, goalId: autonomousReviews.goalId, planId: tasks.sourcePlanId,
  }).from(autonomousReviews).innerJoin(tasks, and(
    eq(tasks.id, autonomousReviews.taskId), eq(tasks.goalId, autonomousReviews.goalId),
    eq(tasks.organizationId, ctx.organizationId), eq(tasks.projectId, projectId),
  )).where(eq(autonomousReviews.organizationId, ctx.organizationId));
  const links = new Map(reviewLinks.map((link) => [link.taskId, link]));
  return rows.map((row) => {
    const task = mapTask(row), link = links.get(row.id);
    return link && !row.goalId ? { ...task, goal_id: link.goalId, source_plan_id: link.planId } : task;
  });
}

/**
 * POST /api/v1/tasks — atomically create the task AND its task room, emitting
 * task.created + room.created in the SAME transaction. There is never a task
 * without a room (review gate); a rollback leaves neither row nor event.
 */
export async function createTask(
  ctx: ServerContext,
  req: CreateTaskRequest,
): Promise<{ task: Task; room: Room }> {
  const now = ctx.clock.nowIso();
  const taskId = ctx.idGen.generate(ID_PREFIXES.task);
  const roomId = ctx.idGen.generate(ID_PREFIXES.room);
  const correlationId = taskId;

  return ctx.db.transaction(async (tx) => {
    const project = await tx
      .select()
      .from(projects)
      .where(and(eq(projects.id, req.project_id), eq(projects.organizationId, ctx.organizationId)));
    if (project.length === 0) {
      throw AppError.notFound(`project not found: ${req.project_id}`, { project_id: req.project_id });
    }

    await tx.insert(tasks).values({
      id: taskId,
      organizationId: ctx.organizationId,
      projectId: req.project_id,
      parentTaskId: req.parent_task_id ?? null,
      roomId,
      title: req.title,
      description: req.description,
      status: "backlog",
      priority: req.priority,
      requiredCapabilities: req.required_capabilities,
      preferredModelProfileId: req.preferred_model_profile_id ?? null,
      preferredEffort: req.preferred_effort ?? null,
      acceptanceCriteria: req.acceptance_criteria,
      createdByType: "user",
      createdById: ctx.actorUserId,
      createdAt: now,
      updatedAt: now,
    });

    await tx.insert(rooms).values({
      id: roomId,
      organizationId: ctx.organizationId,
      projectId: req.project_id,
      taskId,
      type: "task",
      name: req.title,
      createdAt: now,
    });

    await appendEvent(
      tx,
      buildEvent(ctx, {
        type: "task.created",
        actorType: "user",
        actorId: ctx.actorUserId,
        correlationId,
        projectId: req.project_id,
        taskId,
        roomId,
        payload: { title: req.title },
      }),
    );
    await appendEvent(
      tx,
      buildEvent(ctx, {
        type: "room.created",
        actorType: "system",
        actorId: "system",
        correlationId,
        projectId: req.project_id,
        taskId,
        roomId,
      }),
    );

    const taskRow = (await tx.select().from(tasks).where(eq(tasks.id, taskId)))[0];
    const roomRow = (await tx.select().from(rooms).where(eq(rooms.id, roomId)))[0];
    if (taskRow === undefined || roomRow === undefined) {
      throw new Error("createTask: row missing after insert");
    }
    return { task: mapTask(taskRow), room: mapRoom(roomRow) };
  });
}

export interface TaskSnapshot {
  task: Task;
  room: Room | null;
  runs: ReturnType<typeof mapRun>[];
  approvals: ReturnType<typeof mapApproval>[];
  artifacts: ReturnType<typeof mapArtifact>[];
  reviews: TaskReview[];
  /**
   * Task-scoped optimistic-concurrency version (#27 v2-B slice 2): the task's
   * highest `event_log.position`. A client that hydrated this snapshot sends it
   * back as a command `base_version`; the server rejects the command if the task
   * has since advanced. Sourced from the actual resource read — not the global
   * org cursor — so a command can never act on a snapshot the user never loaded.
   */
  version_cursor: number;
}

/** GET /api/v1/tasks/:id — one consistent task, review and artifact snapshot. */
export async function getTaskSnapshot(ctx: ServerContext, id: string): Promise<TaskSnapshot> {
  return ctx.db.db.transaction(async (db) => {
    const taskRow = (
      await db
        .select()
        .from(tasks)
        .where(and(eq(tasks.id, id), eq(tasks.organizationId, ctx.organizationId)))
    )[0];
    if (taskRow === undefined) {
      throw AppError.notFound(`task not found: ${id}`, { task_id: id });
    }
    const task = mapTask(taskRow);
    const roomRow =
      task.room_id != null
        ? (await db.select().from(rooms).where(and(eq(rooms.id, task.room_id), eq(rooms.organizationId, ctx.organizationId))))[0]
        : undefined;
    const runRows = await db.select().from(runs).where(and(eq(runs.taskId, id), eq(runs.organizationId, ctx.organizationId)));
    const retention = await loadWorkspaceRetentions(db, ctx.organizationId, runRows);
    const approvalRows = await db.select().from(approvals).where(and(eq(approvals.taskId, id), eq(approvals.organizationId, ctx.organizationId)));
    const artifactRows = await db.select().from(artifacts).where(and(eq(artifacts.taskId, id), eq(artifacts.organizationId, ctx.organizationId)));
    const reviews = await listTaskReviews(ctx, db, id, task.project_id);
    const [version] = await db.select({ position: eventLog.position }).from(eventLog)
      .where(and(eq(eventLog.organizationId, ctx.organizationId), eq(eventLog.taskId, id)))
      .orderBy(desc(eventLog.position)).limit(1);

    return {
      task,
      room: roomRow !== undefined ? mapRoom(roomRow) : null,
      runs: runRows.map((run) => ({ ...mapRun(run), workspace_retention: retention.get(run.id) ?? null })),
      approvals: approvalRows.map(mapApproval),
      artifacts: artifactRows.map(mapArtifact),
      reviews,
      version_cursor: version?.position ?? 0,
    };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
