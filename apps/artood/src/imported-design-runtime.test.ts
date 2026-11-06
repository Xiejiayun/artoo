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
import type {RuntimeAdapter,RunEvent,RunEventMessage} from "@artoo/protocol";
const control=vi.hoisted(()=>({verify:vi.fn(),select:vi.fn(),subject:vi.fn(),authenticated:vi.fn(),describe:vi.fn(),release:vi.fn(),
  closure:vi.fn(),designVerify:vi.fn(),designPreview:vi.fn(),bind:vi.fn((..._args:any[])=>({})),preview:vi.fn(),protectedCommand:vi.fn(()=>{throw Error("Controlled lifecycle may not spawn a command");})}));
vi.mock("./verification.js",()=>({assertFinalVerificationExportBinding:vi.fn(),assertLocallyPreparedVerificationProfile:vi.fn(),prepareVerificationProfiles:vi.fn(value=>value),
  selectVerificationProfile:control.select,subjectManifest:control.subject,runTransferredResearchVerification:control.verify,runTransferredDesignVerification:control.designVerify,runTransferredDesignVerificationPreview:control.designPreview,assertImportedDesignVerificationProfile:vi.fn()}));
vi.mock("./windows-release-storage.js",()=>({prepareWindowsReleaseStorage:vi.fn(()=>({})),assertWindowsReleaseStorage:vi.fn(),auditWindowsReleaseStorage:vi.fn()}));
vi.mock("./owned/windows-owned-process.js",()=>({assertWindowsProcessBackend:vi.fn()}));
vi.mock("./protected-command.js",()=>({runProtectedCommand:control.protectedCommand}));
vi.mock("./product-release.js",()=>({createReleaseCapabilityReader:()=>control.release}));
vi.mock("./research.js",()=>({prepareResearchOptions:vi.fn(value=>value),readResearchReceipt:vi.fn()}));
vi.mock("./product-source-semantic-client.js",()=>({readAuthenticatedProductSourceTransferV2:control.authenticated}));
vi.mock("./product-source-snapshot.js",()=>({captureProductSourceSnapshot:vi.fn(()=>({})),decodeProductSourceSnapshot:vi.fn(),describeProductSourceSnapshot:control.describe,
  encodeProductSourceSnapshot:vi.fn(),materializeProductSourceSnapshot:vi.fn()}));
vi.mock("./process-adapter.js",()=>({assertWindowsVerifiedExecutionExportBinding:vi.fn(),bindWindowsVerifiedExecution:control.bind,
  assertWindowsVerifiedExecutionClosed:control.closure,supportsWorkspaceReadOnlyTools:vi.fn(()=>true)}));
vi.mock("./workspace-readonly.js",()=>({bindWorkspaceReadOnlyTools:vi.fn()}));
vi.mock("./workspace-tools.js",()=>({bindWorkspaceToolCapabilities:vi.fn(),bindWorkspaceToolReleaseCapabilities:vi.fn(),bindWorkspaceToolVerifier:control.preview}));
import {prepareProductSourceRuntime,verifyProductSourceSemanticTransfer,readProductSourceVerificationAdmission,readCompletedProductSourceAdmission,
  reserveImportedProductReview,runImportedProductReview,persistImportedProductReviewResult,closeProductSourceRuntime,
  readProductSourceRuntimeCapabilities,productSourceSemanticExportEnabled} from "./product-source-runtime.js";

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
it("derives destination-only semantic and policy-v2 roles from original prepared runtime state", async () => {
  const f = await fixture();
  expect(productSourceSemanticExportEnabled(f.runtime)).toBe(false);
  expect(readProductSourceRuntimeCapabilities(f.runtime)).toEqual({ semantic:true, measurementV2:true, importedReview:true, importedDesign:true });
  expect(() => readProductSourceRuntimeCapabilities(structuredClone(f.runtime))).toThrow(/original live local runtime/);
  control.release.mockReturnValue({});
  expect(() => readProductSourceRuntimeCapabilities(f.runtime)).toThrow(/release capability changed/);
});
async function fixture(){
  const root=realpathSync.native(mkdtempSync(join(tmpdir(),"artoo-import-design-lifecycle-"))),workspace=join(root,"workspace"),store=join(root,"store"),programs=join(root,"programs");
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
  return {root,workspace,store,runtime,fresh,reviewRequest,adapter,profile,request,release};
}

import { productDevelopmentContext, transferredProductInputV1, importedDesignContinuationRequestDigestV1,
  type ImportedDesignContinuationRequestV1 } from "@artoo/domain";
import { reserveImportedDesignContinuation, runImportedDesignContinuation, persistImportedDesignContinuationResult,
  readImportedDesignResearch, readImportedDesignVerificationAdmission, assertProductSourceWorkspaceBoundary } from "./product-source-runtime.js";

