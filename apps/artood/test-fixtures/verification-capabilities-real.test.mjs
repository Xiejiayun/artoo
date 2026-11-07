// Run after building on POSIX. These are controlled product fixtures, not a live model acceptance run.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { prepareVerificationProfiles, runVerification, runVerificationPreview, selectVerificationProfile, subjectManifest, verificationSupported } from "../dist/verification.js";
import { prepareStaticWebCapabilities } from "../dist/web-acceptance.js";
import { readBrowserEvidence } from "../dist/browser-evidence.js";
import { runOwnedGit } from "../dist/owned/owned-git.js";

const cli = fileURLToPath(new URL("../dist/web-acceptance-cli.js", import.meta.url));
const browser = process.env.ARTOO_TEST_CHROMIUM;
const posix = { skip: !verificationSupported(), timeout: 60000 };
const chromium = { skip: !verificationSupported() || !browser, timeout: 120000 };
const sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function fixture(options = {}) {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), "artoo-capabilities-real-"));
  const workspace = join(root, "workspace"), evidence = join(root, "evidence"), config = join(root, "web.json");
  mkdirSync(join(workspace, ".artoo/product"), { recursive: true }); mkdirSync(join(workspace, "product")); mkdirSync(evidence);
  const research = { version: 1, objective: "Controlled save and reload fixture", assumptions: [],
    requirements: [{ id: "save", description: "Keep the entry", priority: "must", acceptance_criteria: ["Save and reload retains the text"] }],
    sources: [{ id: "fixture", url: "https://example.com/spec", title: "Schema fixture; no live retrieval claim", retrieved_at: "2026-11-04T00:00:00Z", content_digest: sha("fixture") }],
    findings: [{ summary: "Exercise verifier configuration and real browser persistence", source_ids: ["fixture"] }], decisions: [] };
  const design = { version: 1, requirement_ids: ["save"], information_architecture: ["Editor"],
    user_flows: [{ id: "write", name: "Write", requirement_ids: ["save"], steps: ["Save and reload"] }],
    screens: [{ id: "editor", name: "Editor", purpose: "Write", states: ["Empty", "Saved"], accessibility: ["Named input"], responsive: ["Fit configured viewports"] }],
    prototype: { entrypoint: "product/index.html", description: "Persistence fixture" }, data_model: [], api_contracts: [],
    decisions: [{ decision: "Use local storage", rationale: "Exercise actual reload behavior" }],
    validation_cases: [{ id: "persist", requirement_ids: ["save"], procedure: ["Save", "Reload"], expected_result: "Entry remains", browser_steps: [
      { action: "navigate", path: "/" }, { action: "fill", selector: "#entry", value: "A durable entry" }, { action: "click", selector: "#save" },
      { action: "reload" }, { action: "assert_value", selector: "#entry", value: "A durable entry" },
    ] }] };
  writeFileSync(join(workspace, ".artoo/product/research.json"), JSON.stringify(research));
  writeFileSync(join(workspace, ".artoo/product/design.json"), JSON.stringify(design));
  writeFileSync(join(workspace, "product/index.html"), '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Journal</title>'
    + '<style>body{margin:12px}textarea{display:block;width:100%;box-sizing:border-box}</style></head><body><h1>Journal</h1><label for="entry">Entry</label><textarea id="entry"></textarea><button id="save">Save</button>'
    + '<script>const entry=document.getElementById("entry");entry.value=localStorage.getItem("entry")||"";document.getElementById("save").addEventListener("click",()=>localStorage.setItem("entry",entry.value));</script></body></html>');
  const privateOptions = { evidence_root: evidence, ...(browser ? { browser_executable: realpathSync.native(browser) } : {}), viewports: [512, 901], action_timeout_ms: 1250,
    design_capture_cases: true, ...options };
  writeFileSync(config, JSON.stringify(privateOptions));
  const raw = { id: "web", project_id: "project", workspace_root: workspace,
    commands: [{ id: "browser", argv: [process.execPath, cli, config], timeout_ms: 60000,
      observation: { format: "static-web-acceptance.v1", evidence_root: evidence, capabilities: { version: 1 } } }],
    required_files: [], subject_paths: ["product", ".artoo/product"] };
  return { root, workspace, evidence, config, privateOptions, raw, close: () => rmSync(root, { recursive: true, force: true }) };
}
function request(f, profile, stage = "research") {
  const capabilities = profile.capabilities;
  const binding = { version: 1, profile_digest: capabilities.profile_digest,
    checks: capabilities.checks.map(({ command_id, config_digest, contract_digest }) => ({ command_id, config_digest, contract_digest })) };
  const context = { task: { id: "task", title: "Controlled fixture", description: "Preserve the objective", acceptance_criteria: ["Save and reload"] },
    project: { id: "project", name: "Fixture", default_workspace: f.workspace }, workspace: { root: f.workspace, file_scope: [] },
    policy: { filesystem_write_scope: [f.workspace], requires_approval: [] }, memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] },
    verification_capabilities: { ...capabilities, profile_id: profile.id },
    product_development: { version: 1, stage, instructions: ["Use the configured measurement scope"],
      deliverables: [{ path: `.artoo/product/${stage}.json`, format: "json", purpose: "Controlled handoff" }] } };
  return { run_id: "run", task_id: "task", agent_instance_id: "instance", runtime: "fixture", workspace: { root: f.workspace },
    context_pack: { id: "context", payload: context }, policy_snapshot: context.policy, artifact_rules: { paths: [] },
    verification: { version: 1, profile_id: profile.id, request_id: "verification", capability_binding: binding } };
}
function checkBinding(profile) {
  const { command_id, config_digest, contract_digest } = profile.capabilities.checks[0];
  return { version: 1, profile_digest: profile.digest, command_id, config_digest, contract_digest };
}

