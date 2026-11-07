// Controlled products and actual protected browser execution; no model or publication is invoked.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { storageFaultReportFromTraceV1 } from "@artoo/domain";
import { prepareVerificationProfiles, runVerification, runVerificationPreview, subjectManifest, verificationSupported } from "../dist/verification.js";
import { readBrowserEvidence } from "../dist/browser-evidence.js";
import { createNodeClient } from "../dist/node-client.js";
import { takeWorkspaceToolVerifier, takeWorkspaceToolEvidenceReader } from "../dist/workspace-tools.js";
import { STORAGE_FAULT_INITIALIZER_SOURCE } from "../dist/web-acceptance-storage-source.js";

const cli = fileURLToPath(new URL("../dist/web-acceptance-cli.js", import.meta.url));
const browser = process.env.ARTOO_TEST_CHROMIUM;
const real = { skip: !verificationSupported() || !browser, timeout: 120000 };
const sha = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const step = (action, properties = {}) => ({ action, page: "main", ...properties });
const navigate = step("navigate", { path: "/" });
const click = selector => step("click", { selector });
const fill = value => step("fill", { selector: "#draft", value });
const text = (selector, value) => step("assert_text", { selector, text: value });
const draft = "Draft under fault", committed = "Committed through normal UI";
const window = (id, mode, start, end, assertions) => ({ id, page: "main", mode,
  arm_before_step: start, settle_after_step: end,
  requirement_criteria: [{ requirement_id: "storage", criterion_index: mode === "read-security" ? 1 : 0 }],
  ui_assertion_steps: assertions, min_hits: 1, native_storage: { scope: "all", comparison: "sampled-equal" } });
const writeSteps = [navigate, fill(committed), click("#save"), text("#saved", committed), fill(draft),
  click("#save"), text("#status", "Save failed"), step("assert_value", { selector: "#draft", value: draft }),
  text("#saved", committed), click("#save"), text("#status", "Saved"), step("reload"), text("#saved", draft)];
const firstReadSteps = [navigate, text("#status", "Storage unavailable"), text("#saved", "Empty"),
  click("#retry"), text("#status", "Ready")];
const reloadReadSteps = [navigate, fill(committed), click("#save"), text("#saved", committed), step("reload"),
  text("#status", "Storage unavailable"), text("#saved", "Empty"), click("#retry"), text("#saved", committed)];
const cases = {
  write: { steps: writeSteps, storage_checks: { version: 1, windows: [window("save-quota", "write-quota", 5, 8, [6, 7, 8])] } },
  firstRead: { steps: firstReadSteps, storage_checks: { version: 1, windows: [window("first-read", "read-security", 0, 2, [1, 2])] } },
  reloadRead: { steps: reloadReadSteps, storage_checks: { version: 1, windows: [window("reload-read", "read-security", 4, 6, [5, 6])] } },
};
// Failure fixtures stop at the measured window. Later retry assertions must not
// make a broken measurement gate appear to reject the intended storage defect.
const throughWindow = value => ({ ...value, steps: value.steps.slice(0, value.storage_checks.windows.at(-1).settle_after_step + 1) });
const nativeMutation = /Native localStorage (?:mutation observed during a fault window|snapshots differ across the fault window)/;
const failedUi = /(?:assert_text did not match|Browser assert_text exceeded the protected timeout)/;

