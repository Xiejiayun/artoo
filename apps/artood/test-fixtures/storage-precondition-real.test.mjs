// Controlled native browser regressions, not model/live-product acceptance.
// Requires a fresh integrated build containing the candidate runtime/domain
// changes. Never platform-mock, skip Windows, replace a browser response, or
// loosen the production timeouts to qualify this fixture.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ProductDesignV2Schema, ProductResearchReportSchema, storagePreconditionReportFromTraceV1, storageFaultReportFromTraceV1 } from "@artoo/domain";
import { prepareVerificationProfiles, readVerificationCapabilities, attachWindowsVerificationBackend, runVerification, subjectManifest } from "../dist/verification.js";
import { prepareWindowsProcessInstallation } from "../dist/windows-process-installation.js";
import { readBrowserEvidence } from "../dist/browser-evidence.js";
import { STORAGE_FAULT_INITIALIZER_DIGEST } from "../dist/web-acceptance-storage-source.js";

if (process.platform !== "win32" || process.arch !== "x64") throw new Error("This fixture requires native Windows x64; a skip is not qualification");
function physicalEnvironment(name, directory) {
  const value = process.env[name];
  assert.ok(value && isAbsolute(value), name + " must name an explicit existing absolute path");
  const result = realpathSync.native(value), stat = lstatSync(value);
  assert.equal(stat.isSymbolicLink(), false, name + " cannot be a link");
  assert.equal(directory ? stat.isDirectory() : stat.isFile(), true, name + " has the wrong type");
  return result;
}
const fixtureRoot = physicalEnvironment("ARTOO_STORAGE_PRECONDITION_FIXTURE_ROOT", true);
const workspaceParent = physicalEnvironment("ARTOO_STORAGE_PRECONDITION_WORKSPACE_PARENT", true);
const browser = physicalEnvironment("ARTOO_TEST_CHROMIUM", false);
const bundle = JSON.parse(readFileSync(join(fixtureRoot, "bundle.json"), "utf8"));
const inside = (target, root) => { const tail = relative(root, target); return tail === "" || tail !== ".." && !tail.startsWith(".." + sep) && !isAbsolute(tail); };
assert.ok(bundle.writableWorkspaceRoots.some(root => inside(workspaceParent, root)), "Workspace parent must be covered by the declared complete agent write roots");
assert.ok(bundle.writableWorkspaceRoots.every(root => !inside(fixtureRoot, root) && !inside(root, fixtureRoot)), "Audit/configuration root must be outside all agent write roots");
const backend = prepareWindowsProcessInstallation(bundle);
const cli = fileURLToPath(new URL("../dist/web-acceptance-cli.js", import.meta.url));
const worker = fileURLToPath(new URL("./storage-precondition-native-worker.mjs", import.meta.url));
const real = { timeout: 120000, concurrency: false };
const viewport = { id: "compact", width: 512, height: 650 };
const policy = { version: 2, coverage: "every-must-criterion", methods: ["workspace-check", "configured-static-release"] };
const sha = value => "sha256:" + createHash("sha256").update(value).digest("hex");
const canonical = value => Array.isArray(value) ? "[" + value.map(canonical).join(",") + "]"
  : value && typeof value === "object" ? "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}"
    : JSON.stringify(value);
