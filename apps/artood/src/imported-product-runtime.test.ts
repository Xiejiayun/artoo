// Controlled code-installation boundary; native ACL qualification is tested separately.
vi.mock("./windows-code-installation.js", () => ({ prepareWindowsCodeInstallation: vi.fn(() => ({})), assertWindowsCodeInstallation: vi.fn() }));
// Direct runtime lifecycle over real temporary journals and original WeakMap authority.
// Import facts, preparation, verifier and adapter closure are controlled mocks; no subprocess/model/browser runs.
import {createHash} from "node:crypto";
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,realpathSync,lstatSync,existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,beforeEach,describe,it,expect,vi} from "vitest";
import {canonicalProductSourceTransferValueV1 as canonical,productSourceTransferRequestDigestV1,productSourceTransferRequestDigestV2,productSourceExportDigestV2,
  ProductResearchReportSchema,evaluateDeclaredMeasurementPlanV2,ProductSourceOperationV1Schema,productSourceOperationDigestV1,importedProductReviewSubjectV1,
  importedProductReviewRequestDigestV1,type ImportedProductReviewRequestV1,type ProductSourceOperationResultV1,type ReleaseCapabilitiesV1} from "@artoo/domain";
import type {PreparedVerificationProfile} from "./verification.js";
import type {PreparedReleaseProfile} from "./product-release.js";
import type {RuntimeAdapter,RunEvent} from "@artoo/protocol";
const control=vi.hoisted(()=>({verify:vi.fn(),select:vi.fn(),subject:vi.fn(),authenticated:vi.fn(),describe:vi.fn(),release:vi.fn(),
  closure:vi.fn(),protectedCommand:vi.fn(()=>{throw Error("Controlled lifecycle may not spawn a command");})}));
vi.mock("./verification.js",()=>({assertFinalVerificationExportBinding:vi.fn(),assertLocallyPreparedVerificationProfile:vi.fn(),assertLocallyPreparedVerificationProfiles:vi.fn(),prepareVerificationProfiles:vi.fn(value=>value),
  selectVerificationProfile:control.select,subjectManifest:control.subject,runTransferredResearchVerification:control.verify}));
vi.mock("./windows-release-storage.js",()=>({prepareWindowsReleaseStorage:vi.fn(()=>({})),assertWindowsReleaseStorage:vi.fn(),auditWindowsReleaseStorage:vi.fn()}));
vi.mock("./owned/windows-owned-process.js",()=>({assertWindowsProcessBackend:vi.fn()}));
vi.mock("./protected-command.js",()=>({runProtectedCommand:control.protectedCommand}));
vi.mock("./product-release.js",()=>({prepareReleaseCapabilityReader:()=>({capabilities:control.release(),readCapabilities:control.release}),
  prepareReleaseCapabilityReaders:(profiles:readonly object[])=>profiles.map(()=>({capabilities:control.release(),readCapabilities:control.release})),
  readReleaseCapabilitiesBatch:(profiles:readonly object[])=>profiles.map(()=>control.release())}));
vi.mock("./research.js",()=>({prepareResearchOptions:vi.fn(value=>value),readResearchReceipt:vi.fn()}));
vi.mock("./product-source-semantic-client.js",()=>({readAuthenticatedProductSourceTransferV2:control.authenticated}));
vi.mock("./product-source-snapshot.js",()=>({captureProductSourceSnapshot:vi.fn(()=>({})),decodeProductSourceSnapshot:vi.fn(),describeProductSourceSnapshot:control.describe,
  encodeProductSourceSnapshot:vi.fn(),materializeProductSourceSnapshot:vi.fn()}));
vi.mock("./process-adapter.js",()=>({assertWindowsVerifiedExecutionExportBinding:vi.fn(),bindWindowsVerifiedExecution:vi.fn(()=>({})),
  assertWindowsVerifiedExecutionClosed:control.closure,supportsWorkspaceReadOnlyTools:vi.fn(()=>true)}));
vi.mock("./workspace-readonly.js",()=>({bindWorkspaceReadOnlyTools:vi.fn()}));
vi.mock("./workspace-tools.js",()=>({bindWorkspaceToolCapabilities:vi.fn(),bindWorkspaceToolReleaseCapabilities:vi.fn()}));
import {prepareProductSourceRuntime,verifyProductSourceSemanticTransfer,readProductSourceVerificationAdmission,readCompletedProductSourceAdmission,
  reserveImportedProductReview,runImportedProductReview,persistImportedProductReviewResult,closeProductSourceRuntime} from "./product-source-runtime.js";

