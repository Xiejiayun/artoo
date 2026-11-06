import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONFIGURED_STATIC_PUBLICATION_CLAIM, CONFIGURED_STATIC_PUBLICATION_STATEMENT, CONFIGURED_STATIC_PUBLICATION_STATEMENT_DIGEST,
  canonicalReleaseAcceptanceBinding, productDevelopmentContext, type ContextPack, type ProductResearchReport,
  type ProductReleaseRequest, type RunStartPayload, type RunVerificationPayload } from "@artoo/domain";
import * as verification from "./verification.js";
import { createProductReleaseExecutor, createReleaseCapabilityReader, prepareReleaseProfiles, readReleaseCapabilities, type ReleaseProfile } from "./product-release.js";

const roots: string[] = [], executors: ReturnType<typeof createProductReleaseExecutor>[] = [];
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const nativeSupported = verification.verificationSupported();
const sha = (value: string | Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const write = (path: string, value: string) => { writeFileSync(path, value); readFileSync(path); };
afterEach(async () => {
  Object.defineProperty(process, "platform", originalPlatform); vi.restoreAllMocks();
  for (const executor of executors.splice(0)) await executor.stop();
  const writable = (path: string): void => {
    chmodSync(path, 0o700);
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name); if (entry.isDirectory()) writable(child); else chmodSync(child, 0o600);
    }
  };
  for (const root of roots.splice(0)) { writable(root); rmSync(root, { recursive: true, force: true }); }
});

