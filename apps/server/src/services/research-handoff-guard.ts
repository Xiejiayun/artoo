import type { ProductSourceHandoffIntentV1 } from "@artoo/domain";
import { computers, goalResearchDestinationSlots as slots, goalResearchDestinationPools as pools } from "@artoo/db";
import { and, eq } from "drizzle-orm";
import type { DrizzleDb } from "@artoo/storage";
import { isDeepStrictEqual } from "node:util";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { readCurrentResearchHandoff } from "./research-revision-origin-service.js";
import { automationWorkspacesOverlap } from "./automation-workspace.js";

/** Shared computer fence also protects unused slots from a different goal's
 * otherwise valid legacy H1. Ownership is exact, never just the same goal ID. */
export async function assertResearchHandoffDestinationOwner(ctx: ServerContext, tx: DrizzleDb, intent: ProductSourceHandoffIntentV1,
  options: { admittingUnboundRevision?: boolean } = {}): Promise<void> {
  const base = intent.request.byte_request;
  const [computer] = await tx.select().from(computers).where(and(eq(computers.id, base.destination.node_id),
    eq(computers.organizationId, ctx.organizationId))).for("update");
  if (!computer) throw AppError.conflict("Handoff destination computer disappeared");
  const reservations = await tx.select({ slot: slots, pool: pools }).from(slots).innerJoin(pools, eq(pools.id, slots.poolId))
    .where(and(eq(slots.organizationId, ctx.organizationId), eq(slots.computerId, computer.id)));
  for (const { slot, pool } of reservations) {
    if (!automationWorkspacesOverlap(slot.workspaceRoot, base.destination.workspace_root, computer.os)) continue;
    if (pool.organizationId !== ctx.organizationId || pool.goalId !== base.goal_id || pool.planId !== base.plan_id
      || pool.nextTaskId !== intent.next_task_id || slot.workspaceRoot !== base.destination.workspace_root || slot.status === "uncertain"
      || (slot.handoffId !== base.transfer_id && !(options.admittingUnboundRevision && slot.handoffId === null
        && slot.revisionId !== null && slot.revisionId === pool.currentRevisionId && slot.status === "reserved"))) {
      throw AppError.conflict("Handoff destination belongs to another retained research reservation");
    }
    await assertCurrentResearchHandoff(ctx, tx, intent, options);
  }
}

/** Old immutable handoffs remain readable but cannot restart an ancestor or
 * consume H3 after a new research successor has become the current leaf. */
export async function assertCurrentResearchHandoff(ctx: ServerContext, tx: DrizzleDb, intent: ProductSourceHandoffIntentV1,
  options: { admittingUnboundRevision?: boolean } = {}): Promise<void> {
  const base = intent.request.byte_request;
  const current = await readCurrentResearchHandoff(ctx, tx, base.goal_id, base.plan_id, intent.next_task_id);
  if (!current) return; // Legacy goals retain their original singleton path.
  if (current.handoffId !== null) {
    if (current.handoffId !== base.transfer_id) throw AppError.conflict("Only the current research handoff may advance");
    return;
  }
  const revision = current.revision, member = revision ? current.snapshot.members[revision.generation] : undefined;
  if (!options.admittingUnboundRevision || !revision || !member || member.slot_id !== revision.slotId
    || base.source.task_id !== revision.auxiliaryTaskId || base.destination.node_id !== current.snapshot.destination.computer_id
    || base.destination.workspace_root !== member.mapping.destination_release.binding.workspace_root
    || intent.destination_start.agent_instance_id !== member.writer.instance_id
    || !isDeepStrictEqual(intent.request.measurement_v2?.destination_release, member.mapping.destination_release)
    || !isDeepStrictEqual(intent.request.command_pairs, member.mapping.command_pairs)
    || !isDeepStrictEqual(intent.request.source_export.measurement_v2?.source_release, current.snapshot.source.release)) {
    throw AppError.conflict("Research revision is awaiting its exact accepted source and reserved destination handoff");
  }
}
