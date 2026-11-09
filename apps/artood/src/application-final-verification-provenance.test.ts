// Controlled toolchain, command and browser boundaries, not native/product acceptance.
// prepareVerificationProfiles, its private registries, backend preparation,
// runVerification, source hashing and the final provenance getter remain real.
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationVerificationObservationV1Schema, productDevelopmentContext,
  type ApplicationCapabilitiesV1, type ApplicationVerificationObservationV1, type RunStartPayload } from "@artoo/domain";
import type { ApplicationVerificationConfiguration, ApplicationVerificationFile, readApplicationVerificationProfile } from "./application-verification-profile.js";
import type { ApplicationRuntimeFilePin } from "./application-runtime-process-protocol.js";
import type { ApplicationVerificationDefinition } from "./application-verification-definition.js";
import type { PreparedApplicationVerificationCandidate } from "./application-verification-candidate.js";
import type { ApplicationVerificationRun, executeApplicationVerification, readOriginalApplicationMeasurement } from "./application-verification.js";

const controlled = vi.hoisted(() => ({
  prepare: vi.fn(), read: vi.fn(), audit: vi.fn(), execute: vi.fn(), original: vi.fn(), command: vi.fn(), expected: vi.fn(), seal: vi.fn(),
  forbidden: vi.fn(), now: 100, pendingFinalAudit: false, finalAudit: vi.fn(),
}));
vi.mock("./application-verification-profile.js", () => ({ prepareApplicationVerificationProfile: controlled.prepare,
  readApplicationVerificationProfile: controlled.read, assertApplicationVerificationProfile: controlled.audit }));
vi.mock("./application-verification.js", () => ({ executeApplicationVerification: controlled.execute, readOriginalApplicationMeasurement: controlled.original }));
vi.mock("./protected-command.js", async original => ({ ...await original<typeof import("./protected-command.js")>(), runProtectedCommand: controlled.command }));
vi.mock("./web-acceptance.js", async original => ({ ...await original<typeof import("./web-acceptance.js")>(), deriveExpectedWebAcceptanceV3: controlled.expected }));
vi.mock("./browser-evidence.js", async original => ({ ...await original<typeof import("./browser-evidence.js")>(), sealBrowserEvidence: controlled.seal }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(),
  spawn: controlled.forbidden, spawnSync: controlled.forbidden, exec: controlled.forbidden, execFile: controlled.forbidden, fork: controlled.forbidden }));

import { attachWindowsVerificationBackend, prepareVerificationProfiles, readVerificationCapabilities,
  readFinalApplicationVerificationBinding, readPreparedApplicationVerificationProfile, runVerification, selectVerificationProfile, assertFinalVerificationExportBinding,
  type VerificationProfile } from "./verification.js";
