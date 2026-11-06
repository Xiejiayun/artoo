import {mkdtempSync,realpathSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve,sep} from "node:path";
import {describe,it,expect,vi} from "vitest";
import type {ContextPack} from "@artoo/domain";
import type {NodeToServerMessage,RunEvent,RuntimeAdapter} from "@artoo/protocol";
import {createInProcessChannel} from "@artoo/testkit";
import {createNodeClient} from "./node-client.js";
describe("ordinary node admission with imported-review context (controlled adapter only)",()=>{
  it("rejects a public run.start before adapter invocation even without a source runtime",async()=>{
    const root=realpathSync.native(mkdtempSync(join(tmpdir(),"artoo-import-review-boundary-"))),hash=`sha256:${"a".repeat(64)}`;
    const context:ContextPack={task:{id:"task",title:"Imported review",description:"Controlled remote context",acceptance_criteria:[]},
      project:{id:"project",name:"Project",default_workspace:root},workspace:{root,file_scope:[]},
      policy:{execution_mode:"discussion",filesystem_write_scope:[],requires_approval:[]},memory:{task_summary:null,project_notes:[]},artifacts:{expected:[]},
      imported_review_subject:{version:1,review_id:"review",transfer_id:"transfer",operation_id:"operation",request_digest:hash,operation_result_digest:hash,
        source_run_id:"source",source_evidence_id:"source-evidence",source_review_id:"source-review",source_export_digest:hash,admission_digest:hash,mapping_digest:hash,
        research_provenance_digest:hash,subject_digest:hash,author_agent_id:"author",reviewer_agent_id:"reviewer",reviewer_instance_id:"reviewer-instance",development_stage:"research"}};
    const adapter:RuntimeAdapter={runtimeId:"controlled",start:vi.fn(async config=>({runId:config.runId})),stop:vi.fn(async()=>{}),collectArtifacts:async()=>[],
      async *streamEvents():AsyncIterable<RunEvent>{yield {type:"run.lifecycle",payload:{phase:"completed",reason:null}};}};
    const channel=createInProcessChannel(),messages:NodeToServerMessage[]=[];channel.serverTransport.subscribe(message=>messages.push(message));
    const client=createNodeClient({nodeId:"node",adapter,transport:channel.node,workspace:{allowedRoots:[root]}});
    try{
      client.start();await channel.serverTransport.send({kind:"command",id:"start",idempotency_key:"start",type:"run.start",payload:{run_id:"run",task_id:"task",
        agent_instance_id:"reviewer-instance",runtime:"controlled",workspace:{root},context_pack:{id:"context",payload:context},
        policy_snapshot:{filesystem_write_scope:[],requires_approval:[]},artifact_rules:{paths:[]}}});
      await vi.waitFor(()=>expect(messages).toContainEqual(expect.objectContaining({kind:"command.ack",command_id:"start",status:"rejected",
        message:expect.stringContaining("dedicated local operation controller")})));
      expect(adapter.start).not.toHaveBeenCalled();
    }finally{
      await client.stop(true);const prefix=resolve(tmpdir())+sep;
      if(!root.startsWith(prefix)||!root.slice(prefix.length).startsWith("artoo-import-review-boundary-"))throw Error("Unexpected controlled fixture cleanup root");
      rmSync(root,{recursive:true,force:true});
    }
  });
});
