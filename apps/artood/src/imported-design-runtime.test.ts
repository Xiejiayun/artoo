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
import type {RuntimeAdapter,RunEvent,RunEventMessage} from "@artoo/protocol";
import {createImportedDesignReviewEvidence} from "./imported-design-review-evidence.js";
const control=vi.hoisted(()=>({verify:vi.fn(),select:vi.fn(),subject:vi.fn(),authenticated:vi.fn(),describe:vi.fn(),release:vi.fn(),
  closure:vi.fn(),designVerify:vi.fn(),designPreview:vi.fn(),designReviewVerify:vi.fn(),executionVerify:vi.fn(),executionPreview:vi.fn(),
  implementationReviewVerify:vi.fn(),repairVerify:vi.fn(),repairPreview:vi.fn(),
  finalBinding:vi.fn(),bind:vi.fn((..._args:any[])=>({})),preview:vi.fn(),protectedCommand:vi.fn(()=>{throw Error("Controlled lifecycle may not spawn a command");})}));
vi.mock("./verification.js",()=>({assertFinalVerificationExportBinding:vi.fn(),assertLocallyPreparedVerificationProfile:vi.fn(),prepareVerificationProfiles:vi.fn(value=>value),
  selectVerificationProfile:control.select,subjectManifest:control.subject,runTransferredResearchVerification:control.verify,runTransferredDesignVerification:control.designVerify,runTransferredDesignVerificationPreview:control.designPreview,assertImportedDesignVerificationProfile:vi.fn(),
  assertImportedFinalVerificationBinding:control.finalBinding,runImportedDesignReviewVerification:control.designReviewVerify,
  runImportedExecutionVerification:control.executionVerify,runImportedExecutionVerificationPreview:control.executionPreview,
  runImportedExecutionReviewVerification:control.implementationReviewVerify,runImportedExecutionRepairVerification:control.repairVerify,
  runImportedExecutionRepairVerificationPreview:control.repairPreview,
  assertImportedExecutionVerificationProfile:(profile:any)=>{if(profile.capabilities.checks.some((check:any)=>check.contract.stage_policy.design!=="declared-cases"||check.contract.stage_policy.implementation!=="declared-cases"))throw Error("H5 requires all declared cases");},
  assertImportedValidationVerificationProfile:(profile:any)=>{if(profile.capabilities.checks.some((check:any)=>check.contract.version!==3||check.contract.stage_policy.design!=="declared-cases"||check.contract.stage_policy.implementation!=="declared-cases"||check.contract.stage_policy.validation!=="declared-cases"))throw Error("H7 requires all declared cases and native v3 validation");},
  importedDesignVerificationScope:(profile:any)=>profile.capabilities.checks.every((check:any)=>check.contract.stage_policy.design==="declared-cases")?"all-declared-workspace-design-cases":"prototype-only",
  assertImportedDesignReviewVerificationProfile:(profile:any)=>{if(profile.capabilities.checks.some((check:any)=>check.contract.stage_policy.design!=="declared-cases"))throw Error("H4 requires all declared cases");}}));
vi.mock("./windows-release-storage.js",()=>({prepareWindowsReleaseStorage:vi.fn(()=>({})),assertWindowsReleaseStorage:vi.fn(),auditWindowsReleaseStorage:vi.fn()}));
vi.mock("./owned/windows-owned-process.js",()=>({assertWindowsProcessBackend:vi.fn()}));
vi.mock("./protected-command.js",()=>({runProtectedCommand:control.protectedCommand}));
vi.mock("./product-release.js",()=>({prepareReleaseCapabilityReader:()=>({capabilities:control.release(),readCapabilities:control.release})}));
vi.mock("./research.js",()=>({prepareResearchOptions:vi.fn(value=>value),readResearchReceipt:vi.fn()}));
vi.mock("./product-source-semantic-client.js",()=>({readAuthenticatedProductSourceTransferV2:control.authenticated}));
vi.mock("./product-source-snapshot.js",()=>({captureProductSourceSnapshot:vi.fn(()=>({})),decodeProductSourceSnapshot:vi.fn(),describeProductSourceSnapshot:control.describe,
  encodeProductSourceSnapshot:vi.fn(),materializeProductSourceSnapshot:vi.fn()}));
vi.mock("./process-adapter.js",()=>({assertWindowsVerifiedExecutionExportBinding:vi.fn(),bindWindowsVerifiedExecution:control.bind,
  assertWindowsVerifiedExecutionClosed:control.closure,supportsWorkspaceReadOnlyTools:vi.fn(()=>true)}));
vi.mock("./workspace-readonly.js",()=>({bindWorkspaceReadOnlyTools:vi.fn()}));
vi.mock("./workspace-tools.js",()=>({bindWorkspaceToolCapabilities:vi.fn(),bindWorkspaceToolReleaseCapabilities:vi.fn(),bindWorkspaceToolVerifier:control.preview,bindWorkspaceToolEvidenceReader:vi.fn()}));
vi.mock("./imported-design-review-evidence.js",()=>({createImportedDesignReviewEvidence:vi.fn((_profile,receipt,expected,assertCurrent)=>{
  assertCurrent();expect(receipt.request_id).toBe(expected.requestId);expect(receipt.subject_digest).toBe(expected.subjectDigest);
  return {read:async()=>{assertCurrent();throw Error("Controlled runtime fixture has no browser evidence bytes");},
    readEvidenceIndex:()=>({version:1,bundles:[{reference:"controlled_bundle",request_id:receipt.request_id,check_id:"controlled",scope:"final"}]})};
})}));
import {prepareProductSourceRuntime,verifyProductSourceSemanticTransfer,readProductSourceVerificationAdmission,readCompletedProductSourceAdmission,
  reserveImportedProductReview,runImportedProductReview,persistImportedProductReviewResult,closeProductSourceRuntime,
  readProductSourceRuntimeCapabilities,productSourceSemanticExportEnabled} from "./product-source-runtime.js";
