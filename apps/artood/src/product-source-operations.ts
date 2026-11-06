import {createHash} from "node:crypto";
import {canonicalProductSourceTransferValueV1 as canonical,productSourceOperationDigestV1,type ProductSourceOperationResultV1} from "@artoo/domain";
import {productSourceOperationCommandSchema,productSourceOperationStopSchema,productSourceOperationStatusSchema,productSourceOperationReceiptSchema,
  type NodeSideTransport,type ServerToNodeMessage,type ProductSourceOperationCommand} from "@artoo/protocol";
import {importProductSourceSemanticTransfer,verifyProductSourceSemanticTransfer,readCompletedProductSourceAdmission,
  reserveProductSourceOperation,persistProductSourceOperationResult,type PreparedProductSourceRuntime,type PreparedProductSourceOperation} from "./product-source-runtime.js";
import {createProductSourceSemanticClient} from "./product-source-semantic-client.js";

const sha=(value:string|Uint8Array)=>`sha256:${createHash("sha256").update(value).digest("hex")}`;
/** Explicit local opt-in only. No normal runner advertises this controller before preparation. */
export function createProductSourceOperationClient(options:{nodeId:string;runtime:PreparedProductSourceRuntime;client:ReturnType<typeof createProductSourceSemanticClient>;
  transport:NodeSideTransport;isCurrent:()=>boolean}) {
  type Slot={digest:string;requestDigest?:string;controller:AbortController;result?:ProductSourceOperationResultV1;work?:Promise<void>;persisted?:boolean;acknowledged?:string;stopPermit?:PreparedProductSourceOperation};
  const slots=new Map<string,Slot>();let invalidated=false;
  const current=()=>{if(invalidated||!options.isCurrent())throw Error("Operation session invalidated");};
  async function emit(commandId:string,slot:Slot){if(!slot.result)return;current();await options.transport.send({kind:"product.source.operation.result.v1",node_id:options.nodeId,command_id:commandId,payload:slot.result});}
  async function ack(commandId:string,operationId:string,digest:string,status:"accepted"|"rejected",message?:string){current();await options.transport.send({kind:"product.source.operation.ack.v1",node_id:options.nodeId,command_id:commandId,
    payload:{version:1,operation_id:operationId,payload_digest:digest},status,...(message?{message:message.slice(0,2000)}:{})});}
  function cancelledBeforeStart(slot:Slot,operationId:string,requestDigest:string){
    if(!slot.stopPermit||slot.result)return;
    const result:ProductSourceOperationResultV1={version:1,operation_id:operationId,payload_digest:slot.digest,request_digest:requestDigest,
      outcome:"cancelled_before_start",closed:true,reason:"Original durable stop preceded operation admission"};
    persistProductSourceOperationResult(options.runtime,slot.stopPermit,result);slot.requestDigest=requestDigest;slot.result=result;slot.persisted=true;
  }
  async function start(command:ProductSourceOperationCommand){
    if(command.deadline_at&&Date.parse(command.deadline_at)<=Date.now())throw Error("Operation command deadline expired before admission");
    const payload=command.payload,digest=productSourceOperationDigestV1(payload,sha),base=payload.intent.request.byte_request;
    if((payload.kind==="upload"?base.source.node_id:base.destination.node_id)!==options.nodeId)throw Error("Operation is assigned to another node");
    const prior=slots.get(payload.operation_id);
    if(prior){
      if(prior.digest!==digest||prior.requestDigest&&prior.requestDigest!==payload.request_digest)throw Error("Operation ID already belongs to another payload");
      cancelledBeforeStart(prior,payload.operation_id,payload.request_digest);
      await ack(command.id,payload.operation_id,digest,"accepted");await prior.work;await emit(command.id,prior);return;
    }
    current();
    // This protected, exclusive file precedes the ACK and every side effect. A restart cannot recreate its live token.
    const permit=reserveProductSourceOperation(options.runtime,payload.operation_id,digest,"start");
    const slot:Slot={digest,requestDigest:payload.request_digest,controller:new AbortController()};slots.set(payload.operation_id,slot);
    slot.work=(async()=>{
      const binding={version:1 as const,operation_id:payload.operation_id,payload_digest:digest,request_digest:payload.request_digest};
      try {
        await ack(command.id,payload.operation_id,digest,"accepted");current();slot.controller.signal.throwIfAborted();
        if(payload.kind==="upload"){
          const receipt=await options.client.upload(options.runtime,payload.intent.request,slot.controller.signal);
          slot.result={...binding,outcome:"uploaded",closed:true,receipt};
        }else{
          const downloaded=await options.client.download(payload.intent.request,slot.controller.signal);current();slot.controller.signal.throwIfAborted();
          await importProductSourceSemanticTransfer(options.runtime,downloaded,slot.controller.signal);current();slot.controller.signal.throwIfAborted();
          const fresh=await verifyProductSourceSemanticTransfer(options.runtime,downloaded,payload.intent.destination_start,slot.controller.signal);
          slot.result={...binding,outcome:"verified",closed:true,fresh,admission:readCompletedProductSourceAdmission(options.runtime,fresh)};
        }
      }catch(error){slot.result={...binding,outcome:"uncertain",closed:false,reason:(error instanceof Error?error.message:"Operation failed").slice(0,2000)||"Operation failed"};}
      persistProductSourceOperationResult(options.runtime,permit,slot.result);
      slot.persisted=true;
    })();
    await slot.work;
    // Delivery failure must not poison the settled work promise or force another execution on replay.
    if(!invalidated&&options.isCurrent())await emit(command.id,slot);
  }
  return {
    /** Local-only: the original completed fresh object retains runtime authority; cloned wire data does not. */
    readCompletedVerified(operationId:string,payloadDigest:string){
      current();const slot=slots.get(operationId);
      if(!slot?.persisted||slot.digest!==payloadDigest||slot.result?.outcome!=="verified"||slot.result.fresh.verification.outcome!=="passed")throw Error("Original completed verified source operation is unavailable");
      readCompletedProductSourceAdmission(options.runtime,slot.result.fresh);return slot.result;
    },
    async handle(input:ServerToNodeMessage):Promise<boolean>{
      if(!input.type.startsWith("product.source.operation."))return false;current();
      if(input.type==="product.source.operation.v1"){await start(productSourceOperationCommandSchema.parse(input));return true;}
      if(input.type==="product.source.operation.receipt.v1"){
        const receipt=productSourceOperationReceiptSchema.parse(input),slot=slots.get(receipt.payload.operation_id);
        if(!slot||slot.digest!==receipt.payload.payload_digest||!slot.result||sha(canonical(slot.result))!==receipt.result_digest
          ||receipt.payload.request_digest&&receipt.payload.request_digest!==slot.result.request_digest)throw Error("Operation receipt differs from original result");
        if(receipt.status==="accepted")slot.acknowledged=receipt.result_digest;return true;
      }
      const command=input.type==="product.source.operation.stop.v1"?productSourceOperationStopSchema.parse(input):productSourceOperationStatusSchema.parse(input);
      let slot=slots.get(command.payload.operation_id);
      if(slot&&(slot.digest!==command.payload.payload_digest||command.payload.request_digest&&slot.requestDigest&&command.payload.request_digest!==slot.requestDigest))throw Error("Operation control payload changed");
      if(input.type==="product.source.operation.status.v1"){
        if(!slot)throw Error("Original operation owner is unavailable; recovery required");await ack(command.id,command.payload.operation_id,slot.digest,"accepted");await slot.work;await emit(command.id,slot);return true;
      }
      if(!slot){
        // Stop-before-start is durable. Subsequent start stays fenced even after a node restart.
        const stopPermit=reserveProductSourceOperation(options.runtime,command.payload.operation_id,command.payload.payload_digest,"stop");
        slot={digest:command.payload.payload_digest,controller:new AbortController(),stopPermit};slots.set(command.payload.operation_id,slot);slot.controller.abort();
      }else slot.controller.abort();
      // Do not invent the transfer digest for legacy controls. New server stops
      // include it and become durable terminal facts without waiting for a start.
      if(command.payload.request_digest)cancelledBeforeStart(slot,command.payload.operation_id,command.payload.request_digest);
      await slot.work;
      await ack(command.id,command.payload.operation_id,slot.digest,"accepted");await emit(command.id,slot);return true;
    },
    invalidate(){invalidated=true;for(const slot of slots.values())slot.controller.abort();},
    async settled(){await Promise.all([...slots.values()].map(slot=>slot.work));},
  };
}
