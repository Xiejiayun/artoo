// Controlled native Windows author/verifier + real ACL/Git/filesystem/HTTP checks.
// This does not execute a model, a foreign research mapping, GoalRunner or publication.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { canonicalProductSourceTransferValueV1, productDevelopmentContext, ContextPackSchema, ProductSourceExportV1Schema,
  ProductSourceTransferRequestV1Schema, productSourceTransferRequestDigestV1 } from "@artoo/domain";
import { createNodeClient } from "../dist/node-client.js";
import { createProcessAdapter } from "../dist/process-adapter.js";
import { createAdapterRegistry } from "../dist/adapter-registry.js";
import { prepareWindowsProcessInstallation } from "../dist/windows-process-installation.js";
import { prepareVerificationProfiles, attachWindowsVerificationBackend, assertFinalVerificationExportBinding } from "../dist/verification.js";
import { prepareProductSourceRuntime, assertProductSourceWorkspaceBoundary, readProductSourceImportReady,
  claimProductSourceRun, releaseProductSourceRun, closeProductSourceRuntime, importProductSourceTransfer } from "../dist/product-source-runtime.js";
import { createProductSourceTransferClient } from "../dist/product-source-transfer-client.js";
import { resolveCliCommand } from "../dist/cli-resolver.js";

const sha = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const hash = value => sha(canonicalProductSourceTransferValueV1(value));
const sourceBundle = process.env.ARTOO_WINDOWS_PROCESS_BUNDLE, manifestDigest = process.env.ARTOO_WINDOWS_PROCESS_MANIFEST_SHA256;
const fixtureParent = process.env.ARTOO_NATIVE_FIXTURE_PARENT;
if (process.platform !== "win32" || !sourceBundle || !isAbsolute(sourceBundle) || !/^sha256:[a-f0-9]{64}$/.test(manifestDigest ?? ""))
  throw new Error("Native Windows and the separately recorded exact helper bundle are required");
assert.equal(sha(readFileSync(join(sourceBundle, "manifest.json"))), manifestDigest);
if (!fixtureParent || !isAbsolute(fixtureParent) || realpathSync.native(fixtureParent) !== fixtureParent)
  throw new Error("An explicit physical native fixture parent is required; ordinary MSIX temp ancestors may be untrusted");

