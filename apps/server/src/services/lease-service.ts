import { appendEvent, fileLeases, tasks } from "@artoo/db";
import {
  type AcquireLeaseRequest,
  type FileLease,
  ID_PREFIXES,
  type LeaseHolderType,
  type LeaseMode,
  type LeaseScope,
  type LeaseStatus,
  leasesConflict,
  normalizeLeasePath,
} from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, eq } from "drizzle-orm";

import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { mapFileLease } from "../mappers.js";

/**
 * Phase A lease paths are workspace-RELATIVE: the physical workspace root binds
 * later (Phase B, artood worktree injection). Normalizing against an empty root
 * means absolute paths (drive / UNC / root) are rejected at this layer, while
 * `..`/`.` are resolved and null bytes rejected before anything touches storage.
 */
const LEASE_PATH_ROOT = "";

type LeaseRow = typeof fileLeases.$inferSelect;

/** Active = currently held and not past its expiry (expired leases don't gate). */
function isActive(lease: LeaseRow, nowIso: string): boolean {
  if (lease.status !== "held") {
    return false;
  }
  return lease.expiresAt === null || lease.expiresAt > nowIso;
}

async function expireStaleLeases(
  ctx: ServerContext,
  tx: DrizzleDb,
  leases: LeaseRow[],
  nowIso: string,
): Promise<void> {
  for (const lease of leases) {
    if (lease.status !== "held" || lease.expiresAt === null || lease.expiresAt > nowIso) {
      continue;
    }
    await tx.update(fileLeases).set({ status: "expired" }).where(eq(fileLeases.id, lease.id));
    await appendEvent(
      tx,
      buildEvent(ctx, {
        type: "lease.expired",
        actorType: "system",
        actorId: "control_plane",
        correlationId: lease.taskId,
        projectId: lease.projectId,
        taskId: lease.taskId,
        runId: lease.runId,
        payload: {
          lease_id: lease.id,
          project_id: lease.projectId,
          task_id: lease.taskId,
          run_id: lease.runId,
          path: lease.path,
          mode: lease.mode,
          holder_type: lease.holderType,
          holder_id: lease.holderId,
        },
      }),
    );
  }
}

/**
 * POST /api/v1/leases — acquire a file lease. The path is normalized and
 * containment-checked BEFORE storage (malicious paths -> 400). A conflicting
 * active lease (overlapping path, at least one `write`) held by a different
 * holder -> 409. Acquiring the same (holder, path, mode) that is already held is
 * idempotent (returns the existing lease, no duplicate, no second event).
 */
export async function acquireLease(
  ctx: ServerContext,
  req: AcquireLeaseRequest,
): Promise<FileLease> {
  const now = ctx.clock.nowIso();
  return ctx.db.transaction(async (tx) => {
    const task = (
      await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.id, req.task_id), eq(tasks.organizationId, ctx.organizationId)))
    )[0];
    if (task === undefined) {
      throw AppError.notFound(`task not found: ${req.task_id}`, { task_id: req.task_id });
    }

    const normalized = normalizeLeasePath(LEASE_PATH_ROOT, req.path);
    if (!normalized.ok) {
      throw AppError.validation(`invalid lease path: ${normalized.reason}`, { path: req.path });
    }
    const path = normalized.path;
    const mode = req.mode;
    const holderType: LeaseHolderType =
      req.holder_type ?? (req.run_id != null ? "run" : "task");
    const holderId = req.holder_id ?? (req.run_id != null ? req.run_id : req.task_id);

    // Evaluate conflicts/idempotency against the project's currently-active leases.
    const projectLeases = await tx
      .select()
      .from(fileLeases)
      .where(
        and(
          eq(fileLeases.organizationId, ctx.organizationId),
          eq(fileLeases.projectId, task.projectId),
          eq(fileLeases.status, "held"),
        ),
      );
    await expireStaleLeases(ctx, tx, projectLeases, now);
    const active = projectLeases.filter((l) => isActive(l, now));

    const existing = active.find(
      (l) =>
        l.taskId === req.task_id &&
        (l.runId ?? null) === (req.run_id ?? null) &&
        l.holderType === holderType &&
        l.holderId === holderId &&
        l.path === path &&
        l.mode === mode,
    );
    if (existing !== undefined) {
      return mapFileLease(existing);
    }

    const scope: LeaseScope = { path, mode };
    const conflict = active.find((l) =>
      leasesConflict(scope, { path: l.path, mode: l.mode as LeaseMode }),
    );
    if (conflict !== undefined) {
      throw AppError.conflict("file lease conflict", {
        path,
        mode,
        conflicting_lease_id: conflict.id,
        conflicting_path: conflict.path,
        conflicting_mode: conflict.mode,
        conflicting_holder_id: conflict.holderId,
      });
    }

    const id = ctx.idGen.generate(ID_PREFIXES.lease);
    await tx.insert(fileLeases).values({
      id,
      organizationId: ctx.organizationId,
      projectId: task.projectId,
      taskId: req.task_id,
      runId: req.run_id ?? null,
      holderType,
      holderId,
      path,
      mode,
      status: "held",
      acquiredAt: now,
      expiresAt: req.expires_at ?? null,
      releasedAt: null,
      createdAt: now,
    });
    await appendEvent(
      tx,
      buildEvent(ctx, {
        type: "lease.acquired",
        actorType: "system",
        actorId: "control_plane",
        correlationId: req.task_id,
        projectId: task.projectId,
        taskId: req.task_id,
        runId: req.run_id ?? null,
        payload: {
          lease_id: id,
          project_id: task.projectId,
          task_id: req.task_id,
          run_id: req.run_id ?? null,
          path,
          mode,
          holder_type: holderType,
          holder_id: holderId,
        },
      }),
    );

    const row = (await tx.select().from(fileLeases).where(eq(fileLeases.id, id)))[0];
    if (row === undefined) {
      throw new Error("acquireLease: row missing after insert");
    }
    return mapFileLease(row);
  });
}