function html(mode) {
  return `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Storage fault fixture</title>
  <style>body{margin:12px}input{max-width:100%;box-sizing:border-box}p{overflow-wrap:anywhere}</style></head><body><h1>Stored draft</h1>
  <label for="draft">Draft</label><input id="draft"><button id="save">Save</button><button id="retry">Retry loading</button>
  <p id="status">Ready</p><p id="saved">Empty</p><script>
  const input=document.getElementById('draft'),status=document.getElementById('status'),saved=document.getElementById('saved');
  let committed='';
  function load(){
    ${mode === "no-read" ? "status.textContent='Storage unavailable';return;" : ""}
    try {committed=localStorage.getItem('entry')||'';saved.textContent=committed||'Empty';status.textContent='Ready';}
    catch(error){status.textContent=${JSON.stringify(mode === "read-swallow" ? "Ready" : "Storage unavailable")};}
  }
  load();
  ${mode === "duplicate-initializer" ? `const duplicate=document.createElement('script');duplicate.textContent=${JSON.stringify(STORAGE_FAULT_INITIALIZER_SOURCE)};document.body.append(duplicate);` : ""}
  ${mode === "intrinsic-tamper" ? "Object.getOwnPropertyDescriptor=()=>({configurable:true,writable:true});Object.prototype.toJSON=()=>({read_hits:100,write_hits:100});" : ""}
  document.getElementById('retry').onclick=load;
  document.getElementById('save').onclick=()=>{
    const failingInput=input.value===${JSON.stringify(draft)};
    ${mode === "no-hit" ? "if(failingInput){status.textContent='Save failed';return;}" : ""}
    ${mode === "fake-counter" ? "if(failingInput){window.__storageFaultHits=999;status.textContent='Save failed';return;}" : ""}
    ${mode === "delete-before" ? "if(failingInput)localStorage.removeItem('entry');" : ""}
    ${mode === "iframe-borrow" ? "if(failingInput){const iframe=document.createElement('iframe');document.body.append(iframe);iframe.contentWindow.Storage.prototype.setItem.call(localStorage,'entry','borrowed');}" : ""}
    ${mode === "navigation" ? "if(failingInput)location.href='/?unexpected=1';" : ""}
    try {
      localStorage.setItem('entry',input.value);committed=input.value;saved.textContent=committed;status.textContent='Saved';
      ${mode === "too-many-keys" ? "if(!failingInput)for(let i=0;i<513;i++)localStorage.setItem('extra-'+i,'value');" : ""}
      ${mode === "too-many-bytes" ? "if(!failingInput)localStorage.setItem('oversized','x'.repeat(1048577));" : ""}
    } catch(error) {
      ${mode === "property-write" ? "localStorage.entry=input.value;" : ""}
      ${mode === "write-restore" ? "localStorage.entry='temporary value';localStorage.entry=committed;" : ""}
      status.textContent=${JSON.stringify(mode === "swallow" ? "Saved" : "Save failed")};
    }
  };
  ${mode === "unload-delete" ? "addEventListener('beforeunload',()=>localStorage.removeItem('entry'));" : ""}
  ${mode === "native-descriptors" ? "status.textContent=Object.getOwnPropertyDescriptor(window,'localStorage').configurable&&Object.getOwnPropertyDescriptor(Storage.prototype,'setItem').writable?'Native descriptors':'Modified descriptors';" : ""}
  </script></body></html>`;
}

