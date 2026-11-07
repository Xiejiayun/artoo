import {createHash} from "node:crypto";
import {canonicalProductSourceTransferValueV1 as canonical,importedProductReviewRequestDigestV1,productSourceOperationDigestV1,
  type ImportedProductReviewResultV1} from "@artoo/domain";
import {importedProductReviewCommandSchema,importedProductReviewStopSchema,importedProductReviewStatusSchema,importedProductReviewReceiptSchema,
  type ImportedProductReviewCommand,type NodeSideTransport,type RuntimeAdapter,type ServerToNodeMessage} from "@artoo/protocol";
import {reserveImportedProductReview,runImportedProductReview,persistImportedProductReviewResult,readCompletedImportedProductReview,
  type PreparedImportedProductReview,type PreparedProductSourceRuntime} from "./product-source-runtime.js";
import type {createProductSourceOperationClient} from "./product-source-operations.js";
import {recordSourceCommandPhase,recordSourceCommandFailure} from "./source-command-diagnostics.js";

const sha=(value:string|Uint8Array)=>`sha256:${createHash("sha256").update(value).digest("hex")}`;
/** Opt-in node controller. Results and status use the original operation; no receipt recreates local authority. */
export function createImportedProductReviewClient(options:{nodeId:string;runtime:PreparedProductSourceRuntime;
  sourceOperations:ReturnType<typeof createProductSourceOperationClient>;resolveAdapter:(runtime:string)=>RuntimeAdapter|undefined;
  transport:NodeSideTransport;isCurrent:()=>boolean}){
  type Slot={digest:string;controller:AbortController;permit:PreparedImportedProductReview;action:"start"|"stop";
    work?:Promise<void>;result?:ImportedProductReviewResultV1;persisted?:boolean;acknowledged?:string};
  const slots=new Map<string,Slot>();let invalidated=false;
  const current=()=>{if(invalidated||!options.isCurrent())throw Error("Imported review session invalidated");};
  async function ack(commandId:string,reviewId:string,digest:string){recordSourceCommandPhase("acknowledgement");current();await options.transport.send({kind:"product.source.review.ack.v1",node_id:options.nodeId,
    command_id:commandId,status:"accepted",payload:{version:1,review_id:reviewId,request_digest:digest}});}
  async function emit(commandId:string,slot:Slot){if(!slot.persisted||!slot.result)return;recordSourceCommandPhase("emit_result");current();await options.transport.send({kind:"product.source.review.result.v1",
    node_id:options.nodeId,command_id:commandId,payload:slot.result});}
  async function start(command:ImportedProductReviewCommand){
    recordSourceCommandPhase("request");
    const request=command.payload,digest=importedProductReviewRequestDigestV1(request,sha);
    if(command.deadline_at&&Date.parse(command.deadline_at)<=Date.now())throw Error("Imported review command deadline expired");
    if(request.operation.intent.request.byte_request.destination.node_id!==options.nodeId)throw Error("Imported review is assigned to another node");
    const prior=slots.get(request.review_id);
    if(prior){
      if(prior.digest!==digest)throw Error("Imported review identity already belongs to another complete request");
      if(prior.action==="stop"&&!prior.persisted){
        const result:ImportedProductReviewResultV1={version:1,review_id:request.review_id,request_digest:digest,execution_authorized:false,
          outcome:"cancelled_before_start",closed:true,reason:"Original durable stop preceded this matching review start"};
        persistImportedProductReviewResult(options.runtime,prior.permit,result);prior.result=result;prior.persisted=true;
      }
      await ack(command.id,request.review_id,digest);await prior.work;await emit(command.id,prior);return;
    }
    recordSourceCommandPhase("session");current();
    recordSourceCommandPhase("prior_result");
    const original=options.sourceOperations.readCompletedVerified(request.operation.operation_id,productSourceOperationDigestV1(request.operation,sha));
    recordSourceCommandPhase("result_binding");
    if(canonical(original)!==canonical(request.result))throw Error("Imported review differs from the original node-owned transfer result");
    recordSourceCommandPhase("adapter");
    const adapter=options.resolveAdapter(request.review_start.runtime);if(!adapter)throw Error("Imported reviewer runtime is not configured");
    recordSourceCommandPhase("reservation");
    const permit=reserveImportedProductReview(options.runtime,request.review_id,digest,"start"),slot:Slot={digest,permit,action:"start",controller:new AbortController()};
    slots.set(request.review_id,slot);
    slot.work=(async()=>{
      try{
        await ack(command.id,request.review_id,digest);current();slot.controller.signal.throwIfAborted();
        slot.result=await runImportedProductReview(options.runtime,permit,original.fresh,request,adapter,slot.controller.signal,current);
      }catch(error){recordSourceCommandFailure(error);slot.result={version:1,review_id:request.review_id,request_digest:digest,execution_authorized:false,outcome:"uncertain",closed:false,
        reason:(error instanceof Error?error.message:"Imported review failed").slice(0,2000)||"Imported review failed"};}
      recordSourceCommandPhase("persist_result");persistImportedProductReviewResult(options.runtime,permit,slot.result);slot.persisted=true;
    })();
    await slot.work;if(!invalidated&&options.isCurrent())await emit(command.id,slot);
  }
  return {
    async handle(input:ServerToNodeMessage):Promise<boolean>{
      if(!input.type.startsWith("product.source.review."))return false;recordSourceCommandPhase("session");current();
      recordSourceCommandPhase("request");
      if(input.type==="product.source.review.v1"){await start(importedProductReviewCommandSchema.parse(input));return true;}
      if(input.type==="product.source.review.receipt.v1"){
        const receipt=importedProductReviewReceiptSchema.parse(input),slot=slots.get(receipt.payload.review_id);
        if(!slot?.persisted||!slot.result||slot.digest!==receipt.payload.request_digest||sha(canonical(slot.result))!==receipt.result_digest)throw Error("Imported review receipt differs from original result");
        if(receipt.status==="accepted")slot.acknowledged=receipt.result_digest;return true;
      }
      const command=input.type==="product.source.review.stop.v1"?importedProductReviewStopSchema.parse(input):importedProductReviewStatusSchema.parse(input);
      let slot=slots.get(command.payload.review_id);
      if(slot&&slot.digest!==command.payload.request_digest)throw Error("Imported review control request changed");
      if(input.type==="product.source.review.status.v1"){
        if(!slot)throw Error("Original imported-review owner is unavailable; recovery required");
        await ack(command.id,command.payload.review_id,slot.digest);await slot.work;await emit(command.id,slot);return true;
      }
      if(!slot){
        const permit=reserveImportedProductReview(options.runtime,command.payload.review_id,command.payload.request_digest,"stop");
        slot={digest:command.payload.request_digest,permit,action:"stop",controller:new AbortController()};slots.set(command.payload.review_id,slot);
        const result:ImportedProductReviewResultV1={version:1,review_id:command.payload.review_id,request_digest:slot.digest,execution_authorized:false,
          outcome:"cancelled_before_start",closed:true,reason:"Original durable stop preceded review admission"};
        persistImportedProductReviewResult(options.runtime,permit,result);slot.result=result;slot.persisted=true;
      }
      slot.controller.abort();await slot.work;await ack(command.id,command.payload.review_id,slot.digest);await emit(command.id,slot);return true;
    },
    readCompletedAccepted(reviewId:string,digest:string){
      current();const slot=slots.get(reviewId);
      if(!slot?.persisted||!slot.result||slot.digest!==digest)throw Error("Original imported review result is unavailable");
      readCompletedImportedProductReview(options.runtime,slot.result);return slot.result;
    },
    invalidate(){invalidated=true;for(const slot of slots.values())slot.controller.abort();},
    async settled(){await Promise.all([...slots.values()].map(slot=>slot.work));},
  };
}
