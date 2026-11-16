import { createHash } from "node:crypto";
import { computers, contextPacks, runs } from "@artoo/db";
import {
  SchedulerStartProposalV1Schema,
  canonicalSchedulerStartProposalV1,
  type SchedulerPreparedStartSnapshotV1,
} from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, eq } from "drizzle-orm";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { validatePersistedAllocationStart } from "../persisted-allocation-start.js";
import type { SchedulerExecutionClaimInput } from "./scheduler-execution-claim-service.js";
import { parseOwnedResultAssignment } from "./owned-result-service.js";
import { withRevalidatedSchedulerPreparedStart } from "./scheduler-start-revalidation-service.js";

function freeze(value: object): void {
  for (const child of Object.values(value)) if (child !== null && typeof child === "object") freeze(child);
  Object.freeze(value);
}

/** Internal false-authority metadata only. No transport/poller calls this.
 * A proposal cannot stand in for the future node-ready grant transaction. */
export function prepareSchedulerStartProposal(ctx: ServerContext, input: SchedulerExecutionClaimInput) {
  return ctx.db.db.transaction((tx) => prepareSchedulerStartProposalInTransaction(ctx, tx, input), {
    isolationLevel: "read committed",
  });
}

export function prepareSchedulerStartProposalInTransaction(
  ctx: ServerContext,
  tx: DrizzleDb,
  input: SchedulerExecutionClaimInput,
) {
  return withRevalidatedSchedulerPreparedStart(ctx, tx, input, (prepared) =>
    buildSchedulerStartProposalFromPrepared(ctx, tx, prepared),
  );
}

/** Metadata builder only. Grant callers must use the enclosing revalidation
 * transaction; this function grants no admission or credential authority. */
export async function buildSchedulerStartProposalFromPrepared(
  ctx: ServerContext,
  tx: DrizzleDb,
  prepared: SchedulerPreparedStartSnapshotV1,
) {
  const [run] = await tx
    .select()
    .from(runs)
    .where(and(eq(runs.id, prepared.run_id), eq(runs.organizationId, ctx.organizationId)));
  if (!run || run.verificationRequirement !== null || parseOwnedResultAssignment(run)) {
    throw AppError.conflict("Scheduler proposals require their original ordinary per-run execution owner");
  }
  const [stored] = await tx
    .select()
    .from(contextPacks)
    .where(and(eq(contextPacks.id, run.contextPackId!), eq(contextPacks.organizationId, ctx.organizationId)));
  const [computer] = await tx
    .select({ os: computers.os })
    .from(computers)
    .where(and(eq(computers.id, prepared.computer_id), eq(computers.organizationId, ctx.organizationId)));
  const validated = validatePersistedAllocationStart(run, stored, {
    computerOs: computer?.os,
    projectId: prepared.project_id,
  });
  // Same allocated ordinary command contract used by node-binding. Do not
  // consult current instance roots, generate ContextPack IDs or weaken policy.
  const proposal = SchedulerStartProposalV1Schema.parse({
    version: 1,
    prepared_start: prepared,
    run_start: {
      run_id: run.id,
      task_id: run.taskId,
      agent_instance_id: run.agentInstanceId,
      runtime: run.runtimeId,
      workspace: { root: validated.root, branch: validated.branch },
      workspace_allocation: validated.allocation,
      workspace_retention_reporting: "typed-v1",
      context_pack: validated.context,
      policy_snapshot: { filesystem_write_scope: [validated.root], requires_approval: ["git.push", "external.post"] },
      artifact_rules: { paths: ["artifacts/**", "*.patch"] },
    },
  });
  const result = {
    version: 1 as const,
    proposal,
    proposal_digest: `sha256:${createHash("sha256").update(canonicalSchedulerStartProposalV1(proposal)).digest("hex")}`,
    execution_authorized: false as const,
  };
  freeze(result);
  return result;
}
