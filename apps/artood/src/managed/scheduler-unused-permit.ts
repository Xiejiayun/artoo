import { SchedulerPermitUnusedV1Schema, type SchedulerPermitUnusedV1 } from "@artoo/domain";
import type { JournalRun } from "./journal-types.js";

/** Old not_started_fenced records retain their original meaning. Only this
 * explicit versioned receipt can enter the dedicated never-started lane. */
export function readSchedulerUnusedPermit(run: JournalRun): SchedulerPermitUnusedV1 | undefined {
  if (run.receipt?.kind !== "not_started_fenced") return;
  const receipt = JSON.parse(run.receipt.contentJson) as Record<string, unknown>;
  const detail = receipt["detail"] as Record<string, unknown> | undefined;
  if (detail?.["scope"] !== "scheduler-unused-permit.v1") return;
  const payload = SchedulerPermitUnusedV1Schema.parse(detail),
    grant = run.schedulerStartGrant;
  if (
    run.phase !== "closed" ||
    run.mode !== "per-run" ||
    !run.stopRequested ||
    !run.launchKey ||
    !grant ||
    payload.journal_namespace !== run.namespace ||
    payload.grant_id !== grant.grantId ||
    payload.node_attempt_id !== grant.nodeAttemptId ||
    receipt["version"] !== 1 ||
    receipt["namespace"] !== run.namespace ||
    receipt["runId"] !== run.runId ||
    receipt["launchKey"] !== run.launchKey ||
    receipt["kind"] !== "not_started_fenced" ||
    run.receipt.namespace !== run.namespace ||
    run.receipt.runId !== run.runId ||
    run.receipt.launchKey !== run.launchKey ||
    receipt["nodeId"] !== run.receipt.nodeId ||
    receipt["ownerRevision"] !== run.receipt.ownerRevision
  )
    throw new Error("Unused scheduler permit receipt differs from the original durable launch");
  const expected = JSON.stringify({ schedulerUnusedPermit: { type: "scheduler.permit_unused", payload } });
  if (run.finalOutcomeJson !== expected)
    throw new Error("Unused scheduler permit event differs from its immutable fence");
  return payload;
}
