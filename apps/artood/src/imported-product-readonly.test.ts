import {createHash} from "node:crypto";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,realpathSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve,sep} from "node:path";
import {afterEach,describe,it,expect} from "vitest";
import type {ContextPack} from "@artoo/domain";
import type {AgentInstanceConfig} from "@artoo/protocol";
import {prepareVerificationProfiles,subjectManifest} from "./verification.js";
import {bindWorkspaceReadOnlyTools,takeWorkspaceReadOnlyTools,claimWorkspaceReadOnlyTools} from "./workspace-readonly.js";
import {createWorkspaceToolSession,type WorkspaceToolSession} from "./workspace-tools.js";
import {importedDesignReviewRequestFixture} from "./test-fixtures/imported-design-review-request.js";
const sha=(value:string)=>`sha256:${createHash("sha256").update(value).digest("hex")}`;
const temporary=realpathSync.native(tmpdir());
const roots:string[]=[];
const sessions:WorkspaceToolSession[]=[];
afterEach(async()=>{for(const session of sessions.splice(0))await session.close();for(const root of roots.splice(0)){
  const prefix=resolve(temporary)+sep;if(!root.startsWith(prefix)||!root.slice(prefix.length).startsWith("artoo-import-review-readonly-"))throw Error("Unexpected fixture cleanup root");
  rmSync(root,{recursive:true,force:true});
}});
function fixture(){
  const root=realpathSync.native(mkdtempSync(join(temporary,"artoo-import-review-readonly-")));roots.push(root);
  const workspace=join(root,"workspace");mkdirSync(workspace);mkdirSync(join(workspace,"product"));writeFileSync(join(workspace,"product/index.html"),"unchanged source");
  const verifier=join(root,"controlled.fixture");writeFileSync(verifier,"controlled profile trust file; never executed");
  const profile=prepareVerificationProfiles([{id:"profile",project_id:"project",workspace_root:workspace,commands:[{id:"controlled",argv:[verifier],timeout_ms:1000}],
    required_files:[],subject_paths:["product"]}])[0]!,subjectDigest=subjectManifest(profile).digest;
  const context:ContextPack={task:{id:"review-task",title:"Imported research review",description:"Controlled source binding",acceptance_criteria:[]},
    project:{id:"project",name:"Project",default_workspace:workspace},workspace:{root:workspace,file_scope:[]},
    policy:{execution_mode:"discussion",filesystem_write_scope:[],requires_approval:[]},memory:{task_summary:null,project_notes:[]},artifacts:{expected:[]},
    imported_review_subject:{version:1,review_id:"review",transfer_id:"transfer",operation_id:"operation",request_digest:sha("request"),operation_result_digest:sha("result"),
      source_run_id:"source-run",source_evidence_id:"source-evidence",source_review_id:"source-review",source_export_digest:sha("export"),admission_digest:sha("admission"),
      mapping_digest:sha("mapping"),research_provenance_digest:sha("origin"),subject_digest:subjectDigest,author_agent_id:"author",reviewer_agent_id:"reviewer",
      reviewer_instance_id:"reviewer-instance",development_stage:"research"}};
  const config:AgentInstanceConfig={runId:"review-run",taskId:context.task.id,agentInstanceId:"reviewer-instance",runtime:"codex",workspaceRoot:workspace,
    runStart:{run_id:"review-run",task_id:context.task.id,agent_instance_id:"reviewer-instance",runtime:"codex",workspace:{root:workspace},context_pack:{id:"context",payload:context},
      policy_snapshot:{filesystem_write_scope:[],requires_approval:[]},artifact_rules:{paths:[]},verification:{version:1,request_id:"review-check",profile_id:profile.id,expected_subject_digest:subjectDigest}}};
  const binding={projectId:"project",workspaceRoot:workspace,source:{profile,subjectDigest,importedReviewId:"review"},assertCurrent:()=>{}};
  return {context,config,binding,workspace};
}
describe("explicit imported source read-only grants (no process, model or browser)",()=>{
  it("grants pinned source reads only through the exact imported-review binding",()=>{
    const f=fixture();bindWorkspaceReadOnlyTools(f.config,f.binding);const grant=takeWorkspaceReadOnlyTools(f.config)!;
    const authority=claimWorkspaceReadOnlyTools(grant,f.workspace,f.context);expect(authority.source).toBe(true);
    authority.assertRead("product/index.html",sha("unchanged source"),Buffer.byteLength("unchanged source"));
    expect(()=>authority.assertRead("private.txt")).toThrow("outside");expect(()=>claimWorkspaceReadOnlyTools(grant,f.workspace,f.context)).toThrow("fresh local");
  });
  it("does not reinterpret an ordinary review grant as an imported one",()=>{
    const f=fixture(),{importedReviewId:_id,...source}=f.binding.source;
    expect(()=>bindWorkspaceReadOnlyTools(f.config,{...f.binding,source})).toThrow("source differs");
  });
  it("rejects simultaneous ordinary and imported subjects",()=>{
    const f=fixture();f.context.review_subject={version:1,task_id:"invented",run_id:"invented",evidence_id:"invented",subject_digest:f.binding.source.subjectDigest};
    expect(()=>bindWorkspaceReadOnlyTools(f.config,f.binding)).toThrow("source differs");
  });
  it("rejects a copied grant or changed review identity",()=>{
    const f=fixture();bindWorkspaceReadOnlyTools(f.config,f.binding);const grant=takeWorkspaceReadOnlyTools(f.config)!;
    expect(()=>claimWorkspaceReadOnlyTools(structuredClone(grant),f.workspace,f.context)).toThrow("fresh local");
    f.context.imported_review_subject!.review_id="different";expect(()=>claimWorkspaceReadOnlyTools(grant,f.workspace,f.context)).toThrow();
  });
});

