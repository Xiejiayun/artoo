// Run after building: node --test apps/artood/test-fixtures/verification-real.test.mjs
// Uses actual subprocesses/process groups; no injected lifecycle or success fixtures.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { prepareVerificationProfiles, runVerification, runVerificationPreview, verificationSupported, selectVerificationProfile, subjectManifest } from "../dist/verification.js";
import { createNodeClient } from "../dist/node-client.js";
import { createProcessAdapter } from "../dist/process-adapter.js";

function fixture(body, temporaryRoot = tmpdir()) {
  // macOS tmpdir can use /var while profiles bind its physical /private/var path.
  // Construct requests from the same physical root; production still rejects aliases.
  const root = realpathSync.native(mkdtempSync(join(temporaryRoot, "artoo-real-verification-")));
  const workspace = join(root, "product"); mkdirSync(workspace); writeFileSync(join(workspace, "index.txt"), "expected");
  const script = join(root, "verify.mjs"); writeFileSync(script, body);
  const profile = { id: "acceptance", project_id: "project_1", workspace_root: workspace,
    commands: [{ id: "check", argv: [process.execPath, script], timeout_ms: 5000 }], required_files: ["index.txt"], subject_paths: ["index.txt"] };
  return { root, workspace, script, profile, close: () => rmSync(root, { recursive: true, force: true }) };
}
const requestFor = (f) => ({ kind: "command", id: "start", idempotency_key: "run_1:start", type: "run.start", payload: {
  run_id: "run_1", task_id: "task_1", agent_instance_id: "instance_1", runtime: "fixture", workspace: { root: f.workspace },
  context_pack: { id: "context_1", payload: { task: { id: "task_1", title: "T", description: "", acceptance_criteria: ["works"] },
    project: { id: "project_1", name: "P", default_workspace: f.workspace }, workspace: { root: f.workspace, file_scope: [] },
    policy: { requires_approval: [], filesystem_write_scope: [f.workspace] }, memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] } } },
  policy_snapshot: { filesystem_write_scope: [f.workspace], requires_approval: [] }, artifact_rules: { paths: [] },
  verification: { version: 1, profile_id: "acceptance", request_id: "verification_1" },
} });
async function waitFor(predicate) {
  const deadline = Date.now() + 10000;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error("timed out"); await new Promise((resolve) => setTimeout(resolve, 10)); }
}
function node(f) {
  const events = []; let subscriber, starts = 0, stops = 0;
  const transport = { send: async (event) => { events.push(event); }, subscribe: (fn) => { subscriber = fn; return () => {}; } };
  const adapter = { runtimeId: "fixture", async start() { starts++; return { runId: "run_1" }; },
    async *streamEvents() { yield { type: "run.lifecycle", payload: { phase: "started" } }; yield { type: "run.lifecycle", payload: { phase: "completed" } }; },
    async stop() { stops++; }, async collectArtifacts() { return []; } };
  const client = createNodeClient({ nodeId: "node_1", adapter, transport, verificationProfiles: [f.profile] }); client.start();
  return { events, client, send: (request) => subscriber(request), starts: () => starts, stops: () => stops };
}

test("temporary parent aliases yield physical fixtures while aliased requests remain rejected", { skip: !verificationSupported() }, () => {
  const parent = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-verification-parent-")));
  const physical = join(parent, "physical"), alias = join(parent, "alias");
  let f;
  try {
    mkdirSync(physical); symlinkSync(physical, alias, "dir");
    f = fixture("process.exit(0)", alias);
    const [profile] = prepareVerificationProfiles([f.profile]);
    assert.equal(f.root, realpathSync.native(f.root));
    assert.equal(f.workspace, profile.workspace_root);
    assert.equal(selectVerificationProfile(requestFor(f).payload, [profile], false), profile);
    const aliased = requestFor({ ...f, workspace: join(alias, basename(f.root), "product") }).payload;
    assert.notEqual(aliased.workspace.root, profile.workspace_root);
    assert.equal(realpathSync.native(aliased.workspace.root), profile.workspace_root);
    assert.throws(() => selectVerificationProfile(aliased, [profile], false), /verification workspace mismatch/);
  } finally { f?.close(); rmSync(parent, { recursive: true, force: true }); }
});