async function fixture() {
  vi.spyOn(verification, "verificationSupported").mockReturnValue(true);
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-release-acceptance-"))); roots.push(root);
  const workspace = join(root, "workspace"), storage = join(root, "storage"), evidenceRoot = join(root, "evidence"), config = join(root, "browser.json");
  mkdirSync(join(workspace, ".artoo/product"), { recursive: true }); mkdirSync(join(workspace, "product")); mkdirSync(storage); mkdirSync(evidenceRoot);
  write(join(workspace, "product/index.html"), "<h1>Healthy journal</h1>");
  write(config, JSON.stringify({ evidence_root: evidenceRoot, design_capture_cases: true,
    browser_program: { version: 3, viewports: [{ id: "compact", width: 390, height: 900 }] } }));
  const rawVerifier: verification.VerificationProfile = { id: "verify", project_id: "project", workspace_root: workspace,
    subject_paths: ["product", ".artoo/product"], required_files: [],
    measurement_plan_policy: { version: 2, coverage: "every-must-criterion", methods: ["workspace-check", "configured-static-release"] },
    commands: [{ id: "browser", argv: [process.execPath, fileURLToPath(new URL("../dist/web-acceptance-cli.js", import.meta.url)), config], timeout_ms: 1000,
      observation: { format: "static-web-acceptance.v3", evidence_root: evidenceRoot, capabilities: { version: 1 } } }] };
  const verifier = verification.prepareVerificationProfiles([rawVerifier])[0]!, capabilities = verification.readVerificationCapabilities(verifier)!;
  const listener = createServer(); await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as { port: number }).port; await new Promise<void>(resolve => listener.close(() => resolve()));
  const raw: ReleaseProfile = { id: "site", project_id: "project", verification_profile_id: verifier.id, storage_root: storage,
    output_path: "product", public_url: `http://127.0.0.1:${port}`, listen_host: "127.0.0.1", listen_port: port,
    health_checks: [{ path: "/", expect_text: "Healthy" }], health_timeout_ms: 2000, criterion_acceptance: { version: 1 } };
  const profile = prepareReleaseProfiles([raw], [verifier])[0]!, read = createReleaseCapabilityReader(profile), release = read(), check = capabilities.checks[0]!;
  const research: ProductResearchReport = { version: 1, objective: "Journal with configured publication", assumptions: [],
    requirements: [{ id: "UI", description: "Visible journal", priority: "must", acceptance_criteria: ["Show the journal heading"] },
      { id: "PUB", description: "Configured publication", priority: "must", acceptance_criteria: [CONFIGURED_STATIC_PUBLICATION_STATEMENT] }],
    sources: [{ id: "spec", url: "https://example.com/spec", title: "Controlled specification fixture", retrieved_at: "2026-11-05T00:00:00Z", content_digest: sha("spec") }],
    findings: [{ summary: "Static browser product", source_ids: ["spec"] }], decisions: [],
    measurement_plan: { version: 2, profile_digest: verifier.digest, entries: [
      { method: "workspace-check", requirement_id: "UI", criterion_index: 0, command_id: "browser", config_digest: check.config_digest,
        contract_digest: check.contract_digest, actions: ["navigate", "assert_text"], keys: [], viewports: check.contract.viewports.map(viewport => ({ ...viewport })), needs: [] },
      { method: "configured-static-release", requirement_id: "PUB", criterion_index: 0, release_binding: release.binding,
        claim_id: CONFIGURED_STATIC_PUBLICATION_CLAIM, statement_digest: CONFIGURED_STATIC_PUBLICATION_STATEMENT_DIGEST },
    ] } };
  const researchPath = join(workspace, ".artoo/product/research.json"), save = () => write(researchPath, JSON.stringify(research)); save();
  write(join(workspace, ".artoo/product/design.json"), "{}");
  write(join(workspace, ".artoo/product/implementation.md"), "Controlled publisher-boundary test input, not a live implementation result.");
  write(join(workspace, ".artoo/product/validation.json"), "{}");
  const context: ContextPack = { task: { id: "task", title: "Validate", description: "Controlled test", acceptance_criteria: [] },
    project: { id: "project", name: "Product", default_workspace: workspace }, workspace: { root: workspace, file_scope: [] },
    policy: { filesystem_write_scope: [workspace], requires_approval: [] }, memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] },
    goal_context: { version: 1, goal_id: "goal", objective: "Journal", acceptance_criteria: [], plan: { id: "plan", version: 1, rationale: "Controlled", spec_ref: null } },
    product_development: { ...productDevelopmentContext("validation", capabilities), accepted_inputs: { version: 1,
      files: ([".artoo/product/research.json", ".artoo/product/design.json"] as const).map(path => { const bytes = readFileSync(join(workspace, path));
        return { path, checksum: sha(bytes), size: bytes.length, source_task_id: "source-task", source_run_id: "source-run", evidence_id: "accepted-evidence" }; }) } },
    verification_capabilities: capabilities, release_capabilities: release };
  const executor = createProductReleaseExecutor([profile]); executors.push(executor);
  const measured = (runId = "run") => {
    const summary = verification.measureReleaseAcceptancePlan(verifier, workspace, read), subject = verification.subjectManifest(verifier);
    // Controlled final evidence for publisher boundary tests. Native integration runs the real verifier.
    const evidence: RunVerificationPayload = { version: 1, request_id: `verification-${runId}`, profile_id: verifier.id,
      profile_digest: verifier.digest, subject_digest: subject.digest, outcome: "passed", required_files: [summary.research], measurement_plan: summary,
      checks: [{ id: "browser", exit_code: 0, duration_ms: 1, output_digest: sha("controlled-output"), observation: {
        version: 3, format: "static-web-acceptance.v3", scope: "final", stage: "validation", device_scale_factor: 1, cases: [],
        capability_binding: { version: 1, command_id: "browser", profile_digest: verifier.digest, config_digest: check.config_digest, contract_digest: check.contract_digest },
        evidence_bundle: { bundle_id: "controlled-fixture", manifest_digest: sha("controlled-bundle") },
      } }] };
    const request: ProductReleaseRequest = { version: 1, release_id: `release-${runId}`, goal_id: "goal", project_id: "project", run_id: runId,
      release_profile_id: profile.id, verification_request_id: evidence.request_id, verification_profile_id: verifier.id,
      verification_profile_digest: verifier.digest, subject_digest: subject.digest, acceptance_binding: {
        version: 1, plan: { id: "plan", version: 1 }, research: summary.research, measurement_plan_digest: summary.measurement_plan_digest,
        release_binding: release.binding, criteria: summary.pending_release.map(({ requirement_id, criterion_index, criterion_digest, claim_id }) => ({ requirement_id, criterion_index, criterion_digest, claim_id })),
      } };
    return { evidence, request };
  };
  const attest = (runId = "run") => { const result = measured(runId); executor.recordVerification(runId, "project", workspace, result.evidence,
    { context, readCapabilities: executor.getCapabilityReader(profile.id) }); return result; };
  return { root, workspace, storage, config, rawVerifier, verifier, raw, profile, read, release, context, research, researchPath, save, executor, measured, attest };
}

