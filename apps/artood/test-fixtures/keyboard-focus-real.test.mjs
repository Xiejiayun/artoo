// Built POSIX integration fixtures. No model provider or product publication is involved.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { prepareVerificationProfiles, runVerification, runVerificationPreview, subjectManifest, verificationSupported } from "../dist/verification.js";
import { readBrowserEvidence } from "../dist/browser-evidence.js";
import { createNodeClient } from "../dist/node-client.js";
import { takeWorkspaceToolVerifier, takeWorkspaceToolEvidenceReader } from "../dist/workspace-tools.js";

const cli = fileURLToPath(new URL("../dist/web-acceptance-cli.js", import.meta.url));
const browser = process.env.ARTOO_TEST_CHROMIUM;
const real = { skip: !verificationSupported() || !browser, timeout: 120000 };
const sha = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const viewports = [{ id: "compact", width: 512, height: 650 }, { id: "tall", width: 512, height: 1000 }];
const step = (action, properties = {}) => ({ action, page: "main", ...properties });
const navigate = step("navigate", { path: "/" });
const press = key => step("press", { key });
const focused = selector => step("assert_focused", { selector });
const opened = [navigate, press("Tab"), focused("#open"), press("Enter"), focused("#entry")];
const programs = {
  order: [navigate, press("Tab"), focused("#open")],
  keyboard: [...opened, step("type_text", { text: "Keyboard entry" }), press("Tab"), focused("#save"), press("Enter"),
    step("assert_text", { selector: "#status", text: "Saved: Keyboard entry" })],
  reverse: [...opened, press("Shift+Tab"), focused("#save"), step("assert_focus_within", { selector: "#dialog" })],
  restore: [...opened, press("Escape"), step("assert_hidden", { selector: "#dialog" }), focused("#open")],
  trace: [navigate, step("focus", { selector: "#open" }), ...Array.from({ length: 85 }, () => focused("#open"))],
};
// These programs belong only to their explicit attack/repair fixtures. The five
// ordinary product cases above must all remain executable by the default product.
const probePrograms = {
  containment: [...opened, press("Shift+Tab"), step("assert_focus_within", { selector: "#dialog" })],
  setup: [navigate, step("focus", { selector: "#open" }), focused("#open")],
  missing: [navigate, focused("#missing-focus-target")],
  shadow: [navigate, step("focus", { selector: "#shadow-host" }), focused("#shadow-host")],
  pollution: [navigate, step("assert_text", { selector: "#pollution", text: "Main-world overrides installed" })],
};
const allPrograms = { ...programs, ...probePrograms };

