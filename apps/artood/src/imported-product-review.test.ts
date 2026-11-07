import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {beforeEach,describe,it,expect,vi} from "vitest";
import {ProductSourceOperationV1Schema,ProductSourceOperationResultV1Schema,productSourceOperationDigestV1,importedProductReviewSubjectV1,
  importedProductReviewRequestDigestV1,type ImportedProductReviewRequestV1,type ImportedProductReviewResultV1} from "@artoo/domain";
import type {ImportedProductReviewCommand,NodeToServerMessage} from "@artoo/protocol";
const mocks=vi.hoisted(()=>({reserve:vi.fn(()=>({})),run:vi.fn(),persist:vi.fn(),completed:vi.fn()}));
vi.mock("./product-source-runtime.js",()=>({reserveImportedProductReview:mocks.reserve,runImportedProductReview:mocks.run,
  persistImportedProductReviewResult:mocks.persist,readCompletedImportedProductReview:mocks.completed}));
import {createImportedProductReviewClient} from "./imported-product-review.js";
const data=JSON.parse(readFileSync(new URL("../../../packages/domain/test-fixtures/product-source-operation.json",import.meta.url),"utf8"));
const sha=(value:string|Uint8Array)=>`sha256:${createHash("sha256").update(value).digest("hex")}`;
function fixture(){
  const operation=ProductSourceOperationV1Schema.parse({version:1,operation_id:"source-operation",kind:"import_verify",request_digest:data.fresh.request_digest,
    intent:{version:1,request:data.admission.request,next_task_id:"design-next",destination_start:data.admission.run_start}});
  const result=ProductSourceOperationResultV1Schema.parse({version:1,operation_id:operation.operation_id,payload_digest:productSourceOperationDigestV1(operation,sha),
    request_digest:operation.request_digest,outcome:"verified",closed:true,admission:data.admission,fresh:data.fresh});
  const before=structuredClone(operation.intent.destination_start),after=structuredClone(before),review=structuredClone(before);
  before.run_id="review-before";before.verification!.request_id="verify-before";after.run_id="review-after";after.verification!.request_id="verify-after";
  review.run_id="review-run";review.task_id="review-task";review.agent_instance_id="review-instance";review.verification!.request_id="verify-review";
  review.policy_snapshot.filesystem_write_scope=[];
  const context=review.context_pack.payload!;context.task.id=review.task_id;context.policy.execution_mode="discussion";context.policy.filesystem_write_scope=[];
  delete context.product_development;delete context.review_subject;
  const base={review_id:"review",operation,result,source_author:{instance_id:"author-instance",agent_id:"author"},reviewer:{instance_id:"review-instance",agent_id:"reviewer"}};
  context.imported_review_subject=importedProductReviewSubjectV1(base,sha);
  const request:ImportedProductReviewRequestV1={version:1,...base,review_start:review,before_start:before,after_start:after};
  const command:ImportedProductReviewCommand={kind:"command",id:"delivery",idempotency_key:"review:start",type:"product.source.review.v1",payload:request};
  const sent:NodeToServerMessage[]=[],transport={send:vi.fn(async(message:NodeToServerMessage)=>{sent.push(message);}),subscribe:()=>()=>{}};
  const original=vi.fn(()=>result),sourceOperations={readCompletedVerified:original} as never;
  const client=createImportedProductReviewClient({nodeId:operation.intent.request.byte_request.destination.node_id,runtime:{} as never,sourceOperations,
    resolveAdapter:()=>({runtimeId:review.runtime}) as never,isCurrent:()=>true,transport});
  const returned:ImportedProductReviewResultV1={version:1,review_id:request.review_id,request_digest:importedProductReviewRequestDigestV1(request,sha),execution_authorized:false,
    outcome:"failed",closed:true,reason:"Controlled closed reviewer failure; no model/native process"};
  mocks.run.mockResolvedValue(returned);return {client,command,request,sent,transport,original,returned};
}
beforeEach(()=>{vi.clearAllMocks();});
describe("imported review controller with explicitly mocked native lifetime",()=>{
  it("reserves before ACK, calls the original source object once and replays a persisted result",async()=>{
    const f=fixture();await f.client.handle(f.command);await f.client.handle({...f.command,id:"replay"});
    expect(mocks.reserve).toHaveBeenCalledTimes(1);expect(mocks.run).toHaveBeenCalledTimes(1);expect(mocks.persist).toHaveBeenCalledTimes(1);
    expect(mocks.reserve.mock.invocationCallOrder[0]).toBeLessThan(f.transport.send.mock.invocationCallOrder[0]!);
    if(f.request.result.outcome!=="verified")throw Error("Expected controlled transfer");
    expect(mocks.run.mock.calls[0]![2]).toBe(f.original.mock.results[0]!.value.fresh);
    expect(f.sent.filter(message=>message.kind==="product.source.review.result.v1")).toHaveLength(2);
  });
  it("does not rerun review after result delivery failure",async()=>{
    const f=fixture();let lost=false;f.transport.send.mockImplementation(async message=>{if(message.kind==="product.source.review.result.v1"&&!lost){lost=true;throw Error("lost result");}f.sent.push(message);});
    await expect(f.client.handle(f.command)).rejects.toThrow("lost result");await f.client.handle({...f.command,id:"reconnected"});expect(mocks.run).toHaveBeenCalledTimes(1);
  });
  it("rejects changed source result before reservation",async()=>{
    const f=fixture();f.original.mockReturnValue({...f.request.result,execution_authorized:true} as never);
    await expect(f.client.handle(f.command)).rejects.toThrow("original node-owned");expect(mocks.reserve).not.toHaveBeenCalled();
  });
  it("keeps stop-before-start durable without starting a reviewer",async()=>{
    const f=fixture();await f.client.handle({kind:"command",id:"stop",idempotency_key:"stop",type:"product.source.review.stop.v1",
      payload:{version:1,review_id:f.request.review_id,request_digest:importedProductReviewRequestDigestV1(f.request,sha)}});
    expect(mocks.persist).toHaveBeenCalledTimes(1);expect(f.sent.at(-1)).toMatchObject({kind:"product.source.review.result.v1",payload:{outcome:"cancelled_before_start",closed:true}});
    await f.client.handle({kind:"command",id:"status",idempotency_key:"status",type:"product.source.review.status.v1",
      payload:{version:1,review_id:f.request.review_id,request_digest:importedProductReviewRequestDigestV1(f.request,sha)}});
    expect(f.sent.at(-1)).toMatchObject({kind:"product.source.review.result.v1",command_id:"status",payload:{outcome:"cancelled_before_start",closed:true}});
    await f.client.handle(f.command);expect(mocks.run).not.toHaveBeenCalled();expect(mocks.persist).toHaveBeenCalledTimes(1);
  });
  it("never starts a missing operation from status or expired admission",async()=>{
    const f=fixture();await expect(f.client.handle({kind:"command",id:"status",idempotency_key:"status",type:"product.source.review.status.v1",
      payload:{version:1,review_id:f.request.review_id,request_digest:importedProductReviewRequestDigestV1(f.request,sha)}})).rejects.toThrow("recovery required");
    await expect(f.client.handle({...f.command,deadline_at:"2020-01-01T00:00:00Z"})).rejects.toThrow("deadline");expect(mocks.reserve).not.toHaveBeenCalled();
  });
  it("rejects a changed complete request on replay",async()=>{
    const f=fixture();await f.client.handle(f.command);const changed=structuredClone(f.command);changed.payload.review_start.context_pack.payload!.task.description="changed";
    await expect(f.client.handle(changed)).rejects.toThrow("another complete request");expect(mocks.run).toHaveBeenCalledTimes(1);
  });
  it("retains an unavailable original owner instead of reconstructing it",async()=>{
    const f=fixture();mocks.reserve.mockImplementationOnce(()=>{throw Error("EEXIST retained review owner");});
    await expect(f.client.handle(f.command)).rejects.toThrow("retained review owner");expect(mocks.run).not.toHaveBeenCalled();expect(f.sent).toHaveLength(0);
  });
  it("aborts the exact original review and retains its uncertain result when invalidated",async()=>{
    const f=fixture();mocks.run.mockImplementationOnce((_runtime,_permit,_fresh,_request,_adapter,signal:AbortSignal)=>new Promise((_resolve,reject)=>{signal.addEventListener("abort",()=>reject(Error("cancelled")),{once:true});}));
    const pending=f.client.handle(f.command);await vi.waitFor(()=>expect(mocks.run).toHaveBeenCalled());f.client.invalidate();await pending;
    expect(mocks.persist).toHaveBeenCalledWith(expect.anything(),expect.anything(),expect.objectContaining({outcome:"uncertain",closed:false}));
    await expect(f.client.handle(f.command)).rejects.toThrow("invalidated");
  });
});
