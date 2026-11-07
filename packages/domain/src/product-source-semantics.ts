import { z } from "zod";
import { ProductSourceExportV1Schema } from "./product-source-export.js";
import { ProductSourceTransferRequestV1Schema, canonicalProductSourceTransferValueV1 } from "./product-source-transfer.js";
import { ProductResearchReportV1Schema, ProductResearchReportV2Schema } from "./product-development.js";
import { VerificationCapabilitiesSchema } from "./verification-capabilities.js";
import { ReleaseCapabilitiesV1Schema, canonicalReleaseJson } from "./release-capabilities.js";

const id = z.string().min(1).max(128).regex(/^[^\u0000-\u001f\u007f]+$/u);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const root = z.string().min(1).max(4096).regex(/^[^\u0000-\u001f\u007f]+$/u);
export const ProductResearchPinV1Schema = z.object({ path: z.literal(".artoo/product/research.json"), checksum: digest,
  size: z.number().int().min(1).max(1024 * 1024) }).strict();
const metadata = z.object({ id: z.string().regex(/^source_[a-f0-9]{32}$/), url: z.string().url().max(4096).refine(value => {
  const parsed = new URL(value); return parsed.protocol === "https:" && !parsed.username && !parsed.password;
}), title: z.string().min(1).max(1000), retrieved_at: z.string().datetime({ offset: true }), content_digest: digest }).strict();
export const ProductResearchProvenanceV1Schema = z.object({ version: z.literal(1), chain_depth: z.literal(0),
  research: ProductResearchPinV1Schema,
  sources: z.array(z.object({ metadata, metadata_digest: digest,
    origin: z.object({ node_id: id, run_id: id, task_id: id, project_id: id, goal_id: id, workspace_root: root }).strict(),
    content_bytes: z.number().int().min(1).max(1024 * 1024),
  }).strict()).min(1).max(100),
}).strict().refine(value => new Set(value.sources.map(source => source.metadata.id)).size === value.sources.length, "Duplicate provenance source");
export type ProductResearchProvenanceV1 = z.infer<typeof ProductResearchProvenanceV1Schema>;

export const ProductSourceMeasurementExportV2ExtensionV1Schema = z.object({ version: z.literal(1),
  source_release: ReleaseCapabilitiesV1Schema }).strict();
export type ProductSourceMeasurementExportV2ExtensionV1 = z.infer<typeof ProductSourceMeasurementExportV2ExtensionV1Schema>;
export const ProductSourceMeasurementTransferV2ExtensionV1Schema = z.object({ version: z.literal(1),
  destination_release: ReleaseCapabilitiesV1Schema }).strict();
export type ProductSourceMeasurementTransferV2ExtensionV1 = z.infer<typeof ProductSourceMeasurementTransferV2ExtensionV1Schema>;

/** First-hop research only. Absent measurement_v2 retains the original policy-v1/no-release meaning. */
export const ProductSourceExportV2Schema = z.object({ version: z.literal(2), byte_export: ProductSourceExportV1Schema,
  stage: z.literal("research"), source_capabilities: VerificationCapabilitiesSchema,
  research_provenance: ProductResearchProvenanceV1Schema, research_provenance_digest: digest,
  measurement_v2: ProductSourceMeasurementExportV2ExtensionV1Schema.optional(),
}).strict().superRefine((value, context) => {
  const source = value.byte_export;
  if (value.source_capabilities.profile_digest !== source.profile_digest
    || value.source_capabilities.measurement_plan_policy?.version !== (value.measurement_v2 ? 2 : 1)
    || value.research_provenance.sources.some(item => item.origin.node_id !== source.node_id || item.origin.project_id !== source.project_id
      || item.origin.goal_id !== source.goal_id)) context.addIssue({ code: "custom", message: "First-hop provenance or source policy differs" });
  if (value.measurement_v2) {
    const binding = value.measurement_v2.source_release.binding;
    // The byte export has no workspace field; the original retrieval provenance
    // provides its source workspace, and the request checks it again below.
    if (binding.project_id !== source.project_id || binding.verification_profile_id !== source.profile_id
      || binding.verification_profile_digest !== source.profile_digest
      || value.research_provenance.sources.some(item => item.origin.workspace_root !== binding.workspace_root)) {
      context.addIssue({ code: "custom", message: "Source release configuration differs from its original source scope" });
    }
  }
});
export type ProductSourceExportV2 = z.infer<typeof ProductSourceExportV2Schema>;
export const PRODUCT_SOURCE_EXPORT_EVENT_V2 = "run.product-source.export.v2" as const;
export const PRODUCT_SOURCE_TRANSFER_FEATURE_V2 = "product-source-transfer.v2" as const;
export const PRODUCT_SOURCE_TRANSFER_MEASUREMENT_V2_FEATURE_V1 = "product-source-transfer.measurement-v2.v1" as const;

