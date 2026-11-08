// Built POSIX integration tests. The author is explicitly a deterministic test
// adapter; the node's verifier executes real subprocesses and owns their exits.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createNodeClient } from "../dist/node-client.js";
import { takeWorkspaceToolVerifier, takeWorkspaceToolEvidenceReader } from "../dist/workspace-tools.js";
import { VerificationCleanupError, verificationSupported } from "../dist/verification.js";
import { productDevelopmentContext } from "@artoo/domain";

const waitFor = async (predicate) => {
  const until = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() > until) throw new Error("Node tool integration timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
function fixture(body) {
  const root = mkdtempSync(join(tmpdir(), "artoo-workspace-node-")), workspace = join(root, "workspace");
  mkdirSync(join(workspace, "product"), { recursive: true });
  mkdirSync(join(workspace, ".artoo", "product"), { recursive: true });
  // These placeholder bytes exercise inventory/dispatch, not research quality.
  writeFileSync(join(workspace, ".artoo", "product", "research.json"), "{}");
  const source = join(workspace, "product", "index.txt"); writeFileSync(source, "broken");
  const log = join(root, "invocations.jsonl"), script = join(root, "verifier.mjs");
  writeFileSync(script, `import{readFileSync,appendFileSync,writeFileSync}from'node:fs';
const context=JSON.parse(readFileSync(process.env.ARTOO_VERIFICATION_CONTEXT_FILE,'utf8'));
const source=readFileSync('product/index.txt','utf8');
appendFileSync(${JSON.stringify(log)},JSON.stringify({id:context.request_id,source,pid:process.pid})+'\\n');
${body ?? "if(source!=='ok'){console.error('Expected ok product');process.exitCode=9;}"}`);
  const profile = { id: "acceptance", project_id: "project_1", workspace_root: workspace,
    commands: [{ id: "check", argv: [process.execPath, script], timeout_ms: 10000 }], required_files: [], subject_paths: ["product", ".artoo/product"] };
  const request = { kind: "command", id: "start", idempotency_key: "run_1:start", type: "run.start", payload: {
    run_id: "run_1", task_id: "task_1", agent_instance_id: "instance_1", runtime: "fixture", workspace: { root: workspace },
    context_pack: { id: "context_1", payload: {
      task: { id: "task_1", title: "T", description: "", acceptance_criteria: ["works"] },
      project: { id: "project_1", name: "P", default_workspace: workspace }, workspace: { root: workspace, file_scope: [] },
      policy: { requires_approval: [], filesystem_write_scope: [workspace] }, memory: { task_summary: null, project_notes: [] },
      artifacts: { expected: [] }, product_development: { ...productDevelopmentContext("research"), accepted_inputs: { version: 1, files: [] } },
    } }, policy_snapshot: { filesystem_write_scope: [workspace], requires_approval: [] }, artifact_rules: { paths: [] },
    verification: { version: 1, profile_id: "acceptance", request_id: "verification_final" },
  } };
  return { root, workspace, source, profile, request, log,
    invocations: () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) : [],
    close: () => rmSync(root, { recursive: true, force: true }) };
}
function node(f, runAuthor) {
  const events = []; let subscriber, verify, readEvidence, stopped = false;
  const adapter = { runtimeId: "fixture", async start(config) {
    verify = takeWorkspaceToolVerifier(config); assert.equal(typeof verify, "function");
    readEvidence = takeWorkspaceToolEvidenceReader(config);
    assert.equal(takeWorkspaceToolVerifier(config), undefined); return { runId: "run_1" };
  }, async *streamEvents() {
    yield { type: "run.lifecycle", payload: { phase: "started" } };
    await runAuthor((signal = new AbortController().signal) => verify(signal), events, readEvidence);
    yield { type: "run.lifecycle", payload: { phase: stopped ? "cancelled" : "completed" } };
  }, async stop() { stopped = true; }, async collectArtifacts() { return []; } };
  const transport = { send: async (message) => { events.push(message); }, subscribe: (handler) => { subscriber = handler; return () => {}; } };
  const client = createNodeClient({ nodeId: "node_1", adapter, transport, verificationProfiles: [f.profile] }); client.start();
  return { client, events, send: (command) => subscriber(command) };
}
const receiptEvents = (events) => events.filter((item) => item.kind === "run.event" && item.event.type === "run.verification");
const terminal = (events) => events.find((item) => item.kind === "run.event" && item.event.type === "run.lifecycle"
  && ["completed", "cancelled", "failed"].includes(item.event.payload.phase));

