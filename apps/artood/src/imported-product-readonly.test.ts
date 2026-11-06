import {createHash} from "node:crypto";
import {mkdtempSync,mkdirSync,writeFileSync,realpathSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve,sep} from "node:path";
import {afterEach,describe,it,expect} from "vitest";
import type {ContextPack} from "@artoo/domain";
import type {AgentInstanceConfig} from "@artoo/protocol";
import {prepareVerificationProfiles,subjectManifest} from "./verification.js";
import {bindWorkspaceReadOnlyTools,takeWorkspaceReadOnlyTools,claimWorkspaceReadOnlyTools} from "./workspace-readonly.js";
const sha=(value:string)=>`sha256:${createHash("sha256").update(value).digest("hex")}`;
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0)){
  const prefix=resolve(tmpdir())+sep;if(!root.startsWith(prefix)||!root.slice(prefix.length).startsWith("artoo-import-review-readonly-"))throw Error("Unexpected fixture cleanup root");
  rmSync(root,{recursive:true,force:true});
}});
function fixture(){
  const root=realpathSync.native(mkdtempSync(join(tmpdir(),"artoo-import-review-readonly-")));roots.push(root);
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
