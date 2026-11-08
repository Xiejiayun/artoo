// Actual installed no-browser CLI and POSIX process ownership. The adapter and
// research metadata are declared fixtures: no provider, fetched receipt or product acceptance is claimed.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { canonicalMeasurementPlanV1, productDevelopmentContext } from "@artoo/domain";
import { prepareVerificationProfiles, readVerificationCapabilities, runVerification, runVerificationPreview,
  subjectManifest, verificationSupported } from "../dist/verification.js";
import { createNodeClient } from "../dist/node-client.js";
import { takeWorkspaceToolVerifier } from "../dist/workspace-tools.js";

const cli = fileURLToPath(new URL("../dist/web-acceptance-cli.js", import.meta.url));
const real = { skip: !verificationSupported(), timeout: 60000 };
const sha = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const policy = { version: 1, coverage: "every-must-criterion" };
const researchRelative = ".artoo/product/research.json";
const sleep = () => new Promise(resolve => setTimeout(resolve, 20));
async function waitFor(value, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const observed = value(); if (observed) return observed;
    assert.ok(Date.now() < deadline, label); await sleep();
  }
}

function fixture(mode = "success") {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), "artoo-measurement-plan-real-"));
  const workspace = join(root, "workspace"), evidence = join(root, "evidence"), config = join(root, "browser.json");
  const probe = join(root, "after-cli.mjs"), marker = join(root, "invocations.jsonl");
  mkdirSync(join(workspace, ".artoo/product"), { recursive: true }); mkdirSync(join(workspace, "product")); mkdirSync(evidence);
  writeFileSync(config, JSON.stringify({ evidence_root: evidence, viewports: [390], design_capture_cases: true }));
  // The protected follow-up script writes its own process/context facts outside
  // the measured subject. It cannot provide a successful measurement summary.
  writeFileSync(probe, `import {appendFileSync,readFileSync} from 'node:fs';
const contextFile=process.env.ARTOO_VERIFICATION_CONTEXT_FILE,envelope=JSON.parse(readFileSync(contextFile,'utf8'));
appendFileSync(${JSON.stringify(marker)},JSON.stringify({request_id:envelope.request_id,profile_id:envelope.profile_id,
profile_digest:envelope.profile_digest,subject_digest:envelope.subject_digest,workspace:process.cwd(),pid:process.pid,
context_file:contextFile,tmp:process.env.TMPDIR})+'\\n');
${mode === "exit" ? "console.error('Controlled later verifier failure');process.exitCode=7;" : ["timeout", "cancel"].includes(mode) ? "setInterval(()=>{},1000);" : "console.log('Controlled follow-up completed');"}
`);
  const [profile] = prepareVerificationProfiles([{ id: "acceptance", project_id: "project", workspace_root: workspace,
    measurement_plan_policy: policy, required_files: [], subject_paths: ["product", ".artoo/product"],
    commands: [{ id: "browser", argv: [process.execPath, cli, config], timeout_ms: 10000,
      observation: { format: "static-web-acceptance.v1", evidence_root: evidence, capabilities: { version: 1 } } },
    { id: "after", argv: [process.execPath, probe], timeout_ms: mode === "timeout" ? 1000 : 10000 }] }]);
  const capabilities = readVerificationCapabilities(profile), check = capabilities.checks[0];
  const research = { version: 1, objective: "Controlled declaration of two required observations", assumptions: [],
    requirements: [{ id: "save", description: "Visible save and recovery outcomes", priority: "must",
      acceptance_criteria: ["Show saved content", "Show recovery status"] }],
    sources: [{ id: "schema-fixture", url: "https://example.com/spec", title: "Schema fixture, not a fetched source receipt",
      retrieved_at: "2026-11-05T00:00:00Z", content_digest: sha("controlled schema fixture") }],
    findings: [{ summary: "Declare observable UI checks", source_ids: ["schema-fixture"] }], decisions: [],
    measurement_plan: { version: 1, profile_digest: profile.digest, entries: [0, 1].map(criterion_index => ({
      requirement_id: "save", criterion_index, command_id: check.command_id, config_digest: check.config_digest, contract_digest: check.contract_digest,
      actions: ["navigate", "assert_text"], keys: [], viewports: check.contract.viewports.map(viewport => ({ ...viewport })), needs: [] })) } };
  const researchPath = join(workspace, researchRelative), save = () => writeFileSync(researchPath, `${JSON.stringify(research, null, 2)}\n`); save();
  const context = { task: { id: "task", title: "Controlled research", description: "Declare two checks", acceptance_criteria: [] },
    project: { id: "project", name: "Fixture", default_workspace: workspace }, workspace: { root: workspace, file_scope: [] },
    policy: { filesystem_write_scope: [workspace], requires_approval: [] }, memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] },
    product_development: productDevelopmentContext("research", capabilities), verification_capabilities: capabilities };
  let retained = false;
  const records = () => existsSync(marker) ? readFileSync(marker, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const assertClosed = () => {
    for (const record of records()) {
      assert.equal(record.profile_digest, profile.digest); assert.equal(record.workspace, workspace);
      assert.ok(Number.isSafeInteger(record.pid) && record.pid > 1);
      assert.throws(() => process.kill(record.pid, 0), { code: "ESRCH" });
      assert.throws(() => process.kill(-record.pid, 0), { code: "ESRCH" });
      assert.equal(existsSync(dirname(record.context_file)), false, "Owned verifier context must be removed after actual group closure");
    }
  };
  return { root, workspace, evidence, marker, profile, context, research, researchPath, save, records, assertClosed,
    retain: () => { retained = true; }, close: () => {
      if (retained) { console.error(`Unconfirmed measurement verifier cleanup; fixture retained at ${root}`); return; }
      try { assertClosed(); assert.equal(realpathSync.native(root), root, "Fixture cleanup target changed"); }
      catch (error) { retained = true; throw new Error(`Unconfirmed process cleanup; fixture retained at ${root}`, { cause: error }); }
      rmSync(root, { recursive: true, force: true });
    } };
}
function peerContext(f, source) {
  const context = structuredClone(f.context); delete context.product_development;
  context.task.id = "peer_task"; context.policy = { execution_mode: "discussion", filesystem_write_scope: [], requires_approval: [] };
  context.review_subject = { version: 1, task_id: "task", run_id: "author", evidence_id: "controlled_author_evidence",
    subject_digest: source?.subject_digest ?? subjectManifest(f.profile).digest, development_stage: "research",
    ...(source ? { verification: { version: 1, request_id: source.request_id, profile_id: source.profile_id, profile_digest: source.profile_digest,
      checks: source.checks.map(({ id, output_digest, observation }) => ({ id, output_digest, ...(observation ? { observation } : {}) })),
      measurement_plan: structuredClone(source.measurement_plan) } } : {}) };
  return context;
}
async function execute(f, route, requestId, signal = new AbortController().signal) {
  const context = route === "peer" ? peerContext(f) : f.context;
  try {
    return route === "preview" ? (await runVerificationPreview(f.profile, requestId, signal, context)).verification
      : await runVerification(f.profile, requestId, signal, context, route === "peer" ? context.review_subject.subject_digest : undefined);
  } catch (error) { f.retain(); throw error; }
}
function inspect(f, result, scope) {
  const bytes = readFileSync(f.researchPath), before = subjectManifest(f.profile).digest;
  assert.equal(result.outcome, "passed", result.reason); assert.equal(result.subject_digest, before);
  assert.deepEqual(result.checks.map(check => [check.id, check.exit_code]), [["browser", 0], ["after", 0]]);
  assert.deepEqual(result.measurement_plan, { version: 1, claim: "declared-mapping-feasibility", scope, policy,
    research: { path: researchRelative, checksum: sha(bytes), size: bytes.length },
    measurement_plan_digest: sha(canonicalMeasurementPlanV1(f.research.measurement_plan)), must_criterion_count: 2, mapped_criterion_count: 2,
    used_checks: f.profile.capabilities.checks.map(({ command_id, config_digest, contract_digest }) => ({ command_id, config_digest, contract_digest })) });
  assert.notEqual(sha(bytes), sha(JSON.stringify(f.research)), "Actual pretty-printed research bytes must determine the file checksum");
  assert.deepEqual(result.required_files.find(file => file.path === researchRelative), result.measurement_plan.research);
  assert.deepEqual(result.checks[0].observation.cases, []); assert.equal(result.checks[0].observation.scope, scope);
  assert.equal(result.checks[1].observation, undefined);
  const report = JSON.parse(readFileSync(join(f.evidence, sha(result.request_id).slice(7), "result.json"), "utf8"));
  assert.equal(report.stage, "research"); assert.deepEqual(report.cases, []); assert.equal(report.measurement_plan, undefined);
  assert.deepEqual(report.capability_binding, result.checks[0].observation.capability_binding);
  assert.equal(f.records().filter(record => record.request_id === result.request_id).length, 1);
  f.assertClosed();
}

