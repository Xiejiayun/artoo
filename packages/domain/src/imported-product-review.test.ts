import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe,it,expect } from "vitest";
import { ProductSourceOperationV1Schema,ProductSourceOperationResultV1Schema,productSourceOperationDigestV1 } from "./product-source-operations.js";
import { inspectProductSourceVerificationEnvelope } from "./product-source-verification.js";
import { canonicalProductSourceTransferValueV1 as canonical } from "./product-source-transfer.js";
import { importedProductReviewSubjectV1,importedProductReviewRequestDigestV1,inspectImportedProductReviewRequestV1,
  inspectImportedProductReviewResultV1,type ImportedProductReviewRequestV1,type ImportedProductReviewResultV1 } from "./imported-product-review.js";

const sha=(value:string|Uint8Array)=>`sha256:${createHash("sha256").update(value).digest("hex")}`;
const recorded=JSON.parse(readFileSync(new URL("../test-fixtures/product-source-operation.json",import.meta.url),"utf8"));
function fixture(){
  const bytes=new TextEncoder().encode(recorded.research);
  const operation=ProductSourceOperationV1Schema.parse({version:1,operation_id:"import-operation",kind:"import_verify",request_digest:recorded.fresh.request_digest,
    intent:{version:1,request:recorded.admission.request,next_task_id:"design-next",destination_start:recorded.admission.run_start}});
  const result=ProductSourceOperationResultV1Schema.parse({version:1,operation_id:operation.operation_id,payload_digest:productSourceOperationDigestV1(operation,sha),
    request_digest:operation.request_digest,outcome:"verified",closed:true,admission:recorded.admission,fresh:recorded.fresh});
  const original=operation.intent.destination_start,before=structuredClone(original),after=structuredClone(original),review=structuredClone(original);
  before.run_id="review-before";before.verification!.request_id="request-before";after.run_id="review-after";after.verification!.request_id="request-after";
  review.run_id="review-agent";review.task_id="review-task";review.agent_instance_id="review-instance";review.verification!.request_id="request-review";
  review.policy_snapshot.filesystem_write_scope=[];
  const context=review.context_pack.payload!;context.task.id=review.task_id;delete context.product_development;delete context.review_subject;
  context.policy.execution_mode="discussion";context.policy.filesystem_write_scope=[];
  const base={review_id:"imported-review",operation,result,source_author:{instance_id:"source-instance",agent_id:"author-agent"},reviewer:{instance_id:"review-instance",agent_id:"review-agent"}};
  context.imported_review_subject=importedProductReviewSubjectV1(base,sha);
  const request:ImportedProductReviewRequestV1={version:1,...base,review_start:review,before_start:before,after_start:after};
  function measurement(start:typeof original){
    const envelope=structuredClone(recorded.admission);envelope.run_start=start;
    const inspected=inspectProductSourceVerificationEnvelope(envelope,bytes,sha),fresh=structuredClone(recorded.fresh);
    fresh.destination_run_id=start.run_id;fresh.admission_digest=inspected.admission_digest;fresh.verification.request_id=start.verification!.request_id;
    return {admission:inspected.envelope,fresh};
  }
  const reviewResult:ImportedProductReviewResultV1={version:1,review_id:request.review_id,request_digest:importedProductReviewRequestDigestV1(request,sha),
    execution_authorized:false,outcome:"reviewed",closed:true,before:measurement(before),after:measurement(after),
    reviewer:{run_id:review.run_id,config_digest:sha(canonical(review)),closure:"windows-job-and-tools-closed.v1"},
    verdict:{version:1,review_id:request.review_id,transfer_id:operation.intent.request.byte_request.transfer_id,
      subject_digest:context.imported_review_subject.subject_digest,source_export_digest:operation.intent.request.source_export_digest,
      outcome:"accepted",summary:"Controlled protocol fixture; no new native/model execution",findings:[]}};
  return {request,result:reviewResult,bytes};
}
describe("imported research review contracts (recorded source data and controlled review receipts only)",()=>{
  it("binds distinct reviewer and fresh before/after identities without writer authority",()=>{
    const f=fixture();expect(inspectImportedProductReviewRequestV1(f.request,f.bytes,sha)).toEqual(f.request);
    expect(inspectImportedProductReviewResultV1(f.request,f.result,f.bytes,sha)).toEqual(f.result);expect(f.result.execution_authorized).toBe(false);
  });
  for(const change of ["same-agent","changed-before-scope","changed-review-objective","changed-review-plan","same-verifier-run","write-scope","ordinary-subject","wrong-subject","wrong-review-instance"] as const)
    it(`rejects ${change}`,()=>{
      const f=fixture(),request=f.request,context=request.review_start.context_pack.payload!;
      if(change==="same-agent")request.reviewer.agent_id=request.source_author.agent_id;
      if(change==="changed-before-scope")request.before_start.context_pack.payload!.goal_context!.objective="substituted objective";
      if(change==="changed-review-objective")context.goal_context!.objective="substituted user requirements";
      if(change==="changed-review-plan")context.goal_context!.plan!.rationale="substituted accepted plan";
      if(change==="same-verifier-run")request.after_start.run_id=request.before_start.run_id;
      if(change==="write-scope")context.policy.filesystem_write_scope=["product"];
      if(change==="ordinary-subject")context.review_subject={version:1,task_id:"invented",run_id:"invented",evidence_id:"invented",subject_digest:sha("invented")};
      if(change==="wrong-subject")context.imported_review_subject!.operation_result_digest=sha("different");
      if(change==="wrong-review-instance")request.review_start.agent_instance_id="other";
      expect(()=>inspectImportedProductReviewRequestV1(request,f.bytes,sha)).toThrow();
    });
  for(const change of ["failed-before","changed-after-run","changed-config","changed-verdict","blocking-accepted","writer-authority"] as const)
    it(`rejects reviewed receipt with ${change}`,()=>{
      const f=fixture();if(f.result.outcome!=="reviewed")throw Error("Expected fixture review");
      if(change==="failed-before")f.result.before.fresh.verification.outcome="failed";
      if(change==="changed-after-run")f.result.after.fresh.destination_run_id="different";
      if(change==="changed-config")f.result.reviewer.config_digest=sha("different");
      if(change==="changed-verdict")f.result.verdict.source_export_digest=sha("different");
      if(change==="blocking-accepted")f.result.verdict.findings=[{severity:"blocking",description:"Controlled unresolved finding"}];
      const result=change==="writer-authority"?{...f.result,execution_authorized:true}:f.result;
      expect(()=>inspectImportedProductReviewResultV1(f.request,result,f.bytes,sha)).toThrow();
    });
  it("keeps a changes-requested verdict valid but never authorizes a writer",()=>{
    const f=fixture();if(f.result.outcome!=="reviewed")throw Error("Expected fixture review");f.result.verdict.outcome="changes_requested";
    f.result.verdict.findings=[{severity:"blocking",description:"Controlled missing acceptance criterion"}];
    expect(inspectImportedProductReviewResultV1(f.request,f.result,f.bytes,sha)).toEqual(f.result);
  });
});