function fixture(mode = "correct", selected = { write: cases.write, firstRead: cases.firstRead, reloadRead: cases.reloadRead }, optIn = true) {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), "artoo-storage-fault-real-"));
  const workspace = join(root, "workspace"), evidence = join(root, "evidence"), config = join(root, "web.json");
  mkdirSync(join(workspace, ".artoo/product"), { recursive: true }); mkdirSync(join(workspace, "product")); mkdirSync(evidence);
  writeFileSync(config, JSON.stringify({ evidence_root: evidence, browser_executable: realpathSync.native(browser),
    browser_program: { version: 3, viewports: [{ id: "compact", width: 512, height: 650 }] },
    ...(optIn ? { storage_fault: { version: 1 } } : {}), action_timeout_ms: 1000, design_capture_cases: true }));
  const [profile] = prepareVerificationProfiles([{ id: "web", project_id: "project", workspace_root: workspace,
    commands: [{ id: "browser", argv: [process.execPath, cli, config], timeout_ms: 60000,
      observation: { format: "static-web-acceptance.v3", evidence_root: evidence, capabilities: { version: 1 } } }],
    required_files: [], subject_paths: ["product", ".artoo/product"] }]);
  const research = { version: 1, objective: "Controlled storage failure recovery", assumptions: [],
    requirements: [{ id: "storage", description: "Recover from storage access failures", priority: "must", acceptance_criteria: [
      "A failed UI save preserves the draft and previously committed data, and retry can save", "Initial and repeated loading handle denied storage access and can recover"] }],
    sources: [{ id: "fixture", url: "https://example.com/spec", title: "Schema fixture, not live research", retrieved_at: "2026-11-05T00:00:00Z", content_digest: sha("fixture") }],
    findings: [{ summary: "Measure synthetic fixed exceptions and native before/after storage", source_ids: ["fixture"] }], decisions: [] };
  const design = { version: 1, requirement_ids: ["storage"], information_architecture: ["Draft"],
    user_flows: [{ id: "save", name: "Save", requirement_ids: ["storage"], steps: ["Write", "Handle failure", "Retry"] }],
    screens: [{ id: "draft", name: "Draft", purpose: "Write", states: ["Empty", "Saved", "Error"], accessibility: ["Named input"], responsive: ["Fit configured dimensions"] }],
    prototype: { entrypoint: "product/index.html", description: "Controlled fault fixture" }, data_model: [], api_contracts: [],
    decisions: [{ decision: "Use normal UI writes for setup", rationale: "No verifier storage seeding or product-authored proof" }],
    validation_cases: Object.entries(selected).map(([id, value]) => ({ id, requirement_ids: ["storage"], procedure: ["Use real product UI"], expected_result: "Error handling and recovery satisfy declared checks",
      browser_program: { version: 3, contract_digest: profile.capabilities.checks[0].contract_digest, steps: value.steps },
      ...(value.storage_checks ? { storage_checks: value.storage_checks } : {}) })) };
  writeFileSync(join(workspace, ".artoo/product/research.json"), JSON.stringify(research));
  writeFileSync(join(workspace, ".artoo/product/design.json"), JSON.stringify(design));
  writeFileSync(join(workspace, "product/index.html"), html(mode));
  const context = { task: { id: "task", title: "Storage fixture", description: "Measure real UI failure handling", acceptance_criteria: ["Actual exceptions and native snapshots"] },
    project: { id: "project", name: "Fixture", default_workspace: workspace }, workspace: { root: workspace, file_scope: [] },
    policy: { filesystem_write_scope: [workspace], requires_approval: [] }, memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] },
    verification_capabilities: { ...profile.capabilities, profile_id: profile.id },
    product_development: { version: 1, stage: "design", instructions: ["Use the configured contract"],
      deliverables: [{ path: ".artoo/product/design.json", format: "json", purpose: "Controlled handoff" }] } };
  let retained = false;
  return { root, workspace, evidence, profile, context, retain: () => { retained = true; }, close: () => {
    if (retained) { console.error(`Unconfirmed verifier cleanup; fixture retained at ${root}`); return; }
    assert.equal(realpathSync.native(root), root, "Fixture cleanup target changed");
    rmSync(root, { recursive: true, force: true });
  } };
}
async function verify(f, requestId, scope = "final") {
  try {
    return scope === "preview"
      ? (await runVerificationPreview(f.profile, requestId, new AbortController().signal, f.context)).verification
      : await runVerification(f.profile, requestId, new AbortController().signal, f.context);
  } catch (error) {
    // The verifier returns normal failures only after confirmed subprocess closure.
    // An exception cannot authorize removal of its fixture or evidence directory.
    f.retain(); throw error;
  }
}
function grant(f, receipt, scope = "final") {
  return { evidenceRoot: f.evidence, requestId: receipt.request_id, profileId: f.profile.id, profileDigest: f.profile.digest,
    subjectDigest: receipt.subject_digest, checkId: "browser", scope, ...receipt.checks[0].observation.evidence_bundle };
}
function inspectStorageTrace(f, measured, content) {
    const trace = JSON.parse(content);
    assert.equal(trace.storage_fault.version, 1);
    assert.deepEqual(storageFaultReportFromTraceV1(trace.storage_fault), measured.storage_fault);
    assert.ok(["write", "firstRead", "reloadRead"].includes(measured.case_id));
    // Compute expected summaries from fixture inputs, independently of the
    // runtime snapshot helper. Setup values are written only by normal UI.
    const entries = measured.case_id === "firstRead" ? [] : [["entry", committed]];
    const expectedNative = { digest: sha(JSON.stringify(entries)), key_count: entries.length,
      utf8_bytes: entries.reduce((total, [key, value]) => total + Buffer.byteLength(key) + Buffer.byteLength(value), 0) };
    for (const [index, actual] of trace.storage_fault.windows.entries()) {
      assert.deepEqual(actual.sequence, ["baseline", "armed", "settled", "disarmed"]);
      assert.ok(actual.hits.delta >= 1); assert.equal(actual.hits.final - actual.hits.baseline, actual.hits.delta);
      assert.deepEqual(actual.native_storage.before, expectedNative); assert.deepEqual(actual.native_storage.after, expectedNative);
      assert.equal(actual.native_storage.scope, "all"); assert.equal(actual.native_storage.comparison, "sampled-equal");
      assert.equal(actual.native_storage.equal, true);
      assert.deepEqual(actual.events, { coverage: "observed-only", observed_mutations: 0 });
      assert.equal(actual.installation.confirmed, true);
      assert.equal(actual.installation.script_digest, f.profile.capabilities.checks[0].contract.storage_fault.initializer_digest);
      assert.equal(measured.storage_fault.windows[index].fresh_hits, actual.hits.delta);
      if (measured.case_id === "firstRead") { assert.equal(actual.baseline_phase, "first-document-paused"); assert.equal(actual.document_epoch, 1); }
      if (measured.case_id === "reloadRead") { assert.equal(actual.baseline_phase, "before-step"); assert.equal(actual.document_epoch, 2); }
    }
    assert.equal(content.includes(committed), false, "Native values must not be copied into trace evidence");
    assert.equal(content.includes(draft), false, "Draft values must not be copied into trace evidence");
    return trace;
}
function inspectStorageEvidence(f, receipt, scope = "final") {
  const observation = receipt.checks[0].observation;
  assert.equal(observation.version, 3); assert.equal(observation.scope, scope);
  for (const measured of observation.cases) {
    const content = readBrowserEvidence(grant(f, receipt, scope), measured.trace_ref);
    assert.equal(content.mime_type, "application/json"); inspectStorageTrace(f, measured, content.text);
  }
}