test("native sealed export, fixed HTTP and durable fresh Git import remain byte-only authority", { timeout: 240000 }, async () => {
  const root = realpathSync.native(mkdtempSync(join(fixtureParent, "artoo-source-runtime-")));
  const paths = Object.fromEntries(["source", "destination", "failure", "source-store", "destination-store", "failure-store", "helper", "evidence"]
    .map(name => { const path = join(root, name); if (name !== "helper") mkdirSync(path); return [name, path]; }));
  cpSync(sourceBundle, paths.helper, { recursive: true, errorOnExist: true, force: false });
  const backend = prepareWindowsProcessInstallation({ directory: paths.helper, manifestSha256: manifestDigest,
    writableWorkspaceRoots: [paths.source, paths.destination, paths.failure] }); // Real shared policy, no caller ACL callbacks.
  const git = process.env.ARTOO_NATIVE_GIT_EXECUTABLE ? [process.env.ARTOO_NATIVE_GIT_EXECUTABLE] : resolveCliCommand("git");
  assert.equal(git?.length, 1);
  const author = join(root, "author.mjs"), verifier = join(root, "verifier.mjs"), facts = join(root, "facts.jsonl");
  writeFileSync(author, `import{mkdirSync,readFileSync,writeFileSync,appendFileSync}from'node:fs';import{join}from'node:path';
const w=process.argv[2],broker=JSON.parse(readFileSync(process.argv[3],'utf8'));
const response=await fetch(broker.url,{method:'POST',headers:{authorization:'Bearer '+broker.token,'content-type':'application/json'},
body:JSON.stringify({tool:'fetch',url:'https://example.com/'})});const fetched=await response.json();if(!response.ok)throw Error('Real fixture research retrieval failed: '+fetched.error);
const source=Object.fromEntries(['id','url','title','retrieved_at','content_digest'].map(key=>[key,fetched[key]]));
mkdirSync(join(w,'.artoo','product'),{recursive:true});mkdirSync(join(w,'product'));
writeFileSync(join(w,'.artoo','product','research.json'),JSON.stringify({version:1,objective:'Controlled native byte provenance fixture',assumptions:[],
requirements:[{id:'bytes',description:'Retain the native authored file',priority:'must',acceptance_criteria:['The product file retains its exact content']}],
sources:[source],findings:[{summary:'A real public reference was retrieved through the node-owned broker for this controlled fixture',source_ids:[source.id]}],decisions:[]}));
writeFileSync(join(w,'product','index.html'),'<!doctype html><title>Controlled native product bytes</title>');
appendFileSync(${JSON.stringify(facts)},JSON.stringify({kind:'author',pid:process.pid})+'\\n');`);
  writeFileSync(verifier, `import{readFileSync,appendFileSync}from'node:fs';import{join}from'node:path';
const c=JSON.parse(readFileSync(process.env.ARTOO_VERIFICATION_CONTEXT_FILE,'utf8'));
if(!readFileSync(join(c.context.workspace.root,'product','index.html'),'utf8').includes('Controlled native product bytes'))throw Error('wrong bytes');
appendFileSync(${JSON.stringify(facts)},JSON.stringify({kind:'verifier',pid:process.pid,request:c.request_id})+'\\n');`);
  const config = join(root, "static-web.json"); writeFileSync(config, JSON.stringify({ evidence_root: paths.evidence }));
  for (const file of [author, verifier, config]) readFileSync(file);
  const [source] = prepareVerificationProfiles([{ id: "source", project_id: "project", workspace_root: paths.source,
    subject_paths: [".artoo/product", "product"], required_files: [], commands: [{ id: "check", argv: [process.execPath, verifier], timeout_ms: 10000 }] }], [paths.source]);
  const cli = realpathSync.native(fileURLToPath(new URL("../dist/web-acceptance-cli.js", import.meta.url)));
  const destinationProfiles = ["destination", "failure"].map(name => prepareVerificationProfiles([{ id: name, project_id: "project", workspace_root: paths[name],
    subject_paths: [".artoo/product", "product"], required_files: [], commands: [{ id: "browser", argv: [process.execPath, cli, config], timeout_ms: 10000,
      observation: { format: "static-web-acceptance.v1", evidence_root: paths.evidence, capabilities: { version: 1 } } }] }], [paths[name]])[0]);
  for (const profile of [source, ...destinationProfiles]) attachWindowsVerificationBackend(profile, backend);
  const sourceRuntime = prepareProductSourceRuntime({ nodeId: "source-node", storeRoot: paths["source-store"], allowedRoots: [paths.source],
    profiles: [source], gitExecutable: git[0], windowsBackend: backend });
  const makeDestinationRuntime = (name, profile) => prepareProductSourceRuntime({ nodeId: "destination-node", storeRoot: paths[`${name}-store`],
    allowedRoots: [paths[name]], profiles: [profile], gitExecutable: git[0], windowsBackend: backend });
  let destinationRuntime = makeDestinationRuntime("destination", destinationProfiles[0]);
  const failureRuntime = makeDestinationRuntime("failure", destinationProfiles[1]);
  assert.throws(() => closeProductSourceRuntime({}), /original live local runtime/);
  const context = ContextPackSchema.parse({ task: { id: "task", title: "Controlled native source", description: "Byte provenance fixture", acceptance_criteria: [] },
    project: { id: "project", name: "Fixture", default_workspace: paths.source }, workspace: { root: paths.source, file_scope: [] },
    policy: { filesystem_write_scope: [paths.source], requires_approval: [] }, memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] },
    product_development: productDevelopmentContext("research"), goal_context: { version: 1, goal_id: "goal", objective: "Controlled fixture", acceptance_criteria: [],
      plan: { id: "plan", version: 1, rationale: "Byte transport", spec_ref: null } } });
  const start = { run_id: "run", task_id: "task", agent_instance_id: "agent", runtime: "fixture", workspace: { root: paths.source },
    context_pack: { id: "context", payload: context }, policy_snapshot: { filesystem_write_scope: [paths.source], requires_approval: [] },
    artifact_rules: { paths: [] }, verification: { version: 1, profile_id: "source", request_id: "verify" } };
  assert.throws(() => assertFinalVerificationExportBinding(source, { outcome: "passed" }, "verify", context), /original|final verification/);
  const messages = []; let dispatch;
  const client = createNodeClient({ nodeId: "source-node", workspace: { allowedRoots: [paths.source] }, verificationProfiles: [source], productSourceRuntime: sourceRuntime,
    registry: createAdapterRegistry([{ runtime: "fixture", adapter: createProcessAdapter({ runtimeId: "fixture", allowedRoots: [paths.source],
      artifacts: [], research: { receiptDirectory: join(root, "research-receipts") },
      command: [process.execPath, author, "{{workspace_root}}", "{{research_config_path}}"] }) }]),
    transport: { send: async value => { messages.push(value); }, subscribe: handler => { dispatch = handler; return () => {}; } } });
  client.start();
  dispatch({ kind: "command", id: "missing-start", idempotency_key: "missing-run:start", type: "run.start",
    payload: { ...start, run_id: "missing-run", runtime: "missing" } });
  while (!messages.some(message => message.kind === "command.ack" && message.command_id === "missing-start")) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(messages.find(message => message.command_id === "missing-start").status, "rejected");
  // This new claim proves a known pre-process failure released exclusive occupancy.
  await new Promise(resolve => setTimeout(resolve, 10));
  claimProductSourceRun(sourceRuntime, "after-rejected-start", paths.source); releaseProductSourceRun(sourceRuntime, "after-rejected-start");
  dispatch({ kind: "command", id: "start", idempotency_key: "run:start", type: "run.start", payload: start });
  const deadline = Date.now() + 60000;
  while (!messages.some(message => message.kind === "run.event" && message.event.type === "run.lifecycle" && message.event.payload.phase === "completed")) {
    assert.equal(messages.some(message => message.kind === "command.ack" && message.command_id === "start" && message.status === "rejected"), false, JSON.stringify(messages));
    assert.equal(messages.some(message => message.kind === "run.event" && message.event.type === "run.lifecycle" && message.event.payload.phase === "failed"), false, JSON.stringify(messages));
    assert.ok(Date.now() < deadline, JSON.stringify(messages)); await new Promise(resolve => setTimeout(resolve, 25));
  }
  const verificationEvent = messages.find(message => message.event?.type === "run.verification");
  assert.equal(verificationEvent.event.payload.outcome, "passed", verificationEvent.event.payload.reason);
  assert.throws(() => assertFinalVerificationExportBinding(source, structuredClone(verificationEvent.event.payload), "verify", context), /original|final verification/);
  const exported = messages.find(message => message.event?.type === "run.product-source.export.v1"), proof = ProductSourceExportV1Schema.parse(exported?.event.payload);
  assert.equal(exported.sequence, verificationEvent.sequence + 1);
  assert.equal(messages.find(message => message.event?.type === "run.lifecycle" && message.event.payload.phase === "completed").sequence, exported.sequence + 1);
  await client.stop(true); closeProductSourceRuntime(sourceRuntime);
  // Reopen proves sealed upload state survives a node runtime restart.
  const reopenedSource = prepareProductSourceRuntime({ nodeId: "source-node", storeRoot: paths["source-store"], allowedRoots: [paths.source],
    profiles: [source], gitExecutable: git[0], windowsBackend: backend });
  const request = ProductSourceTransferRequestV1Schema.parse({ version: 1, kind: "product-source-transfer.v1", transfer_id: "transfer", organization_id: "organization",
    project_id: "project", goal_id: "goal", plan_id: "plan", authorization: { actor_user_id: "user", consent_id: null, policy_version: "policy" },
    source: { node_id: "source-node", task_id: "task", run_id: "run", evidence_id: "evidence", verification_request_id: "verify", profile_id: "source",
      profile_digest: source.digest, workspace_root: paths.source, subject_digest: proof.subject_digest, review_id: "review", reviewer_run_id: "review-run",
      reviewer_evidence_id: "review-evidence", capsule_digest: proof.capsule_digest, manifest_digest: proof.manifest_digest, capsule_bytes: proof.capsule_bytes },
    destination: { node_id: "destination-node", profile_id: "destination", workspace_root: paths.destination, capabilities: destinationProfiles[0].capabilities,
      capability_digest: hash(destinationProfiles[0].capabilities) } });
  const digest = productSourceTransferRequestDigestV1(request, sha), token = "sk_device_fixture_fixturesecret";
  let mode = "normal", stored, requests = 0;
  const http = createServer((req, res) => {
    requests++;
    if (req.url !== "/api/v1/node/product-source-transfers/transfer/content" || req.headers.authorization !== `Bearer ${token}`
      || req.headers["x-artoo-transfer-request-digest"] !== digest) { res.writeHead(403); res.end(); return; }
    if (mode === "redirect") { res.writeHead(302, { location: "http://127.0.0.1:1/leak" }); res.end(); return; }
    if (req.method === "PUT") {
      const chunks = []; req.on("data", bytes => chunks.push(bytes)); req.on("end", () => {
        stored = Buffer.concat(chunks); assert.equal(sha(stored), proof.capsule_digest);
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ transfer: { version: 1, transfer_id: "transfer", request_digest: digest,
          capsule_digest: proof.capsule_digest, status: "available", execution_authorized: false } }));
      });
    } else { res.writeHead(200, { "content-type": "application/octet-stream", "x-artoo-transfer-request-digest": digest,
      "x-artoo-checksum": mode === "bad-checksum" ? sha("wrong") : proof.capsule_digest }); res.end(stored); }
  });
  await new Promise(resolve => http.listen(0, "127.0.0.1", resolve));
  const serverOrigin = `http://127.0.0.1:${http.address().port}`;
  try {
    const uploader = createProductSourceTransferClient({ serverOrigin, nodeToken: token, runtime: reopenedSource });
    const receiver = createProductSourceTransferClient({ serverOrigin, nodeToken: token, runtime: destinationRuntime });
    assert.throws(() => createProductSourceTransferClient({ serverOrigin: `${serverOrigin}/arbitrary`, nodeToken: token, runtime: reopenedSource }), /exact server origin/);
    await assert.rejects(uploader.upload({ ...request, source: { ...request.source, task_id: "other-task" } }), /stored export proof differs/);
    assert.equal(requests, 0); await uploader.upload(request); assert.ok(stored);
    mode = "redirect"; await assert.rejects(receiver.downloadAndImport(request)); assert.deepEqual(readdirSync(paths.destination), []);
    mode = "bad-checksum"; await assert.rejects(receiver.downloadAndImport(request), /binding differs/); assert.deepEqual(readdirSync(paths.destination), []);
    mode = "normal";
    claimProductSourceRun(destinationRuntime, "occupied", paths.destination);
    await assert.rejects(receiver.downloadAndImport(request), /occupied/); releaseProductSourceRun(destinationRuntime, "occupied");
    const ready = await receiver.downloadAndImport(request);
    assert.equal(ready.execution_authorized, false); assert.equal(ready.verification_passed, false); assert.equal(ready.semantic_mapping_accepted, false);
    assert.equal(ready.git_processes_closed, true); assert.ok(existsSync(join(paths.destination, ".git", "HEAD")));
    assert.equal(readFileSync(join(paths.destination, "product", "index.html"), "utf8"), readFileSync(join(paths.source, "product", "index.html"), "utf8"));
    assert.deepEqual(await receiver.downloadAndImport(request), ready);
    assert.throws(() => assertProductSourceWorkspaceBoundary(destinationRuntime, paths.destination), /retained product source import/);
    await assert.rejects(importProductSourceTransfer(destinationRuntime, { ...request, authorization: { ...request.authorization, policy_version: "changed" } }, digest, stored), /digest differs/);
    closeProductSourceRuntime(destinationRuntime); destinationRuntime = makeDestinationRuntime("destination", destinationProfiles[0]);
    assert.deepEqual(readProductSourceImportReady(destinationRuntime, request, digest), ready);
    assert.throws(() => claimProductSourceRun(destinationRuntime, "ordinary", paths.destination), /retained product source import/);
    closeProductSourceRuntime(destinationRuntime);
    const failedRequest = structuredClone(request); failedRequest.transfer_id = "failed-transfer";
    failedRequest.destination = { node_id: "destination-node", profile_id: "failure", workspace_root: paths.failure,
      capabilities: destinationProfiles[1].capabilities, capability_digest: hash(destinationProfiles[1].capabilities) };
    const failedDigest = productSourceTransferRequestDigestV1(failedRequest, sha), abort = new AbortController();
    const timer = setInterval(() => { if (readdirSync(join(paths["failure-store"], "operations")).length > 1) abort.abort(); }, 2);
    try { await assert.rejects(importProductSourceTransfer(failureRuntime, failedRequest, failedDigest, stored, abort.signal), /incomplete.*retained/); }
    finally { clearInterval(timer); }
    assert.throws(() => closeProductSourceRuntime(failureRuntime), /uncertain work/);
    assert.throws(() => assertProductSourceWorkspaceBoundary(failureRuntime, paths.failure), /retained product source import/);
    await assert.rejects(importProductSourceTransfer(failureRuntime, failedRequest, failedDigest, stored), /pending or uncertain/);
    closeProductSourceRuntime(reopenedSource);
    console.log(JSON.stringify({ scope: "controlled-native-byte-provenance", root, helper_manifest: manifestDigest, export: proof,
      ready, native_facts: readFileSync(facts, "utf8"), fixed_http_requests: requests, expected_failure_retained: paths["failure-store"] }));
  } finally { await new Promise(resolve => http.close(resolve)); }
});
