import { lockSchedulerCapacity } from "./scheduler-capacity-service.js";
import {
  agents,
  appendEvent,
  computers,
  projects,
  schedulerAgentPolicies,
  schedulerComputerPolicies,
  schedulerProjectPolicies,
} from "@artoo/db";
import {
  SchedulerAgentPolicyV1Schema,
  SchedulerComputerPolicyV1Schema,
  SchedulerProjectPolicyV1Schema,
} from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { requireAdministrator } from "../auth/request-auth.js";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";

export type SchedulerPolicyKind = "project" | "agent" | "computer";

async function requireTarget(ctx: ServerContext, tx: DrizzleDb, kind: SchedulerPolicyKind, id: string) {
  const rows =
    kind === "project"
      ? await tx
          .select({ id: projects.id })
          .from(projects)
          .where(and(eq(projects.id, id), eq(projects.organizationId, ctx.organizationId)))
          .for("share")
      : kind === "agent"
        ? await tx
            .select({ id: agents.id })
            .from(agents)
            .where(and(eq(agents.id, id), eq(agents.organizationId, ctx.organizationId), isNull(agents.deletedAt)))
            .for("share")
        : await tx
            .select({ id: computers.id })
            .from(computers)
            .where(
              and(eq(computers.id, id), eq(computers.organizationId, ctx.organizationId), isNull(computers.deletedAt)),
            )
            .for("share");
  if (!rows.length) throw AppError.notFound(`${kind} not found`);
}

export async function getSchedulerPolicy(ctx: ServerContext, kind: SchedulerPolicyKind, id: string) {
  return ctx.db.transaction(async (tx) => {
    await requireTarget(ctx, tx, kind, id);
    const rows =
      kind === "project"
        ? await tx
            .select()
            .from(schedulerProjectPolicies)
            .where(
              and(
                eq(schedulerProjectPolicies.projectId, id),
                eq(schedulerProjectPolicies.organizationId, ctx.organizationId),
              ),
            )
        : kind === "agent"
          ? await tx
              .select()
              .from(schedulerAgentPolicies)
              .where(
                and(
                  eq(schedulerAgentPolicies.agentId, id),
                  eq(schedulerAgentPolicies.organizationId, ctx.organizationId),
                ),
              )
          : await tx
              .select()
              .from(schedulerComputerPolicies)
              .where(
                and(
                  eq(schedulerComputerPolicies.computerId, id),
                  eq(schedulerComputerPolicies.organizationId, ctx.organizationId),
                ),
              );
    // No implicit limits or unpinning of legacy instances: absence stays explicit.
    return rows[0] ?? null;
  });
}

export async function putSchedulerPolicy(ctx: ServerContext, kind: SchedulerPolicyKind, id: string, input: unknown) {
  return ctx.db.transaction(async (tx) => {
    await requireAdministrator(ctx, tx);
    await lockSchedulerCapacity(ctx, tx);
    await requireTarget(ctx, tx, kind, id);
    const common = {
      organizationId: ctx.organizationId,
      updatedByUserId: ctx.actorUserId,
      updatedAt: ctx.clock.nowIso(),
    };
    let result;
    if (kind === "project") {
      const parsed = SchedulerProjectPolicyV1Schema.safeParse(input);
      if (!parsed.success) throw AppError.validation("invalid version 1 project scheduling policy");
      [result] = await tx
        .insert(schedulerProjectPolicies)
        .values({ ...common, projectId: id, policy: parsed.data })
        .onConflictDoUpdate({
          target: schedulerProjectPolicies.projectId,
          set: { ...common, policy: parsed.data, revision: sql`${schedulerProjectPolicies.revision} + 1` },
          setWhere: and(
            eq(schedulerProjectPolicies.organizationId, ctx.organizationId),
            lt(schedulerProjectPolicies.revision, Number.MAX_SAFE_INTEGER),
          ),
        })
        .returning();
    } else if (kind === "agent") {
      const parsed = SchedulerAgentPolicyV1Schema.safeParse(input);
      if (!parsed.success) throw AppError.validation("invalid version 1 Agent scheduling policy");
      if (parsed.data.pinned_computer_id !== null)
        await requireTarget(ctx, tx, "computer", parsed.data.pinned_computer_id);
      [result] = await tx
        .insert(schedulerAgentPolicies)
        .values({ ...common, agentId: id, policy: parsed.data })
        .onConflictDoUpdate({
          target: schedulerAgentPolicies.agentId,
          set: { ...common, policy: parsed.data, revision: sql`${schedulerAgentPolicies.revision} + 1` },
          setWhere: and(
            eq(schedulerAgentPolicies.organizationId, ctx.organizationId),
            lt(schedulerAgentPolicies.revision, Number.MAX_SAFE_INTEGER),
          ),
        })
        .returning();
    } else {
      const parsed = SchedulerComputerPolicyV1Schema.safeParse(input);
      if (!parsed.success) throw AppError.validation("invalid version 1 computer scheduling policy");
      [result] = await tx
        .insert(schedulerComputerPolicies)
        .values({ ...common, computerId: id, policy: parsed.data })
        .onConflictDoUpdate({
          target: schedulerComputerPolicies.computerId,
          set: { ...common, policy: parsed.data, revision: sql`${schedulerComputerPolicies.revision} + 1` },
          setWhere: and(
            eq(schedulerComputerPolicies.organizationId, ctx.organizationId),
            lt(schedulerComputerPolicies.revision, Number.MAX_SAFE_INTEGER),
          ),
        })
        .returning();
    }
    if (!result) throw AppError.conflict("Scheduling policy scope changed or revision exhausted");
    await appendEvent(
      tx,
      buildEvent(ctx, {
        type: "scheduler.policy.updated",
        actorType: "user",
        actorId: ctx.actorUserId,
        correlationId: id,
        projectId: kind === "project" ? id : null,
        payload: {
          version: 1,
          kind,
          target_id: id,
          policy: result.policy,
          revision: result.revision,
          execution_authorized: false,
        },
      }),
    );
    return result;
  });
}