test("v3 storage windows measure actual first-load/reload failures, UI draft preservation and normal retry", real, async () => {
  const f = fixture();
  try {
    const receipt = await verify(f, "storage-positive");
    assert.equal(receipt.outcome, "passed", receipt.reason); inspectStorageEvidence(f, receipt);
    const preview = await verify(f, "storage-preview", "preview");
    assert.equal(preview.outcome, "passed", preview.reason); inspectStorageEvidence(f, preview, "preview");
    assert.notEqual(preview.checks[0].observation.cases[0].trace_ref, receipt.checks[0].observation.cases[0].trace_ref);
  } finally { f.close(); }
});

test("storage measurement keeps native counters and snapshots despite product intrinsic tampering", real, async () => {
  const f = fixture("intrinsic-tamper", { write: cases.write });
  try {
    const receipt = await verify(f, "storage-intrinsics");
    assert.equal(receipt.outcome, "passed", receipt.reason); inspectStorageEvidence(f, receipt);
  } finally { f.close(); }
});

test("the product's byte-identical second initializer is rejected as a duplicate debugger pause", real, async () => {
  const f = fixture("duplicate-initializer", { firstRead: throughWindow(cases.firstRead) });
  try {
    const receipt = await verify(f, "storage-duplicate-initializer");
    assert.equal(receipt.outcome, "failed"); assert.equal(receipt.checks[0].exit_code, 1);
    assert.equal(receipt.checks[0].observation, undefined);
    assert.match(receipt.reason, /Unexpected or duplicate debugger pause cannot install a controller/);
    const directory = join(f.evidence, sha(receipt.request_id).slice(7));
    assert.equal(readdirSync(directory).some(name => name === "result.json" || name.startsWith("sealed-")), false);
  } finally { f.close(); }
});

