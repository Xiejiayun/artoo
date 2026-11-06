import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {describe,it,expect} from "vitest";
import {ProductSourceHandoffIntentV1Schema,productSourceOperationDigestV1,inspectProductSourceOperationResultV1,ProductSourceOperationV1Schema} from "./product-source-operations.js";
import {canonicalProductSourceTransferValueV1 as canonical} from "./product-source-transfer.js";
const sha=(v:string|Uint8Array)=>`sha256:${createHash("sha256").update(v).digest("hex")}`;
const data=JSON.parse(readFileSync(new URL("../test-fixtures/product-source-operation.json",import.meta.url),"utf8"));
function fixture(){const intent=ProductSourceHandoffIntentV1Schema.parse({version:1,request:data.admission.request,next_task_id:"next-design",destination_start:data.admission.run_start});
  const operation=ProductSourceOperationV1Schema.parse({version:1,operation_id:"operation",kind:"import_verify",request_digest:data.fresh.request_digest,intent});
  const result={version:1,operation_id:operation.operation_id,payload_digest:productSourceOperationDigestV1(operation,sha),request_digest:operation.request_digest,
    outcome:"verified",closed:true,admission:structuredClone(data.admission),fresh:structuredClone(data.fresh)};
  return {operation,result,bytes:new TextEncoder().encode(data.research)};}
describe("operation contracts using recorded native data; no native execution",()=>{
  it("qualifies exact recorded complete v2 research result while keeping both authorities false",()=>{const f=fixture();expect(inspectProductSourceOperationResultV1(f.operation,f.result,f.bytes,sha)).toEqual(f.result);});
  for(const field of ["operation_id","payload_digest","request_digest"] as const)it(`rejects changed ${field}`,()=>{const f=fixture();f.result[field]=field==="operation_id"?"other":sha("other");expect(()=>inspectProductSourceOperationResultV1(f.operation,f.result,f.bytes,sha)).toThrow();});
  for(const [name,mutate] of [
    ["pending publication removed",(f:ReturnType<typeof fixture>)=>{f.result.fresh.verification.measurement_plan.pending_release=[];}],
    ["original provenance changed",(f:ReturnType<typeof fixture>)=>{f.result.admission.request.source_export.research_provenance.sources[0].origin.node_id="destination-node";}],
    ["verifier reports no checks",(f:ReturnType<typeof fixture>)=>{f.result.fresh.verification.checks=[];}],
    ["review authorization invented",(f:ReturnType<typeof fixture>)=>{f.result.fresh.automatic_review_authorized=true;}],
  ] as const)it(`rejects ${name}`,()=>{const f=fixture();mutate(f);expect(()=>inspectProductSourceOperationResultV1(f.operation,f.result,f.bytes,sha)).toThrow();});
  it("binds complete next verification context in the operation digest",()=>{const f=fixture(),old=productSourceOperationDigestV1(f.operation,sha);f.operation.intent.destination_start.verification!.request_id="different";expect(productSourceOperationDigestV1(f.operation,sha)).not.toBe(old);});
  it("rejects changed original research bytes",()=>{const f=fixture();expect(()=>inspectProductSourceOperationResultV1(f.operation,f.result,new TextEncoder().encode(data.research+" "),sha)).toThrow();});
});