/** Local prepared configuration discovery only. It grants no transfer, review or execution authority. */
export const ProductSourceDestinationMappingV1Schema = z.object({
  source_release: ReleaseCapabilitiesV1Schema,
  destination_release: ReleaseCapabilitiesV1Schema,
  command_pairs: z.array(z.object({ source_command_id: id, destination_command_id: id }).strict()).min(1).max(32),
}).strict().superRefine((value, ctx) => {
  const source = value.source_release, destination = value.destination_release;
  if (source.binding.project_id !== destination.binding.project_id
    || source.binding.contract_digest !== destination.binding.contract_digest
    || canonicalReleaseJson(source.contract) !== canonicalReleaseJson(destination.contract)
    || new Set(value.command_pairs.map(pair => pair.source_command_id)).size !== value.command_pairs.length
    || new Set(value.command_pairs.map(pair => pair.destination_command_id)).size !== value.command_pairs.length) {
    ctx.addIssue({ code: "custom", message: "A prepared route requires the same project/release contract and a one-to-one command mapping" });
  }
});
export const ProductSourceRoutingV1Schema = z.object({
  version: z.literal(1),
  source_exports: z.array(ReleaseCapabilitiesV1Schema).max(64),
  destination_mappings: z.array(ProductSourceDestinationMappingV1Schema).max(64),
}).strict().superRefine((value, ctx) => {
  const sources = value.source_exports.map(release => canonicalReleaseJson(release.binding));
  const destinations = value.destination_mappings.map(mapping => canonicalReleaseJson({
    source: mapping.source_release.binding, destination: mapping.destination_release.binding,
  }));
  if (new Set(sources).size !== sources.length || new Set(destinations).size !== destinations.length) {
    ctx.addIssue({ code: "custom", message: "Prepared source routes must be unambiguous" });
  }
});
export type ProductSourceRoutingV1 = z.infer<typeof ProductSourceRoutingV1Schema>;
export type ProductSourceDestinationMappingV1 = z.infer<typeof ProductSourceDestinationMappingV1Schema>;

