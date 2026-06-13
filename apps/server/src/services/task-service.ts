import {
  appendEvent,
  approvals,
  artifacts,
  organizations,
  projects,
  rooms,
  runs,
  tasks,
  users,
} from "@artoo/db";
import { ID_PREFIXES, type CreateTaskRequest, type Room, type Task } from "@artoo/domain";
import { and, eq } from "drizzle-orm";

import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { mapApproval, mapArtifact, mapRoom, mapRun, mapTask } from "../mappers.js";

export interface BootstrapResponse {
  organization: { id: string; name: string };
  user: { id: string; email: string; display_name: string; role: string };
  projects: { id: string; name: string; default_workspace: string | null }[];
  actor: { type: "user"; id: string };
}

/** GET /api/v1/bootstrap — seeded org/user/projects + current actor (no auth in v0.1). */
export async function bootstrap(ctx: ServerContext): Promise<BootstrapResponse> {
  const db = ctx.db.db;
  const orgRow = (await db.select().from(organizations).where(eq(organizations.id, ctx.organizationId)))[0];
  const userRow = (await db.select().from(users).where(eq(users.id, ctx.actorUserId)))[0];
  if (orgRow === undefined || userRow === undefined) {
    throw AppError.notFound("bootstrap data missing; database not seeded");
  }
  const projectRows = await db
    .select()
    .from(projects)
    .where(eq(projects.organizationId, ctx.organizationId));
  return {
    organization: { id: orgRow.id, name: orgRow.name },
    user: {
      id: userRow.id,
      email: userRow.email,
      display_name: userRow.displayName,
      role: userRow.role,
    },
    projects: projectRows.map((p) => ({
      id: p.id,
      name: p.name,
      default_workspace: p.defaultWorkspace,
    })),
    actor: { type: "user", id: userRow.id },
  };
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
}

/** GET /api/v1/tasks/:id — task + room + runs[] + approvals[] + artifacts[]. */
export async function getTaskSnapshot(ctx: ServerContext, id: string): Promise<TaskSnapshot> {
  const db = ctx.db.db;
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
      ? (await db.select().from(rooms).where(eq(rooms.id, task.room_id)))[0]
      : undefined;
  const runRows = await db.select().from(runs).where(eq(runs.taskId, id));
  const approvalRows = await db.select().from(approvals).where(eq(approvals.taskId, id));
  const artifactRows = await db.select().from(artifacts).where(eq(artifacts.taskId, id));

  return {
    task,
    room: roomRow !== undefined ? mapRoom(roomRow) : null,
    runs: runRows.map(mapRun),
    approvals: approvalRows.map(mapApproval),
    artifacts: artifactRows.map(mapArtifact),
  };
}