const writeDefects = [
  ["swallow", failedUi], ["delete-before", nativeMutation], ["property-write", nativeMutation],
  ["write-restore", /Native localStorage mutation observed during a fault window/],
  ["no-hit", /Storage window has no fresh fault hit/], ["fake-counter", /Storage window has no fresh fault hit/],
  ["iframe-borrow", /iframe|document realm|authorized main\/default document epoch|Native localStorage mutation observed during a fault window/],
  ["navigation", /(?:Product (?:changed documents|document disappeared) outside an explicit navigation|Product created an unauthorized main document context)/],
  // Repeated UI writes may reach the case event cap before the snapshot key cap.
  // The key-count helper has its own focused unit test; this case checks bounded rejection.
  ["too-many-keys", /Storage mutation observations exceeded the case bound|Native localStorage snapshot exceeds its key bound/],
  ["too-many-bytes", /Native localStorage snapshot exceeds its UTF-8 byte bound/],
];
for (const [mode, reason] of writeDefects) {
  test(`storage window rejects ${mode} at its intended measurement or UI guard`, real, async () => {
    const f = fixture(mode, { write: throughWindow(cases.write) });
    try {
      const receipt = await verify(f, `storage-${mode}`);
      assert.equal(receipt.outcome, "failed"); assert.equal(receipt.checks[0].exit_code, 1);
      assert.equal(receipt.checks[0].observation, undefined);
      assert.match(receipt.reason, reason);
    } finally { f.close(); }
  });
}

for (const [mode, reason] of [["no-read", /Storage window has no fresh fault hit/], ["read-swallow", failedUi], ["unload-delete", nativeMutation]]) {
  test(`read-security rejects ${mode}, including mutations before a reload's new document`, real, async () => {
    const f = fixture(mode, mode === "unload-delete" ? { reloadRead: throughWindow(cases.reloadRead) } : { firstRead: throughWindow(cases.firstRead) });
    try {
      const receipt = await verify(f, `storage-${mode}`);
      assert.equal(receipt.outcome, "failed"); assert.equal(receipt.checks[0].exit_code, 1);
      assert.equal(receipt.checks[0].observation, undefined);
      assert.match(receipt.reason, reason);
    } finally { f.close(); }
  });
}

test("a v3 profile without storage opt-in rejects the sidecar before admitting measurement", real, async () => {
  const f = fixture("correct", { write: cases.write }, false);
  try {
    const receipt = await verify(f, "storage-unconfigured");
    assert.equal(receipt.outcome, "failed"); assert.equal(receipt.checks[0].exit_code, 1);
    assert.equal(receipt.checks[0].observation, undefined); assert.match(receipt.reason, /requires the protected storage_fault opt-in/);
    assert.deepEqual(readdirSync(f.evidence), [], "Unopted sidecars must fail before creating any report or sealed bundle");
  } finally { f.close(); }
});

test("an opted-in profile leaves a normal multi-page case uninstrumented and emits no storage proof", real, async () => {
  const normal = { steps: [navigate, text("#status", "Native descriptors"), fill(committed), click("#save"),
    { action: "open_page", page: "peer", path: "/" },
    { action: "assert_text", page: "peer", selector: "#status", text: "Native descriptors" },
    { action: "assert_text", page: "peer", selector: "#saved", text: committed },
    { action: "close_page", page: "peer" }, text("#saved", committed)] };
  const f = fixture("native-descriptors", { normal });
  try {
    const receipt = await verify(f, "storage-normal-pages");
    assert.equal(receipt.outcome, "passed", receipt.reason);
    const measured = receipt.checks[0].observation.cases[0];
    assert.equal(measured.storage_fault, undefined);
    const trace = JSON.parse(readBrowserEvidence(grant(f, receipt), measured.trace_ref).text);
    assert.equal(trace.storage_fault, undefined); assert.equal(trace.captures.length, 2);
  } finally { f.close(); }
});