const key = "controlled-journal:v1", resetDocument = '{"version":1,"entries":[]}';
const unsaved = "Unsaved draft retained through damaged storage";
const ref = { requirement_id: "storage", criterion_index: 0 };
const action = (name, value = {}, page = "main") => ({ action: name, page, ...value });
const click = (selector, page) => action("click", { selector }, page);
const text = (selector, value, page) => action("assert_text", { selector, text: value }, page);
const value = expected => action("assert_value", { selector: "#draft", value: expected });
const initial = action("navigate", { path: "/" });
const fill = action("fill", { selector: "#draft", value: unsaved });
const inputs = [
  ["invalid-json", ' \n{ broken: "🚧" \t'],
  ["invalid-schema", '{"version":2,"entries":[]}'],
  ["invalid-record", '{"version":1,"entries":[{"id":7,"text":"invalid id type"}]}'],
];
const cycleSteps = [
  initial, text("#status", "Invalid saved data"), text("#records", "Empty"), fill,
  click("#retry"), text("#status", "Invalid saved data"), value(unsaved),
  click("#reset"), click("#reset-cancel"), text("#status", "Reset cancelled"), value(unsaved),
  click("#reset"), click("#reset-confirm"), text("#status", "Reset failed"), value(unsaved), text("#records", "Empty"),
  click("#reset"), click("#reset-confirm"), text("#status", "Reset complete"), value(""),
  action("reload"), text("#status", "Ready"), text("#records", "Empty"), value(""),
];
const peerSteps = [
  initial, text("#status", "Invalid saved data"), fill,
  action("open_page", { path: "/" }, "peer"), text("#status", "Invalid saved data", "peer"),
  action("reload", {}, "peer"), text("#status", "Invalid saved data", "peer"),
  click("#reset", "peer"), click("#reset-confirm", "peer"), text("#status", "Reset complete", "peer"),
  // The same visible notice is shown by positive and negative products. Only
  // the later main Retry result separates them; the worker also observes the
  // genuine trusted StorageEvent in a fixed isolated browser world.
  text("#external", "Saved data changed in another tab"), value(unsaved),
  click("#retry"), text("#status", "Ready"), action("assert_count", { selector: ".entry", count: 0 }), value(""),
  action("reload"), text("#status", "Ready"), action("close_page", {}, "peer"), text("#records", "Empty"),
];
const failedUi = /assert_text did not match|Browser assert_text exceeded the protected timeout/;
const preservationFailure = /Native storage no longer equals the actual seeded document/;
const faultMutation = /Native localStorage mutation observed during a fault window|Native localStorage snapshots differ across the fault window/;
function documentHtml(defect) {
  // Fixed controlled product. It has no initial-storage injection, CDP access,
  // verifier hooks or self-reported counters. Reset and Retry are real UI code.
  // Both peer variants share this exact implementation except the defect literal.
  return [
    '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>Controlled storage recovery</title><style>body{margin:12px;font:16px sans-serif}textarea{display:block;width:100%;box-sizing:border-box}button{margin:4px;padding:8px}p{overflow-wrap:anywhere}[hidden]{display:none}</style></head>',
    '<body><h1>Controlled journal</h1><label for="draft">Draft</label><textarea id="draft"></textarea>',
    '<button id="retry">Retry loading</button><button id="reset">Reset saved data</button>',
    '<div id="reset-panel" role="dialog" aria-label="Confirm reset" hidden><p>Replace saved data with an empty journal?</p><button id="reset-confirm">Confirm reset</button><button id="reset-cancel">Cancel reset</button></div>',
    '<p id="status">Starting</p><p id="external"></p><div id="records">Empty</div><script>',
    'const defect=' + JSON.stringify(defect) + ',KEY="controlled-journal:v1";',
    'const draft=document.getElementById("draft"),status=document.getElementById("status"),records=document.getElementById("records"),panel=document.getElementById("reset-panel"),external=document.getElementById("external");',
    'let baseline=null,mode="starting";',
    'function decode(raw){if(raw===null)return {version:1,entries:[]};const data=JSON.parse(raw);',
    'if(!data||Array.isArray(data)||data.version!==1||!Array.isArray(data.entries))throw new Error("Invalid schema");',
    'if(data.entries.some(entry=>!entry||typeof entry!=="object"||typeof entry.id!=="string"||!entry.id||typeof entry.text!=="string"))throw new Error("Invalid record");return data;}',
    'function render(data){records.replaceChildren();if(!data.entries.length){records.textContent="Empty";return;}for(const entry of data.entries){const p=document.createElement("p");p.className="entry";p.textContent=entry.text;records.append(p);}}',
    'function load(retry){if(retry&&mode==="conflict"){status.textContent="Conflict: reload before retry";return;}',
    'try{const raw=localStorage.getItem(KEY),data=decode(raw);baseline=raw;mode="ready";render(data);draft.value="";status.textContent="Ready";}',
    'catch(error){mode="malformed";status.textContent="Invalid saved data";if(retry&&defect==="retry-deletes")localStorage.removeItem(KEY);}}',
    'document.getElementById("retry").onclick=()=>load(true);',
    'document.getElementById("reset").onclick=()=>{panel.hidden=false;};',
    'document.getElementById("reset-cancel").onclick=()=>{panel.hidden=true;if(defect==="cancel-deletes")localStorage.removeItem(KEY);status.textContent="Reset cancelled";};',
    'document.getElementById("reset-confirm").onclick=()=>{panel.hidden=true;try{const raw=JSON.stringify({version:1,entries:[]});localStorage.setItem(KEY,raw);baseline=raw;mode="ready";draft.value="";render({version:1,entries:[]});status.textContent="Reset complete";}',
    'catch(error){if(defect==="failed-reset-deletes")localStorage.removeItem(KEY);status.textContent="Reset failed";}};',
    'addEventListener("storage",event=>{if(event.key!==KEY)return;external.textContent="Saved data changed in another tab";',
    'if(defect==="malformed-conflict"&&event.newValue!==baseline){mode="conflict";status.textContent="Conflict detected";}',
    'else if(mode==="malformed"){status.textContent="Saved data changed; Retry to load";}',
    'else if(event.newValue!==baseline){mode="conflict";status.textContent="Conflict detected";}});',
    'load(false);</script></body></html>',
  ].join("\n");
}
function fixture(inputName, raw, { peer = false, defect = "correct" } = {}) {
  const root = realpathSync.native(mkdtempSync(join(fixtureRoot, "storage-" + inputName + "-" + defect + "-")));
  const workspace = realpathSync.native(mkdtempSync(join(workspaceParent, "storage-precondition-")));
  writeFileSync(join(root, "paths.json"), JSON.stringify({ claim: "controlled-native-fixture", workspace, records: root, browser, bundle }, null, 2));
  const evidence = join(root, "evidence"), config = join(root, "web.json"), nativeConfig = join(root, "native.json");
  mkdirSync(evidence); mkdirSync(join(workspace, ".artoo/product"), { recursive: true }); mkdirSync(join(workspace, "product"));
  const options = { evidence_root: evidence, browser_executable: browser,
    browser_program: { version: 3, viewports: [viewport] }, storage_precondition: { version: 1 },
    ...(!peer ? { storage_fault: { version: 1 } } : {}), action_timeout_ms: 1000, design_capture_cases: true };
  writeFileSync(config, JSON.stringify(options));
  const [profile] = prepareVerificationProfiles([{ id: "web", project_id: "project", workspace_root: workspace,
    commands: [{ id: "browser", argv: [process.execPath, cli, config], timeout_ms: 60000,
      observation: { format: "static-web-acceptance.v3", evidence_root: evidence, capabilities: { version: 1 } } }],
    required_files: [".artoo/product/research.json", ".artoo/product/design.json", "product/index.html"],
    subject_paths: ["product", ".artoo/product"], measurement_plan_policy: policy }], bundle.writableWorkspaceRoots);
  attachWindowsVerificationBackend(profile, backend);
  const capabilities = readVerificationCapabilities(profile), contract = capabilities.checks[0];
  const steps = structuredClone(peer ? peerSteps : cycleSteps), assertions = steps.flatMap((step, index) => ["assert_text", "assert_value", "assert_count"].includes(step.action) ? [index] : []);
  const checkpoints = peer ? [6] : [2, 6, 10, 15];
  const storage = { version: 1, local_storage: { key, value: raw }, requirement_criteria: [ref], ui_assertion_steps: assertions,
    preservation_checks: checkpoints.map(after_step => ({ after_step, requirement_criteria: [ref], ui_assertion_steps: [after_step] })) };
  const needs = [{ kind: "storage-precondition", version: 1, input: "raw-local-document", phase: "before-first-product-script",
    page_scope: "main-seed-same-origin-pages", preservation: "seeded-sampled-equal" }];
  if (peer) needs.push({ kind: "pages", max_created: 2, same_origin: true, same_browser_context: true });
  else needs.push({ kind: "storage-fault", version: 1, mode: "write-quota", invariant: "sampled-equal", page_scope: "main-only", api_scope: "fixed-entry" });
  const research = ProductResearchReportSchema.parse({ version: 1, objective: "Controlled native malformed storage recovery", assumptions: [],
    requirements: [{ id: "storage", description: "Recover through actual UI without silently discarding damaged data", priority: "must",
      acceptance_criteria: [peer ? "Peer Reset repairs storage; main receives a real storage event, then Retry loads and reload remains valid"
        : "Retry and cancelled or failed Reset preserve malformed bytes and draft; successful Reset survives reload"] }],
    sources: [{ id: "fixture", url: "https://example.com/controlled-storage", title: "Controlled schema fixture, not fetched research",
      retrieved_at: "2026-11-05T00:00:00Z", content_digest: sha("controlled") }],
    findings: [{ summary: "Native seeded data and real UI exercise bounded storage recovery", source_ids: ["fixture"] }], decisions: [],
    measurement_plan: { version: 2, profile_digest: profile.digest, entries: [{ method: "workspace-check", ...ref, command_id: contract.command_id,
      config_digest: contract.config_digest, contract_digest: contract.contract_digest, actions: [...new Set(steps.map(step => step.action))],
      keys: [], viewports: [viewport], needs }] } });
  const selected = { id: peer ? "peer-retry" : "malformed-cycle", method: "workspace-check", requirement_ids: ["storage"], requirement_criteria: [ref],
    procedure: ["Operate the controlled product UI using the exact protected browser program"], expected_result: research.requirements[0].acceptance_criteria[0],
    browser_program: { version: 3, contract_digest: contract.contract_digest, steps }, storage_precondition: storage,
    ...(!peer ? { storage_checks: { version: 1, windows: [{ id: "failed-reset", page: "main", mode: "write-quota",
      arm_before_step: 12, settle_after_step: 15, requirement_criteria: [ref], ui_assertion_steps: [13, 14, 15], min_hits: 1,
      native_storage: { scope: "all", comparison: "sampled-equal" } }] } } : {}) };
  const design = ProductDesignV2Schema.parse({ version: 2, requirement_ids: ["storage"], information_architecture: ["Journal"],
    user_flows: [{ id: "recovery", name: "Recover", requirement_ids: ["storage"], steps: ["Inspect error", "Retry", "Cancel or confirm Reset"] }],
    screens: [{ id: "journal", name: "Journal", purpose: "Write", states: ["Invalid", "Ready", "Reset failed"], accessibility: ["Labelled controls"],
      responsive: ["Fit the configured compact viewport"] }], prototype: { entrypoint: "product/index.html", description: "Fixed controlled product" },
    data_model: [], api_contracts: [], decisions: [{ decision: "Use one raw fixture only at first document", rationale: "Prove native preservation and normal UI recovery" }],
    validation_cases: [selected] });
  const sources = { ".artoo/product/research.json": JSON.stringify(research, null, 2) + "\n",
    ".artoo/product/design.json": JSON.stringify(design, null, 2) + "\n", "product/index.html": documentHtml(defect) };
  for (const [file, content] of Object.entries(sources)) writeFileSync(join(workspace, file), content);
  const context = { task: { id: "task", title: "Controlled native storage fixture", description: "Real browser regression", acceptance_criteria: [] },
    project: { id: "project", name: "Fixture", default_workspace: workspace }, workspace: { root: workspace, file_scope: [] },
    policy: { filesystem_write_scope: [workspace], requires_approval: [] }, memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] },
    verification_capabilities: capabilities, product_development: { version: 1, stage: "design", instructions: ["Controlled fixture, not live research"],
      deliverables: [{ path: ".artoo/product/design.json", format: "json", purpose: "Controlled browser handoff" }] } };
  writeFileSync(nativeConfig, JSON.stringify({ workspace, browser_executable: browser, case_id: selected.id,
    action_timeout_ms: 1000, viewport: { width: viewport.width, height: viewport.height } }));
  const [nativeProfile] = prepareVerificationProfiles([{ id: "native-observer", project_id: "project", workspace_root: workspace,
    commands: [{ id: "native", argv: [process.execPath, worker, nativeConfig], timeout_ms: 60000 }],
    required_files: Object.keys(sources), subject_paths: ["product", ".artoo/product"] }], bundle.writableWorkspaceRoots);
  attachWindowsVerificationBackend(nativeProfile, backend);
  const nativeContext = structuredClone(context); delete nativeContext.verification_capabilities; delete nativeContext.product_development;
  const before = subjectManifest(profile).digest;
  return { root, workspace, evidence, profile, context, nativeProfile, nativeContext, selected: design.validation_cases[0], raw, peer, defect, before,
    assertUnchanged() { assert.equal(subjectManifest(profile).digest, before); for (const [file, content] of Object.entries(sources)) assert.equal(readFileSync(join(workspace, file), "utf8"), content); },
    // Retain positives as well as expected negatives. Parent cleanup must use the
    // saved original process/Job closure evidence and verified absolute paths.
    finish(status, error) { writeFileSync(join(root, "fixture-outcome.json"), JSON.stringify({ status, error: error?.message, workspace,
      retained: true, scope: "controlled native browser fixture; no live product or publication" }, null, 2)); console.log(JSON.stringify({ fixture: root, workspace, status, retained: true })); },
  };
}
async function verify(f, label, native = false) {
  const profile = native ? f.nativeProfile : f.profile, context = native ? f.nativeContext : f.context;
  const originalDescriptor = Object.getOwnPropertyDescriptor(childProcess, "spawn"), original = childProcess.spawn;
  const records = [], logPath = join(f.root, label + "-processes.jsonl");
  writeFileSync(logPath, "", { flag: "wx" });
  let observerFailure;
  const append = event => {
    if (observerFailure) return;
    try { appendFileSync(logPath, JSON.stringify(event) + "\n"); }
    catch (error) { observerFailure = error; }
  };
  function observed(...args) {
    const child = Reflect.apply(original, this, args);
    const record = { executable: args[0], pid: null, spawned: false, exit: null, close: null,
      stdout_eof: child.stdout ? false : null, stderr_eof: child.stderr ? false : null };
    records.push(record);
    child.once("spawn", () => { record.pid = child.pid; record.spawned = true; append({ event: "spawn", pid: child.pid, executable: args[0] }); });
    child.once("error", error => { record.error = error.message; append({ event: "error", pid: child.pid, message: error.message }); });
    for (const event of ["exit", "close"]) child.once(event, (code, signal) => { record[event] = { code, signal }; append({ event, pid: child.pid, code, signal }); });
    for (const [stream, name] of [[child.stdout, "stdout_eof"], [child.stderr, "stderr_eof"]]) stream?.once("end", () => {
      record[name] = true; append({ event: name, pid: child.pid });
    });
    return child;
  }
  Object.defineProperty(childProcess, "spawn", { ...originalDescriptor, value: observed }); syncBuiltinESMExports();
  let receipt, error, returned = false;
  try {
    receipt = await runVerification(profile, label, new AbortController().signal, context); returned = true;
    writeFileSync(join(f.root, label + "-receipt.json"), JSON.stringify(receipt, null, 2));
    assert.ok(records.length > 0, "The protected native verifier must actually spawn");
    for (const child of records) {
      assert.ok(child.spawned && child.exit && child.close, "Actual owned verifier process exit and close are required");
      assert.deepEqual(child.exit, child.close); assert.equal(child.error, undefined);
      assert.notEqual(child.stdout_eof, false); assert.notEqual(child.stderr_eof, false);
    }
    if (observerFailure) throw observerFailure;
    return receipt;
  } catch (caught) { error = caught; throw caught; }
  finally {
    const finalizationErrors = [];
    try {
      try { writeFileSync(join(f.root, label + "-closure.json"), JSON.stringify({ returned_normally: returned, records,
        error: error?.message, observer_error: observerFailure?.message }, null, 2)); }
      catch (failure) { finalizationErrors.push(failure); }
      try { assert.equal(childProcess.spawn, observed, "Exclusive fixture spawn observer changed"); }
      catch (failure) { finalizationErrors.push(failure); }
    } finally {
      // Evidence-write or identity failure must not contaminate later serial tests.
      try { Object.defineProperty(childProcess, "spawn", originalDescriptor); }
      catch (failure) { finalizationErrors.push(failure); }
      finally { try { syncBuiltinESMExports(); } catch (failure) { finalizationErrors.push(failure); } }
    }
    if (finalizationErrors.length) throw new AggregateError([...(error ? [error] : []), ...finalizationErrors],
      "Native fixture evidence finalization or global spawn restoration failed");
  }
}
function nativeSummary(entries) {
  return { digest: sha(JSON.stringify(entries)), key_count: entries.length,
    utf8_bytes: entries.reduce((total, [key, value]) => total + Buffer.byteLength(key) + Buffer.byteLength(value), 0) };
}
function inspectTrace(f, receipt) {
  assert.equal(receipt.outcome, "passed", receipt.reason); assert.equal(receipt.subject_digest, f.before);
  assert.equal(receipt.checks.length, 1); assert.equal(receipt.checks[0].exit_code, 0);
  const observation = receipt.checks[0].observation;
  assert.equal(observation.version, 3); assert.equal(observation.scope, "final"); assert.equal(observation.cases.length, 1);
  const measured = observation.cases[0], grant = { evidenceRoot: f.evidence, requestId: receipt.request_id, profileId: f.profile.id,
    profileDigest: f.profile.digest, subjectDigest: receipt.subject_digest, checkId: "browser", scope: "final", ...observation.evidence_bundle };
  const content = readBrowserEvidence(grant, measured.trace_ref), trace = JSON.parse(content.text);
  assert.equal(content.mime_type, "application/json"); assert.equal(sha(content.text), measured.trace_digest);
  assert.deepEqual(storagePreconditionReportFromTraceV1(trace.storage_precondition), measured.storage_precondition);
  const actual = trace.storage_precondition, spec = f.selected.storage_precondition;
  const source = readFileSync(join(f.workspace, ".artoo/product/design.json"));
  assert.deepEqual(actual.source, { path: ".artoo/product/design.json", checksum: sha(source), size: source.length, case_id: f.selected.id });
  assert.equal(actual.descriptor_digest, sha(canonical(spec))); assert.equal(actual.program_digest, sha(canonical(f.selected.browser_program)));
  assert.equal(actual.initial_step_digest, sha(canonical(f.selected.browser_program.steps[0])));
  assert.equal(actual.page_id, "main"); assert.equal(actual.document_epoch, 1); assert.equal(actual.seed_apply_count, 1);
  assert.match(actual.origin, /^http:\/\/127\.0\.0\.1:\d+$/); assert.equal(new URL(actual.origin).origin, actual.origin);
  assert.deepEqual(actual.installation, { script_digest: STORAGE_FAULT_INITIALIZER_DIGEST, confirmed: true });
  assert.deepEqual(actual.sequence, ["empty-baseline", "native-seed-readback", "resumed"]);
  const seeded = nativeSummary([[key, f.raw]]);
  assert.deepEqual(actual.native_storage, { scope: "all", before: nativeSummary([]), seeded });
  assert.equal(actual.preservation_checks.length, spec.preservation_checks.length);
  for (const [index, checkpoint] of actual.preservation_checks.entries()) {
    assert.deepEqual({ after_step: checkpoint.after_step, requirement_criteria: checkpoint.requirement_criteria, ui_assertion_steps: checkpoint.ui_assertion_steps }, spec.preservation_checks[index]);
    assert.equal(checkpoint.document_epoch, 1, "Peer reload must not advance the main seed epoch");
    assert.equal(checkpoint.step_digest, sha(canonical(f.selected.browser_program.steps[checkpoint.after_step])));
    assert.deepEqual(checkpoint.native_storage, { scope: "all", comparison: "sampled-equal", snapshot: seeded, equal: true });
  }
  assert.deepEqual(trace.operations.map(item => [item.action, item.page_id]), f.selected.browser_program.steps.map(item => [item.action, item.page]));
  assert.equal(Object.hasOwn(actual, "local_storage"), false);
  assert.equal(content.text.includes(JSON.stringify(f.raw).slice(1, -1)), false, "Native raw fixture bytes must not leak into the sealed trace");
  if (f.peer) {
    assert.equal(trace.storage_fault, undefined); assert.equal(measured.captures.length, 2);
    assert.deepEqual(measured.captures.map(item => [item.page_id, item.timing]),
      [["main", { kind: "case-end" }], ["peer", { kind: "before-close", step_index: 18 }]]);
  } else {
    assert.deepEqual(storageFaultReportFromTraceV1(trace.storage_fault), measured.storage_fault);
    const window = trace.storage_fault.windows[0];
    assert.deepEqual(window.native_storage.before, seeded); assert.deepEqual(window.native_storage.after, seeded);
    assert.equal(window.hits.delta, 1); assert.equal(window.events.observed_mutations, 0);
    assert.deepEqual(window.sequence, ["baseline", "armed", "settled", "disarmed"]);
  }
  for (const capture of measured.captures) {
    const image = readBrowserEvidence(grant, capture.screenshot_ref), png = Buffer.from(image.data, "base64");
    assert.equal(image.mime_type, "image/png"); assert.equal(sha(png), capture.screenshot_digest);
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.equal(png.readUInt32BE(16), viewport.width); assert.equal(png.readUInt32BE(20), viewport.height);
  }
  return trace;
}
function inspectNative(f, receipt, expectedOutcome, expectedError) {
  const result = JSON.parse(readFileSync(join(f.root, "native-result.json"), "utf8"));
  const bytes = readFileSync(join(f.root, "native-events.jsonl")), events = bytes.toString("utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(receipt.outcome, expectedOutcome, receipt.reason);
  assert.equal(receipt.checks[0].exit_code, expectedOutcome === "passed" ? 0 : 1);
  assert.equal(receipt.checks[0].observation, undefined, "The supplemental worker cannot manufacture a browser capability receipt");
  assert.equal(result.claim, "controlled-native-browser-fixture");
  assert.equal(result.request_id, receipt.request_id); assert.equal(result.profile_digest, f.nativeProfile.digest);
  assert.equal(result.subject_digest, f.before); assert.equal(result.audit_checksum, sha(bytes));
  assert.equal(result.audit_events, events.length); assert.ok(events.every((event, index) => event.ordinal === index + 1));
  assert.equal(result.program_outcome, expectedOutcome);
  assert.equal(result.setup_error, undefined); assert.equal(result.cleanup_confirmed, true, JSON.stringify(result));
  assert.equal(result.observer_restoration_error, undefined); assert.equal(result.context_close_error, undefined);
  assert.equal(result.context_closed, true); assert.equal(result.browser_close_fulfilled, true); assert.equal(result.server_close_fulfilled, true);
  assert.ok(result.pages.every(page => page.close_event && page.actually_closed)); assert.ok(result.sessions.every(session => session.closed));
  assert.equal(result.observer_error, undefined); assert.equal(result.audit_read_error, undefined);
  if (expectedError) { assert.match(result.program_error, expectedError); assert.deepEqual(result.errors, [result.program_error]); }
  else assert.deepEqual(result.errors, []);
  const controller = events.filter(event => event.role === "controller");
  assert.equal(result.sessions.filter(session => session.role === "controller").length, 1);
  assert.ok(controller.every(event => event.page_id === "main"), "Only main may own a seed/fault controller");
  const registration = controller.filter(event => event.kind === "cdp-send" && event.method === "Page.addScriptToEvaluateOnNewDocument");
  assert.equal(registration.length, 1); assert.equal(registration[0].params.source_digest, STORAGE_FAULT_INITIALIZER_DIGEST);
  assert.equal(registration[0].params.world_name, null, "The unchanged initializer owns the main default world");
  const writes = controller.filter(event => event.kind === "cdp-send" && event.method === "DOMStorage.setDOMStorageItem");
  assert.equal(writes.length, 1, "Initial navigation, peer navigation/reload and main reload must never reseed");
  const write = writes[0];
  assert.deepEqual(write.params, { storageId: { securityOrigin: result.origin, isLocalStorage: true }, key, value: f.raw });
  const response = controller.find(event => event.kind === "cdp-response" && event.session === write.session && event.request === write.request);
  assert.ok(response && response.ordinal > write.ordinal, "Actual CDP write acknowledgement is required");
  const pause = controller.find(event => event.kind === "cdp-event" && event.event === "Debugger.paused");
  const baseline = controller.find(event => event.kind === "cdp-response" && event.method === "DOMStorage.getDOMStorageItems");
  assert.ok(pause && baseline && pause.ordinal < baseline.ordinal && baseline.ordinal < write.ordinal);
  assert.deepEqual(baseline.result.entries, [], "The native origin must actually start empty");
  const readback = controller.find(event => event.kind === "cdp-response" && event.method === "DOMStorage.getDOMStorageItems" && event.ordinal > response.ordinal);
  assert.ok(readback); assert.deepEqual(readback.result.entries, [[key, f.raw]]);
  const seedEvents = controller.filter(event => event.kind === "cdp-event" && event.event === "DOMStorage.domStorageItemAdded"
    && event.value.storageId.securityOrigin === result.origin && event.value.key === key && event.value.newValue === f.raw);
  assert.equal(seedEvents.length, 1, "One actual matching native item-added event is required");
  const resume = controller.find(event => event.kind === "cdp-send" && event.method === "Debugger.resume");
  assert.ok(resume && resume.ordinal > response.ordinal && resume.ordinal > readback.ordinal
    && resume.ordinal > seedEvents[0].ordinal && seedEvents[0].ordinal > write.ordinal,
  "Product resumes only after real seed acknowledgement, exact native readback and the actual native event");
  const source = controller.find(event => event.kind === "cdp-response" && event.method === "Debugger.getScriptSource");
  assert.equal(source.result.source_digest, STORAGE_FAULT_INITIALIZER_DIGEST);
  assert.ok(source.ordinal < baseline.ordinal);
  if (expectedOutcome === "passed") {
    assert.deepEqual(result.final_native_entries, [[key, resetDocument]], "Successful UI Reset must remain native after reload");
    assert.equal(result.final_ui.status, "Ready"); assert.equal(result.final_ui.draft, "");
    assert.equal(result.storage_precondition.seed_apply_count, 1);
    assert.deepEqual(result.storage_precondition.native_storage.seeded, nativeSummary([[key, f.raw]]));
    assert.equal(controller.filter(event => event.kind === "cdp-event" && event.event === "Debugger.paused").length, 2,
      "Only initial main navigation and explicit main reload install the main controller");
  }
  if (f.peer) {
    const peerReset = events.find(event => event.kind === "native-dom-event" && event.page_id === "peer"
      && event.value.event === "click" && event.value.trusted === true && event.value.target_id === "reset-confirm");
    const storage = events.filter(event => event.kind === "native-dom-event" && event.page_id === "main" && event.value.event === "storage"
      && event.value.trusted === true && event.value.key === key && event.value.old_value === f.raw && event.value.new_value === resetDocument);
    const retry = events.find(event => event.kind === "native-dom-event" && event.page_id === "main"
      && event.value.event === "click" && event.value.trusted === true && event.value.target_id === "retry");
    assert.ok(peerReset && retry); assert.equal(storage.length, 1, "Observe the real trusted cross-page StorageEvent in the main isolated world");
    for (const event of [peerReset, storage[0], retry]) {
      assert.ok(Number.isFinite(event.browser_timestamp)); assert.ok(event.unique_id);
      assert.equal(event.world_name, "artoo-controlled-native-storage-observer-v1");
      assert.equal(event.frame_id, events.find(item => item.kind === "observer-page" && item.page_id === event.page_id).frame_id);
    }
    // Different renderer sessions can deliver console records in different orders.
    // Their browser timestamps establish peer causality; the same main-session
    // storage and Retry records also have an ordered CDP arrival stream.
    assert.ok(peerReset.browser_timestamp <= storage[0].browser_timestamp && storage[0].browser_timestamp <= retry.browser_timestamp);
    assert.ok(storage[0].ordinal < retry.ordinal);
    assert.equal(new URL(storage[0].value.url).origin, result.origin);
    assert.deepEqual(result.final_native_entries, [[key, resetDocument]], "Peer Reset really repaired native storage before Retry");
    if (f.defect === "malformed-conflict") {
      assert.equal(result.final_ui.status, "Conflict: reload before retry");
      assert.equal(result.final_ui.draft, unsaved);
      assert.equal(result.final_ui.external, "Saved data changed in another tab");
    }
  }
  return result;
}
async function runCase(inputName, raw, options = {}, expectedError) {
  const f = fixture(inputName, raw, options);
  let failure;
  try {
    const installed = await verify(f, "installed-" + inputName + "-" + f.defect);
    if (expectedError) {
      assert.equal(installed.outcome, "failed"); assert.equal(installed.checks.length, 1);
      assert.equal(installed.checks[0].exit_code, 1); assert.equal(installed.checks[0].observation, undefined);
      assert.match(installed.reason, expectedError);
    } else inspectTrace(f, installed);
    f.assertUnchanged();
    const native = await verify(f, "native-" + inputName + "-" + f.defect, true);
    inspectNative(f, native, expectedError ? "failed" : "passed", expectedError); f.assertUnchanged();
  } catch (error) { failure = error; throw error; }
  finally { f.finish(failure ? "failed" : expectedError ? "expected-negative-confirmed" : "passed", failure); }
}
for (const [inputName, raw] of inputs) {
  test("native " + inputName + " preserves original bytes through Retry, cancelled/failed Reset and survives successful Reset/reload", real,
    async () => runCase(inputName, raw));
}
test("native seed-only peer Reset produces a real storage event before main Retry and does not reseed on either page reload", real,
  async () => runCase("peer-recovery", inputs[0][1], { peer: true }));
test("native same peer Retry program rejects malformed-to-conflict after real repair at the final main UI assertion", real,
  async () => runCase("peer-conflict", inputs[0][1], { peer: true, defect: "malformed-conflict" }, failedUi));
for (const defect of ["retry-deletes", "cancel-deletes", "failed-reset-deletes"]) {
  test("native measurement rejects " + defect + " even when the product displays the expected error/cancel UI", real,
    async () => runCase(defect, inputs[0][1], { defect }, defect === "failed-reset-deletes" ? faultMutation : preservationFailure));
}