function html(mode) {
  const opener = mode === "mouse-only" ? '<div id="open" role="button" tabindex="0">Open editor</div>'
    : mode === "spoof-setup" ? '<div id="open" role="button">Open editor</div>' : '<button id="open">Open editor</button>';
  return `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Keyboard fixture</title>
    <style>body{margin:12px}textarea{display:block;width:100%;box-sizing:border-box}[hidden]{display:none}</style></head>
    <body><h1>Keyboard fixture</h1>${opener}<section id="dialog" role="dialog" aria-modal="true" aria-label="Editor" hidden>
    <label for="entry">Entry</label><textarea id="entry"></textarea><button id="save">Save</button></section>
    <button id="outside"${["tab-order", "spoof-focus", "spoof-query"].includes(mode) ? ' tabindex="1"' : ""}>Outside</button><p id="status">Ready</p>
    ${mode === "closed-shadow" ? '<div id="shadow-host" tabindex="0"></div>' : ""}
    ${mode === "polluted-correct" ? '<p id="pollution">Overrides pending</p>' : ""}
    <script>
    const opener=document.getElementById('open'), dialog=document.getElementById('dialog'), entry=document.getElementById('entry'), save=document.getElementById('save'), outside=document.getElementById('outside');
    // Product behavior deliberately retains the original native methods. The
    // polluted positive fixture changes only what a main-world verifier observes.
    const nativeFocus=HTMLElement.prototype.focus, nativeQueryAll=Document.prototype.querySelectorAll;
    const nativeActive=Object.getOwnPropertyDescriptor(Document.prototype,'activeElement').get;
    const focus=element=>nativeFocus.call(element), active=()=>nativeActive.call(document);
    opener.addEventListener('click',()=>{dialog.hidden=false;focus(entry);});
    save.addEventListener('click',()=>{document.getElementById('status').textContent='Saved: '+entry.value;});
    dialog.addEventListener('keydown',event=>{
      if(event.key==='Escape'){event.preventDefault();dialog.hidden=true;${mode === "restore" ? "focus(outside);" : "focus(opener);"}}
      ${["reverse", "spoof-contains"].includes(mode) ? "" : "if(event.key==='Tab'&&event.shiftKey&&active()===entry){event.preventDefault();focus(save);} if(event.key==='Tab'&&!event.shiftKey&&active()===save){event.preventDefault();focus(entry);}"}
    });
    ${mode === "spoof-focus" ? "Object.defineProperty(document,'activeElement',{get:()=>opener});" : ""}
    ${mode === "spoof-query" ? "document.querySelectorAll=function(selector){return selector==='#open'?[outside]:nativeQueryAll.call(this,selector);};" : ""}
    ${mode === "spoof-contains" ? "Node.prototype.contains=function(){return true;};" : ""}
    ${mode === "spoof-setup" ? "focus(outside);opener.focus=function(){};Object.defineProperty(document,'activeElement',{get:()=>opener});" : ""}
    ${mode === "polluted-correct" ? `
      Object.defineProperty(document,'activeElement',{get:()=>outside});
      document.querySelectorAll=function(selector){return ['#open','#entry','#save','#dialog'].includes(selector)?[outside]:nativeQueryAll.call(this,selector);};
      Node.prototype.contains=function(){return false;};
      HTMLElement.prototype.focus=function(){};
      document.getElementById('pollution').textContent='Main-world overrides installed';
    ` : ""}
    ${mode === "closed-shadow" ? `
      const host=document.getElementById('shadow-host'), root=host.attachShadow({mode:'closed',delegatesFocus:true});
      const control=document.createElement('button');control.textContent='Closed shadow control';root.append(control);
    ` : ""}
    ${mode === "popup" ? "opener.addEventListener('click',()=>window.open('/','unexpected'));" : ""}
    ${mode === "iframe" ? "opener.addEventListener('click',()=>{const frame=document.createElement('iframe');frame.src='/';document.body.append(frame);});" : ""}
    </script></body></html>`;
}
function fixture(mode = "correct", caseIds = Object.keys(programs), designCapture = true) {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), "artoo-keyboard-real-"));
  const workspace = join(root, "workspace"), evidence = join(root, "evidence"), config = join(root, "web.json");
  mkdirSync(join(workspace, ".artoo/product"), { recursive: true }); mkdirSync(join(workspace, "product")); mkdirSync(evidence);
  writeFileSync(config, JSON.stringify({ evidence_root: evidence, browser_executable: realpathSync.native(browser),
    browser_program: { version: 2, viewports }, action_timeout_ms: 1000, design_capture_cases: designCapture }));
  const [profile] = prepareVerificationProfiles([{ id: "web", project_id: "project", workspace_root: workspace,
    commands: [{ id: "browser", argv: [process.execPath, cli, config], timeout_ms: 60000,
      observation: { format: "static-web-acceptance.v2", evidence_root: evidence, capabilities: { version: 1 } } }],
    required_files: [], subject_paths: ["product", ".artoo/product"] }]);
  const contractDigest = profile.capabilities.checks[0].contract_digest;
  const research = { version: 1, objective: "Controlled keyboard and focus fixture", assumptions: [],
    requirements: [{ id: "keyboard", description: "Keyboard editor and dialog focus", priority: "must", acceptance_criteria: ["Keyboard saves; reverse Tab is contained; Escape restores focus"] }],
    sources: [{ id: "fixture", url: "https://example.com/spec", title: "Schema fixture, not live research", retrieved_at: "2026-11-05T00:00:00Z", content_digest: sha("fixture") }],
    findings: [{ summary: "Measure actual keyboard events and focused elements", source_ids: ["fixture"] }], decisions: [] };
  const design = { version: 1, requirement_ids: ["keyboard"], information_architecture: ["Editor"],
    user_flows: [{ id: "edit", name: "Edit", requirement_ids: ["keyboard"], steps: ["Open", "Write", "Save", "Close"] }],
    screens: [{ id: "editor", name: "Editor", purpose: "Write", states: ["Closed", "Open"], accessibility: ["Keyboard focus"], responsive: ["Fit configured dimensions"] }],
    prototype: { entrypoint: "product/index.html", description: "Controlled keyboard fixture" }, data_model: [], api_contracts: [],
    decisions: [{ decision: "Exercise actual browser keyboard events", rationale: "Click and programmatic focus cannot establish keyboard traversal" }],
    validation_cases: caseIds.map(id => ({ id, requirement_ids: ["keyboard"], procedure: ["Exercise real browser controls"], expected_result: "Program assertions pass",
      browser_program: { version: 2, contract_digest: contractDigest, steps: allPrograms[id] } })) };
  writeFileSync(join(workspace, ".artoo/product/research.json"), JSON.stringify(research));
  writeFileSync(join(workspace, ".artoo/product/design.json"), JSON.stringify(design));
  writeFileSync(join(workspace, "product/index.html"), html(mode));
  const context = { task: { id: "task", title: "Keyboard fixture", description: "Measure without mouse substitution", acceptance_criteria: ["Keyboard interaction works"] },
    project: { id: "project", name: "Fixture", default_workspace: workspace }, workspace: { root: workspace, file_scope: [] },
    policy: { filesystem_write_scope: [workspace], requires_approval: [] }, memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] },
    verification_capabilities: { ...profile.capabilities, profile_id: profile.id },
    product_development: { version: 1, stage: "design", instructions: ["Use the configured contract"],
      deliverables: [{ path: ".artoo/product/design.json", format: "json", purpose: "Controlled handoff" }] } };
  return { root, workspace, evidence, profile, context, close: () => rmSync(root, { recursive: true, force: true }) };
}
function grant(f, receipt, scope = "final") {
  return { evidenceRoot: f.evidence, requestId: receipt.request_id, profileId: f.profile.id, profileDigest: f.profile.digest,
    subjectDigest: receipt.subject_digest, checkId: "browser", scope, ...receipt.checks[0].observation.evidence_bundle };
}

