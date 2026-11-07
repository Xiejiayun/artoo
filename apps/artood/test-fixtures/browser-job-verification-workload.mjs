// Fixed v3 storage workload reused from storage-precondition-real.test.mjs.
// It calls the installed CLI through real node verification; no product/model claim.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ContextPackSchema, ProductDesignV2Schema, ProductResearchReportSchema, storagePreconditionReportFromTraceV1, storageFaultReportFromTraceV1 } from "@artoo/domain";
import { prepareVerificationProfiles, readVerificationCapabilities, attachWindowsVerificationBackend, subjectManifest } from "../dist/verification.js";
import { readBrowserEvidence } from "../dist/browser-evidence.js";
import { STORAGE_FAULT_INITIALIZER_DIGEST } from "../dist/web-acceptance-storage-source.js";

const viewport = { id: "compact", width: 512, height: 650 };
/** @type {import("@artoo/domain").MeasurementPlanPolicy} */
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

export function createStorageVerificationFixture({ root, workspace, browser, backend, cli }) {
  const peer = false, defect = "correct", raw = inputs[0]?.[1]; assert.ok(typeof raw === "string");
  const evidence = join(root, "evidence"), config = join(root, "browser.json");
  mkdirSync(evidence); mkdirSync(join(workspace, ".artoo", "product"), { recursive: true }); mkdirSync(join(workspace, "product"));
  const options = { evidence_root: evidence, browser_executable: browser, windows_browser_process: { version: 1 },
    browser_program: { version: 3, viewports: [viewport] }, storage_precondition: { version: 1 }, storage_fault: { version: 1 },
    action_timeout_ms: 1000, design_capture_cases: true };
  writeFileSync(config, JSON.stringify(options)); readFileSync(config);
  /** @type {import("../dist/verification.js").VerificationProfile} */
  const rawProfile = { id: "job-browser-profile", project_id: "project", workspace_root: workspace,
    commands: [{ id: "browser", argv: [process.execPath, cli, config], timeout_ms: 60000,
      observation: { format: "static-web-acceptance.v3", evidence_root: evidence, capabilities: { version: 1 } } }],
    required_files: [".artoo/product/research.json", ".artoo/product/design.json", "product/index.html"],
    subject_paths: ["product", ".artoo/product"], measurement_plan_policy: policy };
  const [profile] = prepareVerificationProfiles([rawProfile], [workspace]); assert.ok(profile); attachWindowsVerificationBackend(profile, backend);
  const capabilities = readVerificationCapabilities(profile); assert.ok(capabilities);
  const contract = capabilities.checks[0]; assert.ok(contract);
  const steps = structuredClone(cycleSteps), assertions = steps.flatMap((step, index) => ["assert_text", "assert_value", "assert_count"].includes(step.action) ? [index] : []);
  const checkpoints = peer ? [6] : [2, 6, 10, 15];
  const storage = { version: 1, local_storage: { key, value: raw }, requirement_criteria: [ref], ui_assertion_steps: assertions,
    preservation_checks: checkpoints.map(after_step => ({ after_step, requirement_criteria: [ref], ui_assertion_steps: [after_step] })) };
  /** @type {Array<Record<string, unknown>>} */
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
  const requirement = research.requirements[0]; assert.ok(requirement);
  const expectedResult = requirement.acceptance_criteria[0]; assert.ok(expectedResult);
  const selected = { id: peer ? "peer-retry" : "malformed-cycle", method: "workspace-check", requirement_ids: ["storage"], requirement_criteria: [ref],
    procedure: ["Operate the controlled product UI using the exact protected browser program"], expected_result: expectedResult,
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
  const context = ContextPackSchema.parse({ task: { id: "task", title: "Controlled native storage fixture", description: "Real browser regression", acceptance_criteria: [] },
    project: { id: "project", name: "Fixture", default_workspace: workspace }, workspace: { root: workspace, file_scope: [] },
    policy: { filesystem_write_scope: [workspace], requires_approval: [] }, memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] },
    verification_capabilities: capabilities, product_development: { version: 1, stage: "design", instructions: ["Controlled fixture, not live research"],
      deliverables: [{ path: ".artoo/product/design.json", format: "json", purpose: "Controlled browser handoff" }] } });

  const before = subjectManifest(profile).digest;
  return { root, workspace, evidence, config, profile, rawProfile, context, options, selected: design.validation_cases[0], raw, peer, before,
    assertUnchanged() { assert.equal(subjectManifest(profile).digest, before); for (const [file, content] of Object.entries(sources)) assert.equal(readFileSync(join(workspace, file), "utf8"), content); } };
}

function nativeSummary(entries) {
  return { digest: sha(JSON.stringify(entries)), key_count: entries.length,
    utf8_bytes: entries.reduce((total, [key, value]) => total + Buffer.byteLength(key) + Buffer.byteLength(value), 0) };
}
export function inspectSealedStorageTrace(f, receipt) {
  assert.equal(receipt.outcome, "passed", receipt.reason); assert.equal(receipt.subject_digest, f.before);
  assert.equal(receipt.checks.length, 1); assert.equal(receipt.checks[0].exit_code, 0);
  const observation = receipt.checks[0].observation;
  assert.equal(observation.version, 3); assert.equal(observation.scope, "final"); assert.equal(observation.cases.length, 1);
  const measured = observation.cases[0], grant = { evidenceRoot: f.evidence, requestId: receipt.request_id, profileId: f.profile.id,
    profileDigest: f.profile.digest, subjectDigest: receipt.subject_digest, checkId: "browser", scope: "final", ...observation.evidence_bundle };
  const content = readBrowserEvidence(grant, measured.trace_ref);
  assert.ok(content.mime_type === "application/json"); const trace = JSON.parse(content.text);
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
    const image = readBrowserEvidence(grant, capture.screenshot_ref);
    assert.ok(image.mime_type === "image/png"); const png = Buffer.from(image.data, "base64");
    assert.equal(image.mime_type, "image/png"); assert.equal(sha(png), capture.screenshot_digest);
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.equal(png.readUInt32BE(16), viewport.width); assert.equal(png.readUInt32BE(20), viewport.height);
  }
  return trace;
}