const browserReport = { version: 1, format: "static-web-acceptance.v1", stage: "design", passed: true, requirements: 17,
  cases: [390, 1280].map((viewport) => ({ case_id: "prototype", viewport, assertions: 0, screenshot_digest: `sha256:${"a".repeat(64)}` })) };
function observationFixture(body) {
  const f = fixture(body);
  mkdirSync(join(f.workspace, ".artoo/product"), { recursive: true }); mkdirSync(join(f.workspace, "product"));
  writeFileSync(join(f.workspace, ".artoo/product/research.json"), "{}");
  writeFileSync(join(f.workspace, ".artoo/product/design.json"), "{}");
  writeFileSync(join(f.workspace, "product/index.html"), "prototype");
  f.profile.required_files = []; f.profile.subject_paths = [".artoo/product", "product"];
  f.profile.commands[0].observation = { format: "static-web-acceptance.v1" };
  const context = requestFor(f).payload.context_pack.payload;
  context.product_development = { version: 1, stage: "design", deliverables: [{ path: ".artoo/product/design.json", format: "json", purpose: "Design" }], instructions: ["Preserve research"] };
  return { ...f, context };
}

test("actual protected output adds only opt-in measured scope with explicit preview/final binding", { skip: !verificationSupported() }, async () => {
  const f = observationFixture(`console.log(${JSON.stringify(JSON.stringify(browserReport))});`);
  try {
    const profile = prepareVerificationProfiles([f.profile])[0];
    const preview = await runVerificationPreview(profile, "ordinary_request_name", new AbortController().signal, f.context);
    assert.equal(preview.verification.outcome, "passed");
    assert.deepEqual(preview.verification.checks[0].observation, { version: 1, format: browserReport.format, scope: "preview", stage: "design", cases: browserReport.cases });
    assert.match(preview.diagnostics.commands[0].stdout_excerpt, /prototype/);
    assert.equal(preview.diagnostics.commands[0].output_digest, preview.verification.checks[0].output_digest);
    const final = await runVerification(profile, "preview_named_final_request", new AbortController().signal, f.context);
    assert.equal(final.checks[0].observation.scope, "final");
    assert.equal("requirements" in final.checks[0].observation, false);
    assert.equal("diagnostics" in final, false);
    const generic = prepareVerificationProfiles([{ ...f.profile, commands: f.profile.commands.map(({ observation, ...command }) => command) }])[0];
    const legacy = await runVerification(generic, "legacy", new AbortController().signal, f.context);
    assert.equal(legacy.outcome, "passed"); assert.equal(legacy.checks[0].observation, undefined);
  } finally { f.close(); }
});

test("malformed reports, mismatched stages, source mutation and cancellation cannot expose successful scope", { skip: !verificationSupported() }, async () => {
  for (const [body, cancelled] of [
    ["console.log('not json');", false],
    [`console.log(${JSON.stringify(JSON.stringify({ ...browserReport, stage: "implementation" }))});`, false],
    [`import{writeFileSync}from'node:fs';console.log(${JSON.stringify(JSON.stringify(browserReport))});writeFileSync('product/index.html','changed');`, false],
    [`console.log(${JSON.stringify(JSON.stringify(browserReport))});setTimeout(()=>{},10000);`, true],
  ]) {
    const f = observationFixture(body), controller = new AbortController(); let timer;
    try {
      const profile = prepareVerificationProfiles([f.profile])[0];
      if (cancelled) timer = setTimeout(() => controller.abort(), 150);
      const result = await runVerificationPreview(profile, "bad", controller.signal, f.context);
      assert.equal(result.verification.outcome, cancelled ? "cancelled" : "failed");
      assert.ok(result.verification.checks.every((check) => check.observation === undefined));
    } finally { clearTimeout(timer); f.close(); }
  }
});

