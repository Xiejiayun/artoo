import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {describe,it,expect,vi,beforeEach} from "vitest";
import {ProductSourceOperationV1Schema,productSourceOperationDigestV1,type ProductSourceTransferReceiptV1} from "@artoo/domain";
import type {ProductSourceOperationCommand,NodeToServerMessage} from "@artoo/protocol";
const mocks=vi.hoisted(()=>({reserve:vi.fn(()=>({})),persist:vi.fn(),import:vi.fn(),verify:vi.fn(),admission:vi.fn()}));
vi.mock("./product-source-runtime.js",()=>({reserveProductSourceOperation:mocks.reserve,persistProductSourceOperationResult:mocks.persist,
  importProductSourceSemanticTransfer:mocks.import,verifyProductSourceSemanticTransfer:mocks.verify,readCompletedProductSourceAdmission:mocks.admission}));
import {createProductSourceOperationClient} from "./product-source-operations.js";
const data=JSON.parse(readFileSync(new URL("../../../packages/domain/test-fixtures/product-source-operation.json",import.meta.url),"utf8"));
const sha=(v:string|Uint8Array)=>`sha256:${createHash("sha256").update(v).digest("hex")}`;
function fixture(){const payload=ProductSourceOperationV1Schema.parse({version:1,operation_id:"source-operation",kind:"upload",request_digest:data.fresh.request_digest,
  intent:{version:1,request:data.admission.request,next_task_id:"next-design",destination_start:data.admission.run_start}});
  const command:ProductSourceOperationCommand={kind:"command",id:"delivery",type:"product.source.operation.v1",idempotency_key:"operation:start",payload};
  const sent:NodeToServerMessage[]=[],receipt:ProductSourceTransferReceiptV1={version:1,transfer_id:payload.intent.request.byte_request.transfer_id,request_digest:payload.request_digest,
    capsule_digest:payload.intent.request.byte_request.source.capsule_digest,status:"available",execution_authorized:false};
  const transport={send:vi.fn(async(message:NodeToServerMessage)=>{sent.push(message);}),subscribe:()=>()=>{}};
  const upload=vi.fn(async(_runtime:unknown,_request:unknown,_signal?:AbortSignal)=>receipt),download=vi.fn(),client=createProductSourceOperationClient({nodeId:payload.intent.request.byte_request.source.node_id,runtime:{} as never,
    client:{upload,download},isCurrent:()=>true,transport});return {client,command,payload,upload,sent,transport};}