/**
 * DELETE /api/v1/leases/:id — release a held lease (frees its scope). Idempotent:
 * releasing an already-released/expired lease is a no-op that returns it. Emits
 * `lease.released` only on a real state change.
 */
export async function releaseLease(ctx: ServerContext, leaseId: string): Promise<FileLease> {
  const now = ctx.clock.nowIso();
  return ctx.db.transaction(async (tx) => {
    const lease = (
      await tx
        .select()
        .from(fileLeases)
        .where(and(eq(fileLeases.id, leaseId), eq(fileLeases.organizationId, ctx.organizationId)))
    )[0];
    if (lease === undefined) {
      throw AppError.notFound(`lease not found: ${leaseId}`, { lease_id: leaseId });
    }
    if (lease.status === "held") {
      await tx
        .update(fileLeases)
        .set({ status: "released", releasedAt: now })
        .where(eq(fileLeases.id, leaseId));
      await appendEvent(
        tx,
        buildEvent(ctx, {
          type: "lease.released",
          actorType: "system",
          actorId: "control_plane",
          correlationId: lease.taskId,
          projectId: lease.projectId,
          taskId: lease.taskId,
          runId: lease.runId,
          payload: {
            lease_id: leaseId,
            project_id: lease.projectId,
            task_id: lease.taskId,
            run_id: lease.runId,
            path: lease.path,
            mode: lease.mode,
            holder_type: lease.holderType,
            holder_id: lease.holderId,
          },
        }),
      );
    }
    const row = (await tx.select().from(fileLeases).where(eq(fileLeases.id, leaseId)))[0];
    if (row === undefined) {
      throw new Error("releaseLease: row missing after update");
    }
    return mapFileLease(row);
  });
}

/** GET /api/v1/projects/:id/leases — list a project's leases (optionally by status). */
export async function listLeases(
  ctx: ServerContext,
  projectId: string,
  status?: LeaseStatus,
): Promise<FileLease[]> {
  return ctx.db.transaction(async (tx) => {
    const projectLeases = await tx
      .select()
      .from(fileLeases)
      .where(
        and(eq(fileLeases.organizationId, ctx.organizationId), eq(fileLeases.projectId, projectId)),
      );
    await expireStaleLeases(ctx, tx, projectLeases, ctx.clock.nowIso());

    const where =
      status === undefined
        ? and(eq(fileLeases.organizationId, ctx.organizationId), eq(fileLeases.projectId, projectId))
        : and(
          eq(fileLeases.organizationId, ctx.organizationId),
          eq(fileLeases.projectId, projectId),
          eq(fileLeases.status, status),
        );
    const rows = await tx.select().from(fileLeases).where(where);
    return rows.map(mapFileLease);
  });
}

/**
 * Reserve `write` leases for a run (#20), INSIDE the caller's transaction (so a
 * conflict aborts the whole assignment — no run row, task stays `ready`). Paths
 * are normalized + deduped to canonical lowercase keys (so `Src/Foo` and
 * `src/foo` reserve once). Idempotent: a path this run already holds is skipped.
 * The run's own overlapping paths never self-conflict. Throws AppError.conflict on
 * a foreign overlapping lease. Returns the reserved/existing lease ids.
 */
