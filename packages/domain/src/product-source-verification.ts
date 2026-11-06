import { z } from "zod";
import { RunStartPayloadSchema } from "./node-payloads.js";
import { ProductSourceImportReadyV1Schema } from "./product-source-export.js";
import { ProductSourceTransferRequestV2Schema, assertProductResearchProvenanceV1, assertProductResearchProvenanceV2,
  productSourceTransferRequestDigestV2 } from "./product-source-semantics.js";
import { canonicalProductSourceTransferValueV1 as canonical, productSourceTransferRequestDigestV1 } from "./product-source-transfer.js";
import { ProductSourceMeasurementMappingV1Schema, describeProductSourceMeasurementMappingV1 } from "./product-source-measurement.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
/** Protected child-process input. Parsing this public shape grants no node admission. */
export const ProductSourceVerificationEnvelopeV1Schema = z.object({ version: z.literal(1),
  request: ProductSourceTransferRequestV2Schema, request_digest: digest, ready: ProductSourceImportReadyV1Schema,
  run_start: RunStartPayloadSchema, mapping: ProductSourceMeasurementMappingV1Schema,
}).strict().refine(value => !value.request.measurement_v2 && !value.request.source_export.measurement_v2,
  "Legacy private verifier envelopes cannot carry measurement-v2 extensions");
export type ProductSourceVerificationEnvelopeV1 = z.infer<typeof ProductSourceVerificationEnvelopeV1Schema>;

/** Paired policy-v2/release-aware first-hop research. This shape grants no local reader or admission. */
export const ProductSourceVerificationEnvelopeV2Schema = z.object({ version: z.literal(2),
  request: ProductSourceTransferRequestV2Schema, request_digest: digest, ready: ProductSourceImportReadyV1Schema,
  run_start: RunStartPayloadSchema, mapping: ProductSourceMeasurementMappingV1Schema,
}).strict().refine(value => !!value.request.measurement_v2 && !!value.request.source_export.measurement_v2,
  "Private verifier v2 requires both measurement-v2 extensions");
export type ProductSourceVerificationEnvelopeV2 = z.infer<typeof ProductSourceVerificationEnvelopeV2Schema>;
export const ProductSourceVerificationEnvelopeSchema: z.ZodUnion<[typeof ProductSourceVerificationEnvelopeV1Schema, typeof ProductSourceVerificationEnvelopeV2Schema]> = z.union([ProductSourceVerificationEnvelopeV1Schema, ProductSourceVerificationEnvelopeV2Schema]);
export type ProductSourceVerificationEnvelope = z.infer<typeof ProductSourceVerificationEnvelopeSchema>;

/** Both the node and its protected child recompute the full mapping from original bytes. */
export function inspectProductSourceVerificationEnvelopeV1(input: unknown, bytes: Uint8Array,
  sha256: (value: string | Uint8Array) => string) {
  const envelope = ProductSourceVerificationEnvelopeV1Schema.parse(input), request = envelope.request, base = request.byte_request;
  const { ready, run_start: start } = envelope, context = start.context_pack.payload, destination = ready.destination;
  if (productSourceTransferRequestDigestV2(request, sha256) !== envelope.request_digest
    || productSourceTransferRequestDigestV1(base, sha256) !== ready.request_digest || base.transfer_id !== ready.transfer_id
    || ready.capsule_digest !== base.source.capsule_digest || ready.manifest_digest !== base.source.manifest_digest
    || destination.node_id !== base.destination.node_id || destination.project_id !== base.project_id
    || destination.profile_id !== base.destination.profile_id || destination.profile_digest !== base.destination.capabilities.profile_digest
    || destination.workspace_root !== base.destination.workspace_root || start.workspace.root !== destination.workspace_root
    || start.workspace.branch != null || start.workspace_allocation || !start.verification
    || start.verification.profile_id !== destination.profile_id || start.verification.expected_subject_digest !== destination.subject_digest
    || start.verification.release_capability_binding || context?.release_capabilities || context?.imported_validation || context?.imported_validation_review_subject || context?.review_subject || context?.imported_execution || context?.imported_execution_review_subject || context?.imported_execution_repair
    || context?.product_development?.stage !== "research" || context.project.id !== base.project_id
    || context.task.id !== start.task_id || context.workspace.root !== destination.workspace_root
    || context.goal_context?.goal_id !== base.goal_id || context.goal_context.plan?.id !== base.plan_id
    || !context.verification_capabilities || context.verification_capabilities.profile_id !== destination.profile_id) {
    throw new Error("Foreign research verifier input differs from its full transfer, destination or research run");
  }
  const { profile_id: _id, ...capabilities } = context.verification_capabilities;
  const expectedBinding = { version: 1, profile_digest: destination.profile_digest,
    checks: base.destination.capabilities.checks.map(({ command_id, config_digest, contract_digest }) => ({ command_id, config_digest, contract_digest })) };
  if (canonical(capabilities) !== canonical(base.destination.capabilities) || canonical(start.verification.capability_binding) !== canonical(expectedBinding)) {
    throw new Error("Foreign research verifier capability snapshot differs");
  }
  assertProductResearchProvenanceV1(request.source_export.research_provenance, bytes, sha256);
  const described = describeProductSourceMeasurementMappingV1({ transfer: { request_digest: envelope.request_digest,
    capsule_digest: ready.capsule_digest, source_subject_digest: base.source.subject_digest, destination_subject_digest: destination.subject_digest },
    researchPin: request.source_export.research_provenance.research, researchBytes: bytes,
    sourceCapabilities: request.source_export.source_capabilities, destinationCapabilities: base.destination.capabilities,
    commandPairs: request.command_pairs, sha256 });
  if (canonical(described.mapping) !== canonical(envelope.mapping) || described.effective_plan.version !== 1 || described.mapping.release) {
    throw new Error("Foreign research verifier mapping differs from the original measured bytes");
  }
  return { envelope, ...described, admission_digest: sha256(canonical(envelope)) };
}