test("preview logs redact entire bounded output before truncation and never enter the final receipt", { skip: !verificationSupported() }, async () => {
  const secret = "s".repeat(3000);
  const f = fixture(`console.log('api_key=${secret}');console.error('x'.repeat(5000)+' authorization: Bearer private-token-value');`);
  try {
    const profile = prepareVerificationProfiles([f.profile])[0];
    const preview = await runVerificationPreview(profile, "logs", new AbortController().signal);
    assert.equal(preview.verification.outcome, "passed");
    const diagnostic = preview.diagnostics.commands[0];
    assert.match(diagnostic.stdout_excerpt, /api_key=\[redacted\]/);
    assert.equal(diagnostic.stdout_excerpt.includes("s".repeat(32)), false);
    assert.equal(diagnostic.stderr_excerpt.includes("private-token-value"), false);
    assert.equal(diagnostic.stderr_truncated, true); assert.ok(diagnostic.stderr_excerpt.length <= 2048);
    const final = await runVerification(profile, "final_logs", new AbortController().signal);
    assert.equal(JSON.stringify(final).includes("private-token-value"), false);
    assert.equal("diagnostics" in final, false);
  } finally { f.close(); }
});
test("real verifier exit outcomes bind content and do not trust output claims", { skip: !verificationSupported() }, async () => {
  for (const status of [0, 7]) {
    const f = fixture(`import {readFileSync} from 'node:fs'; if(readFileSync('index.txt','utf8')!=='expected')process.exit(8);console.log('{"outcome":"passed"}');console.error('assertion: expected Start button; api_key=must-not-appear-in-receipt');process.exit(${status});`);
    try {
      const [profile] = prepareVerificationProfiles([f.profile]);
      const evidence = await runVerification(profile, "request_1", new AbortController().signal);
      assert.equal(evidence.outcome, status === 0 ? "passed" : "failed"); assert.equal(evidence.checks[0].exit_code, status);
      assert.match(evidence.subject_digest, /^sha256:[a-f0-9]{64}$/); assert.equal(evidence.required_files[0].size, 8);
      if (status !== 0) { assert.match(evidence.reason, /assertion: expected Start button/); assert.equal(evidence.reason.includes("must-not-appear-in-receipt"), false); assert.ok(evidence.reason.length <= 2000); }
    } finally { f.close(); }
  }
});

test("restricted peer review is source-bound before launch and after actual verifier checks", { skip: !verificationSupported() }, async () => {
  const f = fixture("import{readFileSync}from'node:fs';if(readFileSync('index.txt','utf8')!=='expected')process.exit(2)");
  try {
    const [profile] = prepareVerificationProfiles([f.profile]);
    const author = await runVerification(profile, "author", new AbortController().signal);
    assert.equal(author.outcome, "passed");
    const request = requestFor(f).payload;
    request.context_pack.payload.policy.execution_mode = "discussion";
    request.context_pack.payload.policy.filesystem_write_scope = [];
    assert.throws(() => selectVerificationProfile(request, [profile], false), /exact source digest/);
    request.verification.expected_subject_digest = author.subject_digest;
    assert.equal(selectVerificationProfile(request, [profile], false), profile);
    const peer = await runVerification(profile, "peer", new AbortController().signal, request.context_pack.payload, author.subject_digest);
    assert.equal(peer.outcome, "passed"); assert.equal(peer.subject_digest, author.subject_digest);
    writeFileSync(join(f.workspace, "index.txt"), "changed");
    assert.throws(() => selectVerificationProfile(request, [profile], false), /source changed/);
    const changed = await runVerification(profile, "changed", new AbortController().signal, request.context_pack.payload, author.subject_digest);
    assert.equal(changed.outcome, "failed"); assert.equal(changed.checks.length, 0); assert.match(changed.reason, /source changed/);
  } finally { f.close(); }
});