import { prepareWindowsProcessBackend } from "./owned/windows-owned-process.js";
import { applicationPublicationRequestFixture } from "./test-fixtures/application-publication-request.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const roots: { root: string; parent: string }[] = [];
const sha = (bytes: string | Buffer): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const sourceBytes = "controlled application source before final audit";
beforeEach(() => {
  vi.resetAllMocks(); controlled.now = 100; controlled.pendingFinalAudit = false;
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  vi.spyOn(performance, "now").mockImplementation(() => controlled.now);
  controlled.forbidden.mockImplementation(() => { throw Error("No native or child process is permitted by this controlled fixture"); });
});
afterEach(() => {
  expect(controlled.forbidden).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.unstubAllEnvs(); Object.defineProperty(process, "platform", platform);
  for (const { root, parent } of roots.splice(0)) {
    // Delete only the direct temporary child created by this fixture.
    if (dirname(root) !== parent || !root.startsWith(join(parent, "artoo-final-app-provenance-"))) throw Error("Fixture cleanup escaped its original temporary parent");
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const parent = realpathSync.native(tmpdir()), root = realpathSync.native(mkdtempSync(join(parent, "artoo-final-app-provenance-")));
  roots.push({ root, parent });
  const workspace = join(root, "workspace"), bundle = join(root, "bundle"), evidence = join(root, "evidence"), toolRoot = join(root, "application-tools");
  const candidateRoot = join(root, "candidates"), installationRoot = join(root, "installations"), selectionRoot = join(root, "selections");
  for (const path of [workspace, bundle, evidence, toolRoot, candidateRoot, installationRoot, selectionRoot]) mkdirSync(path);
  mkdirSync(join(workspace, "product")); mkdirSync(join(workspace, ".artoo", "product"), { recursive: true });
  const source = join(workspace, "product", "index.html"); writeFileSync(source, sourceBytes);
  // Browser plan/evidence are controlled below; these handoffs are still hashed
  // by the real verifier and are explicitly not a valid accepted product.
  for (const name of ["research.json", "design.json", "implementation.md", "validation.json"])
    writeFileSync(join(workspace, ".artoo", "product", name), "controlled outer-finalization handoff");
  vi.stubEnv("SystemRoot", root);
  const executable = "CONTROLLED TEST BYTES, NOT A WINDOWS EXECUTABLE";
  writeFileSync(join(bundle, "Artoo.WindowsProcessHost.exe"), executable);
  const manifest = JSON.stringify({ version: 1, protocol: "artoo.windows-job-process.v1", runtime: "win-x64",
    executable: "Artoo.WindowsProcessHost.exe", files: [{ path: "Artoo.WindowsProcessHost.exe", size: Buffer.byteLength(executable), sha256: sha(executable) }],
    capabilities: ["artoo.windows-target-input.v1"] });
  writeFileSync(join(bundle, "manifest.json"), manifest);
  const backend = prepareWindowsProcessBackend({ directory: bundle, manifestSha256: sha(manifest), assertLocalInstallation: () => {} });
  const files: ApplicationVerificationFile[] = [];
  const pin = (name: string, value: string): ApplicationRuntimeFilePin => {
    const path = join(toolRoot, name); writeFileSync(path, value); readFileSync(path);
    const result = Object.freeze({ path, bytes: Buffer.byteLength(value), sha256: sha(value) }); files.push({ name, pin: result }); return result;
  };
  const node = pin("node.exe", executable), runtime = {
    helper: pin("runtime-helper.exe", executable), helperManifest: pin("runtime-helper-manifest.json", "{}"),
    entry: pin("application-runtime.mjs", "// controlled runtime"), vendorManifest: pin("vendor-manifest.json", "{}"),
    guestBootstrap: pin("application-runtime-guest-bootstrap.js", "// controlled guest"),
  };
  const config: ApplicationVerificationConfiguration = { version: 1, format: "artoo.application-verification-profile.v1", node,
    compiler: { helper: pin("compiler-helper.exe", executable), helperManifest: pin("compiler-helper-manifest.json", "{}"), node,
      entry: pin("application-compiler.mjs", "// controlled compiler"), configuration: pin("compiler-configuration.json", "{}") },
    runtime, broker: pin("application-broker.mjs", "// controlled broker"), hostManifest: pin("application-service-host-manifest.json", "{}"),
    browser: pin("browser.exe", executable), candidate_parent: candidateRoot, installation_parent: installationRoot, selection_parent: selectionRoot,
    origin: "http://127.0.0.1:18080", timeout_ms: 10_000, operation_timeout_ms: 1000, action_timeout_ms: 500 };
  const hostEntry = pin("application-service-bootstrap.mjs", "// controlled bootstrap"); pin("application-service-host-api.mjs", "// controlled host API");
  const configuration = pin("configuration.json", JSON.stringify(config));
  const capabilities: ApplicationCapabilitiesV1 = { version: 1, kind: "local-application-development", claim: "configured",
    config_digest: configuration.sha256, contract_digest: sha("controlled application contract"),
    source_paths: ["product/client", "product/server", ".artoo/product/application.json"], definition_format: "artoo.application-definition.v1",
    test_scope: "normal-api-browser-reopen", failure_recovery: "unsupported", publication: "unsupported", qualified_for_product: false,
    browser_viewport: { width: 1280, height: 900, device_scale_factor: 1 } };
  const selected = Object.freeze({}), saved: ReturnType<typeof readApplicationVerificationProfile> = {
    config, configuration, roots: [workspace], files, packageFiles: [
      { name: "application-runtime.mjs", pin: runtime.entry }, { name: "application-broker.mjs", pin: config.broker },
      { name: "application-runtime-guest-bootstrap.js", pin: runtime.guestBootstrap }, { name: "vendor/manifest.json", pin: runtime.vendorManifest },
      { name: "native/runtime-helper.exe", pin: runtime.helper }, { name: "native/runtime-helper-manifest.json", pin: runtime.helperManifest },
    ], toolchainDigest: sha("controlled toolchain"), hostEntry, capabilities };
  controlled.prepare.mockImplementation((selection, writeRoots) => {
    expect(selection).toEqual({ version: 1, configuration }); expect(writeRoots).toEqual([workspace]); return selected;
  });
  controlled.read.mockImplementation(actual => { expect(actual).toBe(selected); return saved; });
  controlled.audit.mockImplementation(actual => {
    expect(actual).toBe(selected);
    if (controlled.pendingFinalAudit) { controlled.pendingFinalAudit = false; controlled.finalAudit(); }
  });
  const browserConfig = join(root, "browser.json");
  writeFileSync(browserConfig, JSON.stringify({ browser_executable: config.browser.path, evidence_root: evidence,
    browser_program: { version: 3, viewports: [{ id: "desktop", width: 1280, height: 900 }] } }));
  const raw: VerificationProfile = { id: "profile", project_id: "project", workspace_root: workspace,
    commands: [{ id: "browser", argv: [process.execPath, fileURLToPath(new URL("../dist/web-acceptance-cli.js", import.meta.url)), browserConfig], timeout_ms: 1000,
      observation: { format: "static-web-acceptance.v3", evidence_root: evidence, capabilities: { version: 1 } } }],
    required_files: [], subject_paths: ["product", ".artoo/product"], application: { version: 1, configuration } };
  const profile = prepareVerificationProfiles([raw], [workspace])[0]!;
  attachWindowsVerificationBackend(profile, backend);
  const context: NonNullable<RunStartPayload["context_pack"]["payload"]> = {
    task: { id: "task", title: "Controlled finalization", description: "Fixture only", acceptance_criteria: ["controlled"] },
    project: { id: "project", name: "Controlled", default_workspace: workspace }, workspace: { root: workspace, file_scope: [] },
    policy: { requires_approval: [], filesystem_write_scope: [workspace] }, memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] },
    app_delivery: { version: 1, kind: "local-application-development" }, product_development: productDevelopmentContext("validation"),
    verification_capabilities: readVerificationCapabilities(profile),
  };
  const runStart: RunStartPayload = { run_id: "run", task_id: "task", agent_instance_id: "instance", runtime: "controlled-fixture",
    workspace: { root: workspace }, context_pack: { id: "context", payload: context },
    policy_snapshot: { requires_approval: [], filesystem_write_scope: [workspace] }, artifact_rules: { paths: [] },
    verification: { version: 1, profile_id: profile.id, request_id: "request", application: {
      version: 1, config_digest: capabilities.config_digest, contract_digest: capabilities.contract_digest } } };
  const run: ApplicationVerificationRun = { nodeId: "node", runStart };
  const check = profile.capabilities!.checks[0]!, binding = { version: 1, command_id: check.command_id, profile_digest: profile.digest,
    config_digest: check.config_digest, contract_digest: check.contract_digest };
  // Only process output/planning/sealing are controlled. The actual verifier
  // validates this report and carries it through its normal finalization path.
  controlled.command.mockResolvedValue({ status: 0, stdout: Buffer.from(JSON.stringify({ version: 3, format: "static-web-acceptance.v3",
    stage: "validation", passed: true, requirements: 1, device_scale_factor: 1, capability_binding: binding,
    cases: [{ case_id: "controlled-case", viewport: { id: "desktop", width: 1280, height: 900 }, program_digest: sha("program"),
      assertions: 1, operation_count: 2, trace_digest: sha("trace"), trace_size: 10,
      captures: [{ page_id: "main", timing: { kind: "case-end" }, screenshot_digest: sha("capture") }] }] })), stderr: Buffer.alloc(0), elapsedMs: 1 });
  controlled.expected.mockReturnValue({ stage: "validation", requirements: 1, programs: [] });
  controlled.seal.mockReturnValue({ bundle_id: "controlled_bundle", manifest_digest: sha("manifest"), case_refs: [{
    case_id: "controlled-case", viewport_id: "desktop", trace_ref: "controlled_trace", captures: [{ page_id: "main", screenshot_ref: "controlled_capture" }] }] });
  const definition: ApplicationVerificationDefinition = { schema: { version: 1, tables: [{ name: "items",
    columns: [{ name: "text", type: "text", nullable: false, max_bytes: 100 }] }] }, schemaJson: "controlled schema", schemaDigest: sha("schema"),
    cases: [], persistence: { write: { path: "/api/items", body: { text: "item" }, expected_status: 201, expected_json: { saved: true } },
      read: { path: "/api/items", expected_status: 200, expected_json: { items: [] } },
      after_restart_browser_program: { version: 3, contract_digest: capabilities.contract_digest,
        steps: [{ action: "navigate", page: "main", path: "/" }, { action: "assert_text", page: "main", selector: "body", text: "item" }] } } };
  let observation: ApplicationVerificationObservationV1 | undefined;
  let measurement: ReturnType<typeof readOriginalApplicationMeasurement> | undefined;
  controlled.execute.mockImplementation(async (actual: Parameters<typeof executeApplicationVerification>[0], input: Parameters<typeof executeApplicationVerification>[1]) => {
    expect(actual).toBe(selected); expect(input.run).toBe(run); expect(input.backend).toBe(backend); input.assertSubject();
    observation = ApplicationVerificationObservationV1Schema.parse({ version: 1, scope: "local-development-api-browser-reopen", stage: "validation",
      run_id: runStart.run_id, request_id: "request", origin_run_id: runStart.run_id, origin_request_id: "request", qualified_for_product: false,
      candidate: { version: 1, subject_digest: input.subject.digest, source_digest: sha("source"), artifact_digest: sha("artifact"),
        toolchain_digest: saved.toolchainDigest, package_digest: sha("package"), schema_digest: sha("schema"), qualified_for_product: false },
      acceptance: { version: 1, cases: [{ case_id: "controlled-case", program_digest: sha("program"), trace_digest: sha("trace"), assertions: 1,
        capture_digests: [sha("capture")] }], persistence: { request_digest: sha("write"), before_read_digest: sha("read"), after_read_digest: sha("read"),
        replay_response_digest: sha("write"), after_replay_read_digest: sha("read"), browser_trace_digest: sha("browser") },
        closures: { compiler: true, initialize: true, services: 2, browser: true }, test_store_id: "00000000-0000-4000-8000-000000000001" } });
    measurement = Object.freeze({ profile: actual, candidate: Object.freeze({}) as PreparedApplicationVerificationCandidate,
      backend, nodeId: run.nodeId, runStart, runSnapshot: JSON.stringify(runStart), observationSnapshot: JSON.stringify(observation),
      definition, deadline: controlled.now + 1000 });
    return observation;
  });
  let firstMeasurementRead = true;
  controlled.original.mockImplementation((actual: Parameters<typeof readOriginalApplicationMeasurement>[0], supplied: ApplicationVerificationObservationV1,
    suppliedRun: ApplicationVerificationRun) => {
    if (!measurement || actual !== selected || supplied !== observation || suppliedRun.nodeId !== run.nodeId || suppliedRun.runStart !== runStart
      || JSON.stringify(suppliedRun.runStart) !== measurement.runSnapshot || JSON.stringify(supplied) !== measurement.observationSnapshot)
      throw Error("Controlled original application measurement required");
    // Arm only the real final assertVerificationSubject, after the original
    // measurement has returned. Earlier preparation and getter audits stay real.
    if (firstMeasurementRead) { firstMeasurementRead = false; controlled.pendingFinalAudit = true; }
    return measurement;
  });
  const controller = new AbortController();
  return { profile, raw, selected, run, context, workspace, source, controller,
    observation: () => observation!, measurement: () => measurement!,
    verify: () => runVerification(profile, "request", controller.signal, context, undefined, undefined, run) };
}