async function acceptedFixture() {
  const f = await fixture(), reviewPermit = reserveImportedProductReview(f.runtime, f.reviewRequest.review_id,
    importedProductReviewRequestDigestV1(f.reviewRequest, sha), "start");
  const original = await runImportedProductReview(f.runtime, reviewPermit, f.fresh, f.reviewRequest, f.adapter, new AbortController().signal, () => {});
  expect(original.outcome).toBe("reviewed"); persistImportedProductReviewResult(f.runtime, reviewPermit, original);
  const start = structuredClone(f.reviewRequest.operation.intent.destination_start), source = f.request.byte_request.source;
  start.run_id = "design-run"; start.task_id = f.reviewRequest.operation.intent.next_task_id; start.agent_instance_id = "design-instance";
  start.verification!.request_id = "design-verification"; delete start.verification!.expected_subject_digest;
  const context = start.context_pack.payload!;
  context.task.id = start.task_id; delete context.policy.execution_mode;
  context.policy.filesystem_write_scope = [f.workspace]; start.policy_snapshot.filesystem_write_scope = [f.workspace];
  context.product_development = productDevelopmentContext("design", context.verification_capabilities, context.release_capabilities);
  context.product_development.accepted_inputs = { version: 1, files: [{ ...f.request.source_export.research_provenance.research,
    source_task_id: source.task_id, source_run_id: source.run_id, evidence_id: source.evidence_id }] };
  const base = { continuation_id: "design", review_request: f.reviewRequest, review_result: original };
  context.transferred_product_input = transferredProductInputV1(base, sha);
  const design: ImportedDesignContinuationRequestV1 = { version: 1, ...base, writer: { agent_id: "design-agent", instance_id: start.agent_instance_id }, run_start: start as never };
  const controlBinding = { version: 1 as const, continuation_id: design.continuation_id,
    request_digest: importedDesignContinuationRequestDigestV1(design, sha), run_id: start.run_id };
  const permit = reserveImportedDesignContinuation(f.runtime, controlBinding, "start"), events: RunEventMessage["event"][] = [];
  const writer: RuntimeAdapter = { runtimeId: start.runtime, start: vi.fn(async () => ({ runId: start.run_id })), stop: vi.fn(async () => {}), collectArtifacts: async () => [],
    async *streamEvents() { yield { type: "run.lifecycle" as const, payload: { phase: "completed" as const, reason: null } }; } };
  control.designVerify.mockImplementation(async (profile, requestId, _signal, originalContext, admitted) => {
    const selected = readImportedDesignVerificationAdmission(admitted, profile, requestId, originalContext, "final");
    expect(selected.request.run_start.context_pack.payload).toBe(originalContext);
    const evidence = structuredClone(data.fresh.verification); evidence.request_id = requestId; evidence.subject_digest = sha("new design subject"); return evidence;
  });
  const emit = async (event: RunEventMessage["event"]) => { events.push(event); };
  const execute = (override: Partial<{ original: typeof original; request: typeof design; adapter: RuntimeAdapter; session: () => void; emit: typeof emit }> = {}) =>
    runImportedDesignContinuation(f.runtime, permit, override.original ?? original, override.request ?? design, override.adapter ?? writer,
      new AbortController().signal, override.session ?? (() => {}), override.emit ?? emit);
  control.closure.mockClear(); control.bind.mockClear(); control.preview.mockClear();
  return { ...f, original, design, permit, writer, events, execute, controlBinding };
}