test("installed research CLI independently measures author preview, author final and read-only peer summaries through real node execution", real, async () => {
  const f = fixture(), events = []; let author, peer, send, verifier, preview, executionError, peerStarts = 0;
  const terminal = messages => messages.find(message => message.kind === "run.event" && message.event.type === "run.lifecycle"
    && ["completed", "cancelled", "failed"].includes(message.event.payload.phase));
  const receipt = messages => messages.find(message => message.kind === "run.event" && message.event.type === "run.verification")?.event.payload;
  const waitTerminal = async (messages, startIndex = 0) => {
    const finished = await waitFor(() => {
      const current = messages.slice(startIndex);
      assert.equal(current.some(message => message.kind === "command.ack" && message.status === "rejected"), false,
        `Node rejected the declared fixture request: ${JSON.stringify(current)}`);
      return terminal(current);
    }, "Node measurement-plan flow did not finish", 30000);
    assert.equal(finished.event.payload.phase, "completed", JSON.stringify(finished));
  };
  const capabilityBinding = { version: 1, profile_digest: f.profile.digest,
    checks: f.profile.capabilities.checks.map(({ command_id, config_digest, contract_digest }) => ({ command_id, config_digest, contract_digest })) };
  const request = { kind: "command", id: "author_start", idempotency_key: "author:start", type: "run.start", payload: {
    run_id: "author", task_id: "task", agent_instance_id: "author_instance", runtime: "fixture", workspace: { root: f.workspace },
    context_pack: { id: "author_context", payload: f.context }, policy_snapshot: f.context.policy, artifact_rules: { paths: [] },
    verification: { version: 1, profile_id: f.profile.id, request_id: "measurement-author-final", capability_binding: capabilityBinding } } };
  try {
    const before = subjectManifest(f.profile).digest;
    author = createNodeClient({ nodeId: "node", verificationProfiles: [f.profile],
      transport: { send: async message => { events.push(message); }, subscribe: handler => { send = handler; return () => {}; } },
      // Controlled orchestration adapter only. It does not claim fetched research
      // receipts or invoke the separate production research/provenance stage gate.
      adapter: { runtimeId: "fixture", async start(config) {
        verifier = takeWorkspaceToolVerifier(config); assert.equal(typeof verifier, "function"); return { runId: "author" };
      }, async *streamEvents() {
        yield { type: "run.lifecycle", payload: { phase: "started" } };
        preview = (await verifier(new AbortController().signal)).verification; inspect(f, preview, "preview");
        yield { type: "run.lifecycle", payload: { phase: "completed" } };
      }, async stop() {}, async collectArtifacts() { return []; } } });
    author.start(); send(request); await waitTerminal(events);
    const final = receipt(events); inspect(f, final, "final");
    assert.notEqual(final.request_id, preview.request_id); assert.equal(final.subject_digest, before);
    assert.deepEqual(final.measurement_plan, { ...preview.measurement_plan, scope: "final" });
    await author.stop(true); author = undefined;
    const peerEvents = [], context = peerContext(f, final);
    peer = createNodeClient({ nodeId: "node", verificationProfiles: [f.profile],
      transport: { send: async message => { peerEvents.push(message); }, subscribe: handler => { send = handler; return () => {}; } },
      adapter: { runtimeId: "fixture", async start(config) {
        peerStarts++; assert.equal(takeWorkspaceToolVerifier(config), undefined);
        const actual = config.runStart.context_pack.payload;
        assert.equal(actual.policy.execution_mode, "discussion"); assert.deepEqual(actual.policy.filesystem_write_scope, []);
        assert.deepEqual(config.runStart.policy_snapshot.filesystem_write_scope, [f.workspace]);
        assert.deepEqual(actual.review_subject.verification.measurement_plan, final.measurement_plan); return { runId: "peer" };
      }, async *streamEvents() { yield { type: "run.lifecycle", payload: { phase: "completed" } }; }, async stop() {}, async collectArtifacts() { return []; } } });
    peer.start();
    const payload = { ...request.payload, run_id: "peer", task_id: "peer_task", agent_instance_id: "peer_instance",
      context_pack: { id: "peer_context", payload: context },
      // Keep outer server admission; only the distinct discussion context is read-only.
      verification: { ...request.payload.verification, request_id: "measurement-peer-final", expected_subject_digest: final.subject_digest } };
    const wrong = structuredClone(payload); wrong.run_id = "preview_peer";
    wrong.context_pack.payload.review_subject.verification.measurement_plan = preview.measurement_plan;
    send({ ...request, id: "preview_summary_rejected", idempotency_key: "peer:preview-rejected", payload: wrong });
    const rejected = await waitFor(() => peerEvents.find(message => message.kind === "command.ack" && message.command_id === "preview_summary_rejected"), "Preview summary was not rejected");
    assert.equal(rejected.status, "rejected"); assert.equal(peerStarts, 0); assert.equal(f.records().length, 2);
    const peerEventStart = peerEvents.length;
    send({ ...request, id: "peer_start", idempotency_key: "peer:start", payload });
    await waitTerminal(peerEvents, peerEventStart);
    const reviewed = receipt(peerEvents); inspect(f, reviewed, "final");
    assert.equal(peerStarts, 1); assert.notEqual(reviewed.request_id, final.request_id);
    assert.deepEqual(reviewed.measurement_plan, final.measurement_plan); assert.equal(f.records().length, 3);
    assert.equal(subjectManifest(f.profile).digest, before);
  } catch (error) { executionError = error; throw error; }
  finally {
    const stopped = await Promise.allSettled([peer?.stop(true), author?.stop(true)]);
    const errors = stopped.filter(result => result.status === "rejected").map(result => result.reason);
    if (errors.length) { f.retain(); f.close(); throw new AggregateError([...(executionError ? [executionError] : []), ...errors], `Node cleanup unconfirmed; fixture retained at ${f.root}`); }
    f.close();
  }
});

