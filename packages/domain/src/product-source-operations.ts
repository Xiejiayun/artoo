import { z } from "zod";
import { RunStartPayloadSchema, type RunStartPayload } from "./node-payloads.js";
import { RunVerificationPayloadSchema, type RunVerificationPayload } from "./autonomy.js";
import { ProductSourceTransferRequestV2Schema, productSourceTransferRequestDigestV2, type ProductSourceTransferRequestV2 } from "./product-source-semantics.js";
import { ProductSourceVerificationEnvelopeSchema, inspectProductSourceVerificationEnvelope, type ProductSourceVerificationEnvelope } from "./product-source-verification.js";
import { ProductSourceTransferReceiptV1Schema, canonicalProductSourceTransferValueV1 as canonical, type ProductSourceTransferReceiptV1 } from "./product-source-transfer.js";
import { ProductResearchReportSchema } from "./product-development.js";
import { evaluateDeclaredMeasurementPlanV1, evaluateDeclaredMeasurementPlanV2 } from "./measurement-plan.js";

const id = z.string().min(1).max(128).regex(/^[^\u0000-\u001f\u007f]+$/u);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const PRODUCT_SOURCE_OPERATIONS_FEATURE_V1 = "product-source-operations.v1";
export interface ProductSourceHandoffIntentV1 {
  version: 1; request: ProductSourceTransferRequestV2; next_task_id: string; destination_start: RunStartPayload;
}
/** Data contract only: source authorization and destination admission remain trusted-boundary checks. */
export const ProductSourceHandoffIntentV1Schema: z.ZodType<ProductSourceHandoffIntentV1> = z.object({
  version: z.literal(1), request: ProductSourceTransferRequestV2Schema, next_task_id: id, destination_start: RunStartPayloadSchema,
}).strict().superRefine((value, ctx) => {
  const base = value.request.byte_request, start = value.destination_start, context = start.context_pack.payload;
  if (!value.request.measurement_v2 || !value.request.source_export.measurement_v2 || start.workspace.root !== base.destination.workspace_root || start.workspace.branch != null || start.workspace_allocation
    || start.verification?.profile_id !== base.destination.profile_id || start.verification.expected_subject_digest !== base.source.subject_digest
    || context?.task.id !== start.task_id || context.project.id !== base.project_id || context.workspace.root !== base.destination.workspace_root
    || context.goal_context?.goal_id !== base.goal_id || context.goal_context.plan?.id !== base.plan_id
    || context.imported_clean_validation || context.imported_clean_validation_review_subject || context.imported_recovery_validation || context.imported_recovery_validation_review_subject || context.product_development?.stage !== "research" || context.review_subject || context.imported_review_subject || value.next_task_id === base.source.task_id
    || value.next_task_id === start.task_id || start.run_id === base.source.run_id) {
    ctx.addIssue({code:"custom",message:"Handoff must pin a distinct research verification and intended next task in the exact destination scope"});
  }
});
export interface ProductSourceOperationV1 { version: 1; operation_id: string; kind: "upload" | "import_verify"; request_digest: string; intent: ProductSourceHandoffIntentV1 }
export const ProductSourceOperationV1Schema: z.ZodType<ProductSourceOperationV1> = z.object({
  version:z.literal(1), operation_id:id, kind:z.enum(["upload","import_verify"]), request_digest:digest, intent:ProductSourceHandoffIntentV1Schema,
}).strict();
export interface ProductSourceFreshVerificationV1 {
  version:1; claim:"fresh-destination-research-verification"; request_digest:string; source_export_digest:string; admission_digest:string;
  mapping_digest:string; research_provenance_digest:string; destination_run_id:string; verification:RunVerificationPayload;
  execution_authorized:false; automatic_review_authorized:false;
}
export const ProductSourceFreshVerificationV1Schema: z.ZodType<ProductSourceFreshVerificationV1> = z.object({
  version:z.literal(1),claim:z.literal("fresh-destination-research-verification"),request_digest:digest,source_export_digest:digest,
  admission_digest:digest,mapping_digest:digest,research_provenance_digest:digest,destination_run_id:id,verification:RunVerificationPayloadSchema,
  execution_authorized:z.literal(false),automatic_review_authorized:z.literal(false),
}).strict();
type ResultBase = {version:1;operation_id:string;payload_digest:string;request_digest:string};
export type ProductSourceOperationResultV1 = ResultBase & (
  | {outcome:"uploaded";closed:true;receipt:ProductSourceTransferReceiptV1}
  | {outcome:"verified";closed:true;admission:ProductSourceVerificationEnvelope;fresh:ProductSourceFreshVerificationV1}
  | {outcome:"cancelled_before_start";closed:true;reason:string}
  | {outcome:"uncertain";closed:false;reason:string});
