import { z } from "zod";
import { RunStartPayloadSchema,type RunStartPayload } from "./node-payloads.js";
import { ImportedProductReviewSubjectV1Schema,type ImportedProductReviewSubjectV1 } from "./imported-product-review-context.js";
import { ProductSourceOperationV1Schema,ProductSourceOperationResultV1Schema,ProductSourceFreshVerificationV1Schema,
  inspectProductSourceOperationResultV1,productSourceOperationDigestV1,type ProductSourceOperationV1,type ProductSourceOperationResultV1,
  type ProductSourceFreshVerificationV1,type SourceOperationSha } from "./product-source-operations.js";
import { ProductSourceVerificationEnvelopeSchema,type ProductSourceVerificationEnvelope } from "./product-source-verification.js";
import { canonicalProductSourceTransferValueV1 as canonical } from "./product-source-transfer.js";

const id=z.string().min(1).max(128),digest=z.string().regex(/^sha256:[a-f0-9]{64}$/);
const agent=z.object({instance_id:id,agent_id:id}).strict();
type Agent=z.infer<typeof agent>;
export const IMPORTED_PRODUCT_REVIEW_FEATURE_V1="imported-product-review.v1";
export const ImportedProductReviewControlV1Schema=z.object({version:z.literal(1),review_id:id,request_digest:digest}).strict();
export type ImportedProductReviewControlV1=z.infer<typeof ImportedProductReviewControlV1Schema>;
export interface ImportedProductReviewRequestV1 {
  version:1;review_id:string;operation:ProductSourceOperationV1;result:ProductSourceOperationResultV1;
  source_author:Agent;reviewer:Agent;review_start:RunStartPayload;before_start:RunStartPayload;after_start:RunStartPayload;
}
function verifierOnlyIdentityChanged(original:RunStartPayload,child:RunStartPayload):boolean {
  if(!original.verification||!child.verification)return false;
  return canonical({...child,run_id:original.run_id,verification:{...child.verification,request_id:original.verification.request_id}})===canonical(original);
}
export const ImportedProductReviewRequestV1Schema:z.ZodType<ImportedProductReviewRequestV1>=z.object({
  version:z.literal(1),review_id:id,operation:ProductSourceOperationV1Schema,result:ProductSourceOperationResultV1Schema,
  source_author:agent,reviewer:agent,review_start:RunStartPayloadSchema,before_start:RunStartPayloadSchema,after_start:RunStartPayloadSchema,
}).strict().superRefine((value,ctx)=>{
  const original=value.operation.intent.destination_start,request=value.operation.intent.request,base=request.byte_request;
  const review=value.review_start,context=review.context_pack.payload,subject=context?.imported_review_subject;
  const ids=[original.run_id,value.before_start.run_id,value.after_start.run_id,review.run_id];
  const requests=[original.verification?.request_id,value.before_start.verification?.request_id,value.after_start.verification?.request_id,review.verification?.request_id];
  if(value.operation.kind!=="import_verify"||value.result.outcome!=="verified"||value.result.fresh.verification.outcome!=="passed"
    ||value.source_author.agent_id===value.reviewer.agent_id||value.source_author.instance_id===value.reviewer.instance_id
    ||!verifierOnlyIdentityChanged(original,value.before_start)||!verifierOnlyIdentityChanged(original,value.after_start)
    ||new Set(ids).size!==4||requests.some(item=>!item)||new Set(requests).size!==4
    ||review.agent_instance_id!==value.reviewer.instance_id||review.task_id===original.task_id||review.task_id===base.source.task_id
    ||review.workspace.root!==base.destination.workspace_root||review.workspace.branch!=null||review.workspace_allocation
    ||review.verification?.profile_id!==base.destination.profile_id||review.verification.expected_subject_digest!==base.source.subject_digest
    ||context?.task.id!==review.task_id||context.project.id!==base.project_id||context.workspace.root!==review.workspace.root
    ||context.goal_context?.goal_id!==base.goal_id||context.goal_context.plan?.id!==base.plan_id
    ||canonical(context.goal_context)!==canonical(original.context_pack.payload?.goal_context)||canonical(context.project)!==canonical(original.context_pack.payload?.project)
    ||context.policy.execution_mode!=="discussion"||context.policy.filesystem_write_scope.length!==0||review.policy_snapshot.filesystem_write_scope.length!==0||context.imported_clean_validation || context.imported_clean_validation_review_subject || context.imported_recovery_validation||context.imported_recovery_validation_review_subject||context.product_development||context.imported_validation ||context.imported_validation_review_subject ||context.review_subject||context.imported_execution || context.imported_execution_review_subject || context.imported_execution_repair
    ||!subject||subject.review_id!==value.review_id||subject.author_agent_id!==value.source_author.agent_id
    ||subject.reviewer_agent_id!==value.reviewer.agent_id||subject.reviewer_instance_id!==value.reviewer.instance_id
    ||subject.measurement_mapping!==undefined&&(value.result.outcome!=="verified"||canonical(subject.measurement_mapping)!==canonical(value.result.admission.mapping))
    ||canonical(context.verification_capabilities)!==canonical({...base.destination.capabilities,profile_id:base.destination.profile_id})
    ||canonical(context.release_capabilities)!==canonical(request.measurement_v2?.destination_release)){
    ctx.addIssue({code:"custom",message:"Imported review must bind distinct read-only review and exact before/after research verification identities"});
  }
});
export function importedProductReviewSubjectV1(input:Pick<ImportedProductReviewRequestV1,"review_id"|"operation"|"result"|"source_author"|"reviewer">,sha:SourceOperationSha):ImportedProductReviewSubjectV1 {
  const request=input.operation.intent.request,source=request.byte_request.source,result=input.result;
  if(result.outcome!=="verified")throw Error("Imported subject requires the original qualified research verification");
  return ImportedProductReviewSubjectV1Schema.parse({version:1,review_id:input.review_id,transfer_id:request.byte_request.transfer_id,
    operation_id:input.operation.operation_id,request_digest:input.operation.request_digest,operation_result_digest:sha(canonical(result)),
    source_run_id:source.run_id,source_evidence_id:source.evidence_id,source_review_id:source.review_id,source_export_digest:request.source_export_digest,
    admission_digest:result.fresh.admission_digest,mapping_digest:result.fresh.mapping_digest,research_provenance_digest:result.fresh.research_provenance_digest,
    subject_digest:result.admission.ready.destination.subject_digest,author_agent_id:input.source_author.agent_id,reviewer_agent_id:input.reviewer.agent_id,
    reviewer_instance_id:input.reviewer.instance_id,development_stage:"research"});
}
export function inspectImportedProductReviewRequestV1(input:unknown,researchBytes:Uint8Array,sha:SourceOperationSha):ImportedProductReviewRequestV1 {
  const request=ImportedProductReviewRequestV1Schema.parse(input);
  inspectProductSourceOperationResultV1(request.operation,request.result,researchBytes,sha);
  const subject=request.review_start.context_pack.payload!.imported_review_subject!;
  const expected=importedProductReviewSubjectV1(request,sha);
  // Older reviews remain unchanged; an optional projection must be the exact admitted mapping.
  if(subject.measurement_mapping!==undefined&&request.result.outcome==="verified")expected.measurement_mapping=request.result.admission.mapping;
  if(canonical(subject)!==canonical(expected))throw Error("Imported review subject differs from its complete transfer result");
  return request;
}
export function importedProductReviewRequestDigestV1(input:unknown,sha:SourceOperationSha):string {
  return digest.parse(sha(canonical(ImportedProductReviewRequestV1Schema.parse(input))));
}
export const ImportedProductReviewVerdictV1Schema=z.object({version:z.literal(1),review_id:id,transfer_id:id,subject_digest:digest,source_export_digest:digest,
  outcome:z.enum(["accepted","changes_requested"]),summary:z.string().trim().min(1).max(12000),
  findings:z.array(z.object({severity:z.enum(["blocking","nonblocking"]),description:z.string().trim().min(1).max(4000),file:z.string().max(4096).optional()}).strict()).max(100),
}).strict().superRefine((value,ctx)=>{
  if(value.outcome==="accepted"&&value.findings.some(finding=>finding.severity==="blocking"))ctx.addIssue({code:"custom",message:"Blocking findings cannot be accepted"});
});
export type ImportedProductReviewVerdictV1=z.infer<typeof ImportedProductReviewVerdictV1Schema>;
export interface ImportedProductReviewMeasurementV1 {admission:ProductSourceVerificationEnvelope;fresh:ProductSourceFreshVerificationV1}
const measured=z.object({admission:ProductSourceVerificationEnvelopeSchema,fresh:ProductSourceFreshVerificationV1Schema}).strict();
export type ImportedProductReviewResultV1={version:1;review_id:string;request_digest:string;execution_authorized:false}&(
  |{outcome:"reviewed";closed:true;before:ImportedProductReviewMeasurementV1;after:ImportedProductReviewMeasurementV1;
    reviewer:{run_id:string;config_digest:string;closure:"windows-job-and-tools-closed.v1"};verdict:ImportedProductReviewVerdictV1}
  |{outcome:"failed";closed:true;reason:string}
  |{outcome:"uncertain";closed:false;reason:string}
  |{outcome:"cancelled_before_start";closed:true;reason:string});
