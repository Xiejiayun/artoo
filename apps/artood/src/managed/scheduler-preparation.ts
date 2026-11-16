import { createHash } from "node:crypto";
import { SchedulerStartProposalV1Schema, canonicalSchedulerStartProposalV1, canonicalReleaseJson } from "@artoo/domain";
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