test("node preview and final carry bounded research schema diagnostics before any verifier subprocess", real, async () => {
  const f = fixture(), events = []; let node, send, verifier, preview, executionError;
  const prefix = "Verification: measurement-plan research does not satisfy its versioned report contract: ";
  writeFileSync(f.researchPath, JSON.stringify({ version: 1, sources: f.research.sources,
    findings: [{ finding: "PRIVATE_SCHEMA_INPUT_9127", source_ids: ["schema-fixture"] }] }));
  const before = readFileSync(f.researchPath), beforeDigest = subjectManifest(f.profile).digest;
  const inspectFailure = result => {
    assert.equal(result.outcome, "failed"); assert.deepEqual(result.checks, []); assert.equal(result.measurement_plan, undefined);
    assert.equal(result.reason.startsWith(prefix), true); assert.ok(result.reason.length < 1800);
    assert.equal(result.reason.includes("PRIVATE_SCHEMA_INPUT_9127"), false); assert.equal(result.reason.includes(f.root), false);
    const detail = JSON.parse(result.reason.slice(prefix.length));
    assert.deepEqual(detail, { version: 1, format: "artoo-research-schema-issues.v1", file: researchRelative, issues: [
      { path: ["objective"], code: "invalid_type", expected: "string" },
      { path: ["assumptions"], code: "invalid_type", expected: "array" },
      { path: ["requirements"], code: "invalid_type", expected: "array" },
      { path: ["findings", 0, "summary"], code: "invalid_type", expected: "string" },
      { path: ["decisions"], code: "invalid_type", expected: "array" },
    ], omitted_issues: 0 });
    assert.equal(result.subject_digest, beforeDigest); assert.equal(result.profile_digest, f.profile.digest);
    assert.equal(existsSync(f.marker), false); assert.deepEqual(readdirSync(f.evidence), []);
  };
  try {
    node = createNodeClient({ nodeId: "node", verificationProfiles: [f.profile],
      transport: { send: async message => { events.push(message); }, subscribe: handler => { send = handler; return () => {}; } },
      // Controlled author only; actual node-owned preview/final failure paths remain in force.
      adapter: { runtimeId: "fixture", async start(config) {
        verifier = takeWorkspaceToolVerifier(config); assert.equal(typeof verifier, "function"); return { runId: "schema_author" };
      }, async *streamEvents() {
        const attempted = await verifier(new AbortController().signal); preview = attempted.verification;
        inspectFailure(preview); assert.deepEqual(attempted.diagnostics.commands, []);
        yield { type: "run.lifecycle", payload: { phase: "completed" } };
      }, async stop() {}, async collectArtifacts() { return []; } } });
    node.start(); send({ kind: "command", id: "schema_author_start", idempotency_key: "schema_author:start", type: "run.start", payload: {
      run_id: "schema_author", task_id: "task", agent_instance_id: "author_instance", runtime: "fixture", workspace: { root: f.workspace },
      context_pack: { id: "schema_author_context", payload: f.context }, policy_snapshot: f.context.policy, artifact_rules: { paths: [] },
      verification: { version: 1, profile_id: f.profile.id, request_id: "schema-author-final", capability_binding: {
        version: 1, profile_digest: f.profile.digest,
        checks: f.profile.capabilities.checks.map(({ command_id, config_digest, contract_digest }) => ({ command_id, config_digest, contract_digest })) } } } });
    const terminal = await waitFor(() => {
      assert.equal(events.some(message => message.kind === "command.ack" && message.status === "rejected"), false, JSON.stringify(events));
      return events.find(message => message.kind === "run.event" && message.event.type === "run.lifecycle"
        && ["completed", "cancelled", "failed"].includes(message.event.payload.phase));
    }, "Node research diagnostic flow did not finish", 30000);
    assert.equal(terminal.event.payload.phase, "completed", JSON.stringify(terminal));
    const final = events.find(message => message.kind === "run.event" && message.event.type === "run.verification")?.event.payload;
    assert.ok(final); inspectFailure(final); assert.notEqual(final.request_id, preview.request_id);
    assert.equal(final.reason, preview.reason); assert.deepEqual(readFileSync(f.researchPath), before);
  } catch (error) { executionError = error; throw error; }
  finally {
    try { await node?.stop(true); }
    catch (error) { f.retain(); f.close(); throw new AggregateError([...(executionError ? [executionError] : []), error], `Node cleanup unconfirmed; fixture retained at ${f.root}`); }
    f.close();
  }
});

