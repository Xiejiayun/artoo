// Controlled guardian/checkpoint/author owners and verifier input. Filesystem isolation,
// publisher state, HTTP serving and closure are real; this is not native clean restart evidence.
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { createServer as createHttpServer, request as httpRequest, type ClientRequest } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
const authority = vi.hoisted(() => ({ runtimes: new WeakMap<object, unknown>(), permits: new WeakMap<object, unknown>() }));
vi.mock("./windows-clean-validation-runtime.js", async original => ({ ...await original<typeof import("./windows-clean-validation-runtime.js")>(),
  readWindowsCleanValidationPublicationFence: (runtime: object) => {
    const value = authority.runtimes.get(runtime); if (!value) throw Error("Controlled original checkpoint owner required"); return value;
  },
  isPreparedCleanValidationRelease: (permit: object) => authority.permits.has(permit),
  readPreparedCleanValidationRelease: (permit: object, request?: ProductReleaseRequest) => {
    const value = authority.permits.get(permit) as { request: ProductReleaseRequest; assertCurrent(): void } | undefined;
    if (!value || request && canonicalProductReleaseRequest(value.request) !== canonicalProductReleaseRequest(request))
      throw Error("Controlled original fresh review owner required");
    value.assertCurrent(); return value;
  },
}));
import { canonicalProductReleaseRequest, canonicalReleaseJson,
  type ProductReleaseReceipt } from "@artoo/domain";
import { CONFIGURED_STATIC_PUBLICATION_CLAIM, CONFIGURED_STATIC_PUBLICATION_STATEMENT, CONFIGURED_STATIC_PUBLICATION_STATEMENT_DIGEST,
  canonicalReleaseAcceptanceBinding, productDevelopmentContext, type ContextPack, type ProductResearchReport,
  type ProductReleaseRequest, type RunStartPayload, type RunVerificationPayload } from "@artoo/domain";
import * as verification from "./verification.js";
import { createProductReleaseExecutor, createReleaseCapabilityReader, prepareReleaseProfiles, readReleaseCapabilities,
  readPreparedProductReleaseRetry, type PreparedProductReleaseRetry, type ReleaseProfile } from "./product-release.js";

const roots: string[] = [], executors: ReturnType<typeof createProductReleaseExecutor>[] = [];
const proxyClosers: (() => Promise<void>)[] = [];
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const sha = (value: string | Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const write = (path: string, value: string) => { writeFileSync(path, value); readFileSync(path); };
afterEach(async () => {
  Object.defineProperty(process, "platform", originalPlatform); vi.restoreAllMocks();
  for (const executor of executors.splice(0)) await executor.stop();
  for (const close of proxyClosers.splice(0)) await close();
  const writable = (path: string): void => {
    chmodSync(path, 0o700);
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name); if (entry.isDirectory()) writable(child); else chmodSync(child, 0o600);
    }
  };
  for (const root of roots.splice(0)) {
    const child = relative(realpathSync.native(tmpdir()), realpathSync.native(root));
    if (isAbsolute(child) || child.startsWith("..") || !child.startsWith("artoo-release-acceptance-")) throw Error("Unsafe fixture cleanup path");
    writable(root); rmSync(root, { recursive: true });
  }
});

