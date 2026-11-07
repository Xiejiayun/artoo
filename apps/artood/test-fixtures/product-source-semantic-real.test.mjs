// Controlled author and native protected verifier, actual HTTPS retrieval and physical Git import.
// Paired HTTP is a labelled transport fixture; no model, scheduler, automatic review or release is invoked.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { canonicalProductSourceTransferValueV1 as canonical, ContextPackSchema, productDevelopmentContext,
  ProductSourceExportV2Schema, ProductSourceTransferRequestV2Schema, productSourceExportDigestV2, productSourceTransferRequestDigestV2,
  inspectProductSourceVerificationEnvelopeV1 } from "@artoo/domain";
import { adapterRunEventBodySchema, runEventBodySchema } from "@artoo/protocol";
import { createNodeClient } from "../dist/node-client.js";
import { createProcessAdapter } from "../dist/process-adapter.js";
import { createAdapterRegistry } from "../dist/adapter-registry.js";
import { prepareWindowsProcessInstallation } from "../dist/windows-process-installation.js";
import { prepareVerificationProfiles, attachWindowsVerificationBackend, readVerificationCapabilities,
  runVerification, runTransferredResearchVerification, assertFinalVerificationExportBinding } from "../dist/verification.js";
import { prepareProductSourceRuntime, assertProductSourceWorkspaceBoundary, importProductSourceSemanticTransfer,
  verifyProductSourceSemanticTransfer, closeProductSourceRuntime, readProductSourceVerificationAdmission } from "../dist/product-source-runtime.js";
import { createProductSourceSemanticClient, readAuthenticatedProductSourceTransferV2 } from "../dist/product-source-semantic-client.js";

const sha = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`, hash = value => sha(canonical(value));
const bundle = process.env.ARTOO_WINDOWS_PROCESS_BUNDLE, manifest = process.env.ARTOO_WINDOWS_PROCESS_MANIFEST_SHA256;
const parent = process.env.ARTOO_NATIVE_FIXTURE_PARENT, git = process.env.ARTOO_NATIVE_GIT_EXECUTABLE;
if (process.platform !== "win32" || !bundle || !parent || !git || !isAbsolute(parent) || !isAbsolute(git)
  || !/^sha256:[a-f0-9]{64}$/.test(manifest ?? "") || realpathSync.native(parent) !== parent) throw Error("Explicit native protected fixture configuration required");
assert.equal(sha(readFileSync(join(bundle,"manifest.json"))),manifest);

test("first-hop original research provenance binds fresh native destination verification without rewriting bytes", { timeout: 240000 }, async () => {
  const root = realpathSync.native(mkdtempSync(join(parent,"artoo-semantic-"))), paths = {};
  for (const name of ["source","destination","source-store","destination-store","receipts","source-evidence","destination-evidence"]) {
    paths[name]=join(root,name); mkdirSync(paths[name]);
  }
  paths.helper=join(root,"helper"); cpSync(bundle,paths.helper,{recursive:true,errorOnExist:true,force:false});
  const backend = prepareWindowsProcessInstallation({ directory:paths.helper,manifestSha256:manifest,
    writableWorkspaceRoots:[paths.source,paths.destination] });
  const cli=realpathSync.native(fileURLToPath(new URL("../dist/web-acceptance-cli.js",import.meta.url)));
  const profiles=["source","destination"].map(name=> {
    const config=join(root,`${name}.json`); writeFileSync(config,JSON.stringify({evidence_root:paths[`${name}-evidence`],
      browser_program:{version:3,viewports:[{id:"compact",width:390,height:844}]}}));
    const [profile]=prepareVerificationProfiles([{id:name,project_id:"project",workspace_root:paths[name],subject_paths:[".artoo/product","product"],required_files:[],
      measurement_plan_policy:{version:1,coverage:"every-must-criterion"},commands:[{id:`${name}-browser`,argv:[process.execPath,cli,config],timeout_ms:15000,
        observation:{format:"static-web-acceptance.v3",evidence_root:paths[`${name}-evidence`],capabilities:{version:1}}}]}],[paths[name]]);
    attachWindowsVerificationBackend(profile,backend); return profile;
  });
  const [source,destination]=profiles, pairs=[{source_command_id:"source-browser",destination_command_id:"destination-browser"}];
  const researchOptions={receiptDirectory:paths.receipts};
  const sourceRuntime=prepareProductSourceRuntime({nodeId:"source-node",storeRoot:paths["source-store"],allowedRoots:[paths.source],profiles:[source],
    gitExecutable:git,windowsBackend:backend,sourceResearch:researchOptions});
  const makeDestination=()=>prepareProductSourceRuntime({nodeId:"destination-node",storeRoot:paths["destination-store"],allowedRoots:[paths.destination],profiles:[destination],
    gitExecutable:git,windowsBackend:backend,destinationResearchMappings:[{sourceProfileDigest:source.digest,destinationProfileId:destination.id,commandPairs:pairs}]});
  const destinationRuntime=makeDestination();
  const check=source.capabilities.checks[0], author=join(root,"author.mjs"), facts=join(root,"facts.jsonl"), authorInput=join(root,"author-input.json");
  writeFileSync(authorInput,JSON.stringify({version:1,objective:"Controlled first-hop research transfer",assumptions:[],
    requirements:[{id:"preserve",description:"Preserve native authored bytes",priority:"must",acceptance_criteria:["The product shows its exact title"]}],
    decisions:[],measurement_plan:{version:1,profile_digest:source.digest,entries:[{requirement_id:"preserve",criterion_index:0,
      command_id:check.command_id,config_digest:check.config_digest,contract_digest:check.contract_digest,actions:["navigate","assert_text"],keys:[],
      viewports:check.contract.viewports,needs:[]}]}}));
  writeFileSync(author,`import{mkdirSync,readFileSync,writeFileSync,appendFileSync}from'node:fs';import{join}from'node:path';