describe("final application verification provenance (controlled boundaries, not native acceptance)", () => {
  function publicationFixture() {
    const f = fixture(), request = applicationPublicationRequestFixture(), app = f.profile.capabilities!.application!;
    const capabilities = structuredClone(request.capabilities);
    Object.assign(capabilities.binding, { verification_profile_id: f.profile.id, verification_profile_digest: f.profile.digest,
      application_config_digest: app.config_digest, application_contract_digest: app.contract_digest });
    delete f.context.app_delivery; f.context.app_publication = request.authorization.grant;
    f.context.application_publication = { version: 1, authorization: request.authorization, capabilities, publisher_session_id: "session",
      agent_id: "author-agent", agent_instance_id: f.run.runStart.agent_instance_id };
    f.run.runStart.verification!.application_publication = { version: 1, authorization_event_id: request.authorization.event_id,
      publication_profile_id: capabilities.binding.publication_profile_id, publication_profile_digest: capabilities.binding.publication_profile_digest,
      publication_contract_digest: capabilities.binding.publication_contract_digest, publisher_session_id: "session" };
    f.run.runStart.verification!.capability_binding = { version: 1, profile_digest: f.profile.digest,
      checks: f.profile.capabilities!.checks.map(({ command_id, config_digest, contract_digest }) => ({ command_id, config_digest, contract_digest })) };
    return f;
  }
  it("routes only the separately bound original publication intent and never stamps static export authority", async () => {
    const f = publicationFixture();
    expect(selectVerificationProfile(f.run.runStart, [f.profile], false, undefined, "node")).toBe(f.profile);
    const result = await f.verify(); expect(result.outcome).toBe("passed"); expect(controlled.execute).toHaveBeenCalledOnce();
    expect(readFinalApplicationVerificationBinding(f.profile, result, f.run)).toBe(f.measurement());
    expect(() => assertFinalVerificationExportBinding(f.profile, result, "request", f.context)).toThrow(/original completed final/);
  });
  it.each(["grant", "instance", "computer", "profile", "config", "event", "session", "mixed-intent", "legacy-companion"] as const)
    ("rejects changed publication %s at the protected verifier selection boundary", changed => {
      const f = publicationFixture(), payload = structuredClone(f.run.runStart), context = payload.context_pack.payload!, intent = context.application_publication!;
      if (changed === "grant") context.app_publication!.publication_profile_id = "other";
      if (changed === "instance") intent.agent_instance_id = "other";
      if (changed === "computer") intent.capabilities.binding.computer_id = "other";
      if (changed === "profile") intent.capabilities.binding.verification_profile_digest = sha("other profile");
      if (changed === "config") intent.capabilities.binding.application_config_digest = sha("other config");
      if (changed === "event") payload.verification!.application_publication!.authorization_event_id = "other";
      if (changed === "session") payload.verification!.application_publication!.publisher_session_id = "other";
      if (changed === "mixed-intent" || changed === "legacy-companion") context.app_delivery = { version: 1, kind: "local-application-development" };
      if (changed === "legacy-companion") delete context.app_publication;
      expect(() => selectVerificationProfile(payload, [f.profile], false, undefined, "node")).toThrow();
      expect(controlled.command).not.toHaveBeenCalled(); expect(controlled.execute).not.toHaveBeenCalled();
    });
  it("stamps only the actual successful runVerification result after its final source audit", async () => {
    const f = fixture(), result = await f.verify();
    expect(result.outcome).toBe("passed"); expect(result.application).toBe(f.observation());
    expect(controlled.command).toHaveBeenCalledOnce(); expect(controlled.execute).toHaveBeenCalledOnce(); expect(controlled.finalAudit).toHaveBeenCalledOnce();
    expect(readPreparedApplicationVerificationProfile(f.profile)).toBe(f.selected);
    expect(readFinalApplicationVerificationBinding(f.profile, result, f.run)).toBe(f.measurement());
    // A wrapper has no separate authority; the original node and run.start object do.
    expect(readFinalApplicationVerificationBinding(f.profile, result, { ...f.run })).toBe(f.measurement());
  });

  it("rejects cloned result/profile/run objects and changed evidence before consulting inner provenance", async () => {
    const f = fixture(), result = await f.verify(); expect(result.outcome).toBe("passed");
    controlled.original.mockClear();
    expect(() => readFinalApplicationVerificationBinding(f.profile, structuredClone(result), f.run)).toThrow(/original completed/);
    expect(() => readFinalApplicationVerificationBinding({ ...f.profile }, result, f.run)).toThrow(/locally prepared/);
    expect(() => readFinalApplicationVerificationBinding(f.profile, result, { ...f.run, runStart: structuredClone(f.run.runStart) })).toThrow(/original completed/);
    expect(() => readFinalApplicationVerificationBinding(f.profile, result, { ...f.run, nodeId: "other-node" })).toThrow(/original completed/);
    result.reason = "rewritten evidence";
    expect(() => readFinalApplicationVerificationBinding(f.profile, result, f.run)).toThrow(/original completed/);
    delete result.reason;
    f.run.runStart.policy_snapshot.filesystem_write_scope.push("changed-snapshot");
    expect(() => readFinalApplicationVerificationBinding(f.profile, result, f.run)).toThrow(/original completed/);
    f.run.runStart.policy_snapshot.filesystem_write_scope.pop();
    expect(controlled.original).not.toHaveBeenCalled();
    expect(readFinalApplicationVerificationBinding(f.profile, result, f.run)).toBe(f.measurement());
  });

  it("requires inner original observation identity even when a nested replacement has identical JSON", async () => {
    const f = fixture(), result = await f.verify(); expect(result.outcome).toBe("passed");
    controlled.original.mockClear(); result.application = structuredClone(f.observation());
    expect(() => readFinalApplicationVerificationBinding(f.profile, result, f.run)).toThrow(/Controlled original application measurement/);
    expect(controlled.original).toHaveBeenCalledOnce();
  });

  it("rechecks the measured source when reading a previously stamped result", async () => {
    const f = fixture(), result = await f.verify(); expect(result.outcome).toBe("passed");
    controlled.original.mockClear(); writeFileSync(f.source, "changed after successful verification");
    expect(() => readFinalApplicationVerificationBinding(f.profile, result, f.run)).toThrow(/source changed since the verified run/);
    expect(controlled.original).not.toHaveBeenCalled();
  });

  it.each(["abort", "deadline", "source", "context"] as const)("cannot stamp when %s changes during the final audit", async mode => {
    const f = fixture();
    controlled.finalAudit.mockImplementationOnce(() => {
      if (mode === "abort") f.controller.abort(Error("Controlled abort during final source audit"));
      if (mode === "deadline") controlled.now = f.measurement().deadline;
      if (mode === "source") writeFileSync(f.source, "changed inside final source audit");
      if (mode === "context") f.context.task.title = "changed inside final source audit";
    });
    const result = await f.verify();
    expect(controlled.execute).toHaveBeenCalledOnce(); expect(controlled.original).toHaveBeenCalledOnce(); expect(controlled.finalAudit).toHaveBeenCalledOnce();
    expect(result.outcome).toBe(mode === "abort" ? "cancelled" : "failed");
    expect(result).not.toHaveProperty("application"); expect(result.checks.every(check => check.observation === undefined)).toBe(true);
    expect(result.reason).toMatch(mode === "abort" ? /Controlled abort/ : mode === "deadline" ? /original deadline elapsed during final audit/
      : mode === "source" ? /source changed since the verified run/ : /context changed during final audit/);
    // Restoring source/context and copying successful-looking fields cannot
    // manufacture the private final stamp that was withheld at this boundary.
    writeFileSync(f.source, sourceBytes); f.context.task.title = "Controlled finalization"; controlled.now = 100;
    result.outcome = "passed"; result.application = f.observation(); delete result.reason;
    controlled.original.mockClear();
    expect(() => readFinalApplicationVerificationBinding(f.profile, result, f.run)).toThrow(/original completed application verification/);
    expect(controlled.original).not.toHaveBeenCalled();
  });
});