test("installed CLI produces a node-owned research binding and rejects mismatched admission or changed config", posix, async () => {
  const f = fixture();
  try {
    const [profile] = prepareVerificationProfiles([f.raw]), input = request(f, profile), context = input.context_pack.payload;
    const contract = profile.capabilities.checks[0].contract;
    assert.deepEqual(contract.viewports, [{ id: "width-512", width: 512, height: 900 }, { id: "width-901", width: 901, height: 900 }]);
    assert.equal(contract.claim, "configured"); assert.equal(contract.stage_policy.research, "no-browser");
    assert.equal(JSON.stringify(profile.capabilities).includes(f.root), false);
    assert.equal(selectVerificationProfile(input, [profile], false), profile);
    const before = subjectManifest(profile).digest;
    const receipt = await runVerification(profile, "research", new AbortController().signal, context);
    assert.equal(receipt.outcome, "passed", receipt.reason); assert.equal(receipt.checks[0].exit_code, 0);
    assert.deepEqual(receipt.checks[0].observation.capability_binding, checkBinding(profile));
    assert.deepEqual(receipt.checks[0].observation.cases, []); assert.equal(receipt.checks[0].observation.scope, "final");
    assert.ok(receipt.checks[0].observation.evidence_bundle); assert.equal(subjectManifest(profile).digest, before);
    for (const mutate of [
      (value) => { delete value.verification.capability_binding; },
      (value) => { value.verification.capability_binding.checks[0].config_digest = sha("wrong"); },
      (value) => { value.context_pack.payload.verification_capabilities.checks[0].contract.viewports[0].width = 514; },
      (value) => { value.verification.capability_binding.checks.push({ ...value.verification.capability_binding.checks[0] }); },
    ]) {
      const wrong = structuredClone(input); mutate(wrong);
      assert.throws(() => selectVerificationProfile(wrong, [profile], false), /capabilit/i);
    }
    writeFileSync(f.config, JSON.stringify({ ...f.privateOptions, action_timeout_ms: 1500 }));
    const changed = await runVerification(profile, "changed_config", new AbortController().signal, context);
    assert.equal(changed.outcome, "failed"); assert.equal(changed.checks.length, 0); assert.match(changed.reason, /verifier changed/);
  } finally { f.close(); }
});

test("capability opt-in rejects a same-name wrapper and conflicting protected evidence roots", posix, () => {
  const f = fixture();
  try {
    const wrapper = join(f.root, "web-acceptance-cli.js"); writeFileSync(wrapper, "process.exit(0)");
    const wrong = structuredClone(f.raw); wrong.commands[0].argv[1] = wrapper;
    assert.throws(() => prepareVerificationProfiles([wrong]), /installed|capabilit/i);
    const different = join(f.root, "other-evidence"); mkdirSync(different);
    writeFileSync(f.config, JSON.stringify({ ...f.privateOptions, evidence_root: different }));
    assert.throws(() => prepareVerificationProfiles([f.raw]), /evidence/i);
  } finally { f.close(); }
});