const w=process.argv[2],broker=JSON.parse(readFileSync(process.argv[3],'utf8')),report=JSON.parse(readFileSync(process.argv[4],'utf8'));
const response=await fetch(broker.url,{method:'POST',headers:{authorization:'Bearer '+broker.token,'content-type':'application/json'},
body:JSON.stringify({tool:'fetch',url:'https://example.com/'})});const fetched=await response.json();if(!response.ok)throw Error('Actual research retrieval failed: '+fetched.error);
const source=Object.fromEntries(['id','url','title','retrieved_at','content_digest'].map(key=>[key,fetched[key]]));report.sources=[source];
report.findings=[{summary:'The public reference was retrieved through the original node-owned broker',source_ids:[source.id]}];
mkdirSync(join(w,'.artoo','product'),{recursive:true});mkdirSync(join(w,'product'));
writeFileSync(join(w,'.artoo','product','research.json'),JSON.stringify(report));writeFileSync(join(w,'product','index.html'),'<!doctype html><title>Native first-hop fixture</title>');
appendFileSync(${JSON.stringify(facts)},JSON.stringify({kind:'author',pid:process.pid})+'\\n');`);
  const makeStart=(profile,run,expected)=> {
    const context=ContextPackSchema.parse({task:{id:`${run}-task`,title:"Controlled native research",description:"First-hop fixture",acceptance_criteria:[]},
      project:{id:"project",name:"Fixture",default_workspace:profile.workspace_root},workspace:{root:profile.workspace_root,file_scope:[]},
      policy:{filesystem_write_scope:[profile.workspace_root],requires_approval:[]},memory:{task_summary:null,project_notes:[]},artifacts:{expected:[]},
      product_development:productDevelopmentContext("research"),verification_capabilities:readVerificationCapabilities(profile),
      goal_context:{version:1,goal_id:"goal",objective:"Controlled transfer",acceptance_criteria:[],plan:{id:"plan",version:1,rationale:"First-hop",spec_ref:null}}});
    return {run_id:run,task_id:context.task.id,agent_instance_id:"fixture-agent",runtime:"fixture",workspace:{root:profile.workspace_root},
      context_pack:{id:`${run}-context`,payload:context},policy_snapshot:{filesystem_write_scope:[profile.workspace_root],requires_approval:[]},artifact_rules:{paths:[]},
      verification:{version:1,profile_id:profile.id,request_id:`${run}-verify`,...(expected?{expected_subject_digest:expected}:{}),capability_binding:{version:1,
        profile_digest:profile.digest,checks:profile.capabilities.checks.map(({command_id,config_digest,contract_digest})=>({command_id,config_digest,contract_digest}))}}};
  };
  const start=makeStart(source,"source-run"), messages=[]; let dispatch;
  const client=createNodeClient({nodeId:"source-node",workspace:{allowedRoots:[paths.source]},verificationProfiles:[source],productSourceRuntime:sourceRuntime,
    registry:createAdapterRegistry([{runtime:"fixture",adapter:createProcessAdapter({runtimeId:"fixture",allowedRoots:[paths.source],artifacts:[],research:researchOptions,
      command:[process.execPath,author,"{{workspace_root}}","{{research_config_path}}",authorInput]})}]),
    transport:{send:async value=>{messages.push(value);},subscribe:handler=>{dispatch=handler;return()=>{};}}});
  client.start(); dispatch({kind:"command",id:"start",idempotency_key:"source-run:start",type:"run.start",payload:start});
  const deadline=Date.now()+90000;
  while(!messages.some(message=>message.event?.type==="run.lifecycle"&&message.event.payload.phase==="completed")) {
    assert.equal(messages.some(message=>message.kind==="command.ack"&&message.status==="rejected"),false,JSON.stringify(messages));
    assert.equal(messages.some(message=>message.event?.type==="run.lifecycle"&&message.event.payload.phase==="failed"),false,JSON.stringify(messages));
    assert.ok(Date.now()<deadline,JSON.stringify(messages)); await new Promise(resolve=>setTimeout(resolve,25));
  }
  const sourceVerification=messages.find(message=>message.event?.type==="run.verification"), exported=messages.find(message=>message.event?.type==="run.product-source.export.v2");
  assert.equal(sourceVerification.event.payload.outcome,"passed",sourceVerification.event.payload.reason);
  const proof=ProductSourceExportV2Schema.parse(exported?.event.payload), byte=proof.byte_export;
  const wire={type:"run.product-source.export.v2",payload:proof};
  assert.deepEqual(runEventBodySchema.parse(wire),wire);assert.equal(adapterRunEventBodySchema.safeParse(wire).success,false);
  const chained=structuredClone(proof);chained.research_provenance.chain_depth=1;
  assert.equal(ProductSourceExportV2Schema.safeParse(chained).success,false);
  assert.equal(exported.sequence,sourceVerification.sequence+1); assert.equal(proof.research_provenance.chain_depth,0);
  assert.equal(messages.some(message=>message.event?.type==="run.product-source.export.v1"),false);
  assert.equal(proof.research_provenance.sources[0].origin.run_id,start.run_id);
  assert.equal(proof.research_provenance.sources[0].origin.task_id,start.task_id);
  await client.stop(true);
  const request=ProductSourceTransferRequestV2Schema.parse({version:2,kind:"product-source-transfer.v2",source_export:proof,
    source_export_digest:productSourceExportDigestV2(proof,sha),command_pairs:pairs,byte_request:{version:1,kind:"product-source-transfer.v1",transfer_id:"semantic-transfer",
      organization_id:"organization",project_id:"project",goal_id:"goal",plan_id:"plan",authorization:{actor_user_id:"user",consent_id:null,policy_version:"policy"},
      source:{node_id:"source-node",task_id:start.task_id,run_id:start.run_id,evidence_id:"source-evidence",verification_request_id:start.verification.request_id,
        profile_id:source.id,profile_digest:source.digest,workspace_root:paths.source,subject_digest:byte.subject_digest,review_id:"independent-review",
        reviewer_run_id:"independent-review-run",reviewer_evidence_id:"independent-review-evidence",capsule_digest:byte.capsule_digest,manifest_digest:byte.manifest_digest,capsule_bytes:byte.capsule_bytes},
      destination:{node_id:"destination-node",profile_id:destination.id,workspace_root:paths.destination,capabilities:destination.capabilities,capability_digest:hash(destination.capabilities)}}});
  const digest=productSourceTransferRequestDigestV2(request,sha), deviceToken="sk_device_fixture_fixturesecret"; let stored,mode="normal";
  const http=createServer((req,res)=>{
    if(req.url!=="/api/v1/node/product-source-transfers-v2/semantic-transfer/content"||req.headers.authorization!==`Bearer ${deviceToken}`||req.headers["x-artoo-transfer-request-digest"]!==digest){res.writeHead(403);res.end();return;}
    if(mode==="redirect"){res.writeHead(302,{location:"http://127.0.0.1:1/leak"});res.end();return;}
    if(req.method==="PUT"){const chunks=[];req.on("data",bytes=>chunks.push(bytes));req.on("end",()=>{stored=Buffer.concat(chunks);assert.equal(sha(stored),byte.capsule_digest);
      res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({transfer:{version:1,transfer_id:"semantic-transfer",request_digest:digest,capsule_digest:byte.capsule_digest,status:"available",execution_authorized:false}}));});}
    else {res.writeHead(200,{"content-type":"application/octet-stream","x-artoo-transfer-request-digest":digest,"x-artoo-checksum":byte.capsule_digest,
      "x-artoo-source-export-digest":mode==="wrong-export"?sha("wrong"):request.source_export_digest});res.end(stored);}
  });
  await new Promise(resolve=>http.listen(0,"127.0.0.1",resolve));
  try {
    const serverOrigin=`http://127.0.0.1:${http.address().port}`,sender=createProductSourceSemanticClient({serverOrigin,nodeId:"source-node",nodeToken:deviceToken}),
      receiver=createProductSourceSemanticClient({serverOrigin,nodeId:"destination-node",nodeToken:deviceToken});
    await sender.upload(sourceRuntime,request); assert.throws(()=>readAuthenticatedProductSourceTransferV2({}),/original authenticated/);
    mode="redirect";await assert.rejects(receiver.download(request));mode="wrong-export";await assert.rejects(receiver.download(request),/complete source provenance/);mode="normal";
    assert.deepEqual(readdirSync(paths.destination),[]);
    const authenticated=await receiver.download(request);
    await assert.rejects(importProductSourceSemanticTransfer(destinationRuntime,structuredClone(authenticated)),/original authenticated/);
    const ready=await importProductSourceSemanticTransfer(destinationRuntime,authenticated);
    assert.equal(ready.semantic_mapping_accepted,false);assert.equal(ready.verification_passed,false);
    const sourceBytes=readFileSync(join(paths.source,".artoo/product/research.json")),destinationPath=join(paths.destination,".artoo/product/research.json");
    assert.deepEqual(readFileSync(destinationPath),sourceBytes);
    const destinationStart=makeStart(destination,"destination-run",ready.destination.subject_digest),signal=new AbortController().signal;
    const ordinary=await runVerification(destination,"ordinary",signal,destinationStart.context_pack.payload,ready.destination.subject_digest);
    assert.equal(ordinary.outcome,"failed");assert.match(ordinary.reason,/profile digest/);assert.equal(ordinary.checks.length,0);
    await assert.rejects(runTransferredResearchVerification(destination,"fake",signal,destinationStart.context_pack.payload,ready.destination.subject_digest,{}),/original live semantic/);
    assert.throws(()=>readProductSourceVerificationAdmission({},destination,"fake",destinationStart.context_pack.payload),/original live semantic/);
    const altered=structuredClone(destinationStart);altered.context_pack.payload.goal_context.plan.id="different-plan";
    await assert.rejects(verifyProductSourceSemanticTransfer(destinationRuntime,authenticated,altered,signal),/full transfer/);
    const fresh=await verifyProductSourceSemanticTransfer(destinationRuntime,authenticated,destinationStart,signal);
    assert.equal(fresh.verification.outcome,"passed",fresh.verification.reason);assert.equal(fresh.verification.checks.length,1);
    assert.equal(fresh.verification.checks[0].exit_code,0);assert.equal(fresh.execution_authorized,false);assert.equal(fresh.automatic_review_authorized,false);
    assert.equal(fresh.verification.measurement_plan.research.checksum,sha(sourceBytes));
    assert.throws(()=>assertFinalVerificationExportBinding(destination,fresh.verification,destinationStart.verification.request_id,destinationStart.context_pack.payload),/original completed final/);
    assert.deepEqual(readFileSync(destinationPath),sourceBytes);assert.equal(JSON.parse(sourceBytes).sources[0].id,proof.research_provenance.sources[0].metadata.id);
    assert.throws(()=>assertProductSourceWorkspaceBoundary(destinationRuntime,paths.destination),/retained product source import/);
    await assert.rejects(verifyProductSourceSemanticTransfer(destinationRuntime,authenticated,destinationStart,signal),/EEXIST/);
    const admissionFile=readdirSync(join(paths["destination-store"],"attestations")).find(name=>name.startsWith("semantic-admission-"));
    const envelope=JSON.parse(readFileSync(join(paths["destination-store"],"attestations",admissionFile),"utf8"));
    assert.equal(inspectProductSourceVerificationEnvelopeV1(envelope,sourceBytes,sha).admission_digest,fresh.admission_digest);
    for (const mutation of [value=>{value.run_start.verification.expected_subject_digest=sha("other");},value=>{value.mapping.effective_measurement_plan_digest=sha("other");},
      value=>{value.request.source_export.research_provenance.sources[0].origin.node_id="destination-node";}]) {
      const bad=structuredClone(envelope);mutation(bad);assert.throws(()=>inspectProductSourceVerificationEnvelopeV1(bad,sourceBytes,sha));
    }
    closeProductSourceRuntime(destinationRuntime);closeProductSourceRuntime(sourceRuntime);
    console.log(JSON.stringify({scope:"controlled-native-first-hop-research",root,source_export:proof,fresh_verification:fresh,
      author:readFileSync(facts,"utf8"),original_research_unchanged:true,server_transport:"labelled fixed-route fixture"}));
  } finally {await new Promise(resolve=>http.close(resolve));}
});