test("node gives the author preview storage evidence and a read-only peer only the final measured trace and main capture", real, async () => {
  const f = fixture("correct", { firstRead: cases.firstRead }), events = [], previewReferences = new Set();
  let send, verifier, reader, author, peer, executionError;
  const terminal = messages => messages.find(message => message.kind === "run.event" && message.event.type === "run.lifecycle"
    && ["completed", "cancelled", "failed"].includes(message.event.payload.phase));
  const receipt = messages => messages.find(message => message.kind === "run.event" && message.event.type === "run.verification")?.event.payload;
  const waitTerminal = async messages => {
    const deadline = Date.now() + 90000;
    while (!terminal(messages)) {
      const rejection = messages.find(message => message.status === "rejected");
      assert.equal(rejection, undefined, `Node rejected the storage fixture: ${JSON.stringify(rejection)}`);
      assert.ok(Date.now() < deadline, "Node storage evidence flow did not finish");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(terminal(messages).event.payload.phase, "completed", JSON.stringify(terminal(messages)));
  };
  const readFaultEvidence = async (read, verified, scope) => {
    assert.equal(verified.outcome, "passed", verified.reason);
    const observation = verified.checks[0].observation;
    assert.equal(observation.version, 3); assert.equal(observation.scope, scope); assert.equal(observation.cases.length, 1);
    const measured = observation.cases[0]; assert.equal(measured.case_id, "firstRead");
    let combined = "", offset = 0, pages = 0, finished = false;
    for (let count = 0; count < 128; count++) {
      const page = await read(measured.trace_ref, { offset, limit: 256, ...(offset ? { expected_checksum: measured.trace_digest } : {}) });
      assert.equal(page.mime_type, "application/json"); assert.equal(page.offset, offset);
      assert.equal(page.checksum, measured.trace_digest); assert.equal(page.size, measured.trace_size);
      assert.equal(page.provenance.scope, scope); assert.equal(page.provenance.requestId, verified.request_id);
      assert.equal(page.provenance.subjectDigest, verified.subject_digest); assert.equal(page.provenance.profileDigest, f.profile.digest);
      assert.equal(page.provenance.checkId, "browser");
      assert.ok(Buffer.byteLength(page.text) <= 256); combined += page.text; pages++;
      if (page.eof) { assert.equal(page.next_offset, null); finished = true; break; }
      assert.equal(page.next_offset, offset + Buffer.byteLength(page.text)); offset = page.next_offset;
    }
    assert.equal(finished, true); assert.ok(pages > 1, "The actual fault trace must traverse multiple checksum-bound pages");
    assert.equal(Buffer.byteLength(combined), measured.trace_size); assert.equal(sha(combined), measured.trace_digest);
    const trace = inspectStorageTrace(f, measured, combined);
    assert.equal(trace.program_digest, measured.program_digest);
    assert.deepEqual(trace.operations.map(operation => [operation.action, operation.page_id]), cases.firstRead.steps.map(item => [item.action, item.page]));
    assert.deepEqual(trace.captures, measured.captures.map(({ screenshot_ref, ...capture }) => capture));
    assert.equal(measured.captures.length, 1);
    const capture = measured.captures[0]; assert.equal(capture.page_id, "main"); assert.deepEqual(capture.timing, { kind: "case-end" });
    const image = await read(capture.screenshot_ref), png = Buffer.from(image.data, "base64");
    assert.equal(image.mime_type, "image/png"); assert.equal(image.page_id, "main"); assert.deepEqual(image.timing, capture.timing);
    assert.equal(image.provenance.scope, scope); assert.equal(image.provenance.requestId, verified.request_id);
    assert.equal(image.provenance.subjectDigest, verified.subject_digest); assert.equal(image.checksum, capture.screenshot_digest);
    assert.equal(sha(png), capture.screenshot_digest); assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.equal(png.readUInt32BE(16), measured.viewport.width); assert.equal(png.readUInt32BE(20), measured.viewport.height);
  };
  const binding = { version: 1, profile_digest: f.profile.digest,
    checks: f.profile.capabilities.checks.map(({ command_id, config_digest, contract_digest }) => ({ command_id, config_digest, contract_digest })) };
  const request = { kind: "command", id: "author_start", idempotency_key: "author:start", type: "run.start", payload: {
    run_id: "author", task_id: "task", agent_instance_id: "author_instance", runtime: "fixture", workspace: { root: f.workspace },
    context_pack: { id: "author_context", payload: f.context }, policy_snapshot: f.context.policy, artifact_rules: { paths: [] },
    verification: { version: 1, profile_id: f.profile.id, request_id: "node-final-storage", capability_binding: binding } } };
  try {
    const before = subjectManifest(f.profile).digest;
    author = createNodeClient({ nodeId: "node", verificationProfiles: [f.profile],
      transport: { send: async message => { events.push(message); }, subscribe: handler => { send = handler; return () => {}; } },
      adapter: { runtimeId: "fixture", async start(config) {
        verifier = takeWorkspaceToolVerifier(config); reader = takeWorkspaceToolEvidenceReader(config);
        assert.equal(typeof verifier, "function"); assert.equal(typeof reader, "function"); return { runId: "author" };
      }, async *streamEvents() {
        yield { type: "run.lifecycle", payload: { phase: "started" } };
        const preview = (await verifier(new AbortController().signal)).verification;
        await readFaultEvidence(reader, preview, "preview");
        const observation = preview.checks[0].observation, measured = observation.cases[0];
        previewReferences.add(observation.evidence_bundle.bundle_id); previewReferences.add(measured.trace_ref);
        previewReferences.add(measured.captures[0].screenshot_ref);
        yield { type: "run.lifecycle", payload: { phase: "completed" } };
      }, async stop() {}, async collectArtifacts() { return []; } } });
    author.start(); send(request); await waitTerminal(events);
    const final = receipt(events); assert.equal(final?.outcome, "passed", final?.reason);
    assert.equal(final.subject_digest, before); assert.equal(subjectManifest(f.profile).digest, before);
    const observation = final.checks[0].observation, measured = observation.cases[0];
    assert.equal(observation.scope, "final"); assert.equal(previewReferences.size, 3);
    for (const reference of [observation.evidence_bundle.bundle_id, measured.trace_ref, measured.captures[0].screenshot_ref]) {
      assert.equal(previewReferences.has(reference), false);
    }
    await author.stop(true); author = undefined;
    const peerEvents = [], context = structuredClone(f.context); delete context.product_development;
    context.task.id = "peer_task"; context.policy = { execution_mode: "discussion", filesystem_write_scope: [], requires_approval: [] };
    context.review_subject = { version: 1, task_id: "task", run_id: "author", evidence_id: "author_evidence",
      subject_digest: final.subject_digest, development_stage: "design", verification: { version: 1,
        request_id: final.request_id, profile_id: final.profile_id, profile_digest: final.profile_digest,
        checks: final.checks.map(({ id, output_digest, observation }) => ({ id, output_digest, observation })) } };
    peer = createNodeClient({ nodeId: "node", verificationProfiles: [f.profile],
      transport: { send: async message => { peerEvents.push(message); }, subscribe: handler => { send = handler; return () => {}; } },
      adapter: { runtimeId: "fixture", async start(config) {
        assert.equal(takeWorkspaceToolVerifier(config), undefined);
        const peerContext = config.runStart.context_pack.payload;
        assert.equal(peerContext.policy.execution_mode, "discussion"); assert.deepEqual(peerContext.policy.filesystem_write_scope, []);
        assert.deepEqual(config.runStart.policy_snapshot.filesystem_write_scope, [f.workspace]);
        assert.deepEqual(peerContext.review_subject.verification.checks[0].observation.cases[0].storage_fault, measured.storage_fault);
        const read = takeWorkspaceToolEvidenceReader(config); assert.equal(typeof read, "function");
        await readFaultEvidence(read, final, "final");
        for (const reference of previewReferences) await assert.rejects(read(reference), /not granted/);
        return { runId: "peer" };
      }, async *streamEvents() { yield { type: "run.lifecycle", payload: { phase: "completed" } }; }, async stop() {}, async collectArtifacts() { return []; } } });
    peer.start(); send({ ...request, id: "peer_start", idempotency_key: "peer:start", payload: { ...request.payload,
      // Preserve the server's outer admission scope. The discussion context and
      // absent verifier grant separately limit peer tools to final evidence reads.
      run_id: "peer", task_id: "peer_task", agent_instance_id: "peer_instance", context_pack: { id: "peer_context", payload: context },
      verification: { ...request.payload.verification, request_id: "peer-final-storage", expected_subject_digest: final.subject_digest } } });
    await waitTerminal(peerEvents); assert.equal(receipt(peerEvents)?.outcome, "passed", receipt(peerEvents)?.reason);
    assert.equal(subjectManifest(f.profile).digest, before);
  } catch (error) { executionError = error; throw error; }
  finally {
    const stopped = await Promise.allSettled([peer?.stop(true), author?.stop(true)]);
    const cleanupErrors = stopped.filter(result => result.status === "rejected").map(result => result.reason);
    if (cleanupErrors.length) {
      f.retain(); f.close();
      throw new AggregateError([...(executionError ? [executionError] : []), ...cleanupErrors], `Unconfirmed node cleanup; fixture retained at ${f.root}`);
    }
    f.close();
  }
});
