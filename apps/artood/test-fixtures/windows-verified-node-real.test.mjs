// Native integration regression. Controlled Node author/reviewer, not model/product acceptance.
// Requires the exact combined built candidate and the separately recorded helper bundle manifest.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import { ContextPackSchema, RunStartPayloadSchema, RunVerificationPayloadSchema } from "@artoo/domain";
import { createNodeClient } from "../dist/node-client.js";
import { createProcessAdapter } from "../dist/process-adapter.js";
import { prepareVerificationProfiles, attachWindowsVerificationBackend, subjectManifest } from "../dist/verification.js";
import { prepareWindowsProcessBackend } from "../dist/owned/windows-owned-process.js";
import { initializeEmptyProductRepository } from "../dist/product-bootstrap.js";
import { resolveCliCommand } from "../dist/cli-resolver.js";

if (process.platform !== "win32") throw new Error("Native Windows is required; skipping does not qualify this integration");
const bundleRoot = process.env.ARTOO_WINDOWS_PROCESS_BUNDLE, expectedManifest = process.env.ARTOO_WINDOWS_PROCESS_MANIFEST_SHA256;
if (!bundleRoot || !isAbsolute(bundleRoot) || !/^sha256:[a-f0-9]{64}$/.test(expectedManifest ?? "")) {
  throw new Error("Set the exact helper directory and manifest digest from the separate successful build record");
}
const sha = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const helperRoot = realpathSync.native(bundleRoot), manifestPath = join(helperRoot, "manifest.json");
assert.equal(sha(readFileSync(manifestPath)), expectedManifest);
// Controlled, cooperating-process fixture admission only. This callback is not
// production ACL/restricted-token/workspace qualification and cannot enable discovery.
const backend = prepareWindowsProcessBackend({ directory: helperRoot, manifestSha256: expectedManifest,
  assertLocalInstallation() {
    assert.equal(realpathSync.native(bundleRoot), helperRoot); assert.equal(lstatSync(bundleRoot).isSymbolicLink(), false);
    assert.equal(sha(readFileSync(manifestPath)), expectedManifest);
  } });