beforeEach(()=>{vi.clearAllMocks();});
describe("operation controller with explicitly mocked native ownership/transport",()=>{
  it("replays the persisted original result after result transport failure without another upload",async()=>{const f=fixture();let rejected=false;
    f.transport.send.mockImplementation(async message=>{if(message.kind==="product.source.operation.result.v1"&&!rejected){rejected=true;throw Error("lost result connection");}f.sent.push(message);});
    await expect(f.client.handle(f.command)).rejects.toThrow("lost result connection");await f.client.handle({...f.command,id:"new-delivery"});
    expect(f.upload).toHaveBeenCalledTimes(1);expect(mocks.persist).toHaveBeenCalledTimes(1);expect(f.sent.at(-1)).toMatchObject({kind:"product.source.operation.result.v1",command_id:"new-delivery"});});
  it("rejects an expired admission deadline before durable reservation",async()=>{const f=fixture();await expect(f.client.handle({...f.command,deadline_at:"2020-01-01T00:00:00Z"})).rejects.toThrow("deadline");
    expect(mocks.reserve).not.toHaveBeenCalled();expect(f.upload).not.toHaveBeenCalled();});
  it("reserves ownership before ACK, launches once, and replays the original result",async()=>{const f=fixture();await f.client.handle(f.command);await f.client.handle({...f.command,id:"replayed-delivery"});
    expect(mocks.reserve).toHaveBeenCalledTimes(1);expect(f.upload).toHaveBeenCalledTimes(1);expect(mocks.persist).toHaveBeenCalledTimes(1);
    expect(f.sent.filter(v=>v.kind==="product.source.operation.result.v1")).toHaveLength(2);expect(mocks.reserve.mock.invocationCallOrder[0]).toBeLessThan(f.upload.mock.invocationCallOrder[0]!);});
  it("rejects same operation ID with a changed full payload",async()=>{const f=fixture();await f.client.handle(f.command);const changed=structuredClone(f.command);changed.payload.intent.destination_start.verification!.request_id="different";
    await expect(f.client.handle(changed)).rejects.toThrow("another payload");expect(f.upload).toHaveBeenCalledTimes(1);});
  it("persists stop-before-start immediately and replays it for status and a later start",async()=>{const f=fixture();const binding={version:1 as const,operation_id:f.payload.operation_id,
    payload_digest:productSourceOperationDigestV1(f.payload,sha),request_digest:f.payload.request_digest};
    await f.client.handle({kind:"command",id:"stop",idempotency_key:"stop",type:"product.source.operation.stop.v1",payload:binding});
    expect(mocks.reserve).toHaveBeenCalledWith(expect.anything(),f.payload.operation_id,expect.any(String),"stop");expect(f.upload).not.toHaveBeenCalled();
    expect(mocks.persist).toHaveBeenCalledWith(expect.anything(),expect.anything(),expect.objectContaining({outcome:"cancelled_before_start",closed:true,request_digest:f.payload.request_digest}));
    expect(f.sent.at(-1)).toMatchObject({kind:"product.source.operation.result.v1",command_id:"stop",payload:{...binding,outcome:"cancelled_before_start",closed:true}});
    await f.client.handle({kind:"command",id:"status",idempotency_key:"status",type:"product.source.operation.status.v1",payload:binding});
    expect(f.sent.at(-1)).toMatchObject({kind:"product.source.operation.result.v1",command_id:"status",payload:{...binding,outcome:"cancelled_before_start",closed:true}});
    await f.client.handle(f.command);expect(mocks.reserve).toHaveBeenCalledTimes(1);expect(mocks.persist).toHaveBeenCalledTimes(1);expect(f.upload).not.toHaveBeenCalled();
    expect(f.sent.filter(message=>message.kind==="product.source.operation.result.v1")).toHaveLength(3);});
  it("keeps a legacy digest-less stop fenced until its matching start supplies the transfer binding",async()=>{const f=fixture();
    await f.client.handle({kind:"command",id:"stop",idempotency_key:"stop",type:"product.source.operation.stop.v1",
      payload:{version:1,operation_id:f.payload.operation_id,payload_digest:productSourceOperationDigestV1(f.payload,sha)}});
    expect(mocks.persist).not.toHaveBeenCalled();expect(f.upload).not.toHaveBeenCalled();
    await f.client.handle(f.command);expect(mocks.persist).toHaveBeenCalledTimes(1);expect(f.upload).not.toHaveBeenCalled();
    expect(f.sent.at(-1)).toMatchObject({kind:"product.source.operation.result.v1",payload:{outcome:"cancelled_before_start",closed:true,request_digest:f.payload.request_digest}});});
  it("rejects a changed transfer digest on controls after a stopped operation was bound",async()=>{const f=fixture();const binding={version:1 as const,operation_id:f.payload.operation_id,
    payload_digest:productSourceOperationDigestV1(f.payload,sha),request_digest:f.payload.request_digest};
    await f.client.handle({kind:"command",id:"stop",idempotency_key:"stop",type:"product.source.operation.stop.v1",payload:binding});
    await expect(f.client.handle({kind:"command",id:"changed-stop",idempotency_key:"changed-stop",type:"product.source.operation.stop.v1",
      payload:{...binding,request_digest:`sha256:${"f".repeat(64)}`}})).rejects.toThrow("control payload changed");
    expect(mocks.persist).toHaveBeenCalledTimes(1);expect(f.upload).not.toHaveBeenCalled();});
  it("fails closed if the protected owner cannot be recreated after restart",async()=>{const f=fixture();mocks.reserve.mockImplementationOnce(()=>{throw Error("EEXIST: retained owner requires recovery");});
    await expect(f.client.handle(f.command)).rejects.toThrow("retained owner");expect(f.upload).not.toHaveBeenCalled();expect(f.sent).toHaveLength(0);});
  it("invalidates new commands and aborts the exact active operation",async()=>{const f=fixture();let finish!:()=>void;
    f.upload.mockImplementationOnce((_runtime?:unknown,_request?:unknown,signal?:AbortSignal)=>new Promise<ProductSourceTransferReceiptV1>((_resolve,reject)=>{finish=()=>reject(Error("cancelled"));signal!.addEventListener("abort",finish,{once:true});}));
    const running=f.client.handle(f.command);await vi.waitFor(()=>expect(f.upload).toHaveBeenCalled());f.client.invalidate();await running;
    expect(mocks.persist).toHaveBeenCalledWith(expect.anything(),expect.anything(),expect.objectContaining({outcome:"uncertain",closed:false}));
    await expect(f.client.handle(f.command)).rejects.toThrow("invalidated");});
});