test("v2 executes keyboard, reverse Tab and Escape; seals exact viewport height and paged actual traces", real, async () => {
  const f = fixture();
  try {
    const before = subjectManifest(f.profile).digest;
    const receipt = await runVerification(f.profile, "keyboard-correct", new AbortController().signal, f.context);
    assert.equal(receipt.outcome, "passed", receipt.reason); assert.equal(receipt.checks[0].exit_code, 0);
    assert.equal(subjectManifest(f.profile).digest, before);
    const observation = receipt.checks[0].observation, binding = grant(f, receipt);
    assert.equal(observation.version, 2); assert.equal(observation.cases.length, viewports.length * Object.keys(programs).length);
    for (const item of observation.cases) {
      assert.equal(item.operation_count, programs[item.case_id].length);
      const image = readBrowserEvidence(binding, item.captures[0].screenshot_ref), png = Buffer.from(image.data, "base64");
      assert.equal(png.readUInt32BE(16), item.viewport.width); assert.equal(png.readUInt32BE(20), item.viewport.height);
      assert.equal(sha(png), item.captures[0].screenshot_digest);
      const content = readBrowserEvidence(binding, item.trace_ref), trace = JSON.parse(content.text);
      assert.deepEqual(trace.operations.map(operation => operation.action), programs[item.case_id].map(operation => operation.action));
      assert.equal(sha(content.text), item.trace_digest); assert.deepEqual(trace.viewport, item.viewport);
      if (item.case_id === "keyboard") {
        assert.equal(trace.operations.some(operation => operation.action === "click" || operation.action === "fill" || operation.action === "focus"), false);
        assert.equal(content.text.includes("Keyboard entry"), false, "typed content must not leak into observations");
      }
      if (item.case_id === "trace") {
        assert.ok(item.trace_size > 16 * 1024, `long actual trace is only ${item.trace_size} bytes`);
        let text = "", offset = 0, checksum;
        do {
          const page = readBrowserEvidence(binding, item.trace_ref, { offset, limit: 8192, ...(checksum ? { expected_checksum: checksum } : {}) });
          checksum ??= page.checksum; assert.equal(page.checksum, checksum); text += page.text; offset = page.next_offset;
        } while (offset !== null);
        assert.equal(text, content.text); assert.equal(checksum, item.trace_digest);
        assert.throws(() => readBrowserEvidence(binding, item.trace_ref, { offset: 8192, limit: 8192 }), /checksum/);
        assert.throws(() => readBrowserEvidence(binding, item.trace_ref, { limit: 8192, expected_checksum: sha("another trace") }), /checksum/);
      }
    }
  } finally { f.close(); }
});