export const ProductSourceTransferRequestV2Schema = z.object({ version: z.literal(2), kind: z.literal(PRODUCT_SOURCE_TRANSFER_FEATURE_V2),
  byte_request: ProductSourceTransferRequestV1Schema, source_export: ProductSourceExportV2Schema, source_export_digest: digest,
  command_pairs: z.array(z.object({ source_command_id: id, destination_command_id: id }).strict()).min(1).max(32),
  measurement_v2: ProductSourceMeasurementTransferV2ExtensionV1Schema.optional(),
}).strict().superRefine((request, context) => {
  const base = request.byte_request, source = base.source, proof = request.source_export.byte_export;
  if (proof.node_id !== source.node_id || proof.run_id !== source.run_id || proof.task_id !== source.task_id || proof.project_id !== base.project_id
    || proof.goal_id !== base.goal_id || proof.plan_id !== base.plan_id || proof.verification_request_id !== source.verification_request_id
    || proof.profile_id !== source.profile_id || proof.profile_digest !== source.profile_digest || proof.subject_digest !== source.subject_digest
    || proof.capsule_digest !== source.capsule_digest || proof.manifest_digest !== source.manifest_digest || proof.capsule_bytes !== source.capsule_bytes
    || request.source_export.research_provenance.sources.some(item => item.origin.workspace_root !== source.workspace_root)
    || base.destination.capabilities.measurement_plan_policy?.version !== (request.measurement_v2 ? 2 : 1)
    || new Set(request.command_pairs.map(pair => pair.source_command_id)).size !== request.command_pairs.length
    || new Set(request.command_pairs.map(pair => pair.destination_command_id)).size !== request.command_pairs.length) {
    context.addIssue({ code: "custom", message: "Semantic transfer differs from its immutable byte source or supported mapping" });
  }
  if (!!request.measurement_v2 !== !!request.source_export.measurement_v2) {
    context.addIssue({ code: "custom", message: "Measurement-v2 transfer requires paired source and destination extensions" });
  }
  if (request.measurement_v2 && request.source_export.measurement_v2) {
    const from = request.source_export.measurement_v2.source_release, to = request.measurement_v2.destination_release;
    const sourcePolicy = request.source_export.source_capabilities.measurement_plan_policy, destinationPolicy = base.destination.capabilities.measurement_plan_policy;
    if (from.binding.workspace_root !== source.workspace_root || from.binding.project_id !== base.project_id
      || to.binding.project_id !== base.project_id || to.binding.workspace_root !== base.destination.workspace_root
      || to.binding.verification_profile_id !== base.destination.profile_id
      || to.binding.verification_profile_digest !== base.destination.capabilities.profile_digest
      || !sourcePolicy || !destinationPolicy || canonicalReleaseJson(sourcePolicy) !== canonicalReleaseJson(destinationPolicy)
      || from.binding.contract_digest !== to.binding.contract_digest || canonicalReleaseJson(from.contract) !== canonicalReleaseJson(to.contract)) {
      context.addIssue({ code: "custom", message: "Measurement-v2 policy or release configuration differs from its own source/destination scope" });
    }
  }
});
export type ProductSourceTransferRequestV2 = z.infer<typeof ProductSourceTransferRequestV2Schema>;
export const productSourceExportDigestV2 = (proof: unknown, sha256: (value: string) => string) => {
  const parsed = ProductSourceExportV2Schema.parse(proof), release = parsed.measurement_v2?.source_release;
  if (release && sha256(canonicalReleaseJson(release.contract)) !== release.binding.contract_digest) {
    throw new Error("Source release contract digest differs");
  }
  return digest.parse(sha256(canonicalProductSourceTransferValueV1(parsed)));
};
export function productSourceTransferRequestDigestV2(input: unknown, sha256: (value: string) => string): string {
  const request = ProductSourceTransferRequestV2Schema.parse(input);
  if (productSourceExportDigestV2(request.source_export, sha256) !== request.source_export_digest
    || sha256(canonicalProductSourceTransferValueV1(request.source_export.research_provenance)) !== request.source_export.research_provenance_digest
    || sha256(canonicalProductSourceTransferValueV1(request.byte_request.destination.capabilities)) !== request.byte_request.destination.capability_digest) {
    throw new Error("Semantic transfer's provenance, export or destination capability digest differs");
  }
  const release = request.measurement_v2?.destination_release;
  if (release && sha256(canonicalReleaseJson(release.contract)) !== release.binding.contract_digest) {
    throw new Error("Destination release contract digest differs");
  }
  return digest.parse(sha256(canonicalProductSourceTransferValueV1(request)));
}

/** Metadata is authenticated elsewhere. Here the exact measured report must contain the complete same set. */
export function assertProductResearchProvenanceV1(input: unknown, bytes: Uint8Array, sha256: (value: string | Uint8Array) => string) {
  const provenance = ProductResearchProvenanceV1Schema.parse(input);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== provenance.research.size || sha256(bytes) !== provenance.research.checksum) {
    throw new Error("Research report differs from the original measured pin");
  }
  const report = ProductResearchReportV1Schema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  if (report.sources.length !== provenance.sources.length) throw new Error("Research provenance source set differs");
  for (const source of report.sources) {
    const entry = provenance.sources.find(item => item.metadata.id === source.id);
    if (!entry || canonicalProductSourceTransferValueV1(source) !== canonicalProductSourceTransferValueV1(entry.metadata)
      || sha256(canonicalProductSourceTransferValueV1(source)) !== entry.metadata_digest) throw new Error("Research source metadata differs from its original attribution");
  }
  return report;
}

/** Explicit v2 parser preserves original criterion bytes; V1 remains strict and unchanged. */
export function assertProductResearchProvenanceV2(input: unknown, bytes: Uint8Array, sha256: (value: string | Uint8Array) => string) {
  const provenance = ProductResearchProvenanceV1Schema.parse(input);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== provenance.research.size || sha256(bytes) !== provenance.research.checksum) {
    throw new Error("Research report differs from the original measured pin");
  }
  const report = ProductResearchReportV2Schema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)));
  if (report.sources.length !== provenance.sources.length) throw new Error("Research provenance source set differs");
  for (const source of report.sources) {
    const entry = provenance.sources.find(item => item.metadata.id === source.id);
    if (!entry || canonicalProductSourceTransferValueV1(source) !== canonicalProductSourceTransferValueV1(entry.metadata)
      || sha256(canonicalProductSourceTransferValueV1(source)) !== entry.metadata_digest) throw new Error("Research source metadata differs from its original attribution");
  }
  return report;
}