describe("imported-design direct authority with controlled native facts and real journals", () => {
  it("uses original accepted H2 ownership, writes once, verifies the changed design and preserves import history", async () => {
    const f = await acceptedFixture(), result = await f.execute();
    expect(result).toMatchObject({ outcome: "finished", closed: true, run_id: f.design.run_start.run_id });
    expect(f.events.map(event => event.type)).toEqual(["run.verification", "run.lifecycle"]);
    expect(control.designVerify).toHaveBeenCalledTimes(1); expect(f.writer.start).toHaveBeenCalledTimes(1);
    persistImportedDesignContinuationResult(f.runtime, f.permit, result);
    expect(() => assertProductSourceWorkspaceBoundary(f.runtime, f.workspace)).toThrow("retained");
    closeProductSourceRuntime(f.runtime); expect(existsSync(join(f.store, "operations/owner.lock"))).toBe(false);
    expect(existsSync(join(f.store, "attestations", "claim-" + sha(f.workspace).slice(7) + ".json"))).toBe(true);
    expect(control.protectedCommand).not.toHaveBeenCalled();
  });
  it("rejects cloned completed research-review JSON without starting any writer", async () => {
    const f = await acceptedFixture(), result = await f.execute({ original: structuredClone(f.original) });
    expect(result).toMatchObject({ outcome: "failed", closed: true, reason: expect.stringContaining("Original accepted") });
    expect(f.events).toEqual([expect.objectContaining({ type: "run.lifecycle", payload: expect.objectContaining({ phase: "failed" }) })]);
    expect(f.writer.start).not.toHaveBeenCalled(); persistImportedDesignContinuationResult(f.runtime, f.permit, result); closeProductSourceRuntime(f.runtime);
  });
  it("rejects cloned opaque permits", async () => {
    const f = await acceptedFixture();
    await expect(runImportedDesignContinuation(f.runtime, { ...f.permit }, f.original, f.design, f.writer, new AbortController().signal, () => {}, async () => {})).rejects.toThrow("reservation");
    expect(f.writer.start).not.toHaveBeenCalled();
  });
  it("rejects changed initial subject before consuming the writer", async () => {
    const f = await acceptedFixture(); control.subject.mockReturnValue({ digest: sha("changed before start"), files: new Map(), directories: [] });
    const result = await f.execute(); expect(result).toMatchObject({ outcome: "failed", closed: true }); expect(f.writer.start).not.toHaveBeenCalled();
  });
  it("admits only the exact original context, root and research bytes while authoring", async () => {
    const f = await acceptedFixture();
    vi.mocked(f.writer.start).mockImplementationOnce(async config => {
      const context = config.runStart.context_pack.payload!, bytes = readFileSync(join(f.workspace, ".artoo/product/research.json"));
      const projected = readImportedDesignResearch(f.workspace, context, bytes);
      expect(projected.measurement_plan!.profile_digest).toBe(f.profile.digest);
      expect(() => readImportedDesignResearch(f.workspace, structuredClone(context), bytes)).toThrow("Original imported-design context");
      expect(() => readImportedDesignResearch(f.root, context, bytes)).toThrow("context, root or bytes");
      expect(() => readImportedDesignResearch(f.workspace, context, Buffer.from("changed"))).toThrow("context, root or bytes");
      expect(() => readImportedDesignVerificationAdmission(f.permit, f.profile, "design-verification", context, "final")).toThrow("exact registered invocation");
      return { runId: config.runId };
    });
    expect(await f.execute()).toMatchObject({ outcome: "finished", closed: true });
    const context = control.bind.mock.calls[0]![1].runStart.context_pack.payload;
    expect(() => readImportedDesignResearch(f.workspace, context, Buffer.from(data.research))).toThrow("Original imported-design context");
  });
  it("binds each preview to a fresh node request and refuses final-scope reuse", async () => {
    const f = await acceptedFixture();
    control.designPreview.mockImplementation(async (profile, requestId, _signal, context, permit) => {
      expect(requestId).toMatch(/^preview-/); expect(readImportedDesignVerificationAdmission(permit, profile, requestId, context, "preview").request.run_start).toBe(context === undefined ? undefined : control.bind.mock.calls[0]![1].runStart);
      expect(() => readImportedDesignVerificationAdmission(permit, profile, requestId, context, "final")).toThrow("exact registered");
      return { verification: data.fresh.verification, diagnostics: { version: 1, commands: [] } };
    });
    vi.mocked(f.writer.start).mockImplementationOnce(async config => {
      await control.preview.mock.calls[0]![1](new AbortController().signal); return { runId: config.runId };
    });
    expect(await f.execute()).toMatchObject({ outcome: "finished" }); expect(control.designPreview).toHaveBeenCalledTimes(1);
  });
  it("rejects adapter method mutation at the next admitted boundary", async () => {
    const f = await acceptedFixture();
    vi.mocked(f.writer.start).mockImplementationOnce(async config => {
      f.writer.stop = async () => {};
      expect(() => readImportedDesignResearch(f.workspace, config.runStart.context_pack.payload!, Buffer.from(data.research))).toThrow("configuration or durable history");
      return { runId: config.runId };
    });
    const result = await f.execute(); expect(result).toMatchObject({ outcome: "failed", closed: true }); expect(control.designVerify).not.toHaveBeenCalled();
  });
  it("retains unknown final-verifier closure without reusing old author closure", async () => {
    const f = await acceptedFixture(); control.designVerify.mockRejectedValueOnce(Error("Controlled final verifier closure unknown"));
    const result = await f.execute(); expect(result).toMatchObject({ outcome: "uncertain", closed: false });
    expect(control.closure).toHaveBeenCalledTimes(1); expect(f.writer.stop).not.toHaveBeenCalled();
    persistImportedDesignContinuationResult(f.runtime, f.permit, result); expect(() => closeProductSourceRuntime(f.runtime)).toThrow("live or uncertain");
    expect(existsSync(join(f.store, "operations/owner.lock"))).toBe(true);
  });
  it("retains ownership when an ordinary event commit fails even after process closure", async () => {
    const f = await acceptedFixture(), result = await f.execute({ emit: async () => { throw Error("Controlled commit unknown"); } });
    expect(result).toMatchObject({ outcome: "uncertain", closed: false }); persistImportedDesignContinuationResult(f.runtime, f.permit, result);
    expect(() => closeProductSourceRuntime(f.runtime)).toThrow("live or uncertain");
  });
  it("cannot persist a fabricated closed result or reuse a completed reservation", async () => {
    const f = await acceptedFixture();
    expect(() => persistImportedDesignContinuationResult(f.runtime, f.permit, { ...f.controlBinding, outcome: "failed", closed: true, reason: "fabricated" })).toThrow("Original completed");
    const result = await f.execute(); persistImportedDesignContinuationResult(f.runtime, f.permit, result);
    await expect(f.execute()).rejects.toThrow("reservation"); expect(f.writer.start).toHaveBeenCalledTimes(1);
  });
});