async function failureProxy(backendPort: number) {
  let rejectNext = false, requests = 0, failures = 0, forwards = 0;
  const statuses: number[] = [], releaseIds: (string | null)[] = [], outgoing = new Set<ClientRequest>();
  const proxy = createHttpServer((request, response) => {
    requests++;
    if (rejectNext) {
      rejectNext = false; failures++; statuses.push(503);
      response.writeHead(503).end("Controlled transient recovery publication failure"); return;
    }
    forwards++;
    const forwarding = httpRequest({ hostname: "127.0.0.1", port: backendPort, path: request.url, method: "GET" }, incoming => {
      statuses.push(incoming.statusCode ?? 502);
      const releaseId = incoming.headers["x-artoo-release-id"]; releaseIds.push(typeof releaseId === "string" ? releaseId : null);
      response.writeHead(incoming.statusCode ?? 502, incoming.headers); incoming.pipe(response);
    });
    outgoing.add(forwarding); forwarding.once("close", () => outgoing.delete(forwarding));
    forwarding.once("error", () => { if (!response.destroyed) response.writeHead(502).end("Backend unavailable"); }); forwarding.end();
  });
  await new Promise<void>((resolve, reject) => { proxy.once("error", reject); proxy.listen(0, "127.0.0.1", resolve); });
  const port = (proxy.address() as { port: number }).port;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    for (const request of outgoing) request.destroy();
    await new Promise<void>((resolve, reject) => { proxy.close(error => error ? reject(error) : resolve()); proxy.closeAllConnections(); });
  })();
  proxyClosers.push(close);
  return { port, publicUrl: `http://127.0.0.1:${port}`, close,
    failNext() { if (rejectNext) throw Error("A controlled HTTP failure is already queued"); rejectNext = true; },
    counts() { return { requests, failures, forwards, statuses: [...statuses], releaseIds: [...releaseIds] }; } };
}
function retryRequest(receipt: ProductReleaseReceipt, id: string): ProductReleaseRequest {
  if (!receipt.retry_source) throw Error("Expected the original executor's closed failure projection");
  return { ...receipt.request, release_id: id, retry: { version: 1,
    root_release_id: receipt.request.retry?.root_release_id ?? receipt.request.release_id,
    previous_release_id: receipt.request.release_id, generation: (receipt.request.retry?.generation ?? 0) + 1,
    source_id: receipt.retry_source.source_id, previous_request_digest: sha(canonicalProductReleaseRequest(receipt.request)),
    previous_receipt_digest: sha(canonicalReleaseJson(receipt)), authorization: { event_id: id + "-authorized", actor_user_id: "user",
      goal_id: receipt.request.goal_id, attempt_index: Math.max(receipt.request.retry?.authorization.attempt_index ?? 0,
        receipt.request.imported_clean?.authorization.attempt_index ?? 0) + 1 } } };
}

async function fixture(withRetryProxy = false) {
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
  // This publisher-isolation fixture fixes its verifier input; verifier installation
  // mutation is outside its scope. Reuse the first real capability snapshot only
  // for this original profile. Unknown profiles and clones still use the real reader.
  const actualReadCapabilities = verification.readVerificationCapabilities;
  vi.spyOn(verification, "readVerificationCapabilities").mockImplementation(profile =>
    profile === verifier ? capabilities : actualReadCapabilities(profile));
  const listener = createServer(); await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as { port: number }).port; await new Promise<void>(resolve => listener.close(() => resolve()));
  const proxy = withRetryProxy ? await failureProxy(port) : undefined;
  const raw: ReleaseProfile = { id: "site", project_id: "project", verification_profile_id: verifier.id, storage_root: storage,
    output_path: "product", public_url: proxy?.publicUrl ?? `http://127.0.0.1:${port}`, listen_host: "127.0.0.1", listen_port: port,
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
  // A controlled local session identity enables the real executor's H8 retry machinery.
  const session = Object.freeze({}), options = withRetryProxy ? { retrySession: () => session } : {};
  let executor = createProductReleaseExecutor([profile], options); executors.push(executor);
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
  return { root, workspace, storage, config, rawVerifier, verifier, raw, profile, read, release, context, research, researchPath, save,
    get executor() { return executor; }, measured, attest, proxy,
    async replaceExecutor() { await executor.stop(); executor = createProductReleaseExecutor([profile], options); executors.push(executor); } };
}

