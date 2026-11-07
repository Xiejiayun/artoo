import { z } from "zod";

const id=z.string().min(1).max(128),digest=z.string().regex(/^sha256:[a-f0-9]{64}$/);
/** An imported subject has no ordinary local author run/evidence. This field is descriptive, never authority. */
export const ImportedProductReviewSubjectV1Schema=z.object({
  version:z.literal(1),review_id:id,transfer_id:id,operation_id:id,request_digest:digest,operation_result_digest:digest,
  source_run_id:id,source_evidence_id:id,source_review_id:id,source_export_digest:digest,
  admission_digest:digest,mapping_digest:digest,research_provenance_digest:digest,subject_digest:digest,
  author_agent_id:id,reviewer_agent_id:id,reviewer_instance_id:id,development_stage:z.literal("research"),
}).strict().superRefine((value,ctx)=>{
  if(value.author_agent_id===value.reviewer_agent_id)ctx.addIssue({code:"custom",message:"Imported research requires a distinct logical reviewer"});
});
export type ImportedProductReviewSubjectV1=z.infer<typeof ImportedProductReviewSubjectV1Schema>;