function h4Fixture(){
  const f=fixture(),{request}=importedDesignReviewRequestFixture();
  delete f.context.imported_review_subject;
  f.context.imported_design_review_subject={...request.review_start.context_pack.payload!.imported_design_review_subject!,review_id:"h4-review",subject_digest:f.binding.source.subjectDigest};
  f.context.transferred_product_input=request.review_start.context_pack.payload!.transferred_product_input;
  const {importedReviewId:_old,...source}=f.binding.source;
  const binding={...f.binding,source:{...source,importedDesignReviewId:"h4-review"}};
  return {...f,binding};
}
describe("original H4 read-only grant and broker",()=>{
  it("grants H4 source reads while preserving the foreign transfer context",()=>{
    const f=h4Fixture();bindWorkspaceReadOnlyTools(f.config,f.binding);
    const authority=claimWorkspaceReadOnlyTools(takeWorkspaceReadOnlyTools(f.config)!,f.workspace,f.context);
    authority.assertRead("product/index.html",sha("unchanged source"),Buffer.byteLength("unchanged source"));
    expect(()=>authority.assertRead("private.txt")).toThrow("outside");expect(authority.readEvidenceIndex).toBeUndefined();
  });
  for(const mixed of ["h2-binding","h2-subject","ordinary-subject","missing-transfer"] as const)it(`rejects ${mixed} in the H4 grant`,()=>{
    const f=h4Fixture();
    if(mixed==="h2-binding")Object.assign(f.binding.source,{importedReviewId:"review"});
    if(mixed==="h2-subject")f.context.imported_review_subject=fixture().context.imported_review_subject;
    if(mixed==="ordinary-subject")f.context.review_subject={version:1,task_id:"old",run_id:"old",evidence_id:"old",subject_digest:f.binding.source.subjectDigest};
    if(mixed==="missing-transfer")delete f.context.transferred_product_input;
    expect(()=>bindWorkspaceReadOnlyTools(f.config,f.binding)).toThrow("source differs");
  });
  it("returns the pinned local evidence index and offers only context, source and evidence reads",async()=>{
    const f=h4Fixture(),index={version:1 as const,bundles:[{reference:"controlled_bundle",request_id:"before-request",check_id:"controlled",scope:"final" as const}]};
    bindWorkspaceReadOnlyTools(f.config,{...f.binding,readEvidenceIndex:()=>index});
    const session=await createWorkspaceToolSession({workspaceRoot:f.workspace,context:f.context,contextText:"Controlled H4 context",
      readOnlyGrant:takeWorkspaceReadOnlyTools(f.config)!,readEvidence:async()=>{throw Error("Controlled broker fixture has no sealed evidence bytes");}});sessions.push(session);
    const broker=JSON.parse(readFileSync(session.configPath,"utf8"));
    const send=async(input:unknown)=>{const response=await fetch(broker.url,{method:"POST",headers:{authorization:`Bearer ${broker.token}`},body:JSON.stringify(input)});
      return {status:response.status,body:await response.json() as any};};
    expect(broker.tools).toEqual(["context","list","read","read_evidence"]);
    expect((await send({tool:"context"})).body.evidence_index).toEqual(index);
    expect((await send({tool:"context",offset:0,limit:4})).body).toMatchObject({content:"Cont",evidence_index:index});
    expect((await send({tool:"read",path:"product/index.html"})).status).toBe(200);
    for(const input of [{tool:"write",path:"product/index.html",content:"mutated",expected_checksum:sha("unchanged source")},{tool:"verify"}])expect((await send(input)).status).toBe(400);
    expect(readFileSync(join(f.workspace,"product/index.html"),"utf8")).toBe("unchanged source");
    index.bundles[0]!.reference="changed_bundle";
    expect((await send({tool:"context"})).body.error).toContain("evidence index changed");
  });
  it("rejects asynchronous or path-bearing reference discovery",()=>{
    const f=h4Fixture();
    expect(()=>bindWorkspaceReadOnlyTools(f.config,{...f.binding,readEvidenceIndex:(()=>Promise.resolve({version:1,bundles:[]})) as never})).toThrow();
    expect(()=>bindWorkspaceReadOnlyTools(f.config,{...f.binding,readEvidenceIndex:()=>({version:1,bundles:[{reference:"C:/private/file",request_id:"before",check_id:"check",scope:"final"}]})})).toThrow();
  });
});
