// Controlled source and research metadata, actual protected browser/verifier processes
// and HTTP publication. This is not a live-provider or production-delivery result.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CONFIGURED_STATIC_PUBLICATION_CLAIM, CONFIGURED_STATIC_PUBLICATION_STATEMENT, CONFIGURED_STATIC_PUBLICATION_STATEMENT_DIGEST,
  canonicalReleaseAcceptanceBinding, ContextPackSchema, ProductReleaseSchema, productDevelopmentContext } from "@artoo/domain";
import { prepareVerificationProfiles, readVerificationCapabilities, runVerification, runVerificationPreview,
  verificationSupported, VerificationCleanupError } from "../dist/verification.js";
import { createProductReleaseExecutor, prepareReleaseProfiles } from "../dist/product-release.js";

const browser = process.env.ARTOO_TEST_CHROMIUM;
const cli = fileURLToPath(new URL("../dist/web-acceptance-cli.js", import.meta.url));
const sha = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const policy = { version: 2, coverage: "every-must-criterion", methods: ["workspace-check", "configured-static-release"] };
async function unusedPort() {
  const server = createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port; await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); return port;
}

/** A fresh process has no access to the parent's prepared-profile WeakMaps. */
async function replayInFreshProcess(config, signal) {
  signal.throwIfAborted();
  const child = spawn(process.execPath, [fileURLToPath(new URL("./release-criterion-worker.mjs", import.meta.url)), config],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const observed = { spawn: false, exit: false, close: false, exit_code: null, exit_signal: null, close_code: null, close_signal: null };
  let stdout = "", stderr = "", launchError, interrupted, killTimer, closureTimer;
  let resolveClosed, rejectClosed;
  const closed = new Promise((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
  const stop = reason => {
    if (observed.close || interrupted) return;
    interrupted = reason;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => { if (!observed.close) child.kill("SIGKILL"); }, 1000);
    closureTimer = setTimeout(() => {
      if (!observed.close) rejectClosed(new VerificationCleanupError("Cross-process release worker exit/close remains unconfirmed"));
    }, 5000);
  };
  child.once("spawn", () => { observed.spawn = true; });
  child.once("error", error => { launchError = error; });
  child.once("exit", (code, exitSignal) => { observed.exit = true; observed.exit_code = code; observed.exit_signal = exitSignal; });
  child.once("close", (code, closeSignal) => {
    observed.close = true; observed.close_code = code; observed.close_signal = closeSignal; resolveClosed();
  });
  child.stdout.on("data", bytes => {
    stdout += bytes.toString("utf8");
    if (Buffer.byteLength(stdout) > 1024 * 1024) { stdout = stdout.slice(0, 1024 * 1024); stop("Cross-process output exceeded its bound"); }
  });
  child.stderr.on("data", bytes => { stderr = (stderr + bytes.toString("utf8")).slice(-16000); });
  const abort = () => stop("Cross-process release replay was aborted");
  signal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => stop("Cross-process release replay exceeded 20 seconds"), 20000);
  if (signal.aborted) abort();
  try {
    await closed;
    if (launchError) throw launchError;
    assert.equal(interrupted, undefined, `${interrupted ?? ""}\n${stderr}`);
    assert.deepEqual(observed, { spawn: true, exit: true, close: true, exit_code: 0, exit_signal: null, close_code: 0, close_signal: null }, stderr);
    const result = JSON.parse(stdout);
    assert.notEqual(result.worker_pid, process.pid, "Recovery must execute in a different OS process");
    assert.equal(result.worker_pid, child.pid);
    return result;
  } finally {
    clearTimeout(timeout); clearTimeout(killTimer); clearTimeout(closureTimer); signal.removeEventListener("abort", abort);
    // The worker never launches children. Only confirmed exit and pipe closure allow outer workspace cleanup.
    if (observed.spawn && (!observed.exit || !observed.close)) throw new VerificationCleanupError("Cross-process release worker cleanup remains unconfirmed");
  }
}

test("real stage checks keep publication pending until exact validation-source HTTP settlement, including replay and health", {
  skip: !verificationSupported() || !browser, timeout: 180000,
}, async (testContext) => {
  const parent = realpathSync.native(tmpdir()), root = mkdtempSync(join(parent, "artoo-release-criterion-real-"));
  const rootIdentity = lstatSync(root), workspace = join(root, "workspace"), evidence = join(root, "evidence"), storage = join(root, "release");
  mkdirSync(join(workspace, ".artoo/product"), { recursive: true }); mkdirSync(join(workspace, "product")); mkdirSync(evidence); mkdirSync(storage);
  let publisher, retain = false;
  try {
    const config = join(root, "browser.json");
    writeFileSync(config, JSON.stringify({ browser_executable: realpathSync.native(browser), evidence_root: evidence,
      browser_program: { version: 3, viewports: [{ id: "compact", width: 390, height: 900 }, { id: "wide", width: 1280, height: 900 }] },
      design_capture_cases: true, action_timeout_ms: 1500 }));
    const rawVerifier = { id: "verify", project_id: "project", workspace_root: workspace,
      commands: [{ id: "browser", argv: [process.execPath, cli, config], timeout_ms: 45000,
        observation: { format: "static-web-acceptance.v3", evidence_root: evidence, capabilities: { version: 1 } } }],
      required_files: [], subject_paths: ["product", ".artoo/product"], measurement_plan_policy: policy };
    const [verifier] = prepareVerificationProfiles([rawVerifier]);
    const port = await unusedPort();
    const rawProfile = { id: "publish", project_id: "project", verification_profile_id: verifier.id,
      storage_root: storage, output_path: "product", public_url: `http://127.0.0.1:${port}`, listen_host: "127.0.0.1", listen_port: port,
      health_checks: [{ path: "/", expect_text: "Journal" }], health_timeout_ms: 3000,
      monitoring: { interval_ms: 3600000, failure_threshold: 2 }, criterion_acceptance: { version: 1 } };
    const [profile] = prepareReleaseProfiles([rawProfile], [verifier]);
    publisher = createProductReleaseExecutor([profile]); await publisher.start();
    let read = publisher.getCapabilityReader(profile.id);
    const capabilities = readVerificationCapabilities(verifier), releaseCapabilities = read(), check = capabilities.checks[0];
    const route = { release_binding: releaseCapabilities.binding, claim_id: CONFIGURED_STATIC_PUBLICATION_CLAIM,
      statement_digest: CONFIGURED_STATIC_PUBLICATION_STATEMENT_DIGEST };
    const research = { version: 1, objective: "Controlled save and publish fixture", assumptions: [],
      requirements: [{ id: "save", description: "Persist a note", priority: "must", acceptance_criteria: ["Save and reload retains the text"] },
        { id: "publish", description: "Publish the verified static version", priority: "must", acceptance_criteria: [CONFIGURED_STATIC_PUBLICATION_STATEMENT] }],
      sources: [{ id: "fixture", url: "https://example.com", title: "Schema fixture; no source retrieval claim", retrieved_at: "2026-11-05T00:00:00Z", content_digest: sha("fixture") }],
      findings: [{ summary: "Controlled source for actual browser and publication checks", source_ids: ["fixture"] }], decisions: [],
      measurement_plan: { version: 2, profile_digest: verifier.digest, entries: [
        { method: "workspace-check", requirement_id: "save", criterion_index: 0, command_id: check.command_id, config_digest: check.config_digest,
          contract_digest: check.contract_digest, actions: ["navigate", "fill", "click", "reload", "assert_value"], keys: [], viewports: check.contract.viewports, needs: [] },
        { method: "configured-static-release", requirement_id: "publish", criterion_index: 0, ...route },
      ] } };
    const design = { version: 2, requirement_ids: ["save", "publish"], information_architecture: ["Journal"],
      user_flows: [{ id: "write", name: "Write", requirement_ids: ["save"], steps: ["Save and reload"] }],
      screens: [{ id: "editor", name: "Editor", purpose: "Write", states: ["Empty", "Saved"], accessibility: ["Labelled input"], responsive: ["Phone and desktop"] }],
      prototype: { entrypoint: "product/index.html", description: "Working fixture" }, data_model: [], api_contracts: [],
      decisions: [{ decision: "Configured publication", rationale: "An actual receipt settles the final condition" }], validation_cases: [
        { method: "workspace-check", id: "persist", requirement_ids: ["save"], requirement_criteria: [{ requirement_id: "save", criterion_index: 0 }],
          procedure: ["Save a note", "Reload"], expected_result: "Text remains", browser_program: { version: 3, contract_digest: check.contract_digest, steps: [
            { action: "navigate", page: "main", path: "/" }, { action: "fill", page: "main", selector: "#entry", value: "A durable note" },
            { action: "click", page: "main", selector: "#save" }, { action: "reload", page: "main" },
            { action: "assert_value", page: "main", selector: "#entry", value: "A durable note" },
          ] } },
        { method: "configured-static-release", id: "publish", requirement_ids: ["publish"], requirement_criteria: [{ requirement_id: "publish", criterion_index: 0 }],
          procedure: ["Wait for the protected publisher"], expected_result: CONFIGURED_STATIC_PUBLICATION_STATEMENT, ...route },
      ] };
    const validation = { version: 2, cases: [
      { method: "workspace-check", case_id: "persist", requirement_ids: ["save"], requirement_criteria: [{ requirement_id: "save", criterion_index: 0 }],
        outcome: "passed", observations: "Controlled author notes; node reruns the real browser", evidence_paths: ["product/evidence.md"] },
      { method: "configured-static-release", case_id: "publish", requirement_ids: ["publish"], requirement_criteria: [{ requirement_id: "publish", criterion_index: 0 }],
        outcome: "pending-release", observations: "No publication has occurred", evidence_paths: [], ...route },
    ], known_limitations: [] };
    const write = (path, value) => writeFileSync(join(workspace, path), typeof value === "string" ? value : JSON.stringify(value));
    write(".artoo/product/research.json", research); write(".artoo/product/design.json", design);
    write(".artoo/product/implementation.md", "Controlled product source for executor integration."); write(".artoo/product/validation.json", validation);
    write("product/evidence.md", "Controlled notes; only node-owned observations prove actual execution.");
    write("product/index.html", '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Journal</title>'
      + '<style>textarea{display:block;width:90%;box-sizing:border-box}</style></head><body><h1>Journal</h1><label for="entry">Entry</label><textarea id="entry"></textarea><button id="save">Save</button>'
      + '<script>const e=document.getElementById("entry");e.value=localStorage.getItem("note")||"";document.getElementById("save").onclick=()=>localStorage.setItem("note",e.value);</script></body></html>');
    const pin = (path, stage) => { const bytes = readFileSync(join(workspace, path)); return { path, checksum: sha(bytes), size: bytes.length,
      source_task_id: `task_${stage}`, source_run_id: `run_${stage}`, evidence_id: `evidence_${stage}` }; };
    const contextFor = stage => ContextPackSchema.parse({ task: { id: `task_${stage}`, title: stage, description: "Controlled source", acceptance_criteria: [] },
      project: { id: "project", name: "Fixture", default_workspace: workspace }, workspace: { root: workspace, file_scope: [] },
      policy: { filesystem_write_scope: [workspace], requires_approval: [] }, memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] },
      goal_context: { version: 1, goal_id: "goal", objective: research.objective, acceptance_criteria: [], plan: { id: "plan", version: 1, rationale: "Controlled fixture", spec_ref: "0" } },
      verification_capabilities: capabilities, release_capabilities: releaseCapabilities,
      product_development: { ...productDevelopmentContext(stage, capabilities, releaseCapabilities), accepted_inputs: { version: 1,
        files: stage === "research" ? [] : stage === "design" ? [pin(".artoo/product/research.json", "research")]
          : [pin(".artoo/product/research.json", "research"), pin(".artoo/product/design.json", "design")] } } });
    const requestFor = (id, evidence) => ({ version: 1, release_id: id, goal_id: "goal", project_id: "project", run_id: `run_${id}`,
      release_profile_id: profile.id, verification_request_id: evidence.request_id, verification_profile_id: verifier.id,
      verification_profile_digest: verifier.digest, subject_digest: evidence.subject_digest, acceptance_binding: {
        version: 1, plan: { id: "plan", version: 1 }, research: evidence.measurement_plan.research,
        measurement_plan_digest: evidence.measurement_plan.measurement_plan_digest, release_binding: releaseCapabilities.binding,
        criteria: evidence.measurement_plan.pending_release.map(({ requirement_id, criterion_index, criterion_digest, claim_id }) =>
          ({ requirement_id, criterion_index, criterion_digest, claim_id })),
      } });
    let final, finalContext;
    for (const stage of ["research", "design", "implementation", "validation"]) {
      const context = contextFor(stage), result = await runVerification(verifier, `verify_${stage}`, testContext.signal, context, undefined, read);
      assert.equal(result.outcome, "passed", result.reason); assert.ok(result.checks.every(check => check.exit_code === 0));
      assert.equal(result.measurement_plan.version, 2); assert.equal(result.measurement_plan.pending_release.length, 1);
      assert.equal(result.checks[0].observation.cases.length, stage === "research" ? 0 : 2);
      assert.ok(result.checks[0].observation.cases.every(item => item.case_id === "persist"));
      publisher.recordVerification(`run_${stage}`, "project", workspace, result, { context, readCapabilities: read });
      if (stage === "research") assert.equal((await publisher.release(requestFor(stage, result))).outcome, "failed", "Research cannot authorize publication");
      if (stage === "validation") { final = result; finalContext = context; }
    }
    const preview = await runVerificationPreview(verifier, "preview_validation", testContext.signal, finalContext, undefined, read);
    assert.equal(preview.verification.outcome, "passed", preview.verification.reason);
    assert.throws(() => publisher.recordVerification("run_preview", "project", workspace, preview.verification,
      { context: finalContext, readCapabilities: read }), /final measured/);
    const request = requestFor("validation", final);
    const { acceptance_binding: _binding, ...downgrade } = request;
    assert.equal((await publisher.release({ ...downgrade, release_id: "downgrade" })).outcome, "failed");
    const changed = structuredClone(request); changed.release_id = "changed-binding"; changed.acceptance_binding.plan.version = 2;
    assert.equal((await publisher.release(changed)).outcome, "failed");
    const receipt = await publisher.release(request);
    assert.equal(receipt.outcome, "published", receipt.reason);
    assert.equal(receipt.acceptance.binding_digest, sha(canonicalReleaseAcceptanceBinding(request.acceptance_binding)));
    assert.deepEqual(receipt.acceptance.settled_criteria, request.acceptance_binding.criteria);
    const response = await fetch(receipt.endpoint);
    assert.equal(response.status, 200); assert.equal(response.headers.get("x-artoo-release-id"), request.release_id);
    assert.equal(response.headers.get("x-artoo-artifact-digest"), final.subject_digest);
    assert.equal(sha(Buffer.from(await response.arrayBuffer())), sha(readFileSync(join(workspace, "product/index.html"))));
    assert.deepEqual(await publisher.release(JSON.parse(JSON.stringify(request))), receipt);
    const mismatch = structuredClone(request); mismatch.acceptance_binding.criteria[0].criterion_digest = sha("different");
    await assert.rejects(publisher.cancel(mismatch), /different immutable request/);
    await publisher.checkHealth();
    const health = publisher.getHealthReports().find(item => item.request.release_id === request.release_id);
    assert.equal(health.state, "healthy");
    assert.doesNotThrow(() => ProductReleaseSchema.parse({ id: request.release_id, goal_id: "goal", project_id: "project", computer_id: "computer",
      run_id: request.run_id, evidence_id: "evidence_validation", status: "published", request: structuredClone(request), receipt, health,
      created_at: "2026-11-05T00:00:00Z", updated_at: "2026-11-05T00:00:00Z" }));
    await publisher.stop();
    assert.throws(read, /lifetime has ended/);
    publisher = createProductReleaseExecutor([profile]); await publisher.start(); read = publisher.getCapabilityReader(profile.id);
    assert.deepEqual(await publisher.release(structuredClone(request)), receipt);
    assert.ok(publisher.getPublicationReceipts().some(item => item.request.release_id === request.release_id && item.acceptance.binding_digest === receipt.acceptance.binding_digest));
    await publisher.stop();
    assert.throws(read, /lifetime has ended/);
    const operationPath = join(storage, "operations", `${sha(request.release_id).slice(7)}.json`);
    const operationBefore = readFileSync(operationPath);
    const childConfig = join(root, "release-criterion-worker.json");
    writeFileSync(childConfig, JSON.stringify({ rawVerifier, rawProfile, request }), { flag: "wx", mode: 0o600 });
    const restored = await replayInFreshProcess(childConfig, testContext.signal);
    assert.equal(restored.version, 1); assert.equal(restored.executor_stopped, true);
    assert.deepEqual(restored.capability_binding, releaseCapabilities.binding);
    assert.deepEqual(restored.receipt, receipt, "Disk replay must retain the exact nested acceptance and original receipt");
    assert.deepEqual(restored.health.request, request); assert.equal(restored.health.state, "healthy");
    assert.equal(restored.http.status, 200); assert.equal(restored.http.release_id, request.release_id);
    assert.equal(restored.http.artifact_digest, final.subject_digest);
    assert.equal(restored.http.body_digest, receipt.health_checks.find(check => check.path === "/").body_digest);
    assert.deepEqual(readFileSync(operationPath), operationBefore, "Terminal operation replay must not publish or rewrite its immutable receipt");
  } catch (error) {
    if (error instanceof VerificationCleanupError) retain = true;
    throw error;
  } finally {
    try { await publisher?.stop(); } catch (error) { retain = true; throw error; }
    finally {
      if (retain) console.error(`Unconfirmed execution cleanup; retained ${root}`);
      else {
        const now = lstatSync(root);
        assert.equal(realpathSync.native(root), root); assert.ok(root.startsWith(`${parent}${sep}artoo-release-criterion-real-`));
        assert.equal(now.dev, rootIdentity.dev); assert.equal(now.ino, rootIdentity.ino);
        const writable = path => { const stat = lstatSync(path); assert.equal(stat.isSymbolicLink(), false);
          chmodSync(path, stat.isDirectory() ? 0o700 : 0o600); if (stat.isDirectory()) for (const entry of readdirSync(path)) writable(join(path, entry)); };
        writable(root); rmSync(root, { recursive: true, force: true });
      }
    }
  }
});