test("product-stage admission requires both metadata and the entire product tree in the measured subject", { skip: !verificationSupported() }, () => {
  const f = fixture("process.exit(0)");
  try {
    const request = requestFor(f).payload;
    request.context_pack.payload.product_development = { version: 1, stage: "research", deliverables: [{ path: ".artoo/product/research.json", format: "json", purpose: "Research handoff" }], instructions: ["Preserve sources"] };
    const profile = prepareVerificationProfiles([f.profile])[0];
    assert.throws(() => selectVerificationProfile(request, [profile], false), /include .artoo\/product/);
    const metadataOnly = prepareVerificationProfiles([{ ...f.profile, required_files: [], subject_paths: [".artoo/product"] }])[0];
    assert.throws(() => selectVerificationProfile(request, [metadataOnly], false), /complete product directory/);
    const complete = prepareVerificationProfiles([{ ...f.profile, required_files: [], subject_paths: [".artoo/product", "product"] }])[0];
    assert.equal(selectVerificationProfile(request, [complete], false), complete);
  } finally { f.close(); }
});

test("accepted upstream requirements cannot be weakened before author start or during verification", { skip: !verificationSupported() }, async () => {
  const f = fixture("process.exit(0)");
  const researchPath = ".artoo/product/research.json", designPath = ".artoo/product/design.json";
  const research = '{"requirements":["persist after reload"]}', design = '{"browser_steps":["save","reload","assert saved entry"]}';
  mkdirSync(join(f.workspace, ".artoo", "product"), { recursive: true }); mkdirSync(join(f.workspace, "product"));
  writeFileSync(join(f.workspace, researchPath), research); writeFileSync(join(f.workspace, designPath), design);
  writeFileSync(join(f.workspace, ".artoo/product/implementation.md"), "Implementation notes");
  f.profile = { ...f.profile, required_files: [], subject_paths: ["product", ".artoo/product"] };
  let n;
  try {
    const [profile] = prepareVerificationProfiles([f.profile]), before = subjectManifest(profile);
    const input = requestFor(f), context = input.payload.context_pack.payload;
    context.product_development = { version: 1, stage: "implementation", deliverables: [{ path: ".artoo/product/implementation.md", format: "markdown", purpose: "Implementation" }], instructions: ["Keep the accepted requirements"],
      accepted_inputs: { version: 1, files: [researchPath, designPath].map((path) => ({ ...before.files.get(path), source_task_id: "accepted_task", source_run_id: "accepted_run", evidence_id: "accepted_evidence" })) } };
    assert.equal(selectVerificationProfile(input.payload, [profile], false), profile);
    writeFileSync(join(f.workspace, designPath), '{"browser_steps":[]}');
    assert.throws(() => selectVerificationProfile(input.payload, [profile], false), /Accepted product input .*design.json changed/);
    n = node(f); n.send(input);
    await waitFor(() => n.events.some((event) => event.kind === "command.ack"));
    assert.equal(n.starts(), 0); assert.equal(n.events[0].status, "rejected");
    const failed = await runVerification(profile, "changed_before", new AbortController().signal, context);
    assert.equal(failed.outcome, "failed"); assert.equal(failed.checks.length, 0); assert.match(failed.reason, /Accepted product input .*design.json changed/);
    writeFileSync(join(f.workspace, designPath), design); writeFileSync(join(f.workspace, researchPath), '{"requirements":[]}');
    assert.throws(() => selectVerificationProfile(input.payload, [profile], false), /Accepted product input .*research.json changed/);
    writeFileSync(join(f.workspace, researchPath), research);
    writeFileSync(f.script, "import{writeFileSync}from'node:fs';writeFileSync('.artoo/product/design.json','{\"browser_steps\":[]}')");
    const [mutating] = prepareVerificationProfiles([f.profile]);
    const after = await runVerification(mutating, "changed_during", new AbortController().signal, context);
    assert.equal(after.checks[0].exit_code, 0); assert.equal(after.outcome, "failed"); assert.match(after.reason, /Accepted product input .*design.json changed/);
  } finally { await n?.client.stop(true); f.close(); }
});

