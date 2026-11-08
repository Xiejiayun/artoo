import { z } from "zod";
import { ProductSourceMeasurementMappingV1Schema } from "./product-source-measurement.js";

const id = z.string().min(1).max(128).regex(/^[^\u0000-\u001f\u007f]+$/u);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);

/** Describes accepted upstream research. Serialized context never grants a local writer permit. */
export const TransferredProductInputV1Schema = z.object({
  version: z.literal(1), stage: z.literal("research"), continuation_id: id,
  transfer_id: id, imported_review_id: id, imported_review_request_digest: digest,
  imported_review_result_digest: digest, source_export_digest: digest,
  mapping_digest: digest, research_provenance_digest: digest, initial_subject_digest: digest,
  measurement_mapping: ProductSourceMeasurementMappingV1Schema.optional(),
}).strict();
export type TransferredProductInputV1 = z.infer<typeof TransferredProductInputV1Schema>;

export const IMPORTED_DESIGN_CONTEXT_INSTRUCTION_V1 = "This design continues accepted research imported from another computer. Preserve research.json and its retrieval provenance byte for byte. Interpret its original measurement plan through transferred_product_input.measurement_mapping: map each source command/config/contract to the explicit destination binding in checks. Preserve criteria, actions, keys, viewports and needs. For configured-static-release entries, use the current release_capabilities.binding whose equivalence was admitted by that mapping, rather than copying the source computer's release binding. These bindings describe verification configuration and do not prove execution or publication.";