const sha=(value:string|Uint8Array)=>`sha256:${createHash("sha256").update(value).digest("hex")}`,hash=(value:unknown)=>sha(canonical(value));
const data=JSON.parse(readFileSync(new URL("../../../packages/domain/test-fixtures/product-source-operation.json",import.meta.url),"utf8"));
const platform=Object.getOwnPropertyDescriptor(process,"platform")!;
beforeEach(()=>{vi.clearAllMocks();Object.defineProperty(process,"platform",{...platform,value:"win32"});});
afterEach(()=>{Object.defineProperty(process,"platform",platform);});
function replaceStrings(value:any,oldRoot:string,newRoot:string):any{
  if(typeof value==="string")return value.replaceAll(oldRoot,newRoot);
  if(Array.isArray(value))return value.map(item=>replaceStrings(item,oldRoot,newRoot));
  if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,replaceStrings(item,oldRoot,newRoot)]));return value;
}
async function fixture(){
  const root=realpathSync.native(mkdtempSync(join(tmpdir(),"artoo-import-review-lifecycle-"))),workspace=join(root,"workspace"),store=join(root,"store"),programs=join(root,"programs");
  for(const folder of [workspace,store,programs])mkdirSync(folder);mkdirSync(join(workspace,".git"));mkdirSync(join(workspace,".artoo"));mkdirSync(join(workspace,".artoo/product"));
  writeFileSync(join(workspace,".artoo/product/research.json"),data.research);const git=join(programs,"git.exe");writeFileSync(git,"controlled trust file, never executed");
  const oldRoot=data.admission.request.byte_request.destination.workspace_root;
  const request=replaceStrings(structuredClone(data.admission.request),oldRoot,workspace);
  const start=replaceStrings(structuredClone(data.admission.run_start),oldRoot,workspace);
  const capsule=Buffer.from("controlled capsule fixture; snapshot validation is explicitly mocked"),capsuleDigest=sha(capsule);
  request.byte_request.source.capsule_digest=capsuleDigest;request.byte_request.source.capsule_bytes=capsule.length;
  request.source_export.byte_export.capsule_digest=capsuleDigest;request.source_export.byte_export.capsule_bytes=capsule.length;
  request.source_export.byte_export.export_id=hash({run_id:request.byte_request.source.run_id,request_id:request.byte_request.source.verification_request_id,capsule_digest:capsuleDigest});
  request.source_export_digest=productSourceExportDigestV2(request.source_export,sha);
  const capabilities=request.byte_request.destination.capabilities;
  const profile={id:request.byte_request.destination.profile_id,digest:capabilities.profile_digest,project_id:request.byte_request.project_id,workspace_root:workspace,
    capabilities,commands:[],required_files:[],subject_paths:[".artoo/product"],trustedFiles:[]} as unknown as PreparedVerificationProfile;
  const release=request.measurement_v2.destination_release as ReleaseCapabilitiesV1;
  const prepared={id:release.binding.release_profile_id,digest:release.binding.release_profile_digest,project_id:profile.project_id,verifier:profile} as PreparedReleaseProfile;
  control.release.mockReturnValue(release);control.select.mockReturnValue(profile);
  control.subject.mockReturnValue({digest:request.byte_request.source.subject_digest,files:new Map(),directories:[]});
  control.describe.mockReturnValue({manifest_digest:request.byte_request.source.manifest_digest});
  const runtime=prepareProductSourceRuntime({nodeId:request.byte_request.destination.node_id,storeRoot:store,allowedRoots:[workspace],profiles:[profile],gitExecutable:git,windowsBackend:{} as never,
    measurementV2:{version:1,releaseProfiles:[prepared],destinationResearchMappings:[{sourceProfileDigest:request.source_export.byte_export.profile_digest,destinationProfileId:profile.id,
      sourceRelease:request.source_export.measurement_v2.source_release,commandPairs:request.command_pairs}]}});
  const byteDigest=productSourceTransferRequestDigestV1(request.byte_request,sha),requestDigest=productSourceTransferRequestDigestV2(request,sha);
  const ready=replaceStrings(structuredClone(data.admission.ready),oldRoot,workspace);
  ready.request_digest=byteDigest;ready.capsule_digest=capsuleDigest;ready.git_metadata_digest=hash([{path:".git",kind:"directory"}]);
  const operation=join(store,"operations",sha(request.byte_request.transfer_id).slice(7));mkdirSync(operation);
  let previous:string|null=null;
  for(const [index,stage] of ["reserved","bytes_verified","git_initialized","materializing","ready"].entries()){
    const text=canonical({version:1,stage,request_digest:byteDigest,previous,details:stage==="reserved"?request.byte_request:stage==="ready"?ready:{controlled:true}});
    writeFileSync(join(operation,String(index).padStart(4,"0")+".json"),text);previous=sha(text);
  }
  const stat=lstatSync(workspace,{bigint:true});
  writeFileSync(join(store,"attestations","claim-"+sha(workspace).slice(7)+".json"),canonical({version:1,transfer_id:request.byte_request.transfer_id,request_digest:byteDigest,
    destination:{path:workspace,dev:String(stat.dev),ino:String(stat.ino),directory:true}}));
  writeFileSync(join(store,"artifacts",capsuleDigest.slice(7)+".json"),capsule);
  const authenticated={} as never;control.authenticated.mockReturnValue({nodeId:request.byte_request.destination.node_id,request,requestDigest,bytes:capsule});
  control.verify.mockImplementation(async(selected,requestId,_signal,context,subject,admission)=>{
    if(requestId==="after-request")throw Error("Controlled after-verifier process closure unconfirmed");
    const admitted=readProductSourceVerificationAdmission(admission,selected,requestId,context),research=ProductResearchReportSchema.parse(JSON.parse(data.research));
    const partition=evaluateDeclaredMeasurementPlanV2({research:{...research,measurement_plan:admitted.effective_plan},policy:capabilities.measurement_plan_policy,
      capabilities,releaseCapabilities:release,digest:sha});
    const {canonical_plan,...counts}=partition,verification=structuredClone(data.fresh.verification);
    Object.assign(verification,{request_id:requestId,profile_id:profile.id,profile_digest:profile.digest,subject_digest:subject});
    verification.measurement_plan={version:2,claim:"declared-mapping-feasibility",scope:"final",policy:capabilities.measurement_plan_policy,
      research:request.source_export.research_provenance.research,measurement_plan_digest:sha(canonical_plan),...counts};return verification;
  });
  const fresh=await verifyProductSourceSemanticTransfer(runtime,authenticated,start,new AbortController().signal);
  const imported=ProductSourceOperationV1Schema.parse({version:1,operation_id:"original-import",kind:"import_verify",request_digest:requestDigest,
    intent:{version:1,request,next_task_id:"next-design",destination_start:start}});
  const originalResult:ProductSourceOperationResultV1={version:1,operation_id:imported.operation_id,payload_digest:productSourceOperationDigestV1(imported,sha),request_digest:requestDigest,
    outcome:"verified",closed:true,admission:readCompletedProductSourceAdmission(runtime,fresh),fresh};
  const before=structuredClone(start),after=structuredClone(start),review=structuredClone(start);
  before.run_id="before-run";before.verification.request_id="before-request";after.run_id="after-run";after.verification.request_id="after-request";
  review.run_id="review-run";review.task_id="review-task";review.agent_instance_id="reviewer-instance";review.verification.request_id="review-request";
  review.policy_snapshot.filesystem_write_scope=[];review.context_pack.payload.task.id=review.task_id;delete review.context_pack.payload.product_development;
  review.context_pack.payload.policy={execution_mode:"discussion",filesystem_write_scope:[],requires_approval:[]};
  const subjectInput={review_id:"review",operation:imported,result:originalResult,source_author:{instance_id:"author-instance",agent_id:"author"},reviewer:{instance_id:"reviewer-instance",agent_id:"reviewer"}};
  review.context_pack.payload.imported_review_subject=importedProductReviewSubjectV1(subjectInput,sha);
  const reviewRequest:ImportedProductReviewRequestV1={version:1,...subjectInput,review_start:review,before_start:before,after_start:after};
  const verdict={version:1,review_id:"review",transfer_id:request.byte_request.transfer_id,subject_digest:ready.destination.subject_digest,source_export_digest:request.source_export_digest,
    outcome:"accepted",summary:"Controlled mocked reviewer; no model execution",findings:[]};
  const adapter:RuntimeAdapter={runtimeId:review.runtime,start:vi.fn(async()=>({runId:review.run_id})),stop:vi.fn(async()=>{}),collectArtifacts:async()=>[],
    async *streamEvents():AsyncIterable<RunEvent>{yield {type:"run.answer",payload:{text:JSON.stringify(verdict)}};yield {type:"run.lifecycle",payload:{phase:"completed",reason:null}};}};
  return {root,store,runtime,fresh,reviewRequest,adapter};
}
describe("direct imported-review lifecycle with controlled native facts",()=>{
  it("retains both uncertain post-verifier and review ownership despite a previously closed reviewer",async()=>{
    const f=await fixture(),permit=reserveImportedProductReview(f.runtime,f.reviewRequest.review_id,importedProductReviewRequestDigestV1(f.reviewRequest,sha),"start");
    const result=await runImportedProductReview(f.runtime,permit,f.fresh,f.reviewRequest,f.adapter,new AbortController().signal,()=>{});
    expect(result).toMatchObject({outcome:"uncertain",closed:false,reason:expect.stringContaining("after-verifier process closure unconfirmed")});
    expect(control.closure).toHaveBeenCalledTimes(1);expect(f.adapter.stop).not.toHaveBeenCalled();
    persistImportedProductReviewResult(f.runtime,permit,result);
    expect(()=>closeProductSourceRuntime(f.runtime)).toThrow("live or uncertain");
    expect(existsSync(join(f.store,"operations/owner.lock"))).toBe(true);expect(control.protectedCommand).not.toHaveBeenCalled();
    // Retain the simulated uncertain owner for inspection; no cleanup infers closure from a fixture timeout.
    console.info("Retained controlled imported-review lifecycle fixture:",f.root);
  });
});