test("in-task diagnostics run the bound profile with unique IDs and final verification runs again", { skip: !verificationSupported() }, async () => {
  const f = fixture();
  const n = node(f, async (verify, events) => {
    const failure = await verify(), failed = failure.verification; assert.equal(failed.outcome, "failed"); assert.match(failed.reason, /Expected ok product/);
    assert.match(failure.diagnostics.commands[0].stderr_excerpt, /Expected ok product/);
    writeFileSync(f.source, "ok");
    const passed = (await verify()).verification; assert.equal(passed.outcome, "passed");
    assert.equal(receiptEvents(events).length, 0, "previews cannot create accepted run evidence");
    assert.notEqual(failed.request_id, passed.request_id); assert.match(passed.request_id, /^preview_/);
  });
  try {
    n.send(f.request); await waitFor(() => terminal(n.events));
    const receipts = receiptEvents(n.events); assert.equal(receipts.length, 1);
    assert.equal(receipts[0].event.payload.request_id, "verification_final"); assert.equal(receipts[0].event.payload.outcome, "passed");
    const invocations = f.invocations(); assert.equal(invocations.length, 3); assert.equal(new Set(invocations.map((item) => item.id)).size, 3);
  } finally { await n.client.stop(true); f.close(); }
});

test("successful preview cannot authorize source changed before final exit", { skip: !verificationSupported() }, async () => {
  const f = fixture();
  const n = node(f, async (verify) => {
    writeFileSync(f.source, "ok"); assert.equal((await verify()).verification.outcome, "passed");
    writeFileSync(f.source, "broken again");
  });
  try {
    n.send(f.request); await waitFor(() => terminal(n.events));
    const receipts = receiptEvents(n.events); assert.equal(receipts.length, 1); assert.equal(receipts[0].event.payload.outcome, "failed");
    assert.deepEqual(f.invocations().map((item) => item.source), ["ok", "broken again"]);
  } finally { await n.client.stop(true); f.close(); }
});

test("node grants author preview images and gives a later peer only the final source-bound evidence", { skip: !verificationSupported(), timeout: 30000 }, async () => {
  const f = fixture(), evidenceRoot = join(f.root, "evidence"); mkdirSync(evidenceRoot);
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a54cAAAAASUVORK5CYII=";
  // This is a declared file-only verifier fixture, not evidence of browser rendering.
  writeFileSync(f.profile.commands[0].argv[1], `import{readFileSync,mkdirSync,writeFileSync}from'node:fs';import{createHash}from'node:crypto';import{join}from'node:path';
const c=JSON.parse(readFileSync(process.env.ARTOO_VERIFICATION_CONTEXT_FILE,'utf8')),sha=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
const root=join(${JSON.stringify(evidenceRoot)},sha(c.request_id).slice(7));mkdirSync(root);
const png=Buffer.from(${JSON.stringify(png)},'base64');writeFileSync(join(root,'fixture-1.png'),png);
const result={version:1,format:'static-web-acceptance.v1',stage:'design',passed:true,requirements:1,cases:[{case_id:'fixture',viewport:1,assertions:0,screenshot_digest:sha(png)}]};
writeFileSync(join(root,'result.json'),JSON.stringify(result));console.log(JSON.stringify(result));`);
  f.profile.commands[0].observation = { format: "static-web-acceptance.v1", evidence_root: evidenceRoot };
  writeFileSync(join(f.workspace, ".artoo/product/design.json"), "{}");
  f.request.payload.context_pack.payload.product_development = productDevelopmentContext("design");
  let previewRef;
  const n = node(f, async (verify, _events, readEvidence) => {
    const preview = await verify(), observation = preview.verification.checks[0].observation;
    assert.equal(observation.scope, "preview"); previewRef = observation.cases[0].screenshot_ref;
    const image = await readEvidence(previewRef); assert.equal(image.mime_type, "image/png"); assert.equal(image.data, png);
    assert.equal(image.provenance.subjectDigest, preview.verification.subject_digest);
    await assert.rejects(readEvidence("image_other_session"), /not granted/);
  });
  let peer;
  try {
    n.send(f.request); await waitFor(() => terminal(n.events));
    const final = receiptEvents(n.events)[0].event.payload; assert.equal(final.outcome, "passed");
    const observation = final.checks[0].observation; assert.equal(observation.scope, "final");
    assert.notEqual(observation.cases[0].screenshot_ref, previewRef);
    await n.client.stop(true);
    const events = []; let send;
    const context = structuredClone(f.request.payload.context_pack.payload); delete context.product_development;
    context.task.id = "review_task";
    context.policy = { execution_mode: "discussion", filesystem_write_scope: [], requires_approval: [] };
    context.review_subject = { version: 1, task_id: "task_1", run_id: "run_1", evidence_id: "node_evidence", subject_digest: final.subject_digest, development_stage: "design",
      verification: { version: 1, request_id: final.request_id, profile_id: final.profile_id, profile_digest: final.profile_digest,
        checks: final.checks.map(({ id, output_digest, observation }) => ({ id, output_digest, observation })) } };
    peer = createNodeClient({ nodeId: "node_1", verificationProfiles: [f.profile], transport: { send: async event => { events.push(event); }, subscribe: handler => { send = handler; return () => {}; } },
      adapter: { runtimeId: "fixture", async start(config) {
        assert.equal(takeWorkspaceToolVerifier(config), undefined); const read = takeWorkspaceToolEvidenceReader(config); assert.equal(typeof read, "function");
        const image = await read(observation.cases[0].screenshot_ref); assert.equal(image.data, png); assert.equal(image.provenance.scope, "final");
        await assert.rejects(read(previewRef), /not granted/); return { runId: "peer" };
      }, async *streamEvents() { yield { type: "run.lifecycle", payload: { phase: "completed" } }; }, async stop() {}, async collectArtifacts() { return []; } } });
    peer.start();
    send({ ...f.request, id: "peer_start", idempotency_key: "peer:start", payload: { ...f.request.payload, run_id: "peer", task_id: "review_task", context_pack: { id: "peer_context", payload: context },
      verification: { version: 1, profile_id: final.profile_id, request_id: "peer_final", expected_subject_digest: final.subject_digest } } });
    await waitFor(() => terminal(events));
    assert.equal(events.find(event => event.command_id === "peer_start").status, "accepted");
    assert.equal(receiptEvents(events)[0].event.payload.outcome, "passed");
  } finally { await peer?.stop(true); await n.client.stop(true); f.close(); }
});