test("native ordinary Git bootstrap, verified author and reviewer without evidence grants reach exact node verification", { timeout: 90000 }, async () => {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), "artoo-windows-node-native-"));
  const workspace = join(root, "workspace"), factsPath = join(root, "facts.jsonl"); mkdirSync(workspace);
  let client, passed = false;
  try {
    const git = resolveCliCommand("git"); assert.ok(git && git.length === 1, "Native Git is required for bootstrap qualification");
    assert.equal(await initializeEmptyProductRepository(workspace, git[0], undefined, backend), "created");
    assert.equal(await initializeEmptyProductRepository(workspace, git[0], undefined, backend), "existing");
    writeFileSync(join(workspace, "index.txt"), "initial");
    const author = join(root, "author.mjs"), reviewer = join(root, "reviewer.mjs"), verifier = join(root, "verifier.mjs");
    writeFileSync(author, `import{appendFileSync,readFileSync,writeFileSync}from'node:fs';import{join}from'node:path';
const [workspace,context]=process.argv.slice(2);readFileSync(context);writeFileSync(join(workspace,'index.txt'),'authored');
appendFileSync(${JSON.stringify(factsPath)},JSON.stringify({kind:'author',pid:process.pid,context})+'\\n');`);
    writeFileSync(reviewer, `import{appendFileSync,readFileSync}from'node:fs';import{join}from'node:path';
const [workspace,context]=process.argv.slice(2);if(readFileSync(join(workspace,'index.txt'),'utf8')!=='authored')throw new Error('Source changed');
const pack=JSON.parse(readFileSync(context,'utf8').split('\\n## Raw Payload\\n')[1]),subject=pack.review_subject;
if(pack.policy.execution_mode!=='discussion'||pack.policy.filesystem_write_scope.length!==0||subject.run_id!=='author'||subject.task_id!=='author'
||subject.verification.request_id!=='author:verification'||subject.verification.checks.length!==1||subject.verification.checks[0].id!=='check'
||subject.verification.checks[0].observation!==undefined)throw new Error('Wrong bound review context');
appendFileSync(${JSON.stringify(factsPath)},JSON.stringify({kind:'reviewer',pid:process.pid,context,subject:subject.subject_digest,
source_check_output_digest:subject.verification.checks[0].output_digest})+'\\n');`);
    writeFileSync(verifier, `import{appendFileSync,readFileSync}from'node:fs';import{join}from'node:path';
const file=process.env.ARTOO_VERIFICATION_CONTEXT_FILE,c=JSON.parse(readFileSync(file,'utf8'));
if(readFileSync(join(c.context.workspace.root,'index.txt'),'utf8')!=='authored')throw new Error('Wrong source');
if(!process.env.SystemRoot||!process.env.WINDIR)throw new Error('Missing Windows startup environment');
appendFileSync(${JSON.stringify(factsPath)},JSON.stringify({kind:'verifier',request:c.request_id,profile:c.profile_digest,subject:c.subject_digest,pid:process.pid,context:file})+'\\n');`);
    // Warm fixture reads before stable-file preparation on NTFS.
    for (const file of [author, reviewer, verifier, join(workspace, "index.txt")]) readFileSync(file);
    const [profile] = prepareVerificationProfiles([{ id: "profile", project_id: "project", workspace_root: workspace,
      required_files: ["index.txt"], subject_paths: ["index.txt"], commands: [{ id: "check", argv: [process.execPath, verifier], timeout_ms: 10000 }] }]);
    attachWindowsVerificationBackend(profile, backend);
    const events = []; let dispatch;
    const adapter = createProcessAdapter({ runtimeId: "fixture", allowedRoots: [workspace], artifacts: [],
      command: [process.execPath, author, "{{workspace_root}}", "{{context_pack_path}}"],
      discussionCommand: [process.execPath, reviewer, "{{workspace_root}}", "{{context_pack_path}}"] });
    client = createNodeClient({ nodeId: "node", adapter, verificationProfiles: [profile], transport: {
      send: async message => { events.push(message); }, subscribe: handler => { dispatch = handler; return () => {}; },
    } });
    client.start();
    const context = runId => ({ task: { id: runId, title: runId, description: "Controlled native integration", acceptance_criteria: [] },
      project: { id: "project", name: "Fixture", default_workspace: workspace }, workspace: { root: workspace, file_scope: [] },
      policy: { filesystem_write_scope: [workspace], requires_approval: ["git.push", "external.post"] }, memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] } });
    async function run(runId, sourceVerification) {
      const discussion = sourceVerification !== undefined;
      const payload = context(runId), expected = sourceVerification?.subject_digest;
      if (discussion) {
        RunVerificationPayloadSchema.parse(sourceVerification);
        assert.equal(sourceVerification.outcome, "passed"); assert.equal(sourceVerification.profile_digest, profile.digest);
        assert.equal(subjectManifest(profile).digest, expected, "Review must pin the author's already verified source");
        payload.policy = { execution_mode: "discussion", filesystem_write_scope: [], requires_approval: ["git.push", "external.post"] };
        // Match context-pack-service's receipt projection. This ordinary runtime
        // fixture has no product stage or browser observation/evidence grant.
        payload.review_subject = { version: 1, task_id: "author", run_id: "author", evidence_id: "author-evidence", subject_digest: expected,
          verification: { version: 1, request_id: sourceVerification.request_id, profile_id: sourceVerification.profile_id,
            profile_digest: sourceVerification.profile_digest, checks: sourceVerification.checks.map(check => ({
              id: check.id, output_digest: check.output_digest, ...(check.observation ? { observation: check.observation } : {}),
            })) } };
      }
      const admittedContext = ContextPackSchema.parse(payload); assert.deepEqual(admittedContext, payload);
      const runStart = {
        run_id: runId, task_id: runId, agent_instance_id: discussion ? "reviewer-instance" : "author-instance", runtime: "fixture", workspace: { root: workspace },
        context_pack: { id: runId, payload: admittedContext },
        // Node dispatch authorizes this execution address independently of the
        // read-only discussion context policy, as in node-binding.dispatchRunStart.
        policy_snapshot: { filesystem_write_scope: [workspace], requires_approval: ["git.push", "external.post"] }, artifact_rules: { paths: [] },
        verification: { version: 1, profile_id: profile.id, request_id: `${runId}:verification`, ...(expected ? { expected_subject_digest: expected } : {}) },
      };
      const admittedRun = RunStartPayloadSchema.parse(runStart); assert.deepEqual(admittedRun, runStart);
      assert.deepEqual(admittedRun.policy_snapshot.filesystem_write_scope, [workspace]);
      if (discussion) {
        assert.equal(admittedContext.policy.execution_mode, "discussion"); assert.deepEqual(admittedContext.policy.filesystem_write_scope, []);
        assert.equal(admittedRun.verification.expected_subject_digest, sourceVerification.subject_digest);
        assert.equal(admittedContext.review_subject.verification.checks.some(check => check.observation !== undefined), false);
      }
      dispatch({ kind: "command", id: `${runId}:start`, idempotency_key: `${runId}:start`, type: "run.start", payload: admittedRun });
      const deadline = Date.now() + 30000; let terminal;
      while (!(terminal = events.find(message => message.kind === "run.event" && message.run_id === runId
        && message.event.type === "run.lifecycle" && ["completed", "failed", "cancelled"].includes(message.event.payload.phase)))) {
        assert.equal(events.some(message => message.kind === "command.ack" && message.command_id === `${runId}:start` && message.status === "rejected"), false, JSON.stringify(events));
        assert.ok(Date.now() < deadline, "Native run did not finish"); await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(terminal.event.payload.phase, "completed", JSON.stringify(events));
      const report = events.find(message => message.kind === "run.event" && message.run_id === runId && message.event.type === "run.verification")?.event.payload;
      assert.ok(report, "A completed native execution must emit its node-owned verification");
      const verification = RunVerificationPayloadSchema.parse(report); assert.deepEqual(verification, report);
      assert.equal(verification.outcome, "passed", verification.reason); assert.equal(verification.request_id, `${runId}:verification`);
      assert.equal(verification.profile_id, profile.id); assert.equal(verification.profile_digest, profile.digest);
      assert.equal(verification.subject_digest, expected ?? subjectManifest(profile).digest);
      assert.equal(verification.checks.length, 1); const check = verification.checks[0];
      assert.equal(check.id, "check"); assert.equal(check.exit_code, 0); assert.ok(check.duration_ms >= 0);
      // The protected verifier writes only its external audit facts, so both
      // captured streams are empty; this is their exact production digest input.
      assert.equal(check.output_digest, sha(Buffer.from("\0stderr\0"))); assert.equal(check.observation, undefined);
      assert.deepEqual(verification.required_files, [{ path: "index.txt", checksum: sha("authored"), size: Buffer.byteLength("authored") }]);
      assert.equal(verification.measurement_plan, undefined);
      return verification;
    }
    const authorFinal = await run("author"), reviewerFinal = await run("reviewer", authorFinal);
    await client.stop(true);
    const facts = readFileSync(factsPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(facts.map(fact => fact.kind), ["author", "verifier", "reviewer", "verifier"]);
    const reviewerFact = facts.find(fact => fact.kind === "reviewer");
    assert.equal(existsSync(reviewerFact.context), false); assert.equal(reviewerFact.subject, authorFinal.subject_digest);
    assert.equal(reviewerFact.source_check_output_digest, authorFinal.checks[0].output_digest);
    for (const fact of facts.filter(fact => fact.kind === "verifier")) assert.equal(existsSync(fact.context), false);
    assert.equal(authorFinal.subject_digest, reviewerFinal.subject_digest);
    assert.deepEqual(authorFinal.required_files, reviewerFinal.required_files);
    assert.deepEqual(authorFinal.checks.map(({ duration_ms, ...check }) => check), reviewerFinal.checks.map(({ duration_ms, ...check }) => check));
    console.log(JSON.stringify({ kind: "controlled-native-node-integration", bootstrap: "created-and-existing", author: authorFinal.outcome,
      reviewer_without_evidence_grant: reviewerFinal.outcome, profile_digest: profile.digest, subject_digest: authorFinal.subject_digest,
      helper_manifest: expectedManifest, facts })); passed = true;
  } finally {
    let closed = !client;
    if (client) { try { await client.stop(true); closed = true; } catch { closed = false; } }
    if (passed && closed) rmSync(root, { recursive: true, force: true });
    else console.error(JSON.stringify({ retained_native_fixture: root, reason: "Failure or closure not confirmed; inspect before recovery" }));
  }
});
