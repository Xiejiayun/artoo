import { createHash } from "node:crypto";
import { OwnedResultRunAdmissionV1Schema, OwnedResultAuthorBindingV1Schema, canonicalOwnedResultAuthorContextV1, canonicalOwnedResultRunAdmissionV1,
  type OwnedResultRunAdmissionV1 } from "@artoo/domain";
import { allocationStartBinding } from "./node-allocation-identity.js";
import { canonicalOwnedVerification } from "./owned/worktree-verification-contract.js";

const sha = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
/** Shared node/worker identity codec. Pure metadata checks grant no execution authority. */
export function snapshotOwnedResultRunAdmission(raw: OwnedResultRunAdmissionV1) {
  const snapshot = structuredClone(raw), request = OwnedResultRunAdmissionV1Schema.parse(snapshot);
  if (canonicalOwnedVerification(snapshot) !== canonicalOwnedVerification(request)) throw new Error("Unsupported fields cannot be stripped from an owned result admission");
  const launch = allocationStartBinding(request.run_start, process.platform, true);
  if (!launch || !launch.payload.context_pack.payload || request.run_start.verification !== undefined) {
    throw new Error("Owned result admission requires a per-run author without ordinary verification");
  }
  const contextDigest = sha(canonicalOwnedResultAuthorContextV1(launch.payload.context_pack.payload));
  if (contextDigest !== request.requirement.author_context_digest
    || launch.payload.context_pack.payload.project.id !== request.requirement.profile.project_id) throw new Error("Owned result context differs from its requirement");
  const author = OwnedResultAuthorBindingV1Schema.parse({ run_id: launch.payload.run_id, task_id: launch.payload.task_id,
    agent_instance_id: launch.payload.agent_instance_id, runtime: launch.payload.runtime,
    launch_binding_digest: `sha256:${launch.key}`, author_context_digest: contextDigest, workspace: launch.payload.workspace });
  const frozen = freeze({ version: 1 as const, run_start: launch.payload, requirement: request.requirement });
  const canonical = canonicalOwnedResultRunAdmissionV1(frozen);
  if (Buffer.byteLength(canonical) > 1024 * 1024) throw new Error("Owned result admission exceeds the bounded journal payload size");
  return { request: frozen, launch, author: freeze(author), digest: sha(canonical), canonical: JSON.stringify(frozen) };
}