for (const [mode, caseId] of [["mouse-only", "keyboard"], ["tab-order", "keyboard"], ["reverse", "reverse"], ["restore", "restore"],
  ["spoof-focus", "order"], ["spoof-query", "order"], ["spoof-contains", "containment"], ["spoof-setup", "setup"], ["missing-focus", "missing"]]) {
  test(`v2 rejects the ${mode} defect with unchanged keyboard requirements`, real, async () => {
    const f = fixture(mode, [caseId]);
    try {
      const before = subjectManifest(f.profile).digest;
      const receipt = await runVerification(f.profile, `broken-${mode}`, new AbortController().signal, f.context);
      assert.equal(receipt.outcome, "failed"); assert.equal(receipt.checks[0].exit_code, 1);
      assert.match(receipt.reason, /assert_focused|assert_focus_within|focus assertion|\bfocus\b.*(?:failed|exceeded)/i);
      assert.equal(receipt.checks[0].observation, undefined); assert.equal(subjectManifest(f.profile).digest, before);
    } finally { f.close(); }
  });
}

test("v2 measures correct native focus despite poisoned main-world getters and methods", real, async () => {
  const caseIds = [...Object.keys(programs), "containment", "setup", "pollution"];
  const f = fixture("polluted-correct", caseIds);
  try {
    const before = subjectManifest(f.profile).digest;
    const receipt = await runVerification(f.profile, "polluted-correct", new AbortController().signal, f.context);
    assert.equal(receipt.outcome, "passed", receipt.reason); assert.equal(receipt.checks[0].exit_code, 0);
    assert.equal(subjectManifest(f.profile).digest, before);
    const observation = receipt.checks[0].observation, binding = grant(f, receipt);
    assert.equal(observation.cases.length, viewports.length * caseIds.length);
    for (const item of observation.cases) {
      const content = readBrowserEvidence(binding, item.trace_ref), trace = JSON.parse(content.text);
      assert.deepEqual(trace.operations.map(operation => operation.action), allPrograms[item.case_id].map(operation => operation.action));
      for (const operation of trace.operations.filter(operation => ["focus", "assert_focused", "assert_focus_within"].includes(operation.action))) {
        assert.deepEqual(operation.observation, operation.action === "focus"
          ? { kind: "programmatic-focus", focused: true } : { kind: "focus-assertion", passed: true });
      }
    }
  } finally { f.close(); }
});

test("v2 rejects a closed shadow focus target and exposes no final evidence", real, async () => {
  const f = fixture("closed-shadow", ["shadow"]);
  try {
    const before = subjectManifest(f.profile).digest;
    const receipt = await runVerification(f.profile, "closed-shadow-focus", new AbortController().signal, f.context);
    assert.equal(receipt.outcome, "failed"); assert.equal(receipt.checks[0].exit_code, 1);
    assert.match(receipt.reason, /shadow.*unsupported|unsupported.*shadow/i);
    assert.equal(receipt.checks[0].observation, undefined); assert.equal(subjectManifest(f.profile).digest, before);
  } finally { f.close(); }
});