test("configured design policy executes actual cases or prototype at exactly advertised viewports", chromium, async () => {
  for (const captureCases of [false, true]) {
    const f = fixture({ design_capture_cases: captureCases });
    try {
      const [profile] = prepareVerificationProfiles([f.raw]), input = request(f, profile, "design"), context = input.context_pack.payload;
      const before = subjectManifest(profile).digest;
      assert.equal(profile.capabilities.checks[0].contract.stage_policy.design, captureCases ? "declared-cases" : "prototype-only");
      const { verification: receipt } = await runVerificationPreview(profile, "design", new AbortController().signal, context);
      assert.equal(receipt.outcome, "passed", receipt.reason); assert.equal(receipt.checks[0].exit_code, 0);
      const observation = receipt.checks[0].observation;
      assert.deepEqual(observation.capability_binding, checkBinding(profile)); assert.equal(observation.scope, "preview");
      assert.deepEqual(observation.cases.map(({ case_id, viewport, assertions }) => ({ case_id, viewport, assertions })),
        [512, 901].map(viewport => ({ case_id: captureCases ? "persist" : "prototype", viewport, assertions: captureCases ? 1 : 0 })));
      for (const item of observation.cases) {
        const image = readBrowserEvidence({ evidenceRoot: f.evidence, requestId: "design", profileId: profile.id, profileDigest: profile.digest,
          subjectDigest: receipt.subject_digest, checkId: "browser", scope: "preview", ...observation.evidence_bundle }, item.screenshot_ref);
        const bytes = Buffer.from(image.data, "base64");
        assert.equal(bytes.readUInt32BE(16), item.viewport); assert.equal(bytes.readUInt32BE(20), 900); assert.equal(sha(bytes), item.screenshot_digest);
      }
      assert.equal(subjectManifest(profile).digest, before);
    } finally { f.close(); }
  }
});

test("real CLI uses its protected snapshot and rejects inconsistent binding before producing evidence", chromium, async () => {
  const f = fixture();
  try {
    const [profile] = prepareVerificationProfiles([f.raw]), context = request(f, profile, "design").context_pack.payload;
    const prepared = prepareStaticWebCapabilities(f.privateOptions), binding = checkBinding(profile);
    // This direct CLI contract test deliberately changes argv options. Node execution rejects this mutation;
    // a child with an already supplied protected snapshot must never adopt the changed file's behavior.
    writeFileSync(f.config, JSON.stringify({ ...f.privateOptions, viewports: [390], design_capture_cases: false }));
    const contextFile = join(f.root, "context.json");
    const envelope = { version: 1, request_id: "snapshot", profile_digest: profile.digest, context,
      static_web_capabilities: { version: 1, binding, options: prepared.options } };
    writeFileSync(contextFile, JSON.stringify(envelope));
    const execute = () => runOwnedGit({ cwd: f.workspace, args: [cli, f.config], kind: "materialize", signal: new AbortController().signal },
      { gitExecutable: process.execPath, readTimeoutMs: 30000, materializeTimeoutMs: 60000, guardParent: true, maxOutputBytes: 1024 * 1024,
        environment: { PATH: process.env.PATH, LANG: "C.UTF-8", ARTOO_VERIFICATION_CONTEXT_FILE: contextFile } });
    const actual = await execute(); assert.equal(actual.status, 0, actual.stderr.toString());
    const report = JSON.parse(actual.stdout.toString());
    assert.deepEqual(report.capability_binding, binding);
    assert.deepEqual(report.cases.map(({ case_id, viewport }) => ({ case_id, viewport })), [512, 901].map(viewport => ({ case_id: "persist", viewport })));
    const inventory = readdirSync(f.evidence).sort();
    for (const mutate of [
      (value) => { value.static_web_capabilities.binding.contract_digest = sha("wrong contract"); },
      (value) => { value.profile_digest = sha("wrong profile"); },
    ]) {
      const wrong = structuredClone(envelope); wrong.request_id = "invalid_snapshot"; mutate(wrong); writeFileSync(contextFile, JSON.stringify(wrong));
      const failed = await execute(); assert.equal(failed.status, 1); assert.equal(failed.stdout.length, 0); assert.match(failed.stderr.toString(), /snapshot/i);
      assert.deepEqual(readdirSync(f.evidence).sort(), inventory);
    }
  } finally { f.close(); }
});