test("author and peer receipts automatically inventory the real cumulative stage handoffs", { skip: !verificationSupported() }, async () => {
  const f = fixture("process.exit(0)");
  const stages = ["research", "design", "implementation", "validation"];
  const paths = [".artoo/product/research.json", ".artoo/product/design.json", ".artoo/product/implementation.md", ".artoo/product/validation.json"];
  mkdirSync(join(f.workspace, ".artoo", "product"), { recursive: true }); mkdirSync(join(f.workspace, "product"));
  f.profile = { ...f.profile, required_files: [], subject_paths: ["product", ".artoo/product"] };
  try {
    const [profile] = prepareVerificationProfiles([f.profile]); let previous;
    for (const [index, stage] of stages.entries()) {
      const request = requestFor(f).payload, context = request.context_pack.payload;
      const expectedInputs = paths.slice(0, Math.min(index, 2));
      context.product_development = { version: 1, stage, deliverables: [{ path: paths[index], format: index === 2 ? "markdown" : "json", purpose: stage }], instructions: ["Preserve inputs"],
        accepted_inputs: { version: 1, files: expectedInputs.map((path) => ({ ...previous.required_files.find((file) => file.path === path), source_task_id: "accepted_task", source_run_id: "accepted_run", evidence_id: "accepted_evidence" })) } };
      assert.equal(selectVerificationProfile(request, [profile], false), profile);
      writeFileSync(join(f.workspace, paths[index]), `actual ${stage} handoff`);
      const author = await runVerification(profile, `author_${stage}`, new AbortController().signal, context);
      assert.equal(author.outcome, "passed", author.reason); assert.deepEqual(author.required_files.map((file) => file.path), paths.slice(0, index + 1));
      for (const file of author.required_files) assert.deepEqual(file, subjectManifest(profile).files.get(file.path));
      delete context.product_development;
      context.policy.execution_mode = "discussion"; context.policy.filesystem_write_scope = [];
      context.review_subject = { version: 1, task_id: request.task_id, run_id: request.run_id, evidence_id: "author_evidence", subject_digest: author.subject_digest, development_stage: stage };
      request.verification.expected_subject_digest = author.subject_digest;
      assert.equal(selectVerificationProfile(request, [profile], false), profile);
      const peer = await runVerification(profile, `peer_${stage}`, new AbortController().signal, context, author.subject_digest);
      assert.equal(peer.outcome, "passed", peer.reason); assert.deepEqual(peer.required_files, author.required_files);
      previous = author;
    }
  } finally { f.close(); }
});
test("mutation, missing files, changed verifier, symlink subjects and unbounded output fail", { skip: !verificationSupported() }, async () => {
  for (const scenario of ["mutation", "missing", "verifier", "symlink", "output"]) {
    const body = scenario === "mutation" ? "import{writeFileSync}from'node:fs';writeFileSync('index.txt','changed')" : scenario === "output" ? "process.stdout.write('x'.repeat(2*1024*1024));setInterval(()=>{},1000)" : "process.exit(0)";
    const f = fixture(body);
    try {
      const [profile] = prepareVerificationProfiles([f.profile]);
      if (scenario === "missing") rmSync(join(f.workspace, "index.txt"));
      if (scenario === "verifier") writeFileSync(f.script, "process.exit(1)");
      if (scenario === "symlink") { rmSync(join(f.workspace, "index.txt")); symlinkSync(f.script, join(f.workspace, "index.txt")); }
      const evidence = await runVerification(profile, "request_1", new AbortController().signal);
      assert.equal(evidence.outcome, "failed", scenario);
      if (scenario === "mutation") assert.match(evidence.reason, /subject changed/);
      if (scenario === "output") {
        assert.match(evidence.reason, /output_limit/);
        assert.equal(evidence.checks.length, 1);
      }
    } finally { f.close(); }
  }
});
test("timeout and explicit cancellation close the real process group", { skip: !verificationSupported() }, async () => {
  for (const cancel of [false, true]) {
    const f = fixture("import{writeFileSync}from'node:fs';writeFileSync('pid.txt',String(process.pid));setInterval(()=>{},1000)");
    try {
      if (!cancel) f.profile.commands[0].timeout_ms = 300;
      const [profile] = prepareVerificationProfiles([f.profile]), controller = new AbortController();
      const pending = runVerification(profile, "request_1", controller.signal);
      await waitFor(() => existsSync(join(f.workspace, "pid.txt")));
      const pid = Number(readFileSync(join(f.workspace, "pid.txt"), "utf8"));
      if (cancel) controller.abort();
      const evidence = await pending;
      assert.equal(evidence.outcome, cancel ? "cancelled" : "timed_out");
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    } finally { f.close(); }
  }
});
test("node gates terminal delivery, keeps failed checks reviewable, and rejects unsupported workspace modes", { skip: !verificationSupported() }, async () => {
  for (const status of [0, 2]) {
    const f = fixture(`setTimeout(()=>process.exit(${status}),100)`), n = node(f);
    try {
      n.send(requestFor(f));
      await waitFor(() => n.events.some((event) => event.kind === "run.event" && event.event.type === "run.lifecycle" && event.event.payload.phase === "completed"));
      const verification = n.events.findIndex((event) => event.kind === "run.event" && event.event.type === "run.verification");
      const completion = n.events.findIndex((event) => event.kind === "run.event" && event.event.type === "run.lifecycle" && event.event.payload.phase === "completed");
      assert.ok(verification >= 0 && verification < completion); assert.equal(n.events[verification].event.payload.outcome, status === 0 ? "passed" : "failed");
      const changed = requestFor(f); changed.payload.verification.request_id = "different"; n.send(changed);
      await waitFor(() => n.events.some((event) => event.kind === "command.ack" && event.status === "rejected")); assert.equal(n.starts(), 1);
      const [profile] = prepareVerificationProfiles([f.profile]);
      for (const workspace of [{ ...requestFor(f).payload, workspace: { root: f.workspace, branch: "branch" } }, { ...requestFor(f).payload, workspace_allocation: { version: 1, strategy: "per-run", base_path: f.root } }]) assert.throws(() => selectVerificationProfile(workspace, [profile], false), /ordinary/);
      assert.throws(() => selectVerificationProfile(requestFor(f).payload, [profile], true), /ordinary/);
    } finally { await n.client.stop(true); f.close(); }
  }
});
test("node stop and shutdown cancel verification rather than only its completed coding handle", { skip: !verificationSupported() }, async () => {
  for (const shutdown of [false, true]) {
    const f = fixture("import{writeFileSync}from'node:fs';writeFileSync('pid.txt',String(process.pid));setInterval(()=>{},1000)"), n = node(f);
    try {
      n.send(requestFor(f)); await waitFor(() => existsSync(join(f.workspace, "pid.txt")));
      const pid = Number(readFileSync(join(f.workspace, "pid.txt"), "utf8"));
      assert.equal(n.events.some((event) => event.kind === "run.event" && event.event.type === "run.lifecycle" && event.event.payload.phase === "completed"), false);
      if (shutdown) await n.client.stop(true); else n.send({ kind: "command", id: "stop", idempotency_key: "run_1:stop", type: "run.stop", payload: { run_id: "run_1", reason: "user_cancelled" } });
      await waitFor(() => n.events.some((event) => event.kind === "run.event" && event.event.type === "run.verification"));
      assert.equal(n.events.find((event) => event.kind === "run.event" && event.event.type === "run.verification").event.payload.outcome, "cancelled");
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    } finally { await n.client.stop(true); f.close(); }
  }
});
test("node-owned verifier context ignores writer files and strips provider and interpreter environment", { skip: !verificationSupported() }, async () => {
  const f = fixture(`import assert from 'node:assert/strict';import{readFileSync,writeFileSync,mkdtempSync}from'node:fs';import{tmpdir}from'node:os';import{dirname,join}from'node:path';
    const path=process.env.ARTOO_VERIFICATION_CONTEXT_FILE;const supplied=JSON.parse(readFileSync(path,'utf8'));
    for(const key of ['TMPDIR','TMP','TEMP'])assert.equal(process.env[key],dirname(path));
    const temporary=mkdtempSync(join(tmpdir(),'legacy-child-'));writeFileSync(join(temporary,'cache'),'temporary');writeFileSync('temporary-location.txt',temporary);
    assert.equal(supplied.context.task.id,'task_1');assert.deepEqual(supplied.context.task.acceptance_criteria,['works']);
    assert.equal(process.env.ARTOO_CODEX_PROVIDER_KEY,undefined);assert.equal(process.env.NODE_OPTIONS,undefined);assert.equal(process.env.PYTHONPATH,undefined);
    assert.equal(path.startsWith(process.cwd()+'/'),false);writeFileSync('context-location.txt',path);`);
  const original = Object.fromEntries(["ARTOO_CODEX_PROVIDER_KEY", "NODE_OPTIONS", "PYTHONPATH"].map((key) => [key, process.env[key]]));
  let n;
  try {
    process.env.ARTOO_CODEX_PROVIDER_KEY = "must-not-leak"; process.env.NODE_OPTIONS = "--invalid-injected-option"; process.env.PYTHONPATH = "/malicious";
    writeFileSync(join(f.workspace, "context_pack.json"), JSON.stringify({ task: { acceptance_criteria: ["forged"] } }));
    n = node(f); n.send(requestFor(f));
    await waitFor(() => n.events.some((event) => event.kind === "run.event" && event.event.type === "run.lifecycle" && event.event.payload.phase === "completed"));
    assert.equal(n.events.find((event) => event.kind === "run.event" && event.event.type === "run.verification").event.payload.outcome, "passed");
    assert.equal(existsSync(readFileSync(join(f.workspace, "context-location.txt"), "utf8")), false);
    assert.equal(existsSync(readFileSync(join(f.workspace, "temporary-location.txt"), "utf8")), false);
  } finally {
    for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await n?.client.stop(true); f.close();
  }
});
test("cancellation terminates a descendant as well as its verifier parent", { skip: !verificationSupported() }, async () => {
  const f = fixture(`import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    process.on('SIGTERM',()=>{if(child.exitCode!==null||child.signalCode!==null)process.exit(0);child.once('exit',()=>process.exit(0));});
    child.once('spawn',()=>writeFileSync('pids.json',JSON.stringify([process.pid,child.pid])));setInterval(()=>{},1000);`);
  try {
    const [profile] = prepareVerificationProfiles([f.profile]), controller = new AbortController();
    const pending = runVerification(profile, "request_1", controller.signal);
    await waitFor(() => existsSync(join(f.workspace, "pids.json")));
    const pids = JSON.parse(readFileSync(join(f.workspace, "pids.json"), "utf8"));
    controller.abort(); assert.equal((await pending).outcome, "cancelled");
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally { f.close(); }
});
test("dedicated verifier directories reject ordinary writers through aliases, ancestors and missing children between and during runs", { skip: !verificationSupported() }, async () => {
  const f = fixture("import{writeFileSync}from'node:fs';writeFileSync('ready.txt','ready');setTimeout(()=>process.exit(0),400)"), n = node(f);
  const alias = join(f.root, "alias"); symlinkSync(f.workspace, alias, "dir");
  let sequence = 0;
  const ordinary = async (path) => {
    const request = requestFor(f); delete request.payload.verification;
    request.id = `ordinary_${++sequence}`; request.payload.run_id = request.id; request.idempotency_key = `${request.id}:start`;
    request.payload.workspace.root = path; request.payload.context_pack.payload.workspace.root = path;
    request.payload.policy_snapshot.filesystem_write_scope = [path];
    n.send(request); await waitFor(() => n.events.some((event) => event.kind === "command.ack" && event.command_id === request.id));
    assert.equal(n.events.find((event) => event.kind === "command.ack" && event.command_id === request.id).status, "rejected");
  };
  try {
    for (const path of [alias, join(alias, "missing"), f.root, f.workspace]) await ordinary(path);
    assert.equal(n.starts(), 0);
    n.send(requestFor(f)); await waitFor(() => existsSync(join(f.workspace, "ready.txt")));
    await ordinary(alias);
    await waitFor(() => n.events.some((event) => event.kind === "run.event" && event.event.type === "run.lifecycle" && event.event.payload.phase === "completed"));
    await ordinary(alias); assert.equal(n.starts(), 1);
    const unrelated = join(f.root, "unrelated"); mkdirSync(unrelated);
    const manual = requestFor(f); delete manual.payload.verification;
    manual.id = "manual"; manual.payload.run_id = "manual"; manual.idempotency_key = "manual:start";
    manual.payload.workspace.root = unrelated; manual.payload.context_pack.payload.workspace.root = unrelated;
    manual.payload.policy_snapshot.filesystem_write_scope = [unrelated]; n.send(manual);
    await waitFor(() => n.events.some((event) => event.kind === "run.event" && event.run_id === "manual" && event.event.type === "run.lifecycle" && event.event.payload.phase === "completed"));
    assert.equal(n.starts(), 2);
  } finally { await n.client.stop(true); f.close(); }
});
test("read-only discussion uses external context and cannot overwrite a subject through context_pack.md symlink", { skip: !verificationSupported() }, async () => {
  const f = fixture("process.exit(0)");
  symlinkSync(join(f.workspace, "index.txt"), join(f.workspace, "context_pack.md"));
  const events = []; let subscriber;
  const code = "const fs=require('node:fs');const path=process.argv[1];console.log(JSON.stringify({path,text:fs.readFileSync(path,'utf8')}))";
  const adapter = createProcessAdapter({ command: [process.execPath, "-e", "process.exit(0)"], discussionCommand: [process.execPath, "-e", code, "{{context_pack_path}}"], allowedRoots: [f.workspace] });
  const client = createNodeClient({ nodeId: "node_1", adapter, verificationProfiles: [f.profile], transport: {
    send: async (event) => { events.push(event); }, subscribe: (fn) => { subscriber = fn; return () => {}; },
  } }); client.start();
  try {
    const request = requestFor(f); delete request.payload.verification;
    request.payload.context_pack.payload.policy.execution_mode = "discussion"; request.payload.context_pack.payload.policy.filesystem_write_scope = [];
    for (const [id, path, project] of [["wrong_project", f.workspace, "other"], ["child", join(f.workspace, "child"), "project_1"]]) {
      const denied = structuredClone(request); denied.id = id; denied.payload.run_id = id; denied.idempotency_key = `${id}:start`;
      denied.payload.workspace.root = path; denied.payload.context_pack.payload.workspace.root = path; denied.payload.context_pack.payload.project.id = project;
      subscriber(denied); await waitFor(() => events.some((event) => event.kind === "command.ack" && event.command_id === id));
      assert.equal(events.find((event) => event.kind === "command.ack" && event.command_id === id).status, "rejected");
    }
    subscriber(request);
    await waitFor(() => events.some((event) => event.kind === "run.event" && event.event.type === "run.lifecycle" && event.event.payload.phase === "completed"));
    assert.equal(readFileSync(join(f.workspace, "index.txt"), "utf8"), "expected");
    const reported = JSON.parse(events.find((event) => event.kind === "run.event" && event.event.type === "run.output" && event.event.payload.stream === "stdout").event.payload.text);
    assert.equal(reported.path.startsWith(f.workspace + "/"), false); assert.match(reported.text, /task_1/); assert.equal(existsSync(reported.path), false);
  } finally { await client.stop(true); f.close(); }
});