for (const mode of ["popup", "iframe"]) {
  test(`v2 rejects an unexpected ${mode} and exposes no final evidence`, real, async () => {
    const f = fixture(mode, ["keyboard"]);
    try {
      const receipt = await runVerification(f.profile, `unsupported-${mode}`, new AbortController().signal, f.context);
      assert.equal(receipt.outcome, "failed"); assert.equal(receipt.checks[0].exit_code, 1);
      assert.match(receipt.reason, /unsupported|iframe/i); assert.equal(receipt.checks[0].observation, undefined);
    } finally { f.close(); }
  });
}

test("v2 research has no browser operations and prototype preview seals only its protected navigation", real, async () => {
  const f = fixture("correct", ["keyboard"], false);
  try {
    const researchContext = structuredClone(f.context); researchContext.product_development.stage = "research";
    const research = await runVerification(f.profile, "research-v2", new AbortController().signal, researchContext);
    assert.equal(research.outcome, "passed", research.reason); assert.deepEqual(research.checks[0].observation.cases, []);
    assert.ok(readBrowserEvidence(grant(f, research), research.checks[0].observation.evidence_bundle.bundle_id));
    const { verification: preview } = await runVerificationPreview(f.profile, "prototype-v2", new AbortController().signal, f.context);
    assert.equal(preview.outcome, "passed", preview.reason);
    for (const item of preview.checks[0].observation.cases) {
      assert.equal(item.case_id, "prototype"); assert.equal(item.operation_count, 1); assert.equal(item.assertions, 0);
      const trace = JSON.parse(readBrowserEvidence(grant(f, preview, "preview"), item.trace_ref).text);
      assert.deepEqual(trace.operations.map(operation => operation.action), ["navigate"]);
    }
  } finally { f.close(); }
});