for (const route of ["final", "preview", "peer"]) {
  test(`incomplete criterion mapping prevents every protected command on the ${route} route`, real, async () => {
    const f = fixture(); f.research.measurement_plan.entries.pop(); f.save();
    try {
      const before = readFileSync(f.researchPath), result = await execute(f, route, `missing-${route}`);
      assert.equal(result.outcome, "failed"); assert.match(result.reason, /missing must criterion save:1/);
      assert.deepEqual(result.checks, []); assert.equal(result.measurement_plan, undefined);
      assert.equal(existsSync(f.marker), false); assert.deepEqual(readdirSync(f.evidence), []);
      assert.deepEqual(readFileSync(f.researchPath), before, "Failure must not rewrite or weaken the requirements");
    } finally { f.close(); }
  });
}

for (const [mode, route, outcome] of [["exit", "final", "failed"], ["timeout", "preview", "timed_out"], ["cancel", "peer", "cancelled"]]) {
  test(`a later real ${mode} on ${route} withholds all successful summaries and confirms process closure`, real, async () => {
    const f = fixture(mode), controller = new AbortController(); let pending, executionError;
    try {
      let settled;
      pending = execute(f, route, `later-${mode}`, controller.signal).then(result => (settled = { result }), error => (settled = { error }));
      const observed = await waitFor(() => {
        const record = f.records().find(item => item.request_id === `later-${mode}`);
        if (record) return record;
        assert.equal(settled, undefined, "The verifier ended before its later process marker was observed"); return undefined;
      }, "The later protected process did not emit its ownership marker");
      assert.equal(observed.profile_digest, f.profile.digest); assert.equal(observed.subject_digest, subjectManifest(f.profile).digest);
      assert.equal(observed.tmp, dirname(observed.context_file));
      if (mode === "cancel") {
        assert.equal(existsSync(observed.context_file), true); process.kill(observed.pid, 0); process.kill(-observed.pid, 0);
        controller.abort(); // Abort only after the actual protected command is observed alive.
      }
      const completed = await pending; if (completed.error) throw completed.error;
      const result = completed.result;
      assert.equal(result.outcome, outcome, result.reason); assert.equal(result.measurement_plan, undefined);
      assert.deepEqual(result.checks.map(check => check.id), ["browser", "after"]); assert.equal(result.checks[0].exit_code, 0);
      assert.equal(result.checks.every(check => check.observation === undefined), true);
      if (mode === "exit") { assert.equal(result.checks[1].exit_code, 7); assert.match(result.reason, /Controlled later verifier failure/); }
      const files = readdirSync(join(f.evidence, sha(result.request_id).slice(7)));
      assert.ok(files.includes("result.json"), "The real no-browser CLI must have completed before the later failure");
      assert.equal(files.some(name => name.startsWith("sealed-")), false);
      f.assertClosed();
    } catch (error) { executionError = error; throw error; }
    finally {
      controller.abort();
      const completed = pending && await pending;
      if (completed?.error) { f.retain(); f.close(); throw new AggregateError([...(executionError ? [executionError] : []), completed.error], `Verifier cleanup unconfirmed; fixture retained at ${f.root}`); }
      f.close();
    }
  });
}