const resultBase={version:z.literal(1),review_id:id,request_digest:digest,execution_authorized:z.literal(false)};
export const ImportedProductReviewResultV1Schema:z.ZodType<ImportedProductReviewResultV1>=z.discriminatedUnion("outcome",[
  z.object({...resultBase,outcome:z.literal("reviewed"),closed:z.literal(true),before:measured,after:measured,
    reviewer:z.object({run_id:id,config_digest:digest,closure:z.literal("windows-job-and-tools-closed.v1")}).strict(),verdict:ImportedProductReviewVerdictV1Schema}).strict(),
  z.object({...resultBase,outcome:z.literal("failed"),closed:z.literal(true),reason:z.string().min(1).max(2000)}).strict(),
  z.object({...resultBase,outcome:z.literal("uncertain"),closed:z.literal(false),reason:z.string().min(1).max(2000)}).strict(),
  z.object({...resultBase,outcome:z.literal("cancelled_before_start"),closed:z.literal(true),reason:z.string().min(1).max(2000)}).strict(),
]);
function inspectMeasurement(request:ImportedProductReviewRequestV1,start:RunStartPayload,value:ImportedProductReviewMeasurementV1,bytes:Uint8Array,sha:SourceOperationSha){
  const operation={...request.operation,intent:{...request.operation.intent,destination_start:start}};
  inspectProductSourceOperationResultV1(operation,{version:1,operation_id:operation.operation_id,payload_digest:productSourceOperationDigestV1(operation,sha),
    request_digest:operation.request_digest,outcome:"verified",closed:true,...value},bytes,sha);
  if(value.fresh.verification.outcome!=="passed")throw Error("Independent imported review requires two passed destination verifications");
}
/** Public evidence checks only. A parser/verdict never mints node process or writer authority. */
export function inspectImportedProductReviewResultV1(requestInput:unknown,input:unknown,researchBytes:Uint8Array,sha:SourceOperationSha):ImportedProductReviewResultV1 {
  const request=inspectImportedProductReviewRequestV1(requestInput,researchBytes,sha),result=ImportedProductReviewResultV1Schema.parse(input);
  if(result.review_id!==request.review_id||result.request_digest!==importedProductReviewRequestDigestV1(request,sha))throw Error("Imported review result identity differs");
  if(result.outcome!=="reviewed")return result;
  inspectMeasurement(request,request.before_start,result.before,researchBytes,sha);inspectMeasurement(request,request.after_start,result.after,researchBytes,sha);
  const subject=importedProductReviewSubjectV1(request,sha),verdict=result.verdict;
  if(result.reviewer.run_id!==request.review_start.run_id||result.reviewer.config_digest!==sha(canonical(request.review_start))
    ||verdict.review_id!==request.review_id||verdict.transfer_id!==subject.transfer_id||verdict.subject_digest!==subject.subject_digest||verdict.source_export_digest!==subject.source_export_digest
    ||result.before.fresh.mapping_digest!==subject.mapping_digest||result.after.fresh.mapping_digest!==subject.mapping_digest)throw Error("Imported reviewer verdict or node result binding differs");
  return result;
}