describe("node-owned configured publication criterion", () => {
  it("reuses exact prepared authority and rejects serialized clones without changing legacy digests", async () => {
    const f = await fixture();
    expect(prepareReleaseProfiles([f.profile], verification.prepareVerificationProfiles([f.verifier]))[0]).toBe(f.profile);
    expect(() => readReleaseCapabilities(structuredClone(f.profile))).toThrow(/locally prepared/);
    expect(() => prepareReleaseProfiles([structuredClone(f.profile)], [f.verifier])).toThrow(/unknown.*field/);
    expect(Object.isFrozen(f.release.contract.health_checks[0])).toBe(true);
    const { criterion_acceptance: _, ...legacyRaw } = f.raw;
    const legacy = prepareReleaseProfiles([legacyRaw], [f.verifier])[0]!;
    const { verifier: _verifier, digest: _digest, ...effective } = legacy;
    expect(legacy.digest).toBe(sha(JSON.stringify(effective))); expect(readReleaseCapabilities(legacy)).toBeUndefined();
    expect(f.profile.digest).not.toBe(legacy.digest);
    for (const value of [f.storage, f.config, "argv", "trustedFiles"]) expect(JSON.stringify(f.release)).not.toContain(value);
  });
  it("rechecks protected files, physical directory identities and executor lifetime", async () => {
    const f = await fixture(), read = f.executor.getCapabilityReader(f.profile.id);
    expect(read()).toEqual(f.release);
    const moved = `${f.storage}-old`; renameSync(f.storage, moved); mkdirSync(f.storage);
    expect(read).toThrow(/physical directory identity/);
    rmdirSync(f.storage); renameSync(moved, f.storage);
    write(f.config, `${readFileSync(f.config, "utf8")} `); expect(read).toThrow(/verifier changed/);
    const other = await fixture(), stopped = other.executor.getCapabilityReader(other.profile.id);
    other.executor.requestStop(); expect(stopped).toThrow(/lifetime/);
  });
  it("rejects v2 policies with earlier browser contracts and absent local authority", async () => {
    const f = await fixture();
    write(f.config, JSON.stringify({ evidence_root: join(f.root, "evidence"), viewports: [390], design_capture_cases: true }));
    const raw = structuredClone(f.rawVerifier); raw.commands[0]!.observation!.format = "static-web-acceptance.v1";
    expect(() => verification.prepareVerificationProfiles([raw])).toThrow(/v3 browser/);
    const other = await fixture();
    expect(() => verification.measureReleaseAcceptancePlan(other.verifier, other.workspace, undefined as never)).toThrow();
    const summary = verification.measureReleaseAcceptancePlan(other.verifier, other.workspace, other.read);
    expect(summary).toMatchObject({ version: 2, claim: "declared-mapping-feasibility", workspace_criterion_count: 1, release_criterion_count: 1,
      pending_release: [{ requirement_id: "PUB", criterion_index: 0, release_binding: other.release.binding }] });
    other.research.requirements[1]!.acceptance_criteria[0] = "Search works"; other.save();
    expect(() => verification.measureReleaseAcceptancePlan(other.verifier, other.workspace, other.read)).toThrow(/exact configured/);
  });
  it("admits authors and read-only peers only with exact local request and context bindings", async () => {
    const f = await fixture(); Object.defineProperty(process, "platform", { ...originalPlatform, value: "linux" });
    const payload: RunStartPayload = { run_id: "run", task_id: "task", agent_instance_id: "agent", runtime: "fixture", workspace: { root: f.workspace },
      context_pack: { id: "context", payload: f.context }, policy_snapshot: f.context.policy, artifact_rules: { paths: [] },
      verification: { version: 1, request_id: "verify", profile_id: f.verifier.id, release_capability_binding: f.release.binding,
        capability_binding: { version: 1, profile_digest: f.verifier.digest, checks: f.verifier.capabilities!.checks.map(({ command_id, config_digest, contract_digest }) => ({ command_id, config_digest, contract_digest })) } } };
    expect(verification.selectVerificationProfile(payload, [f.verifier], false, f.read)).toBe(f.verifier);
    expect(() => verification.selectVerificationProfile(payload, [f.verifier], false)).toThrow(/local binding/);
    const changed = structuredClone(payload); changed.verification!.release_capability_binding!.release_profile_digest = sha("other");
    expect(() => verification.selectVerificationProfile(changed, [f.verifier], false, f.read)).toThrow("Release capabilities differ from the node's local binding");
    const peer = structuredClone(payload); delete peer.context_pack.payload!.product_development;
    peer.context_pack.payload!.policy = { execution_mode: "discussion", filesystem_write_scope: [], requires_approval: [] };
    peer.verification!.expected_subject_digest = verification.subjectManifest(f.verifier).digest;
    peer.context_pack.payload!.review_subject = { version: 1, task_id: "author", run_id: "author", evidence_id: "source",
      subject_digest: peer.verification!.expected_subject_digest, development_stage: "validation" };
    expect(verification.selectVerificationProfile(peer, [f.verifier], false, f.read)).toBe(f.verifier);
  });
  it("never turns earlier stages or peer success into a final publication attestation", async () => {
    const f = await fixture(), { evidence } = f.measured();
    expect(() => f.executor.recordVerification("run", "project", f.workspace, evidence)).toThrow(/local acceptance context/);
    const research = structuredClone(f.context); research.product_development = productDevelopmentContext("research", f.verifier.capabilities);
    f.executor.recordVerification("research", "project", f.workspace, evidence, { context: research, readCapabilities: f.read });
    const peer = structuredClone(f.context); delete peer.product_development;
    peer.review_subject = { version: 1, task_id: "author", run_id: "author", evidence_id: "source", subject_digest: evidence.subject_digest!, development_stage: "validation" };
    peer.policy = { execution_mode: "discussion", filesystem_write_scope: [], requires_approval: [] };
    f.executor.recordVerification("peer", "project", f.workspace, evidence, { context: peer, readCapabilities: f.read });
    expect(existsSync(join(f.storage, "attestations"))).toBe(false);
  });
  it("rejects preview scope and changed accepted pins before recording final authority", async () => {
    const f = await fixture(), { evidence } = f.measured();
    const preview = structuredClone(evidence); preview.measurement_plan!.scope = "preview"; preview.checks[0]!.observation!.scope = "preview";
    expect(() => f.executor.recordVerification("preview", "project", f.workspace, preview, { context: f.context, readCapabilities: f.read })).toThrow(/final measured/);
    write(join(f.workspace, ".artoo/product/design.json"), '{"changed":true}');
    expect(() => f.executor.recordVerification("changed", "project", f.workspace, evidence, { context: f.context, readCapabilities: f.read })).toThrow(/Accepted product input/);
    expect(existsSync(join(f.storage, "attestations"))).toBe(false);
  });
  it("records the selected publisher only and keeps its final plan identity immutable", async () => {
    const f = await fixture(), secondStorage = join(f.root, "other-storage"); mkdirSync(secondStorage);
    const profiles = prepareReleaseProfiles([f.profile, { ...f.raw, id: "other-site", storage_root: secondStorage,
      listen_port: f.raw.listen_port === 65535 ? 65534 : f.raw.listen_port + 1 }], [f.verifier]);
    const publisher = createProductReleaseExecutor(profiles); executors.push(publisher);
    const { evidence } = f.measured();
    publisher.recordVerification("run", "project", f.workspace, evidence, { context: f.context, readCapabilities: publisher.getCapabilityReader(f.profile.id) });
    expect(readdirSync(join(f.storage, "attestations"))).toHaveLength(1);
    expect(existsSync(join(secondStorage, "attestations"))).toBe(false);
    const context = structuredClone(f.context); context.goal_context!.plan!.version++;
    expect(() => publisher.recordVerification("run", "project", f.workspace, evidence,
      { context, readCapabilities: publisher.getCapabilityReader(f.profile.id) })).toThrow(/attestation is immutable/);
  });
  it.runIf(nativeSupported)("settles only after actual HTTP publication and replays nested bindings after restart", async () => {
    const f = await fixture(), { request } = f.attest();
    const receipt = await f.executor.release(request);
    expect(receipt).toMatchObject({ outcome: "published", acceptance: { version: 1, scope: "node-http-point-in-time",
      binding_digest: sha(canonicalReleaseAcceptanceBinding(request.acceptance_binding!)), settled_criteria: request.acceptance_binding!.criteria } });
    expect(await (await fetch(f.raw.public_url)).text()).toContain("Healthy journal");
    await f.executor.stop();
    const restarted = createProductReleaseExecutor([f.profile]); executors.push(restarted); await restarted.start();
    expect(await restarted.release(JSON.parse(JSON.stringify(request)))).toEqual(receipt);
    const changed = structuredClone(request); changed.acceptance_binding!.plan.version++;
    await expect(restarted.release(changed)).rejects.toThrow(/different immutable request/);
  });
  it.runIf(nativeSupported)("refuses downgrade, different goal or plan and changed accepted input before activation", async () => {
    const f = await fixture(), { request } = f.attest();
    const noBinding = structuredClone(request); delete noBinding.acceptance_binding; noBinding.release_id = "downgrade";
    expect(await f.executor.release(noBinding)).toMatchObject({ outcome: "failed", artifact_digest: null, reason: expect.stringContaining("downgrade") });
    const otherGoal = { ...request, release_id: "other-goal", goal_id: "other" };
    expect(await f.executor.release(otherGoal)).toMatchObject({ outcome: "failed", artifact_digest: null });
    const otherPlan = structuredClone(request); otherPlan.release_id = "other-plan"; otherPlan.acceptance_binding!.plan.version++;
    expect(await f.executor.release(otherPlan)).toMatchObject({ outcome: "failed", artifact_digest: null });
    write(f.researchPath, `${readFileSync(f.researchPath, "utf8")} `);
    expect(await f.executor.release(request)).toMatchObject({ outcome: "failed", artifact_digest: null });
    expect((await fetch(f.raw.public_url)).status).toBe(503);
  });
  it.runIf(nativeSupported)("records no settlement when endpoint health fails", async () => {
    const f = await fixture(); write(join(f.workspace, "product/index.html"), "<h1>Broken</h1>");
    const { request } = f.attest(), receipt = await f.executor.release(request);
    expect(receipt.outcome).not.toBe("published"); expect(receipt.acceptance).toBeUndefined();
    expect(receipt.request.acceptance_binding).toEqual(request.acceptance_binding);
  });
});