export async function reserveRunLeases(
  ctx: ServerContext,
  tx: DrizzleDb,
  params: { taskId: string; runId: string; projectId: string; paths: readonly string[] },
): Promise<string[]> {
  if (params.paths.length === 0) {
    return [];
  }
  const now = ctx.clock.nowIso();
  const keys = new Set<string>();
  for (const raw of params.paths) {
    const normalized = normalizeLeasePath(LEASE_PATH_ROOT, raw);
    if (!normalized.ok) {
      throw AppError.validation(`invalid write path: ${normalized.reason}`, { path: raw });
    }
    keys.add(normalized.path);
  }

  const projectLeases = await tx
    .select()
    .from(fileLeases)
    .where(
      and(
        eq(fileLeases.organizationId, ctx.organizationId),
        eq(fileLeases.projectId, params.projectId),
        eq(fileLeases.status, "held"),
      ),
    );
  await expireStaleLeases(ctx, tx, projectLeases, now);
  const active = projectLeases.filter((l) => isActive(l, now));
  const ownedByRun = (l: LeaseRow): boolean =>
    l.holderType === "run" && l.holderId === params.runId;

  const reserved: string[] = [];
  for (const path of keys) {
    const existing = active.find((l) => ownedByRun(l) && l.path === path && l.mode === "write");
    if (existing !== undefined) {
      reserved.push(existing.id);
      continue;
    }
    const scope: LeaseScope = { path, mode: "write" };
    const conflict = active.find(
      (l) => !ownedByRun(l) && leasesConflict(scope, { path: l.path, mode: l.mode as LeaseMode }),
    );
    if (conflict !== undefined) {
      throw AppError.conflict("file lease conflict on write_paths", {
        path,
        conflicting_lease_id: conflict.id,
        conflicting_path: conflict.path,
        conflicting_mode: conflict.mode,
        conflicting_holder_id: conflict.holderId,
      });
    }
    const id = ctx.idGen.generate(ID_PREFIXES.lease);
    const row: LeaseRow = {
      id,
      organizationId: ctx.organizationId,
      projectId: params.projectId,
      taskId: params.taskId,
      runId: params.runId,
      holderType: "run",
      holderId: params.runId,
      path,
      mode: "write",
      status: "held",
      acquiredAt: now,
      expiresAt: null,
      releasedAt: null,
      createdAt: now,
    };
    await tx.insert(fileLeases).values(row);
    await appendEvent(
      tx,
      buildEvent(ctx, {
        type: "lease.acquired",
        actorType: "system",
        actorId: "control_plane",
        correlationId: params.taskId,
        projectId: params.projectId,
        taskId: params.taskId,
        runId: params.runId,
        payload: {
          lease_id: id,
          project_id: params.projectId,
          task_id: params.taskId,
          run_id: params.runId,
          path,
          mode: "write",
          holder_type: "run",
          holder_id: params.runId,
        },
      }),
    );
    // Subsequent paths in this same call must see the just-reserved lease.
    active.push(row);
    reserved.push(id);
  }
  return reserved;
}

/**
 * Release every held lease owned by a run (#20), INSIDE the caller's transaction.
 * Called at terminal run transitions (completed/failed/cancelled/start-failed).
 * Emits `lease.released` only for leases actually transitioned (held -> released).
 */
export async function releaseRunLeases(
  ctx: ServerContext,
  tx: DrizzleDb,
  runId: string,
): Promise<void> {
  const now = ctx.clock.nowIso();
  const held = await tx
    .select()
    .from(fileLeases)
    .where(
      and(
        eq(fileLeases.organizationId, ctx.organizationId),
        eq(fileLeases.holderType, "run"),
        eq(fileLeases.holderId, runId),
        eq(fileLeases.status, "held"),
      ),
    );
  for (const lease of held) {
    await tx
      .update(fileLeases)
      .set({ status: "released", releasedAt: now })
      .where(eq(fileLeases.id, lease.id));
    await appendEvent(
      tx,
      buildEvent(ctx, {
        type: "lease.released",
        actorType: "system",
        actorId: "control_plane",
        correlationId: lease.taskId,
        projectId: lease.projectId,
        taskId: lease.taskId,
        runId: lease.runId,
        payload: {
          lease_id: lease.id,
          project_id: lease.projectId,
          task_id: lease.taskId,
          run_id: lease.runId,
          path: lease.path,
          mode: lease.mode,
          holder_type: lease.holderType,
          holder_id: lease.holderId,
        },
      }),
    );
  }
}