function checkpointOwner(f: Awaited<ReturnType<typeof fixture>>, old?: ProductReleaseRequest) {
  // Deliberately controlled opaque authority. This does not construct a native
  // checkpoint or validate its lifecycle; only publisher isolation is under test.
  const checkpoint = Object.freeze({}), generationId = "clean-generation", lineageId = "clean-lineage";
  const operations = old ? [{ kind: "release" as const, operation_id: old.release_id,
    request_digest: sha(canonicalProductReleaseRequest(old)) }] : [];
  const runtime = Object.freeze({}), current = { live: true };
  const assertCurrent = () => { if (!current.live) throw Error("Controlled original epoch is no longer current"); };
  authority.runtimes.set(runtime, Object.freeze({ checkpoint, generationId, lineageId,
    predecessorOperations: operations, workspaceRoot: f.workspace, projectId: "project", assertCurrent }));
  return { runtime: runtime as never, checkpoint, generationId, lineageId, operations,
    restart: { generation_id: generationId, lineage_id: lineageId }, assertCurrent, expire: () => { current.live = false; } };
}
function freshPublication(f: Awaited<ReturnType<typeof fixture>>, owner: ReturnType<typeof checkpointOwner>) {
  const { request: measured, evidence } = f.measured("fresh-clean"), request: ProductReleaseRequest = { ...measured,
    imported_clean: { version: 1, clean_generation_id: owner.generationId,
      restart_digest: sha("controlled-clean-restart-origin"), validation_id: "fresh-validation",
      validation_request_digest: sha("fresh-author-request"), validation_result_digest: sha("fresh-final-verifier"),
      review_id: "fresh-review", review_request_digest: sha("fresh-review-request"), review_result_digest: sha("fresh-review-result"),
      acceptance_event_id: "fresh-review-accepted", subject_digest: measured.subject_digest,
      interrupted_release_id: owner.operations.find(operation => operation.kind === "release")?.operation_id ?? null,
      authorization: { event_id: "fresh-publication-authorized", goal_id: measured.goal_id, actor_user_id: "user", attempt_index: 2 } } };
  const context: ContextPack = { ...f.context,
    imported_clean_validation: { version: 1, clean_generation_id: owner.generationId, restart_digest: request.imported_clean!.restart_digest,
      epoch_id: "8e1e3c88-6902-4507-9947-4e8dcd7d0e7f", validation_id: "fresh-validation", root_validation_id: "fresh-validation",
      generation: 0, kind: "initial", origin_digest: sha("controlled-origin"), initial_subject_digest: measured.subject_digest,
      authorization_event_id: "clean-author-authorized", attempt_index: 1 } };
  const start = { run_id: request.run_id, context_pack: { payload: context } }, permit = Object.freeze({});
  let currentPermit: object = permit;
  const assertCurrent = (expected: object) => {
    owner.assertCurrent(); if (currentPermit !== expected) throw Error("Controlled clean publication permit is no longer current");
  };
  authority.permits.set(permit, { profile: f.verifier, start, verification: evidence, checkpoint: owner.checkpoint, restart: owner.restart,
    request, readReleaseCapabilities: f.read, effectivePlan: f.research.measurement_plan, assertCurrent: () => assertCurrent(permit) });
  // Publisher isolation is under test; imported-author measurement qualification has its own suite.
  const measure = verification.measureReleaseAcceptancePlan;
  vi.spyOn(verification, "measureReleaseAcceptancePlan").mockImplementation((profile, root, read) => measure(profile, root, read));
  const attest = () => f.executor.recordVerification(request.run_id, "project", f.workspace, evidence,
    { context, readCapabilities: f.read, importedClean: permit as never });
  return { request, attest, permit,
    retry(next: ProductReleaseRequest, retry: PreparedProductReleaseRetry) {
      // Only the clean author/reviewer owner is simulated here. The exact-source retry permit reader and
      // its original executor/session/source/closed-listener checks remain real.
      const original = readPreparedProductReleaseRetry(retry, next);
      expect(original.previousRequest.imported_clean).toEqual(request.imported_clean);
      expect(next.imported_clean).toEqual(request.imported_clean);
      const previous = authority.permits.get(currentPermit) as { request: ProductReleaseRequest };
      expect(canonicalProductReleaseRequest(previous.request)).toBe(canonicalProductReleaseRequest(original.previousRequest));
      const retryPermit = Object.freeze({});
      authority.permits.set(retryPermit, { profile: f.verifier, start, verification: evidence, checkpoint: owner.checkpoint, restart: owner.restart,
        request: next, readReleaseCapabilities: f.read, effectivePlan: f.research.measurement_plan,
        assertCurrent() { assertCurrent(retryPermit); readPreparedProductReleaseRetry(retry, next); } });
      currentPermit = retryPermit;
      const attestRetry = () => f.executor.recordVerification(next.run_id, "project", f.workspace, evidence,
        { context, readCapabilities: f.read, importedClean: retryPermit as never });
      return { permit: retryPermit, attest: attestRetry };
    } };
}
function operationPath(f: Awaited<ReturnType<typeof fixture>>, request: ProductReleaseRequest) {
  return join(f.storage, "operations", `${sha(request.release_id).slice(7)}.json`);
}
function interruptedPublication(f: Awaited<ReturnType<typeof fixture>>, request: ProductReleaseRequest) {
  // An activated-but-unsettled local operation, after its old process has gone away.
  const operation = { request, previous: null, phase: "activated" };
  writeFileSync(operationPath(f, request), JSON.stringify(operation));
  writeFileSync(join(f.storage, "current.json"), JSON.stringify({ release_id: request.release_id,
    artifact_digest: request.subject_digest, release_profile_digest: f.profile.digest }));
  return readFileSync(operationPath(f, request));
}
async function assertListenerClosed(port: number) {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(port, "127.0.0.1", resolve); });
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
}