test("run cancellation waits for the real in-task verifier process to exit", { skip: !verificationSupported() }, async () => {
  const f = fixture("setInterval(()=>{},1000);"); let observed;
  const n = node(f, async (verify) => { observed = await verify(); });
  try {
    n.send(f.request); await waitFor(() => f.invocations().length === 1);
    const pid = f.invocations()[0].pid;
    n.send({ kind: "command", id: "stop", idempotency_key: "run_1:stop", type: "run.stop", payload: { run_id: "run_1", reason: "user_cancelled" } });
    await waitFor(() => n.events.some((event) => event.kind === "command.ack" && event.command_id === "stop"));
    assert.equal(n.events.find((event) => event.kind === "command.ack" && event.command_id === "stop").status, "accepted");
    assert.equal(observed.verification.outcome, "cancelled"); assert.equal(receiptEvents(n.events).length, 0);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally { await n.client.stop(true); f.close(); }
});

test("simulated unconfirmed verifier at adapter startup retains the workspace and denies false stop/resume confirmation", { skip: !verificationSupported() }, async () => {
  const f = fixture(), events = []; let subscriber, attempts = 0;
  const adapter = { runtimeId: "fixture", async start() { attempts++; throw new VerificationCleanupError("Injected unconfirmed closure"); },
    async *streamEvents() {}, async stop() { throw new Error("No physical handle was returned"); }, async collectArtifacts() { return []; } };
  const client = createNodeClient({ nodeId: "node_1", adapter, verificationProfiles: [f.profile], transport: {
    send: async (message) => { events.push(message); }, subscribe: (handler) => { subscriber = handler; return () => {}; },
  } });
  client.start();
  try {
    subscriber(f.request);
    await waitFor(() => events.some((event) => event.command_id === "start"));
    subscriber({ ...f.request, id: "second", idempotency_key: "run_2:start", payload: { ...f.request.payload, run_id: "run_2" } });
    subscriber({ kind: "command", id: "stop", idempotency_key: "run_1:stop", type: "run.stop", payload: { run_id: "run_1", reason: "user_cancelled" } });
    subscriber({ kind: "command", id: "resume", idempotency_key: "run_1:resume", type: "run.resume", payload: { run_id: "run_1" } });
    await waitFor(() => ["second", "stop", "resume"].every((id) => events.some((event) => event.command_id === id)));
    for (const id of ["second", "stop", "resume"]) assert.equal(events.find((event) => event.command_id === id).status, "rejected");
    assert.equal(attempts, 1);
    await assert.rejects(client.stop(true), /closure remains unconfirmed/);
  } finally { await client.stop(false); f.close(); }
});