/** Node and child independently pin both local scopes and recompute the v2 mapping from unchanged bytes. */
export function inspectProductSourceVerificationEnvelopeV2(input: unknown, bytes: Uint8Array,
  sha256: (value: string | Uint8Array) => string) {
  const envelope = ProductSourceVerificationEnvelopeV2Schema.parse(input), request = envelope.request, base = request.byte_request;
  const { ready, run_start: start } = envelope, context = start.context_pack.payload, destination = ready.destination;
  const sourceRelease = request.source_export.measurement_v2?.source_release, destinationRelease = request.measurement_v2?.destination_release;
  if (!sourceRelease || !destinationRelease) throw new Error("Foreign research v2 requires paired release configurations");
  if (productSourceTransferRequestDigestV2(request, sha256) !== envelope.request_digest
    || productSourceTransferRequestDigestV1(base, sha256) !== ready.request_digest || base.transfer_id !== ready.transfer_id
    || ready.capsule_digest !== base.source.capsule_digest || ready.manifest_digest !== base.source.manifest_digest
    || destination.node_id !== base.destination.node_id || destination.project_id !== base.project_id
    || destination.profile_id !== base.destination.profile_id || destination.profile_digest !== base.destination.capabilities.profile_digest
    || destination.workspace_root !== base.destination.workspace_root || start.workspace.root !== destination.workspace_root
    || start.workspace.branch != null || start.workspace_allocation || !start.verification
    || start.verification.profile_id !== destination.profile_id || start.verification.expected_subject_digest !== destination.subject_digest
    || context?.imported_validation || context?.imported_validation_review_subject || context?.review_subject || context?.imported_execution || context?.imported_execution_review_subject || context?.imported_execution_repair || context?.product_development?.stage !== "research" || context.project.id !== base.project_id
    || context.task.id !== start.task_id || context.workspace.root !== destination.workspace_root
    || context.goal_context?.goal_id !== base.goal_id || context.goal_context.plan?.id !== base.plan_id
    || !context.verification_capabilities || context.verification_capabilities.profile_id !== destination.profile_id) {
    throw new Error("Foreign research v2 verifier input differs from its full transfer, destination or research run");
  }
  const { profile_id: _id, ...capabilities } = context.verification_capabilities;
  const expectedBinding = { version: 1, profile_digest: destination.profile_digest,
    checks: base.destination.capabilities.checks.map(({ command_id, config_digest, contract_digest }) => ({ command_id, config_digest, contract_digest })) };
  if (canonical(capabilities) !== canonical(base.destination.capabilities) || canonical(start.verification.capability_binding) !== canonical(expectedBinding)
    || canonical(start.verification.release_capability_binding) !== canonical(destinationRelease.binding)
    || canonical(context.release_capabilities) !== canonical(destinationRelease)) {
    throw new Error("Foreign research v2 verifier capability or release snapshot differs");
  }
  // The request schema binds each release workspace/project/profile to its own
  // side. The pure mapper then checks complete policy/check/release equivalence.
  assertProductResearchProvenanceV2(request.source_export.research_provenance, bytes, sha256);
  const described = describeProductSourceMeasurementMappingV1({ transfer: { request_digest: envelope.request_digest,
    capsule_digest: ready.capsule_digest, source_subject_digest: base.source.subject_digest, destination_subject_digest: destination.subject_digest },
    researchPin: request.source_export.research_provenance.research, researchBytes: bytes,
    sourceCapabilities: request.source_export.source_capabilities, destinationCapabilities: base.destination.capabilities,
    commandPairs: request.command_pairs, sourceRelease, destinationRelease, sha256 });
  if (canonical(described.mapping) !== canonical(envelope.mapping) || described.effective_plan.version !== 2 || !described.mapping.release) {
    throw new Error("Foreign research v2 verifier mapping differs from the original measured bytes");
  }
  return { envelope, ...described, admission_digest: sha256(canonical(envelope)) };
}

/** Explicit version dispatch; a caller cannot silently send a new branch through the legacy inspector. */
export function inspectProductSourceVerificationEnvelope(input: unknown, bytes: Uint8Array,
  sha256: (value: string | Uint8Array) => string) {
  const envelope = ProductSourceVerificationEnvelopeSchema.parse(input);
  return envelope.version === 1 ? inspectProductSourceVerificationEnvelopeV1(envelope, bytes, sha256)
    : inspectProductSourceVerificationEnvelopeV2(envelope, bytes, sha256);
}