describe("clean publisher isolation", () => {
  it("publishes a first clean source only after its own checkpoint fence and fresh local permit", async () => {
    const f = await fixture(), owner = checkpointOwner(f), fresh = freshPublication(f, owner);
    expect(() => fresh.attest()).toThrow("original installed checkpoint fence");
    await expect(f.executor.release(fresh.request)).rejects.toThrow("original installed checkpoint fence");
    f.executor.fenceCleanWorkspace(owner.runtime); fresh.attest();
    const receipt = await f.executor.release(fresh.request);
    expect(receipt.outcome).toBe("published"); expect(receipt.previous_release_id).toBeNull();
    expect(JSON.parse(readFileSync(join(f.storage, "source-clean-restart.json"), "utf8"))).toMatchObject({
      clean_generation_id: owner.generationId, lineage_id: owner.lineageId, previous_pointer: null });
    expect(existsSync(join(f.storage, "source-recovery.json"))).toBe(false);
  });
  it("rejects a different opaque checkpoint even when generation and lineage strings match", async () => {
    const f = await fixture(), owner = checkpointOwner(f);
    f.executor.fenceCleanWorkspace(owner.runtime); const fresh = freshPublication(f, owner);
    const saved = authority.permits.get(fresh.permit) as { checkpoint: object };
    saved.checkpoint = Object.freeze({});
    expect(() => fresh.attest()).toThrow("old or unrelated author");
    saved.checkpoint = owner.checkpoint; fresh.attest();
    const downgraded = { ...fresh.request }; delete downgraded.imported_clean;
    await expect(f.executor.release(downgraded)).rejects.toThrow("isolated old publication");
    await assertListenerClosed(f.raw.listen_port);
  });
  it("allows fresh publication after closure of an original queued request that never reached the publisher", async () => {
    const f = await fixture(), old = f.measured("old-queued").request, owner = checkpointOwner(f, old);
    f.executor.fenceCleanWorkspace(owner.runtime);
    const fresh = freshPublication(f, owner); fresh.attest();
    expect(() => f.executor.replayReceipt(old)).toThrow("isolated old publication");
    expect(existsSync(operationPath(f, old))).toBe(false);
    const reused = { ...fresh.request, release_id: old.release_id };
    await expect(f.executor.release(reused)).rejects.toThrow("Clean publication requires its exclusive newly accepted source and configured release contract");
    // The schema rejects self-reference first; a schema-valid reuse must still hit the original epoch fence.
    const fencedReuse = { ...reused, imported_clean: { ...reused.imported_clean!, interrupted_release_id: null } };
    await expect(f.executor.release(fencedReuse)).rejects.toThrow("isolated old publication");
    expect((await f.executor.release(fresh.request)).outcome).toBe("published");
    expect(existsSync(operationPath(f, old))).toBe(false);
  });
  it("refuses an old queued journal that appears after the original absence was fenced", async () => {
    const f = await fixture(), old = f.measured("old-queued").request, owner = checkpointOwner(f, old);
    f.executor.fenceCleanWorkspace(owner.runtime); const fresh = freshPublication(f, owner); fresh.attest();
    writeFileSync(operationPath(f, old), JSON.stringify({ request: old, previous: null, phase: "prepared" }));
    await expect(f.executor.release(fresh.request)).rejects.toThrow("absent original publication journal appeared");
    await assertListenerClosed(f.raw.listen_port);
  });
  it("keeps clean and surviving-guardian recovery fence records separate", async () => {
    const f = await fixture(), owner = checkpointOwner(f);
    writeFileSync(join(f.storage, "source-recovery.json"), JSON.stringify({ version: 1, controlled: true }));
    expect(() => f.executor.fenceCleanWorkspace(owner.runtime)).toThrow("another source generation");
    expect(existsSync(join(f.storage, "source-clean-restart.json"))).toBe(false);
    await expect(f.executor.start()).rejects.toThrow("source recovery requires its original live checkpoint owner");
    await assertListenerClosed(f.raw.listen_port);
  });
  it("keeps an old activated operation untouched and listener closed until a fresh reviewed publication", async () => {
    const f = await fixture(), old = f.attest("old").request, bytes = interruptedPublication(f, old), owner = checkpointOwner(f, old);
    expect(() => f.executor.fenceCleanWorkspace({} as never)).toThrow("original checkpoint owner");
    f.executor.fenceCleanWorkspace(owner.runtime);
    await expect(f.executor.start()).rejects.toThrow("awaiting fresh verification");
    await f.executor.checkHealth(); expect(f.executor.getPublicationReceipts()).toEqual([]); expect(f.executor.getHealthReports()).toEqual([]);
    await expect(f.executor.release(old)).rejects.toThrow("isolated old publication");
    await expect(f.executor.cancel(old)).rejects.toThrow("isolated old publication");
    expect(readFileSync(operationPath(f, old))).toEqual(bytes); await assertListenerClosed(f.raw.listen_port);
    const fresh = freshPublication(f, owner);
    await expect(f.executor.release(fresh.request)).rejects.toThrow("fresh local author");
    await assertListenerClosed(f.raw.listen_port); fresh.attest();
    const receipt = await f.executor.release(fresh.request);
    expect(receipt.outcome).toBe("published"); expect(receipt.previous_release_id).toBeNull();
    const response = await fetch(f.raw.public_url); expect(response.headers.get("x-artoo-release-id")).toBe(fresh.request.release_id);
    expect(await response.text()).toContain("Healthy journal"); expect(readFileSync(operationPath(f, old))).toEqual(bytes);
    expect(f.executor.getPublicationReceipts().map(value => value.request.release_id)).toEqual([fresh.request.release_id]);
    expect(f.executor.replayReceipt(fresh.request)).toEqual(receipt);
  });
  it("never replays even a locally terminal old receipt and refuses a restart from the durable fence alone", async () => {
    const f = await fixture(), old = f.attest("old-terminal").request;
    expect((await f.executor.release(old)).outcome).toBe("published"); await f.executor.stop();
    const oldBytes = readFileSync(operationPath(f, old)), owner = checkpointOwner(f, old);
    const replacement = createProductReleaseExecutor([f.profile]); executors.push(replacement);
    replacement.fenceCleanWorkspace(owner.runtime);
    expect(replacement.getPublicationReceipts()).toEqual([]);
    expect(() => replacement.replayReceipt(old)).toThrow("isolated old publication");
    await expect(replacement.start()).rejects.toThrow("awaiting fresh verification");
    const unowned = createProductReleaseExecutor([f.profile]); executors.push(unowned);
    await expect(unowned.start()).rejects.toThrow("original live checkpoint owner");
    expect(() => unowned.getPublicationReceipts()).toThrow("original live checkpoint owner");
    expect(() => unowned.replayReceipt(old)).toThrow("original live checkpoint owner");
    expect(readFileSync(operationPath(f, old))).toEqual(oldBytes); await assertListenerClosed(f.raw.listen_port);
  });
  it("rejects unrelated unfinished history before writing an isolation record", async () => {
    const f = await fixture(), old = f.attest("unlisted").request, bytes = interruptedPublication(f, old), owner = checkpointOwner(f);
    expect(() => f.executor.fenceCleanWorkspace(owner.runtime)).toThrow("outside the original closed epoch");
    expect(existsSync(join(f.storage, "source-clean-restart.json"))).toBe(false);
    expect(readFileSync(operationPath(f, old))).toEqual(bytes); await assertListenerClosed(f.raw.listen_port);
  });
  it("rejects an old request digest mismatch before changing the pointer", async () => {
    const f = await fixture(), old = f.attest("old").request, bytes = interruptedPublication(f, old), owner = checkpointOwner(f, old);
    owner.operations[0]!.request_digest = sha("changed original request");
    expect(() => f.executor.fenceCleanWorkspace(owner.runtime)).toThrow("differs from local history");
    expect(readFileSync(operationPath(f, old))).toEqual(bytes); expect(existsSync(join(f.storage, "source-clean-restart.json"))).toBe(false);
  });
  it("rechecks old immutable files and current epoch before fresh publication can start", async () => {
    const f = await fixture(), old = f.attest("old").request, bytes = interruptedPublication(f, old), owner = checkpointOwner(f, old);
    f.executor.fenceCleanWorkspace(owner.runtime); const fresh = freshPublication(f, owner); fresh.attest();
    writeFileSync(operationPath(f, old), Buffer.concat([bytes, Buffer.from(" ")]));
    await expect(f.executor.release(fresh.request)).rejects.toThrow("isolated publication history changed");
    writeFileSync(operationPath(f, old), bytes); owner.expire();
    await expect(f.executor.release(fresh.request)).rejects.toThrow("epoch is no longer current");
    await assertListenerClosed(f.raw.listen_port);
  });
  it("retains old attestations and cancellation facts without granting their source publication authority", async () => {
    const f = await fixture(), old = f.attest("old").request;
    interruptedPublication(f, old);
    const cancelledPath = `${operationPath(f, old)}.cancelled`, cancelled = JSON.stringify(old);
    writeFileSync(cancelledPath, cancelled);
    const attestationPath = join(f.storage, "attestations", `${sha(old.run_id).slice(7)}.json`), attestation = readFileSync(attestationPath);
    const owner = checkpointOwner(f, old); f.executor.fenceCleanWorkspace(owner.runtime);
    const fresh = freshPublication(f, owner); fresh.attest();
    writeFileSync(attestationPath, Buffer.concat([attestation, Buffer.from(" ")]));
    await expect(f.executor.release(fresh.request)).rejects.toThrow("isolated publication history changed");
    writeFileSync(attestationPath, attestation); writeFileSync(cancelledPath, cancelled + " ");
    await expect(f.executor.release(fresh.request)).rejects.toThrow("isolated publication history changed");
    writeFileSync(cancelledPath, cancelled);
    expect((await f.executor.release(fresh.request)).outcome).toBe("published");
    expect(readFileSync(attestationPath)).toEqual(attestation); expect(readFileSync(cancelledPath, "utf8")).toBe(cancelled);
  });
  it("keeps interrupted history isolated across two real HTTP 503 failures and an original-owner successful retry", async () => {
    const f = await fixture(true), proxy = f.proxy!;
    const terminal = f.attest("old-terminal-retry").request, oldReceipt = await f.executor.release(terminal);
    expect(oldReceipt.outcome).toBe("published");
    const terminalBytes = readFileSync(operationPath(f, terminal));
    const old = f.attest("old-interrupted-retry").request;
    await f.replaceExecutor(); await assertListenerClosed(f.raw.listen_port);
    const interruptedBytes = interruptedPublication(f, old), oldPointer = readFileSync(join(f.storage, "current.json"));
    const owner = checkpointOwner(f, old); f.executor.fenceCleanWorkspace(owner.runtime);
    const isolationBytes = readFileSync(join(f.storage, "source-clean-restart.json"));
    expect(JSON.parse(isolationBytes.toString()).previous_pointer.release_id).toBe(old.release_id);
    expect(readFileSync(join(f.storage, "current.json"))).toEqual(oldPointer);
    const assertOldHistoryFiles = () => {
      expect(readFileSync(operationPath(f, old))).toEqual(interruptedBytes);
      expect(readFileSync(operationPath(f, terminal))).toEqual(terminalBytes);
      expect(JSON.parse(readFileSync(operationPath(f, terminal), "utf8")).receipt).toEqual(oldReceipt);
      expect(readFileSync(join(f.storage, "source-clean-restart.json"))).toEqual(isolationBytes);
    };
    const assertOldHistory = () => {
      assertOldHistoryFiles();
      expect(() => f.executor.replayReceipt(old)).toThrow("isolated old publication");
      expect(() => f.executor.replayReceipt(terminal)).toThrow("isolated old publication");
    };
    const pointer = () => JSON.parse(readFileSync(join(f.storage, "current.json"), "utf8"));
    await expect(f.executor.start()).rejects.toThrow("awaiting fresh verification");
    await f.executor.checkHealth(); assertOldHistory(); await assertListenerClosed(f.raw.listen_port);
    expect(proxy.counts()).toEqual({ requests: 1, failures: 0, forwards: 1, statuses: [200], releaseIds: [terminal.release_id] });
    write(join(f.workspace, "product/index.html"), "<h1>Healthy recovered journal</h1>");
    const fresh = freshPublication(f, owner); fresh.attest(); proxy.failNext();
    const failed = await f.executor.release(fresh.request);
    expect(failed).toMatchObject({ outcome: "rolled_back", previous_release_id: null,
      retry_source: { closure: "local-release-settled.v1", recovery: { kind: "listener-closed", active_release_id: null, active_artifact_digest: null } } });
    expect(f.executor.isAttemptSettled(fresh.request)).toBe(true); expect(pointer()).toBeNull();
    assertOldHistory(); await assertListenerClosed(f.raw.listen_port);
    expect(proxy.counts()).toEqual({ requests: 2, failures: 1, forwards: 1, statuses: [200, 503], releaseIds: [terminal.release_id] });
    const failedBytes = readFileSync(operationPath(f, fresh.request));

    const second = retryRequest(failed, "fresh-clean-retry-1"), secondRetry = f.executor.prepareRetry(second);
    expect(f.executor.prepareRetry(structuredClone(second))).toBe(secondRetry);
    expect(readPreparedProductReleaseRetry(secondRetry, second).previousReceipt).toEqual(failed);
    expect(() => readPreparedProductReleaseRetry(structuredClone(secondRetry), second)).toThrow("original exact");
    await expect(f.executor.release(second)).rejects.toThrow("original local permit");
    await expect(f.executor.release(second, { retry: secondRetry })).rejects.toThrow("fresh local author");
    expect(pointer()).toBeNull(); await assertListenerClosed(f.raw.listen_port);
    expect(proxy.counts().requests).toBe(2);
    const secondReview = fresh.retry(second, secondRetry);
    expect((authority.permits.get(secondReview.permit) as { checkpoint: unknown }).checkpoint).toBe(owner.checkpoint);
    expect(() => fresh.attest()).toThrow("publication permit is no longer current");
    secondReview.attest(); proxy.failNext();
    const failedAgain = await f.executor.release(second, { retry: secondRetry });
    expect(failedAgain).toMatchObject({ outcome: "rolled_back", previous_release_id: null, request: { retry: { generation: 1 } },
      retry_source: { closure: "local-release-settled.v1", recovery: { kind: "listener-closed", active_release_id: null, active_artifact_digest: null } } });
    expect(failedAgain.retry_source!.source_id).not.toBe(failed.retry_source!.source_id);
    expect(f.executor.isAttemptSettled(second)).toBe(true); expect(pointer()).toBeNull();
    assertOldHistory(); expect(readFileSync(operationPath(f, fresh.request))).toEqual(failedBytes); await assertListenerClosed(f.raw.listen_port);
    expect(proxy.counts()).toEqual({ requests: 3, failures: 2, forwards: 1, statuses: [200, 503, 503], releaseIds: [terminal.release_id] });
    const secondBytes = readFileSync(operationPath(f, second));

    const third = retryRequest(failedAgain, "fresh-clean-retry-2"), thirdRetry = f.executor.prepareRetry(third);
    expect(readPreparedProductReleaseRetry(thirdRetry, third).previousReceipt).toEqual(failedAgain);
    const thirdReview = fresh.retry(third, thirdRetry);
    expect((authority.permits.get(thirdReview.permit) as { checkpoint: unknown }).checkpoint).toBe(owner.checkpoint);
    expect(() => secondReview.attest()).toThrow("publication permit is no longer current");
    thirdReview.attest();
    const published = await f.executor.release(third, { retry: thirdRetry });
    expect(published).toMatchObject({ outcome: "published", previous_release_id: null, request: { retry: { generation: 2, root_release_id: fresh.request.release_id } } });
    expect(published.retry_source).toBeUndefined(); expect(f.executor.isAttemptSettled(third)).toBe(true);
    expect(pointer().release_id).toBe(third.release_id); assertOldHistory();
    expect(proxy.counts()).toEqual({ requests: 4, failures: 2, forwards: 2, statuses: [200, 503, 503, 200],
      releaseIds: [terminal.release_id, third.release_id] });
    const response = await fetch(f.raw.public_url);
    expect(response.status).toBe(200); expect(response.headers.get("x-artoo-release-id")).toBe(third.release_id);
    expect(await response.text()).toContain("Healthy recovered journal");
    expect(proxy.counts()).toEqual({ requests: 5, failures: 2, forwards: 3, statuses: [200, 503, 503, 200, 200],
      releaseIds: [terminal.release_id, third.release_id, third.release_id] });
    expect(f.executor.replayReceipt(fresh.request)).toEqual(failed); expect(f.executor.replayReceipt(second)).toEqual(failedAgain);
    expect(f.executor.replayReceipt(third)).toEqual(published);
    expect(readFileSync(operationPath(f, fresh.request))).toEqual(failedBytes); expect(readFileSync(operationPath(f, second))).toEqual(secondBytes);
    expect(f.executor.getPublicationReceipts().map(value => value.request.release_id).sort()).toEqual([fresh.request.release_id, second.release_id, third.release_id].sort());
    expect(f.executor.getHealthReports()).toEqual([]);
    await f.executor.stop(); await assertListenerClosed(f.raw.listen_port); assertOldHistoryFiles();
    expect(readFileSync(operationPath(f, fresh.request))).toEqual(failedBytes); expect(readFileSync(operationPath(f, second))).toEqual(secondBytes);
    expect(() => f.executor.replayReceipt(old)).toThrow(/^Product release: release capability lifetime has ended$/);
    expect(() => f.executor.replayReceipt(terminal)).toThrow(/^Product release: release capability lifetime has ended$/);
    await proxy.close(); await assertListenerClosed(proxy.port);
  });
});
