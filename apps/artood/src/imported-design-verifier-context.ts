import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { canonicalProductSourceTransferValueV1 as canonical, inspectImportedDesignVerificationEnvelopeV1,
  importedDesignVerificationEchoV1, type ContextPack, type ProductResearchReport, type StaticWebCapabilityBinding } from "@artoo/domain";
import { assertWindowsProcessBackend, type PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";

const sha = (value: string | Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
type Projection = { root: string; dev: number; ino: number; contextDigest: string; bytesDigest: string; bytesSize: number;
  research: ProductResearchReport; backend: PreparedWindowsProcessBackend };
const projections = new WeakMap<ContextPack, Projection>();

/** Called only after the CLI reads the independently hashed private context and prepares its bound Job backend.
 * This registry supplies verifier data in this child; it cannot create a design writer or a node result.
 */
export function bindImportedDesignVerifierContext(input: {
  envelope: unknown; root: string; context: ContextPack; researchBytes: Uint8Array;
  requestId: string; scope: unknown; profileId: unknown; profileDigest: unknown; subjectDigest: unknown;
  binding: StaticWebCapabilityBinding; backend: PreparedWindowsProcessBackend;
}) {
  assertWindowsProcessBackend(input.backend);
  if (projections.has(input.context)) throw Error("Imported design verifier context is already bound");
  const inspected = inspectImportedDesignVerificationEnvelopeV1(input.envelope, input.researchBytes, sha);
  const envelope = inspected.envelope, start = envelope.request.run_start;
  const destination = envelope.request.review_request.operation.intent.request.byte_request.destination;
  const stat = lstatSync(input.root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync.native(input.root) !== input.root
    || destination.workspace_root !== input.root || canonical(input.context) !== canonical(start.context_pack.payload)
    || input.profileId !== destination.profile_id || input.profileDigest !== destination.capabilities.profile_digest
    || input.subjectDigest !== envelope.subject_digest || input.scope !== envelope.scope
    || input.requestId !== envelope.verification_request_id || input.binding.profile_digest !== input.profileDigest
    || !destination.capabilities.checks.some(check => check.command_id === input.binding.command_id
      && check.config_digest === input.binding.config_digest && check.contract_digest === input.binding.contract_digest)) {
    throw Error("Imported design private mapping differs from the exact protected command context");
  }
  projections.set(input.context, { root: input.root, dev: stat.dev, ino: stat.ino, contextDigest: sha(canonical(input.context)),
    bytesDigest: sha(input.researchBytes), bytesSize: input.researchBytes.byteLength,
    research: structuredClone(inspected.research), backend: input.backend });
  return importedDesignVerificationEchoV1(envelope, input.binding.command_id, sha);
}

/** An unbound context returns undefined so the node can consult its original in-process writer permit. */
export function readImportedDesignVerifierResearch(root: string, context: ContextPack, bytes: Uint8Array): ProductResearchReport | undefined {
  const saved = projections.get(context);
  if (!saved) return undefined;
  assertWindowsProcessBackend(saved.backend);
  const stat = lstatSync(root);
  if (root !== saved.root || realpathSync.native(root) !== root || !stat.isDirectory() || stat.isSymbolicLink()
    || stat.dev !== saved.dev || stat.ino !== saved.ino || sha(canonical(context)) !== saved.contextDigest
    || bytes.byteLength !== saved.bytesSize || sha(bytes) !== saved.bytesDigest) {
    throw Error("Imported design verifier projection changed after private context binding");
  }
  return structuredClone(saved.research);
}
