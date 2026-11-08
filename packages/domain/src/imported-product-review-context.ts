import { z } from "zod";
import { ProductSourceMeasurementMappingV1Schema } from "./product-source-measurement.js";

const id=z.string().min(1).max(128),digest=z.string().regex(/^sha256:[a-f0-9]{64}$/);
/** An imported subject has no ordinary local author run/evidence. This field is descriptive, never authority. */
export const ImportedProductReviewSubjectV1Schema=z.object({
  version:z.literal(1),review_id:id,transfer_id:id,operation_id:id,request_digest:digest,operation_result_digest:digest,
  source_run_id:id,source_evidence_id:id,source_review_id:id,source_export_digest:digest,
  admission_digest:digest,mapping_digest:digest,research_provenance_digest:digest,subject_digest:digest,
  author_agent_id:id,reviewer_agent_id:id,reviewer_instance_id:id,development_stage:z.literal("research"),
  // Optional so already persisted reviews keep their original payload and digest.
  measurement_mapping:ProductSourceMeasurementMappingV1Schema.optional(),
}).strict().superRefine((value,ctx)=>{
  if(value.author_agent_id===value.reviewer_agent_id)ctx.addIssue({code:"custom",message:"Imported research requires a distinct logical reviewer"});
});
export type ImportedProductReviewSubjectV1=z.infer<typeof ImportedProductReviewSubjectV1Schema>;

export const IMPORTED_PRODUCT_REVIEW_MAPPING_INSTRUCTION_V1 = "The imported research keeps its original source-computer measurement plan and retrieval provenance byte for byte. Inspect imported_review_subject.measurement_mapping to interpret the source profile and each source command/config/contract using their explicit destination bindings; inspect current release_capabilities for the mapped configured-static-release binding. A different source binding alone is not a defect when this exact mapping preserves the contract. Do not request rewriting the preserved research merely to copy destination bindings. Independently assess the original requirements, omissions, criteria, actions, keys, viewports, needs and substantive measurement feasibility; the mapping does not resolve a substantive defect or require an accepted verdict. It describes configured equivalence, not proof of process execution, browser coverage, source retrieval or publication, and grants no write or release authority. Missing or inconsistent mapping remains an unresolved limitation.";