test("node grants v2 preview traces to the author and only final source-bound traces to an independent peer", real, async () => {
  const f = fixture("correct", ["trace"]), events = [];
  let send, verifier, reader, previewReference, author, peer;
  const terminal = messages => messages.find(message => message.kind === "run.event" && message.event.type === "run.lifecycle"
    && ["completed", "cancelled", "failed"].includes(message.event.payload.phase));
  const receipt = messages => messages.find(message => message.kind === "run.event" && message.event.type === "run.verification")?.event.payload;
  const waitTerminal = async messages => {
    const deadline = Date.now() + 90000;
    while (!terminal(messages)) {
      const rejection = messages.find(message => message.status === "rejected");
      assert.equal(rejection, undefined, `Node rejected the fixture request: ${JSON.stringify(rejection)}`);
      assert.ok(Date.now() < deadline, "node evidence flow did not finish");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(terminal(messages).event.payload.phase, "completed", JSON.stringify(terminal(messages)));
  };
  const binding = { version: 1, profile_digest: f.profile.digest,
    checks: f.profile.capabilities.checks.map(({ command_id, config_digest, contract_digest }) => ({ command_id, config_digest, contract_digest })) };
  const request = { kind: "command", id: "author_start", idempotency_key: "author:start", type: "run.start", payload: {
    run_id: "author", task_id: "task", agent_instance_id: "author_instance", runtime: "fixture", workspace: { root: f.workspace },
    context_pack: { id: "author_context", payload: f.context }, policy_snapshot: f.context.policy, artifact_rules: { paths: [] },
    verification: { version: 1, profile_id: f.profile.id, request_id: "node-final-v2", capability_binding: binding } } };
  try {
    author = createNodeClient({ nodeId: "node", verificationProfiles: [f.profile],
      transport: { send: async message => { events.push(message); }, subscribe: handler => { send = handler; return () => {}; } },
      adapter: { runtimeId: "fixture", async start(config) {
        verifier = takeWorkspaceToolVerifier(config); reader = takeWorkspaceToolEvidenceReader(config);
        assert.equal(typeof verifier, "function"); assert.equal(typeof reader, "function"); return { runId: "author" };
      }, async *streamEvents() {
        yield { type: "run.lifecycle", payload: { phase: "started" } };
        const preview = (await verifier(new AbortController().signal)).verification;
        assert.equal(preview.outcome, "passed", preview.reason);
        const measured = preview.checks[0].observation.cases[0]; previewReference = measured.trace_ref;
        const first = await reader(previewReference, { offset: 0, limit: 4096 });
        assert.equal(first.provenance.scope, "preview"); assert.equal(first.checksum, measured.trace_digest);
        const second = await reader(previewReference, { offset: first.next_offset, limit: 4096, expected_checksum: first.checksum });
        assert.equal(second.offset, first.next_offset); assert.equal(second.checksum, first.checksum);
        assert.equal((await reader(measured.captures[0].screenshot_ref)).mime_type, "image/png");
        await assert.rejects(reader("trace_other_session"), /not granted/);
        yield { type: "run.lifecycle", payload: { phase: "completed" } };
      }, async stop() {}, async collectArtifacts() { return []; } } });
    author.start(); send(request); await waitTerminal(events);
    const final = receipt(events); assert.equal(final.outcome, "passed", final.reason);
    const measured = final.checks[0].observation.cases[0]; assert.notEqual(measured.trace_ref, previewReference);
    await author.stop(true);
    const peerEvents = [], context = structuredClone(f.context); delete context.product_development;
    context.task.id = "peer_task"; context.policy = { execution_mode: "discussion", filesystem_write_scope: [], requires_approval: [] };
    context.review_subject = { version: 1, task_id: "task", run_id: "author", evidence_id: "author_evidence",
      subject_digest: final.subject_digest, development_stage: "design", verification: { version: 1,
        request_id: final.request_id, profile_id: final.profile_id, profile_digest: final.profile_digest,
        checks: final.checks.map(({ id, output_digest, observation }) => ({ id, output_digest, observation })) } };
    peer = createNodeClient({ nodeId: "node", verificationProfiles: [f.profile],
      transport: { send: async message => { peerEvents.push(message); }, subscribe: handler => { send = handler; return () => {}; } },
      adapter: { runtimeId: "fixture", async start(config) {
        assert.equal(takeWorkspaceToolVerifier(config), undefined); const read = takeWorkspaceToolEvidenceReader(config);
        const first = await read(measured.trace_ref, { offset: 0, limit: 4096 });
        assert.equal(first.provenance.scope, "final"); assert.equal(first.provenance.subjectDigest, final.subject_digest);
        assert.equal(first.checksum, measured.trace_digest);
        const next = await read(measured.trace_ref, { offset: first.next_offset, limit: 4096, expected_checksum: first.checksum });
        assert.equal(next.checksum, first.checksum);
        assert.equal((await read(measured.captures[0].screenshot_ref)).checksum, measured.captures[0].screenshot_digest);
        await assert.rejects(read(previewReference), /not granted/);
        await assert.rejects(read(measured.trace_ref, { offset: first.next_offset, limit: 4096 }), /checksum/);
        await assert.rejects(read(measured.trace_ref, { limit: 4096, expected_checksum: sha("wrong trace") }), /checksum/);
        return { runId: "peer" };
      }, async *streamEvents() { yield { type: "run.lifecycle", payload: { phase: "completed" } }; }, async stop() {}, async collectArtifacts() { return []; } } });
    peer.start(); send({ ...request, id: "peer_start", idempotency_key: "peer:start", payload: { ...request.payload,
      // Match the server's outer workspace admission scope. The review context
      // and read-only broker independently prohibit product writes/verifier use.
      run_id: "peer", task_id: "peer_task", agent_instance_id: "peer_instance", context_pack: { id: "peer_context", payload: context },
      verification: { ...request.payload.verification, request_id: "peer-final-v2", expected_subject_digest: final.subject_digest } } });
    await waitTerminal(peerEvents); assert.equal(receipt(peerEvents).outcome, "passed");
  } finally { await peer?.stop(true); await author?.stop(true); f.close(); }
});