vi.mock("./imported-implementation-review-evidence.js", () => ({ createImportedImplementationReviewEvidence: vi.fn((_profile, receipt, expected, assertCurrent) => {
  assertCurrent(); expect(receipt.request_id).toBe(expected.requestId); expect(receipt.subject_digest).toBe(expected.subjectDigest);
  return { read: async () => { assertCurrent(); throw Error("Controlled runtime fixture has no browser evidence bytes"); },
    readEvidenceIndex: () => ({ version: 1, bundles: [{ reference: "controlled_implementation_bundle", request_id: receipt.request_id, check_id: "controlled", scope: "final" }] }) };
}) }));

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
  expect(readProductSourceRuntimeCapabilities(f.runtime)).toEqual({ semantic:true, researchRevision:false, measurementV2:true, importedReview:true, importedDesign:true, importedDesignReview:false, importedExecution:false, importedValidation:false });
  expect(() => readProductSourceRuntimeCapabilities(structuredClone(f.runtime))).toThrow(/original live local runtime/);
  control.release.mockReturnValue({});
  expect(() => readProductSourceRuntimeCapabilities(f.runtime)).toThrow(/release capability changed/);
});
async function fixture(recordedInput = data){
  const data = recordedInput;
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
import { importedAllCaseRecordFixture, controlledDesignVerification, h4RequestForCompletedFixture } from "./test-fixtures/imported-design-review-request.js";
import { readCompletedVerifiedImportedDesign, reserveImportedDesignReview, runImportedDesignReview, persistImportedDesignReviewResult,
  readImportedDesignReviewVerificationAdmission } from "./product-source-runtime.js";
import { importedDesignReviewRequestDigestV1, importedDesignReviewSubjectV1, type ImportedDesignReviewResultV1 } from "@artoo/domain";
import { h5RequestForH4Fixture, controlledPinnedDesignVerification, controlledImplementationVerification } from "./test-fixtures/imported-execution-request.js";
import { importedExecutionRequestDigestV1 } from "@artoo/domain";
import { readCompletedAcceptedImportedDesignReview, reserveImportedExecution, runImportedExecution, persistImportedExecutionResult,
  readImportedExecutionResearch, readImportedExecutionVerificationAdmission } from "./product-source-runtime.js";

async function acceptedFixture(allCases = false) {
  const f = await fixture(allCases ? importedAllCaseRecordFixture() : data), reviewPermit = reserveImportedProductReview(f.runtime, f.reviewRequest.review_id,
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
    const evidence = controlledDesignVerification(design); evidence.request_id = requestId;
    control.subject.mockReturnValue({digest:evidence.subject_digest,files:new Map(),directories:[]}); return evidence;
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

async function h4Fixture(pinnedDesign = false) {
  const f = await acceptedFixture(true);
  if (pinnedDesign) {
    const pinned = controlledPinnedDesignVerification(f.design, readFileSync(join(f.workspace, ".artoo/product/research.json")));
    writeFileSync(join(f.workspace, ".artoo/product/design.json"), pinned.designBytes);
    control.designVerify.mockImplementation(async (profile, requestId, _signal, context, permit) => {
      readImportedDesignVerificationAdmission(permit, profile, requestId, context, "final");
      control.subject.mockReturnValue({ digest: pinned.verification.subject_digest, files: new Map(), directories: [] });
      return pinned.verification;
    });
  }
  const completion = await f.execute();
  expect(completion.outcome).toBe("finished");
  expect(() => readCompletedVerifiedImportedDesign(f.runtime, completion)).toThrow("persisted");
  persistImportedDesignContinuationResult(f.runtime, f.permit, completion);
  const request = h4RequestForCompletedFixture(f.design, completion);
  const binding = { version: 1 as const, review_id: request.review_id, request_digest: importedDesignReviewRequestDigestV1(request, sha) };
  const permit = reserveImportedDesignReview(f.runtime, binding, "start"), subject = importedDesignReviewSubjectV1(request, sha);
  const verdict = { version: 1, review_id: request.review_id, continuation_id: request.continuation_request.continuation_id,
    completed_design_digest: subject.completed_design_digest, subject_digest: subject.subject_digest,
    outcome: "accepted", summary: "Controlled H4 reviewer; no model/native process", findings: [] };
  const reviewer: RuntimeAdapter = { runtimeId: request.review_start.runtime, start: vi.fn(async () => ({ runId: request.review_start.run_id })),
    stop: vi.fn(async () => {}), collectArtifacts: async () => [], async *streamEvents() {
      yield { type: "run.answer", payload: { text: JSON.stringify(verdict) } };
      yield { type: "run.lifecycle", payload: { phase: "completed", reason: null } };
    } };
  control.designReviewVerify.mockImplementation(async (profile, requestId, _signal, context, owner, phase) => {
    const admitted = readImportedDesignReviewVerificationAdmission(owner, profile, requestId, context, phase);
    expect(admitted.start.context_pack.payload).toBe(context);
    expect(() => readImportedDesignReviewVerificationAdmission(owner, profile, requestId, structuredClone(context), phase)).toThrow("phase-specific");
    expect(readImportedDesignResearch(f.workspace, context, readFileSync(join(f.workspace, ".artoo/product/research.json"))).measurement_plan!.profile_digest).toBe(profile.digest);
    if (completion.outcome !== "finished" || !completion.verified_design) throw Error("fixture completion");
    return { ...structuredClone(completion.verified_design.verification), request_id: requestId };
  });
  let live = true; const current = () => { if (!live) throw Error("controlled current session invalidated"); };
  const abort = new AbortController();
  const execute = () => runImportedDesignReview(f.runtime, permit, completion, request, reviewer, abort.signal, current);
  control.closure.mockClear(); control.finalBinding.mockClear();
  return { ...f, completion, request, binding, permitH4: permit, reviewer, abort, verdict, executeH4: execute, invalidate: () => { live = false; } };
}

async function h5Fixture() {
  const f = await h4Fixture(true), acceptedH4 = await f.executeH4();
  expect(acceptedH4).toMatchObject({ outcome: "reviewed", verdict: { outcome: "accepted" } });
  expect(() => readCompletedAcceptedImportedDesignReview(f.runtime, acceptedH4)).toThrow(/persisted|Original/i);
  persistImportedDesignReviewResult(f.runtime, f.permitH4, acceptedH4);
  expect(readCompletedAcceptedImportedDesignReview(f.runtime, acceptedH4)).toEqual(f.request);
  const requestH5 = h5RequestForH4Fixture(f.request, acceptedH4), controlH5 = { version: 1 as const, execution_id: requestH5.execution_id,
    request_digest: importedExecutionRequestDigestV1(requestH5, sha), run_id: requestH5.run_start.run_id };
  const permitH5 = reserveImportedExecution(f.runtime, controlH5, "start"), eventsH5: RunEventMessage["event"][] = [], abortH5 = new AbortController();
  const writerH5: RuntimeAdapter = { runtimeId: requestH5.run_start.runtime, start: vi.fn(async config => {
    expect(existsSync(join(f.store, "attestations", "imported-execution-owner-" + sha(f.workspace).slice(7) + ".json"))).toBe(true);
    mkdirSync(join(f.workspace, "product"), { recursive: true }); writeFileSync(join(f.workspace, "product/index.html"), "controlled implementation");
    writeFileSync(join(f.workspace, ".artoo/product/implementation.md"), "controlled implementation");
    control.subject.mockReturnValue({ digest: sha("controlled implementation subject"), files: new Map(), directories: [] });
    return { runId: config.runId };
  }), stop: vi.fn(async () => {}), collectArtifacts: async () => [], async *streamEvents() {
    yield { type: "run.lifecycle", payload: { phase: "completed", reason: null } };
  } };
  control.executionVerify.mockImplementation(async (profile, requestId, _signal, context, permit) => {
    const admitted = readImportedExecutionVerificationAdmission(permit, profile, requestId, context, "final");
    expect(admitted.request.run_start.context_pack.payload).toBe(context);
    expect(() => readImportedExecutionVerificationAdmission(permit, profile, requestId, structuredClone(context), "final")).toThrow("exact registered");
    return controlledImplementationVerification(requestH5);
  });
  const emitH5 = async (event: RunEventMessage["event"]) => { eventsH5.push(event); };
  const executeH5 = (overrides: Partial<{ original: typeof acceptedH4; emit: typeof emitH5; session: () => void }> = {}) =>
    runImportedExecution(f.runtime, permitH5, overrides.original ?? acceptedH4, requestH5, writerH5, abortH5.signal, overrides.session ?? (() => {}), overrides.emit ?? emitH5);
  control.closure.mockClear(); control.bind.mockClear(); control.preview.mockClear(); control.finalBinding.mockClear();
  return { ...f, acceptedH4, requestH5, controlH5, permitH5, writerH5, eventsH5, abortH5, executeH5 };
}

describe("H5 original runtime authority with controlled native facts and real append-only journals", () => {
  it("consumes accepted original H4 once, retains pinned inputs and commits fresh final implementation before completion", async () => {
    const f = await h5Fixture(), result = await f.executeH5();
    expect(result).toMatchObject({ outcome: "finished", closed: true, verified_execution: { stage: "implementation", scope: "all-declared-workspace-implementation-cases" } });
    expect(f.writerH5.start).toHaveBeenCalledTimes(1); expect(control.executionVerify).toHaveBeenCalledTimes(1);
    expect(f.eventsH5.map(event => event.type)).toEqual(["run.verification", "run.lifecycle"]);
    expect(f.eventsH5.at(-1)).toMatchObject({ payload: { phase: "completed" } });
    expect(() => readCompletedAcceptedImportedDesignReview(f.runtime, f.acceptedH4)).toThrow();
    expect(() => persistImportedExecutionResult(f.runtime, f.permitH5, structuredClone(result))).toThrow("Original H5 author result");
    persistImportedExecutionResult(f.runtime, f.permitH5, result);
    await expect(f.executeH5()).rejects.toThrow("unused H5 reservation");
    expect(() => assertProductSourceWorkspaceBoundary(f.runtime, f.workspace)).toThrow("retained");
    closeProductSourceRuntime(f.runtime); expect(control.protectedCommand).not.toHaveBeenCalled();
  });
  it("rejects cloned H4 facts without starting an implementation author", async () => {
    const f = await h5Fixture(), result = await f.executeH5({ original: structuredClone(f.acceptedH4) });
    expect(result).toMatchObject({ outcome: "failed", closed: true }); expect(f.writerH5.start).not.toHaveBeenCalled();
    persistImportedExecutionResult(f.runtime, f.permitH5, result); closeProductSourceRuntime(f.runtime);
  });
  it.each(["research", "design", "history", "initial-subject"])("rejects changed %s before native admission", async change => {
    const f = await h5Fixture();
    if (change === "research" || change === "design") writeFileSync(join(f.workspace, `.artoo/product/${change}.json`), "{}");
    if (change === "history") writeFileSync(join(f.store, "attestations", "imported-design-review-result-" + sha(f.request.review_id).slice(7) + ".json"), "{}");
    if (change === "initial-subject") control.subject.mockReturnValue({ digest: sha("unexpected subject"), files: new Map(), directories: [] });
    expect(await f.executeH5()).toMatchObject({ outcome: "failed", closed: true });
    expect(f.writerH5.start).not.toHaveBeenCalled(); expect(control.executionVerify).not.toHaveBeenCalled();
  });
  it("allows product writes while rejecting changed pins, cloned contexts and unregistered final invocations", async () => {
    const f = await h5Fixture(), start = vi.mocked(f.writerH5.start).getMockImplementation()!;
    vi.mocked(f.writerH5.start).mockImplementationOnce(async config => {
      const handle = await start(config), context = config.runStart.context_pack.payload!, bytes = readFileSync(join(f.workspace, ".artoo/product/research.json"));
      expect(readImportedExecutionResearch(f.workspace, context, bytes).measurement_plan!.profile_digest).toBe(f.profile.digest);
      expect(() => readImportedExecutionResearch(f.workspace, structuredClone(context), bytes)).toThrow("Original H5 context");
      expect(() => readImportedExecutionVerificationAdmission(f.permitH5, f.profile, f.requestH5.run_start.verification!.request_id, context, "final")).toThrow("exact registered");
      expect(() => readCompletedAcceptedImportedDesignReview(f.runtime, f.acceptedH4)).toThrow();
      return handle;
    });
    expect(await f.executeH5()).toMatchObject({ outcome: "finished", verified_execution: expect.anything() });
  });
  it.each(["research", "design", "adapter", "history"])("rejects %s mutation during the admitted author", async change => {
    const f = await h5Fixture(), start = vi.mocked(f.writerH5.start).getMockImplementation()!;
    vi.mocked(f.writerH5.start).mockImplementationOnce(async config => {
      const handle = await start(config);
      if (change === "research" || change === "design") writeFileSync(join(f.workspace, `.artoo/product/${change}.json`), "{}");
      if (change === "adapter") f.writerH5.stop = async () => {};
      if (change === "history") writeFileSync(join(f.store, "attestations", "imported-design-review-result-" + sha(f.request.review_id).slice(7) + ".json"), "{}");
      return handle;
    });
    expect(await f.executeH5()).toMatchObject({ outcome: "failed", closed: true }); expect(control.executionVerify).not.toHaveBeenCalled();
  });
  it("binds preview to a new invocation and refuses to reuse it as final verification", async () => {
    const f = await h5Fixture(), start = vi.mocked(f.writerH5.start).getMockImplementation()!;
    control.executionPreview.mockImplementation(async (profile, requestId, _signal, context, permit) => {
      expect(requestId).toMatch(/^preview-/); readImportedExecutionVerificationAdmission(permit, profile, requestId, context, "preview");
      expect(() => readImportedExecutionVerificationAdmission(permit, profile, requestId, context, "final")).toThrow("exact registered");
      return { verification: controlledImplementationVerification(f.requestH5), diagnostics: { version: 1, commands: [] } };
    });
    vi.mocked(f.writerH5.start).mockImplementationOnce(async config => {
      const handle = await start(config); await control.preview.mock.calls[0]![1](new AbortController().signal); return handle;
    });
    expect(await f.executeH5()).toMatchObject({ outcome: "finished", verified_execution: expect.anything() });
    expect(control.executionPreview).toHaveBeenCalledTimes(1); expect(control.executionVerify).toHaveBeenCalledTimes(1);
  });
  it("keeps closed failed verification out of completed lifecycle and review readiness", async () => {
    const f = await h5Fixture(); control.executionVerify.mockResolvedValueOnce({ ...controlledImplementationVerification(f.requestH5), outcome: "failed", checks: [], reason: "controlled failure" });
    const result = await f.executeH5(); expect(result).toMatchObject({ outcome: "finished", closed: true }); expect(result).not.toHaveProperty("verified_execution");
    expect(f.eventsH5.at(-1)).toMatchObject({ payload: { phase: "failed" } });
    persistImportedExecutionResult(f.runtime, f.permitH5, result); closeProductSourceRuntime(f.runtime);
  });
  it("retains unknown final verifier closure separately from the original author", async () => {
    const f = await h5Fixture(); control.executionVerify.mockRejectedValueOnce(Error("controlled unknown verifier closure"));
    const result = await f.executeH5(); expect(result).toMatchObject({ outcome: "uncertain", closed: false });
    expect(control.closure).toHaveBeenCalledTimes(1); expect(f.writerH5.stop).not.toHaveBeenCalled();
    persistImportedExecutionResult(f.runtime, f.permitH5, result); expect(() => closeProductSourceRuntime(f.runtime)).toThrow("live or uncertain");
  });
  it("retains ownership when committed ordinary event delivery is uncertain", async () => {
    const f = await h5Fixture(), result = await f.executeH5({ emit: async () => { throw Error("controlled receipt unavailable"); } });
    expect(result).toMatchObject({ outcome: "uncertain", closed: false });
    persistImportedExecutionResult(f.runtime, f.permitH5, result); expect(() => closeProductSourceRuntime(f.runtime)).toThrow("live or uncertain");
  });
  it.each(["research", "design", "subject", "history", "session"])("rejects %s drift while the terminal event awaits its committed receipt", async change => {
    const f = await h5Fixture(); let current = true;
    const result = await f.executeH5({ session: () => { if (!current) throw Error("controlled H5 session ended during receipt"); },
      emit: async event => {
        f.eventsH5.push(event);
        if (event.type !== "run.lifecycle" || event.payload.phase !== "completed") return;
        if (change === "research" || change === "design") writeFileSync(join(f.workspace, `.artoo/product/${change}.json`), "{}");
        if (change === "subject") control.subject.mockReturnValue({ digest: sha("changed during terminal receipt"), files: new Map(), directories: [] });
        if (change === "history") writeFileSync(join(f.store, "attestations", "imported-design-review-result-" + sha(f.request.review_id).slice(7) + ".json"), "{}");
        if (change === "session") current = false;
      } });
    expect(result.outcome).not.toBe("finished"); expect(result).not.toHaveProperty("verified_execution");
    expect(f.writerH5.start).toHaveBeenCalledTimes(1); expect(control.executionVerify).toHaveBeenCalledTimes(1);
  });
});
describe("H4 original completion and per-phase closure with controlled native/verifier facts", () => {
  for (const phase of ["failed", "cancelled"] as const) it(`does not mint completion authority from a closed H3 ${phase} lifecycle`, async () => {
    const f = await acceptedFixture(true);
    f.writer.streamEvents = async function* () { yield { type: "run.lifecycle", payload: { phase, reason: "controlled author terminal" } }; };
    const result = await f.execute(); expect(result).toMatchObject({ outcome: "finished", closed: true });
    expect(result).not.toHaveProperty("verified_design"); expect(control.designVerify).not.toHaveBeenCalled();
    persistImportedDesignContinuationResult(f.runtime, f.permit, result);
    expect(() => readCompletedVerifiedImportedDesign(f.runtime, result)).toThrow("Original persisted"); closeProductSourceRuntime(f.runtime);
  });
  it("does not mint completion authority from a closed H3 whose final verifier failed", async () => {
    const f = await acceptedFixture(true);
    control.designVerify.mockResolvedValueOnce({ ...controlledDesignVerification(f.design), outcome: "failed", reason: "controlled failed final verification" });
    const result = await f.execute(); expect(result).toMatchObject({ outcome: "finished", closed: true }); expect(result).not.toHaveProperty("verified_design");
    persistImportedDesignContinuationResult(f.runtime, f.permit, result);
    expect(() => readCompletedVerifiedImportedDesign(f.runtime, result)).toThrow("Original persisted"); closeProductSourceRuntime(f.runtime);
  });
  it("consumes original persisted H3 once, measures both phases and leaves imported writer fences intact", async () => {
    const f = await h4Fixture(), result = await f.executeH4();
    expect(result).toMatchObject({ outcome: "reviewed", closed: true, execution_authorized: false, verdict: { outcome: "accepted" } });
    expect(control.designReviewVerify.mock.calls.map(call => call[5])).toEqual(["before", "after"]);
    const evidenceCall=vi.mocked(createImportedDesignReviewEvidence).mock.calls.at(-1)!;
    expect(evidenceCall[1].request_id).toBe(f.request.before_start.verification!.request_id);
    expect(()=>evidenceCall[3]()).toThrow("active H4");
    expect(f.reviewer.start).toHaveBeenCalledTimes(1); expect(control.closure).toHaveBeenCalledTimes(1);
    expect(() => persistImportedDesignReviewResult(f.runtime, f.permitH4, structuredClone(result))).toThrow("Original locally closed");
    persistImportedDesignReviewResult(f.runtime, f.permitH4, result);
    expect(() => assertProductSourceWorkspaceBoundary(f.runtime, f.workspace)).toThrow("retained");
    expect(() => readImportedDesignVerificationAdmission(f.permit, f.profile, f.design.run_start.verification!.request_id, f.design.run_start.context_pack.payload, "final")).toThrow("active imported-design");
    await expect(f.executeH4()).rejects.toThrow("reservation");
    closeProductSourceRuntime(f.runtime); expect(control.protectedCommand).not.toHaveBeenCalled();
  });
  it("rejects cloned completed design data and cloned H4 permits", async () => {
    const f = await h4Fixture();
    expect(() => readCompletedVerifiedImportedDesign(f.runtime, structuredClone(f.completion))).toThrow("Original persisted");
    await expect(runImportedDesignReview(f.runtime, f.permitH4, structuredClone(f.completion), f.request, f.reviewer, f.abort.signal, () => {})).rejects.toThrow("Original persisted");
    await expect(runImportedDesignReview(f.runtime, { ...f.permitH4 }, f.completion, f.request, f.reviewer, f.abort.signal, () => {})).rejects.toThrow("reservation");
    expect(f.reviewer.start).not.toHaveBeenCalled(); expect(control.designReviewVerify).not.toHaveBeenCalled();
  });
  for (const change of ["source", "research", "history", "profile"] as const) it(`rejects changed ${change} before H4 subprocess admission`, async () => {
    const f = await h4Fixture();
    if (change === "source") control.subject.mockReturnValue({ digest: sha("changed source"), files: new Map(), directories: [] });
    if (change === "research") writeFileSync(join(f.workspace, ".artoo/product/research.json"), "{}");
    if (change === "history") writeFileSync(join(f.store, "attestations", "imported-design-result-" + sha(f.design.continuation_id).slice(7) + ".json"), "{}");
    if (change === "profile") (f.profile.capabilities!.checks[0]!.contract as any).stage_policy.design = "prototype-only";
    await expect(f.executeH4()).rejects.toThrow(); expect(f.reviewer.start).not.toHaveBeenCalled(); expect(control.designReviewVerify).not.toHaveBeenCalled();
  });
  it("rejects a prototype-only completed H3 even when all-case scope is asserted remotely", async () => {
    const f = await acceptedFixture(), completion = await f.execute(); persistImportedDesignContinuationResult(f.runtime, f.permit, completion);
    expect(readCompletedVerifiedImportedDesign(f.runtime, completion).provenance.scope).toBe("prototype-only");
    if (completion.outcome !== "finished" || !completion.verified_design) throw Error("fixture");
    const changed = structuredClone(completion); if (changed.outcome !== "finished" || !changed.verified_design) throw Error("fixture");
    changed.verified_design.scope = "all-declared-workspace-design-cases";
    expect(() => readCompletedVerifiedImportedDesign(f.runtime, changed)).toThrow("Original persisted");
  });
  for (const phase of ["before", "after"] as const) {
    it(`keeps ${phase} verifier uncertainty separate from reviewer closure`, async () => {
      const f = await h4Fixture(), real = control.designReviewVerify.getMockImplementation()!;
      control.designReviewVerify.mockImplementation(async (...args) => { if (args[5] === phase) throw Error("controlled verifier closure unknown"); return real(...args); });
      const result = await f.executeH4(); expect(result).toMatchObject({ outcome: "uncertain", closed: false });
      expect(control.closure).toHaveBeenCalledTimes(phase === "before" ? 0 : 1); expect(f.reviewer.stop).not.toHaveBeenCalled();
      persistImportedDesignReviewResult(f.runtime, f.permitH4, result); expect(() => closeProductSourceRuntime(f.runtime)).toThrow("live or uncertain");
    });
    it(`records closed ${phase} verification failure without accepted H4 evidence`, async () => {
      const f = await h4Fixture(), real = control.designReviewVerify.getMockImplementation()!;
      control.designReviewVerify.mockImplementation(async (...args) => args[5] === phase ? { ...(await real(...args)), outcome: "failed", checks: [], reason: "controlled closed failure" } : real(...args));
      const result = await f.executeH4(); expect(result).toMatchObject({ outcome: "failed", closed: true });
      expect(f.reviewer.start).toHaveBeenCalledTimes(phase === "before" ? 0 : 1);
      persistImportedDesignReviewResult(f.runtime, f.permitH4, result); closeProductSourceRuntime(f.runtime);
    });
  }
  it("does not start the after verifier when the native reviewer closure is unknown", async () => {
    const f = await h4Fixture(); control.closure.mockImplementation(() => { throw Error("controlled reviewer Job closure unknown"); });
    try {
      const result = await f.executeH4(); expect(result).toMatchObject({ outcome: "uncertain", closed: false });
      expect(control.designReviewVerify.mock.calls.map(call => call[5])).toEqual(["before"]); expect(f.reviewer.stop).toHaveBeenCalledTimes(1);
      persistImportedDesignReviewResult(f.runtime, f.permitH4, result); expect(() => closeProductSourceRuntime(f.runtime)).toThrow("live or uncertain");
    } finally { control.closure.mockReset(); }
  });
  it("rechecks current session after reviewer closure before the after verifier", async () => {
    const f = await h4Fixture(); f.reviewer.streamEvents = async function* () { f.invalidate(); yield { type: "run.answer", payload: { text: JSON.stringify(f.verdict) } };
      yield { type: "run.lifecycle", payload: { phase: "completed", reason: null } }; };
    const result = await f.executeH4(); expect(result).toMatchObject({ outcome: "failed", closed: true });
    expect(control.designReviewVerify.mock.calls.map(call => call[5])).toEqual(["before"]);
  });
  it("rejects accepted blocking findings", async () => {
    const f = await h4Fixture(); f.verdict.findings.push({ severity: "blocking", description: "Unimplemented design requirement" } as never);
    const result = await f.executeH4(); expect(result).toMatchObject({ outcome: "failed", closed: true });
    expect(control.designReviewVerify.mock.calls.map(call => call[5])).toEqual(["before"]);
  });
  it("cancellation after reviewer closure cannot start the final verifier or mint accepted evidence", async () => {
    const f = await h4Fixture();
    f.reviewer.streamEvents = async function* () { f.abort.abort(); yield { type: "run.answer", payload: { text: JSON.stringify(f.verdict) } };
      yield { type: "run.lifecycle", payload: { phase: "completed", reason: null } }; };
    const result = await f.executeH4(); expect(result).toMatchObject({ outcome: "failed", closed: true });
    expect(control.designReviewVerify.mock.calls.map(call => call[5])).toEqual(["before"]);
    persistImportedDesignReviewResult(f.runtime, f.permitH4, result); closeProductSourceRuntime(f.runtime);
  });
  it("persists a separate stop tombstone without calling H3 or a reviewer", async () => {
    const f = await fixture();
    const controlBinding = { version: 1 as const, review_id: "stop-h4", request_digest: sha("request") };
    const permit = reserveImportedDesignReview(f.runtime, controlBinding, "stop");
    const result: ImportedDesignReviewResultV1 = { ...controlBinding, outcome: "cancelled_before_start", closed: true,
      execution_authorized: false, reason: "controlled pre-start stop" };
    persistImportedDesignReviewResult(f.runtime, permit, result);
    expect(JSON.parse(readFileSync(join(f.store, "attestations", "imported-design-review-result-" + sha("stop-h4").slice(7) + ".json"), "utf8"))).toEqual(result);
    expect(() => reserveImportedDesignReview(f.runtime, controlBinding, "start")).toThrow();
    expect(control.designReviewVerify).not.toHaveBeenCalled(); closeProductSourceRuntime(f.runtime);
  });
});

import { importedExecutionReviewRequestDigestV1, importedExecutionRepairRequestDigestV1,
  type ImportedExecutionReviewRequestV1, type ImportedExecutionRepairRequestV1, type ImportedExecutionReviewResultV1 } from "@artoo/domain";
import { readCompletedVerifiedImportedExecution, reserveImportedExecutionReview, runImportedExecutionReview, persistImportedExecutionReviewResult,
  readCompletedImportedExecutionReview, readImportedExecutionReviewVerificationAdmission, reserveImportedExecutionRepair, runImportedExecutionRepair,
  persistImportedExecutionRepairResult, readCompletedVerifiedImportedExecutionRepair, readImportedExecutionRepairVerificationAdmission } from "./product-source-runtime.js";
import { h6RequestForImplementationFixture, controlledImplementationReviewResult, repairRequestForH6Fixture,
  controlledImplementationRepairResult } from "./test-fixtures/imported-execution-review-request.js";

async function h6Fixture() {
  const f = await h5Fixture(), originalH5 = await f.executeH5();
  persistImportedExecutionResult(f.runtime, f.permitH5, originalH5);
  const source = readCompletedVerifiedImportedExecution(f.runtime, originalH5);
  const requestH6 = h6RequestForImplementationFixture(f.requestH5, source);
  let session = true;
  function review(request: ImportedExecutionReviewRequestV1, original: Parameters<typeof runImportedExecutionReview>[2], outcome: "accepted" | "rejected") {
    const projected = controlledImplementationReviewResult(request, outcome);
    if (projected.outcome !== "reviewed") throw Error("Controlled H6 verdict required");
    const binding = { version: 1 as const, review_id: request.review_id, request_digest: importedExecutionReviewRequestDigestV1(request, sha) };
    const permit = reserveImportedExecutionReview(f.runtime, binding, "start");
    const adapter: RuntimeAdapter = { runtimeId: request.review_start.runtime, start: vi.fn(async config => ({ runId: config.runId })),
      stop: vi.fn(async () => {}), collectArtifacts: async () => [], async *streamEvents() {
        yield { type: "run.answer", payload: { text: JSON.stringify(projected.verdict) } };
        yield { type: "run.lifecycle", payload: { phase: "completed", reason: null } };
      } };
    control.implementationReviewVerify.mockImplementation(async (profile, requestId, _signal, context, owner, phase) => {
      const admitted = readImportedExecutionReviewVerificationAdmission(owner, profile, requestId, context, phase);
      expect(admitted.start.context_pack.payload).toBe(context);
      expect(() => readImportedExecutionReviewVerificationAdmission(owner, profile, requestId, structuredClone(context), phase)).toThrow("registered phase");
      expect(readImportedDesignResearch(f.workspace, context, readFileSync(join(f.workspace, ".artoo/product/research.json"))).measurement_plan!.profile_digest).toBe(profile.digest);
      return { ...structuredClone(request.source.verification), request_id: requestId };
    });
    return { binding, permit, adapter, execute: () => runImportedExecutionReview(f.runtime, permit, original, request, adapter,
      new AbortController().signal, () => { if (!session) throw Error("Controlled H6 receipt/session revoked"); }) };
  }
  function repair(request: ImportedExecutionRepairRequestV1, original: ImportedExecutionReviewResultV1) {
    const projected = controlledImplementationRepairResult(request);
    if (projected.outcome !== "finished" || !projected.verified_repair) throw Error("Controlled repair final required");
    const verification = projected.verified_repair.verification;
    const binding = { version: 1 as const, repair_id: request.repair_id, request_digest: importedExecutionRepairRequestDigestV1(request, sha), run_id: request.run_start.run_id };
    const permit = reserveImportedExecutionRepair(f.runtime, binding, "start"), events: RunEventMessage["event"][] = [];
    const adapter: RuntimeAdapter = { runtimeId: request.run_start.runtime, start: vi.fn(async config => {
      writeFileSync(join(f.workspace, "product/index.html"), "controlled repair");
      control.subject.mockReturnValue({ digest: verification.subject_digest, files: new Map(), directories: [] });
      return { runId: config.runId };
    }), stop: vi.fn(async () => {}), collectArtifacts: async () => [], async *streamEvents() {
      yield { type: "run.lifecycle", payload: { phase: "completed", reason: null } };
    } };
    control.repairVerify.mockImplementation(async (profile, requestId, _signal, context, owner) => {
      const admitted = readImportedExecutionRepairVerificationAdmission(owner, profile, requestId, context, "final");
      expect(admitted.request.run_start.context_pack.payload).toBe(context);
      expect(() => readImportedExecutionRepairVerificationAdmission(owner, profile, requestId, structuredClone(context), "final")).toThrow("original invocation");
      return structuredClone(verification);
    });
    const emit = async (event: RunEventMessage["event"]) => { events.push(event); };
    return { binding, permit, adapter, events, execute: (send = emit) => runImportedExecutionRepair(f.runtime, permit, original, request,
      adapter, new AbortController().signal, () => { if (!session) throw Error("Controlled repair receipt/session revoked"); }, send) };
  }
  control.implementationReviewVerify.mockClear(); control.repairVerify.mockClear(); control.closure.mockClear(); control.finalBinding.mockClear();
  return { ...f, originalH5, source, requestH6, review, repair, revoke: () => { session = false; } };
}
describe("H6 rejected-review and bounded repair authority using controlled native closures and real journals", () => {
  it("requires original H5, completes both review phases, repairs once and reviews the actual repair author", async () => {
    const f = await h6Fixture();
    expect(() => readCompletedVerifiedImportedExecution(f.runtime, structuredClone(f.originalH5))).toThrow("Original persisted");
    const first = f.review(f.requestH6, f.originalH5, "rejected"), reviewed = await first.execute();
    expect(reviewed).toMatchObject({ outcome: "reviewed", execution_authorized: false, verdict: { outcome: "rejected" } });
    expect(control.implementationReviewVerify.mock.calls.map(call => call[5])).toEqual(["before", "after"]);
    expect(() => persistImportedExecutionReviewResult(f.runtime, first.permit, structuredClone(reviewed))).toThrow("Original H6");
    persistImportedExecutionReviewResult(f.runtime, first.permit, reviewed);
    expect(readCompletedImportedExecutionReview(f.runtime, reviewed)).toEqual(f.requestH6);
    const request = repairRequestForH6Fixture(f.requestH6, reviewed), repair = f.repair(request, reviewed), repaired = await repair.execute();
    expect(repaired).toMatchObject({ outcome: "finished", closed: true, verified_repair: { attempt_index: 1 } });
    expect(repair.adapter.start).toHaveBeenCalledTimes(1);
    expect(() => persistImportedExecutionRepairResult(f.runtime, repair.permit, structuredClone(repaired))).toThrow("Original repair");
    persistImportedExecutionRepairResult(f.runtime, repair.permit, repaired);
    const source = readCompletedVerifiedImportedExecutionRepair(f.runtime, repaired);
    expect(source.author).toEqual(request.writer); expect(source.subject_digest).not.toBe(f.source.subject_digest);
    const secondRequest = h6RequestForImplementationFixture(f.requestH5, source, "h6-second"), second = f.review(secondRequest, repaired, "accepted");
    const secondResult = await second.execute(); expect(secondResult).toMatchObject({ outcome: "reviewed", verdict: { outcome: "accepted" } });
    persistImportedExecutionReviewResult(f.runtime, second.permit, secondResult);
    await expect(repair.execute()).rejects.toThrow("unused repair");
    expect(() => reserveImportedExecutionRepair(f.runtime, repair.binding, "start")).toThrow();
    closeProductSourceRuntime(f.runtime); expect(control.protectedCommand).not.toHaveBeenCalled();
  });
  it.each(["research", "design", "history", "subject", "author-method"])("rejects %s changes before any H6 native admission", async change => {
    const f = await h6Fixture(), review = f.review(f.requestH6, f.originalH5, "accepted");
    if (change === "research") writeFileSync(join(f.workspace, ".artoo/product/research.json"), "{}");
    if (change === "design") writeFileSync(join(f.workspace, ".artoo/product/design.json"), "{}");
    if (change === "history") writeFileSync(join(f.store, "attestations", "imported-execution-result-" + sha(f.requestH5.execution_id).slice(7) + ".json"), "{}");
    if (change === "subject") control.subject.mockReturnValue({ digest: sha("other"), files: new Map(), directories: [] });
    if (change === "author-method") f.writerH5.stop = async () => {};
    await expect(review.execute()).rejects.toThrow(); expect(review.adapter.start).not.toHaveBeenCalled(); expect(control.implementationReviewVerify).not.toHaveBeenCalled();
  });
  it.each(["before", "after"] as const)("retains ownership when the %s verifier closure is unknown", async phase => {
    const f = await h6Fixture(), review = f.review(f.requestH6, f.originalH5, "rejected");
    const configured = control.implementationReviewVerify.getMockImplementation()!;
    control.implementationReviewVerify.mockImplementation(async (...args) => {
      if (args[5] === phase) throw Error("Controlled independent verifier closure unknown"); return configured(...args);
    });
    const result = await review.execute(); expect(result).toMatchObject({ outcome: "uncertain", closed: false });
    persistImportedExecutionReviewResult(f.runtime, review.permit, result);
    expect(() => closeProductSourceRuntime(f.runtime)).toThrow("live or uncertain");
    expect(review.adapter.start).toHaveBeenCalledTimes(phase === "before" ? 0 : 1);
  });
  it("retains uncertain repair verifier ownership and cannot reuse a rejected H6", async () => {
    const f = await h6Fixture(), review = f.review(f.requestH6, f.originalH5, "rejected"), rejected = await review.execute();
    persistImportedExecutionReviewResult(f.runtime, review.permit, rejected);
    const repair = f.repair(repairRequestForH6Fixture(f.requestH6, rejected), rejected);
    control.repairVerify.mockRejectedValueOnce(Error("Controlled repair verifier closure unknown"));
    const result = await repair.execute(); expect(result).toMatchObject({ outcome: "uncertain", closed: false });
    persistImportedExecutionRepairResult(f.runtime, repair.permit, result);
    expect(() => closeProductSourceRuntime(f.runtime)).toThrow("live or uncertain");
    expect(() => readCompletedVerifiedImportedExecutionRepair(f.runtime, result)).toThrow("Original persisted");
  });
  it.each(["session", "subject", "original-final"])("rechecks %s after the repair terminal event ACK", async change => {
    const f = await h6Fixture(), review = f.review(f.requestH6, f.originalH5, "rejected"), rejected = await review.execute();
    persistImportedExecutionReviewResult(f.runtime, review.permit, rejected);
    const repair = f.repair(repairRequestForH6Fixture(f.requestH6, rejected), rejected);
    try {
      const result = await repair.execute(async event => {
        repair.events.push(event);
        if (event.type === "run.lifecycle" && event.payload.phase === "completed") {
          if (change === "session") f.revoke();
          if (change === "subject") control.subject.mockReturnValue({ digest: sha("changed after ACK"), files: new Map(), directories: [] });
          if (change === "original-final") control.finalBinding.mockImplementation((_p, _e, _permit, _r, _c, phase) => {
            if (phase === "implementation") throw Error("Controlled original H5 verifier binding lost");
          });
        }
      });
      expect(result.outcome).not.toBe("finished"); expect(result).not.toHaveProperty("verified_repair");
      expect(repair.adapter.start).toHaveBeenCalledTimes(1); expect(control.repairVerify).toHaveBeenCalledTimes(1);
    } finally { control.finalBinding.mockReset(); }
  });
});