const base={version:z.literal(1),operation_id:id,payload_digest:digest,request_digest:digest};
export const ProductSourceOperationResultV1Schema: z.ZodType<ProductSourceOperationResultV1> = z.discriminatedUnion("outcome",[
  z.object({...base,outcome:z.literal("uploaded"),closed:z.literal(true),receipt:ProductSourceTransferReceiptV1Schema}).strict(),
  z.object({...base,outcome:z.literal("verified"),closed:z.literal(true),admission:ProductSourceVerificationEnvelopeSchema,fresh:ProductSourceFreshVerificationV1Schema}).strict(),
  z.object({...base,outcome:z.literal("cancelled_before_start"),closed:z.literal(true),reason:z.string().min(1).max(2000)}).strict(),
  z.object({...base,outcome:z.literal("uncertain"),closed:z.literal(false),reason:z.string().min(1).max(2000)}).strict(),
]);
// A newly issued stop carries the immutable transfer digest so a node that has
// never seen its start can persist a completely bound cancellation receipt.
// Older controls remain parseable and fenced until a matching start supplies it.
export type ProductSourceOperationControlV1={version:1;operation_id:string;payload_digest:string;request_digest?:string};
export const ProductSourceOperationControlV1Schema:z.ZodType<ProductSourceOperationControlV1>=z.object({version:z.literal(1),operation_id:id,payload_digest:digest,request_digest:digest.optional()}).strict();
export type SourceOperationSha=(value:string|Uint8Array)=>string;
export function productSourceOperationDigestV1(input:unknown,sha:SourceOperationSha):string {
  const operation=ProductSourceOperationV1Schema.parse(input);
  if(productSourceTransferRequestDigestV2(operation.intent.request,sha)!==operation.request_digest) throw Error("Operation full transfer digest differs");
  return digest.parse(sha(canonical(operation)));
}
/** Exact public evidence validation; calling this does not authenticate a node or authorize a writer/reviewer. */
export function inspectProductSourceOperationResultV1(operation:ProductSourceOperationV1,input:unknown,researchBytes:Uint8Array,sha:SourceOperationSha):ProductSourceOperationResultV1 {
  const result=ProductSourceOperationResultV1Schema.parse(input), request=operation.intent.request, start=operation.intent.destination_start;
  if(result.operation_id!==operation.operation_id||result.payload_digest!==productSourceOperationDigestV1(operation,sha)||result.request_digest!==operation.request_digest) throw Error("Result operation binding differs");
  if(result.outcome==="uploaded") {
    if(operation.kind!=="upload"||result.receipt.transfer_id!==request.byte_request.transfer_id||result.receipt.request_digest!==operation.request_digest
      ||result.receipt.capsule_digest!==request.byte_request.source.capsule_digest||result.receipt.status!=="available") throw Error("Upload receipt binding differs");
  } else if(result.outcome==="verified") {
    if(operation.kind!=="import_verify"||canonical(result.admission.request)!==canonical(request)||canonical(result.admission.run_start)!==canonical(start)) throw Error("Destination admission differs from committed operation");
    const inspected=inspectProductSourceVerificationEnvelope(result.admission,researchBytes,sha), fresh=result.fresh, verification=fresh.verification;
    if(fresh.request_digest!==operation.request_digest||fresh.source_export_digest!==request.source_export_digest
      ||fresh.research_provenance_digest!==request.source_export.research_provenance_digest||fresh.destination_run_id!==start.run_id
      ||fresh.admission_digest!==inspected.admission_digest||fresh.mapping_digest!==sha(canonical(inspected.mapping))
      ||verification.request_id!==start.verification?.request_id||verification.profile_id!==request.byte_request.destination.profile_id
      ||verification.profile_digest!==request.byte_request.destination.capabilities.profile_digest
      ||verification.subject_digest!==result.admission.ready.destination.subject_digest) throw Error("Fresh result complete admission binding differs");
    // A bound, closed failure is a durable observation, never a passing qualification.
    if(verification.outcome!=="passed")return result;
    const capabilities=request.byte_request.destination.capabilities, original=ProductResearchReportSchema.parse(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(researchBytes)));
    const policy=capabilities.measurement_plan_policy;
    if(!policy) throw Error("Missing measurement policy");
    const partition=policy.version===2
      ? evaluateDeclaredMeasurementPlanV2({research:{...original,measurement_plan:inspected.effective_plan},policy,capabilities,releaseCapabilities:request.measurement_v2?.destination_release,digest:sha})
      : evaluateDeclaredMeasurementPlanV1({research:{...original,measurement_plan:inspected.effective_plan},policy,capabilities});
    const {canonical_plan,...counts}=partition;
    const expected={version:policy.version,claim:"declared-mapping-feasibility",scope:"final",policy,research:request.source_export.research_provenance.research,
      measurement_plan_digest:sha(canonical_plan),...counts};
    if(verification.outcome!=="passed"||canonical(verification.measurement_plan)!==canonical(expected)
      ||verification.required_files.length!==1||canonical(verification.required_files[0])!==canonical(request.source_export.research_provenance.research)
      ||verification.checks.length!==capabilities.checks.length||new Set(verification.checks.map(v=>v.id)).size!==capabilities.checks.length
      ||verification.checks.some(check=>{
        const observation=check.observation;
        return check.exit_code!==0||observation?.version!==3||observation.stage!=="research"||observation.scope!=="final"||observation.cases.length!==0
          ||!capabilities.checks.some(binding=>binding.command_id===check.id&&observation.capability_binding.config_digest===binding.config_digest
            &&observation.capability_binding.contract_digest===binding.contract_digest&&observation.capability_binding.profile_digest===capabilities.profile_digest
            &&observation.capability_binding.command_id===check.id);
      })) throw Error("Destination result is not complete fresh research verification");
  }
  return result;
}
