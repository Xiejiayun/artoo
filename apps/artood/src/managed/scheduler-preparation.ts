import { createHash } from "node:crypto";
import {
  SchedulerStartProposalV1Schema,
  SchedulerStartGrantV1Schema,
  canonicalSchedulerStartProposalV1,
  canonicalReleaseJson,
} from "@artoo/domain";
import { allocationStartBinding } from "../node-allocation-identity.js";

/** Node/worker codec only. No filesystem operation, authority or materialization. */
export function snapshotSchedulerProposal(raw: unknown) {
  const parsed = SchedulerStartProposalV1Schema.parse(structuredClone(raw));
  // Normalize record keys as well as schema-defined fields before deriving the
  // existing launch key. Node and worker must reconstruct exactly the same bytes.
  const proposal = SchedulerStartProposalV1Schema.parse(JSON.parse(canonicalReleaseJson(parsed)));
  const launch = allocationStartBinding(proposal.run_start, process.platform, true);
  if (!launch) throw new Error("Scheduler preparation requires an exact per-run allocation");
  return {
    proposal,
    launch,
    canonical: JSON.stringify(proposal),
    digest: `sha256:${createHash("sha256").update(canonicalSchedulerStartProposalV1(proposal)).digest("hex")}`,
  };
}

/** Durable identity codec only. Reading this value never supplies a live window
 * or a producer permit. The original exchange and worker commit remain required. */
export function snapshotSchedulerStartGrant(
  raw: unknown,
  snapshot: ReturnType<typeof snapshotSchedulerProposal>,
  local: { namespace: string; nodeAttemptId: string },
) {
  const grant = SchedulerStartGrantV1Schema.parse(raw),
    prepared = snapshot.proposal.prepared_start;
  for (const key of [
    "request_id",
    "run_id",
    "organization_id",
    "project_id",
    "task_id",
    "actor_user_id",
    "agent_instance_id",
    "computer_id",
    "device_id",
    "session_id",
  ] as const)
    if (grant[key] !== prepared[key]) throw new Error("Scheduler grant changed its prepared identity");
  if (
    grant.journal_namespace !== local.namespace ||
    grant.node_attempt_id !== local.nodeAttemptId ||
    grant.proposal_digest !== snapshot.digest
  )
    throw new Error("Scheduler grant changed its local preparation binding");
  const canonical = JSON.stringify(grant);
  return { grant, canonical, digest: `sha256:${createHash("sha256").update(canonical).digest("hex")}` };
}
