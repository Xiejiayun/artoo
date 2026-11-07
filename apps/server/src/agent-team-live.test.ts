import { createHash, randomUUID } from "node:crypto";
import { accessSync, appendFileSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { agentInstances, agents, assistantTurns, autonomousReviews, computers, contextPacks, discussions, eventLog, messages, productDesignRevisions, productReleaseHealthReports, runs, tasks } from "@artoo/db";
import { AutonomousPlanningRequestV1Schema, BrowserOperationTraceV3Schema, canonicalMeasurementPlanV2, canonicalReleaseAcceptanceBinding,
  canonicalReleaseJson, ContextPackSchema, MeasurementPlanPolicyV2Schema, ProductDesignV2Schema, ProductReleaseHealthReportSchema, ProductResearchReportSchema,
  ProductValidationReportV2Schema, RunVerificationPayloadSchema, type RunVerificationPayload } from "@artoo/domain";
import type { NodeClient, VerificationProfile, ReleaseProfile } from "@artoo/artood";
import { createInProcessChannel } from "@artoo/testkit";
import { and, desc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { attachNodeBinding, type NodeBinding } from "./node-binding.js";
import { authorizeLiveSmokeSharing } from "./live-sharing-test-support.js";
import { createGoalAutomationDispatcher, getGoalAutomation } from "./services/goal-automation-service.js";
import { createDiscussionDispatcher } from "./services/discussion-service.js";
import { createAssistantDispatcher } from "./services/assistant-service.js";
import { createProductReleaseDispatcher, getGoalProductRelease } from "./services/product-release-service.js";
import { readRunVerificationEvidence } from "./services/verification-service.js";
import { recordHeartbeatRuntimes } from "./services/runtime-registry-service.js";
import { buildTestServer, type TestServer } from "./test-support.js";
import { cleanupLiveAcceptance, contextPageMetadataFromCodexOutput, createCodexToolMetadataCollector, createLiveAcceptanceReportWriter } from "./live-acceptance-test-support.js";

import { createLiveReviewDiagnostics, readLiveReviewDiagnosticRows } from "./live-review-diagnostics-test-support.js";

const enabled = process.env.ARTOO_AGENT_TEAM_LIVE === "1";
// A fresh invocation may budget for design revision and its additional independent
// review. Previously recorded invocations keep their original fixed 45 minutes.
const configuredMinutes = process.env.ARTOO_AGENT_TEAM_TIMEOUT_MINUTES ?? "45";
if (enabled && !["45", "90"].includes(configuredMinutes)) throw new Error("Live Agent Team timeout must be 45 or 90 minutes");
const duration = (configuredMinutes === "90" ? 90 : 45) * 60_000;
const acceptanceViewports = [320, 390, 768, 1280].map(width => ({ id: `width-${width}`, width, height: 900 }));
const measurementPolicy = MeasurementPlanPolicyV2Schema.parse({ version: 2, coverage: "every-must-criterion",
  methods: ["workspace-check", "configured-static-release"] });
const defaultObjective = "Build a responsive, accessible browser-only personal journal. Users can create, edit, delete and search entries; entries survive a page reload using local browser storage. Include useful empty states, confirmation before deletion and clear error feedback. Deliver a self-contained static product with no backend or CDN dependencies. Research current authoritative browser documentation, design the user flows, implement and test the complete product, and publish it to the configured endpoint.";

function safeMessage(error: unknown): string {
  let result = error instanceof Error ? error.message : String(error);
  for (const [name, value] of Object.entries(process.env)) if (value && value.length >= 6 && /key|token|secret|password|credential/i.test(name)) result = result.replaceAll(value, "[redacted]");
  return result.slice(0, 2000);
}
async function unusedPort(): Promise<number> {
  const listener = createServer(); await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((done) => listener.close(() => done())); return port;
}

// Real external providers and actual filesystem/browser/HTTP execution. The database,
// authenticated node identity and transport are isolated fixtures, not a public deployment.
describe.skipIf(!enabled)("gated live Agent Team product development", () => {
  let server: TestServer | undefined, node: NodeClient | undefined, binding: NodeBinding | undefined;
  let serverInitialization: Promise<TestServer> | undefined;
  let directory: string | undefined, output: string | undefined;
  let report: Record<string, unknown> = {};
  let reportWriter: ReturnType<typeof createLiveAcceptanceReportWriter> | undefined;
  let reviewDiagnostics: ReturnType<typeof createLiveReviewDiagnostics> | undefined;
  let toolMetadata: ReturnType<typeof createCodexToolMetadataCollector> | undefined;
  let metadataOutput: string | undefined, metadataWriteFailed = false;
  let metadataBytes = 0, metadataRecords = 0, metadataTruncated = false, nodeMetadataCount = 0, nodeMetadataDropped = 0;
  let cleanupStarted = false;
  const refreshMetadata = () => {
    if (reviewDiagnostics) report.review_diagnostics = reviewDiagnostics.snapshot();
    if (toolMetadata && metadataOutput) report.tool_metadata = { ...toolMetadata.snapshot(),
      journal_file: basename(metadataOutput), journal_bytes: metadataBytes, journal_records: metadataRecords,
      journal_truncated: metadataTruncated, journal_write_failed: metadataWriteFailed,
      node_event_records: nodeMetadataCount, node_event_records_dropped: nodeMetadataDropped,
      node_event_scope: "Local receive times; verification check durations cover owned subprocesses, not the complete verifier or provider. Lifecycle completion follows final node verification." };
  };
  const saveProgress = () => {
    refreshMetadata(); reportWriter?.progress(report);
    if (metadataWriteFailed) throw new Error("Live diagnostic metadata journal could not be written");
  };
  const appendMetadata = (metadata: Record<string, unknown>) => {
    if (!metadataOutput || metadataWriteFailed || reportWriter?.finalized) return;
    // Append only the explicit safe projection, never the incoming transport/CLI object.
    const line = `${JSON.stringify(metadata)}\n`, bytes = Buffer.byteLength(line);
    if (metadataTruncated || metadataBytes + bytes > 16 * 1024 * 1024) { metadataTruncated = true; return; }
    try { appendFileSync(metadataOutput, line, "utf8"); metadataBytes += bytes; metadataRecords++; }
    catch { metadataWriteFailed = true; } // The test loop/cleanup fails; transport delivery still proceeds.
  };
  const dispatchers: { stop(): Promise<void> }[] = [];
  afterEach(async () => {
    cleanupStarted = true;
    report.cleanup_passed = false;
    const cleanup = await cleanupLiveAcceptance({
      stopDispatchers: dispatchers.splice(0).map((dispatcher) => () => dispatcher.stop()),
      stopNode: () => node?.stop(true), drainBinding: () => binding?.drain(),
      closeBinding: () => binding?.close(), closeServer: async () => {
        // A timed-out test may still be creating this resource. Keep it owned
        // until initialization and closure both settle, or retain the workspace.
        const initialized = await serverInitialization;
        // Bounded SELECT-only diagnostics share the existing server-close deadline.
        // Always attempt closure, including after diagnostic timeout or failure.
        try { await reviewDiagnostics?.capture("cleanup"); }
        finally { await (server ?? initialized)?.close(); }
      },
      finalized: () => reportWriter?.finalized === true, describeError: safeMessage,
      removeWorkspace: () => {
        if (!directory) return;
        const target = realpathSync.native(directory), parent = realpathSync.native(tmpdir());
        if (!target.startsWith(`${parent}${sep}artoo-agent-team-live-`)) throw new Error("Refusing cleanup outside the isolated live workspace");
        // Snapshots are sealed read-only. This only touches the verified temporary test root after process closure.
        const writable = (path: string): void => {
          const stat = lstatSync(path); if (stat.isSymbolicLink()) return;
          chmodSync(path, stat.isDirectory() ? 0o700 : 0o600);
          if (stat.isDirectory()) for (const entry of readdirSync(path)) writable(join(path, entry));
        };
        writable(target); rmSync(target, { recursive: true, force: true });
      },
    });
    report.cleanup = cleanup;
    report.cleanup_passed = cleanup.passed;
    if (!cleanup.workspace_removed && directory) report.retained_workspace = directory;
    try { saveProgress(); }
    catch (error) {
      cleanup.errors.push({ step: "report.save", error: safeMessage(error) });
      cleanup.passed = false; report.cleanup_passed = false;
    }
    if (!cleanup.passed) throw new AggregateError(cleanup.errors.map((failure) => new Error(`${failure.step}: ${failure.error}`)), "Live acceptance cleanup was not confirmed");
  }, 120_000);

  it("takes one objective from an empty workspace through real contributors, independent review and a healthy endpoint", async (testContext) => {
    const assertActive = () => {
      testContext.signal.throwIfAborted();
      if (metadataWriteFailed) throw new Error("Live diagnostic metadata journal could not be written");
      if (cleanupStarted || reportWriter?.finalized) throw new Error("Live acceptance has already entered cleanup");
    };
    const errors: string[] = [], validationHistory: { observed_at: string; error: string }[] = [];
    const capturePlanningDiagnostics = async () => {
      // Explicit local opt-in: bounded planning excerpts, never authentication or source files.
      if (!server || process.env.ARTOO_AGENT_TEAM_DIAGNOSTICS !== "1" || typeof report.goal_id !== "string") return;
      const [discussion] = await server.db.db.select().from(discussions).where(eq(discussions.goalId, report.goal_id));
      if (discussion) report.planning_diagnostics = (await server.db.db.select({ id: messages.id, body: messages.body })
        .from(messages).where(and(eq(messages.taskId, discussion.taskId), eq(messages.actorType, "agent"), eq(messages.kind, "text")))
        .orderBy(desc(messages.createdAt), desc(messages.id)).limit(4))
        .map(({ id, body }) => ({ message_id: id, response_length: body.length, response_excerpt: safeMessage(body) }));
    };
    const reportRoot = resolve("artifacts/live"); mkdirSync(reportRoot, { recursive: true });
    output = join(reportRoot, `agent-team-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}.json`);
    report = { checked_at: new Date().toISOString(), passed: false, pipeline_passed: false, cleanup_passed: false, transport: "in-process authenticated identity fixture",
      publication_scope: "local HTTP static product; endpoint exists only during this isolated test", pipeline_timeout_minutes: duration / 60000 };
    reportWriter = createLiveAcceptanceReportWriter((snapshot) => {
      // Atomic replacement leaves the prior provisional report intact if saving fails.
      const temporary = `${output!}.${randomUUID()}.tmp`;
      try { writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: "wx" }); renameSync(temporary, output!); }
      finally { if (existsSync(temporary)) rmSync(temporary); }
    });
    reviewDiagnostics = createLiveReviewDiagnostics({
      read: () => server && typeof report.goal_id === "string"
        ? readLiveReviewDiagnosticRows(server.db.db, { organizationId: server.ctx.organizationId, goalId: report.goal_id })
        : Promise.resolve({ rows: [], truncated: false }),
      redact: safeMessage, finalized: () => reportWriter?.finalized === true,
    });
    testContext.onTestFinished(({ task, signal }) => {
      if (report.cleanup_passed !== true && directory) report.retained_workspace = directory;
      refreshMetadata();
      reportWriter!.finish(report, task.result?.state, signal.aborted);
    });
    saveProgress();
    try {
      // Register report finalization before journal creation, so a failed open is
      // recorded just like a later failed append instead of losing diagnostics.
      if (process.env.ARTOO_AGENT_TEAM_DIAGNOSTICS === "1") {
        toolMetadata = createCodexToolMetadataCollector();
        metadataOutput = output.replace(/\.json$/, ".tool-metadata.jsonl");
        try { writeFileSync(metadataOutput, "", { flag: "wx", mode: 0o600 }); }
        catch { metadataWriteFailed = true; }
      }
      assertActive();
      if (!["linux", "darwin", "win32"].includes(process.platform)) throw new Error("Live Agent Team acceptance requires a supported native verification worker");
      const runtime = process.env.ARTOO_AGENT_TEAM_RUNTIME ?? "codex";
      if (runtime !== "codex" && runtime !== "claude-code") throw new Error("ARTOO_AGENT_TEAM_RUNTIME must be codex or claude-code");
      report.runtime = runtime;
      const browser = process.env.ARTOO_AGENT_TEAM_BROWSER_EXECUTABLE;
      if (!browser || !isAbsolute(browser) || !lstatSync(browser).isFile()) throw new Error("Set ARTOO_AGENT_TEAM_BROWSER_EXECUTABLE to an installed native Chromium executable");
      accessSync(browser, constants.X_OK);
      const built = resolve("apps/artood/dist"), acceptanceCli = join(built, "web-acceptance-cli.js");
      if (!["index.js", "research-mcp.js", "web-acceptance-cli.js"].every((file) => existsSync(join(built, file)))) throw new Error("Build the workspace before enabling the live test");
      const worker = await import(pathToFileURL(join(built, "index.js")).href) as typeof import("../../artood/src/index.js");
      const uploader = await import(pathToFileURL(join(built, "artifact-upload.js")).href) as typeof import("../../artood/src/artifact-upload.js");
      const verifierRuntime = await import(pathToFileURL(join(built, "verification.js")).href) as typeof import("../../artood/src/verification.js");
      const resolver = await import(pathToFileURL(join(built, "cli-resolver.js")).href) as typeof import("../../artood/src/cli-resolver.js");
      const daemon = await import(pathToFileURL(join(built, "main.js")).href) as typeof import("../../artood/src/main.js");
      assertActive();
      // Reuse the production validator without importing unrelated daemon/node
      // configuration into this isolated acceptance workspace.
      const codex = runtime === "codex" ? daemon.loadConfigFromEnv({
        ARTOO_NODE_URL: "ws://127.0.0.1", ARTOO_NODE_ID: "isolated_live", ARTOO_ALLOWED_ROOTS: realpathSync.native(process.cwd()),
        ARTOO_CODEX_BINARY: process.env.ARTOO_CODEX_BINARY, ARTOO_CODEX_MODEL: process.env.ARTOO_CODEX_MODEL,
        ARTOO_CODEX_PROVIDER_URL: process.env.ARTOO_CODEX_PROVIDER_URL, ARTOO_CODEX_PROVIDER_KEY: process.env.ARTOO_CODEX_PROVIDER_KEY,
      }).codex : undefined;
      report.model = codex?.model ?? "CLI configured default";
      if (codex?.baseUrl) report.provider_origin = new URL(codex.baseUrl).origin;
      if (!resolver.runtimeAvailable(runtime, codex?.binaryPath) || !resolver.resolveCliCommand("git")) throw new Error("Install the selected native CLI and Git, and configure its provider before live acceptance");
      directory = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-agent-team-live-")));
      const workspace = join(directory, "workspace"), releaseRoot = join(directory, "releases"), researchRoot = join(directory, "research"), browserEvidence = join(directory, "browser-evidence"), artifactRoot = join(directory, "retained-artifacts");
      for (const path of [workspace, releaseRoot, researchRoot, browserEvidence, artifactRoot]) mkdirSync(path, { mode: 0o700 });
      expect(readdirSync(workspace)).toEqual([]);
      const verifierConfig = join(directory, "acceptance.json");
      writeFileSync(verifierConfig, JSON.stringify({ browser_executable: realpathSync.native(browser), evidence_root: browserEvidence,
        ...(process.platform === "win32" ? { windows_browser_process: { version: 1 } } : {}),
        action_timeout_ms: 5000, browser_program: { version: 3, viewports: acceptanceViewports },
        storage_fault: { version: 1 }, storage_precondition: { version: 1 }, design_capture_cases: true }), { mode: 0o400 });
      const verificationProfile: VerificationProfile = { id: "default", project_id: "proj_artoo", workspace_root: workspace,
        commands: [{ id: "browser-acceptance", argv: [process.execPath, acceptanceCli, verifierConfig], timeout_ms: 300_000,
          observation: { format: "static-web-acceptance.v3", evidence_root: browserEvidence, capabilities: { version: 1 } } }],
        measurement_plan_policy: measurementPolicy, required_files: [], subject_paths: ["product", ".artoo/product"] };
      const preparedVerifier = worker.prepareVerificationProfiles([verificationProfile], [workspace])[0]!;
      if (process.platform === "win32") {
        const bundle = process.env.ARTOO_WINDOWS_PROCESS_BUNDLE, manifestSha256 = process.env.ARTOO_WINDOWS_PROCESS_MANIFEST_SHA256;
        if (!bundle || !manifestSha256) throw new Error("Native Windows live acceptance requires the exact protected helper bundle and manifest digest");
        // Use the production installation admission, including all writable roots.
        // A test callback or a fabricated capability cannot enable this path.
        const backend = worker.prepareWindowsProcessInstallation({ directory: bundle, manifestSha256, writableWorkspaceRoots: [workspace] });
        worker.attachWindowsVerificationBackend(preparedVerifier, backend);
        report.windows_process_installation = { directory: bundle, manifest_sha256: manifestSha256, qualified: true };
        report.windows_browser_process = { version: 1, isolation: "native-job", private_context_binding: "node-environment-sha256" };
      }
      const capabilities = preparedVerifier.capabilities!;
      expect(capabilities).toBeDefined();
      report.verification_capabilities = capabilities;
      const port = await unusedPort();
      assertActive();
      const releaseProfile: ReleaseProfile = { id: "default", project_id: "proj_artoo", verification_profile_id: "default",
        storage_root: releaseRoot, output_path: "product", public_url: `http://127.0.0.1:${port}`,
        listen_host: "127.0.0.1", listen_port: port, health_checks: [{ path: "/" }], health_timeout_ms: 10000,
        criterion_acceptance: { version: 1 } };
      const windowsStorage = process.platform === "win32" ? await (async () => {
        const storage = await import(pathToFileURL(join(built, "windows-release-storage.js")).href) as typeof import("../../artood/src/windows-release-storage.js");
        return new Map([[releaseRoot, storage.prepareWindowsReleaseStorage({ directory: releaseRoot, writableWorkspaceRoots: [workspace] })]]);
      })() : undefined;
      const preparedRelease = worker.prepareReleaseProfiles([releaseProfile], [preparedVerifier], { windowsStorage })[0]!;
      const releaseCapabilities = worker.readReleaseCapabilities(preparedRelease)!;
      expect(releaseCapabilities).toBeDefined();
      report.release_capabilities = releaseCapabilities;
      serverInitialization = buildTestServer({ workspaceRoot: workspace, artifactDir: artifactRoot });
      const initializedServer = await serverInitialization;
      // Vitest timeouts abort the test, not the underlying initialization promise.
      // afterEach owns the pending promise even if this await resumes after it.
      assertActive();
      server = initializedServer;
      // Retain real bytes through the production uploader and authenticated artifact
      // route. Source metadata alone cannot supply an accepted revision baseline.
      const artifactAddress = await server.app.listen({ host: "127.0.0.1", port: 0 });
      assertActive();
      const artifactNodeUrl = new URL("/api/v1/node", artifactAddress);
      artifactNodeUrl.protocol = "ws:";
      if (!server.ctx.deviceAuth.devNodeToken) throw new Error("Live artifact fixture requires its isolated development node credential");
      artifactNodeUrl.searchParams.set("token", server.ctx.deviceAuth.devNodeToken);
      const uploadArtifact = uploader.createArtifactUploader(artifactNodeUrl.href, "computer_local_mock");
      report.artifact_retention = { transport: "production uploader and authenticated loopback HTTP route", scope: "bounded content-addressed bytes retained outside the product workspace" };
      server.ctx.clock = { now: () => new Date(), nowIso: () => new Date().toISOString() };
      await authorizeLiveSmokeSharing(server.ctx);
      const registration = (runtime === "codex" ? worker.codexRuntime : worker.claudeCodeRuntime)({ allowedRoots: [workspace], artifacts: [],
        ...(codex ? { codex } : {}),
        initializeRepository: true, research: { receiptDirectory: researchRoot,
          ...(process.env.ARTOO_RESEARCH_BRAVE_KEY_ENV ? { braveApiKeyEnv: process.env.ARTOO_RESEARCH_BRAVE_KEY_ENV } : {}) } });
      expect(registration.capabilities).toEqual(expect.arrayContaining(["code.modify", "code.review", "research.web"]));
      await server.db.db.update(computers).set({ os: process.platform, status: "online", lastHeartbeatAt: server.ctx.clock.nowIso() });
      await server.db.db.update(agents).set({ kind: "coding", capabilities: [...registration.capabilities!] });
      await server.db.db.update(agentInstances).set({ runtime, modelProfileId: null, effortProfileId: null, status: "idle" });
      const [agent] = await server.db.db.select().from(agents), [instance] = await server.db.db.select().from(agentInstances);
      for (const [index, kind] of ["planner", "reviewer", "qa"].entries()) {
        const id = `agent_live_${index}`;
        await server.db.db.insert(agents).values({ ...agent!, id, displayName: `Live team ${kind}`, kind });
        await server.db.db.insert(agentInstances).values({ ...instance!, id: `instance_live_${index}`, agentId: id });
      }
      assertActive();
      const channel = createInProcessChannel();
      const contextDelivery: Record<string, unknown>[] = [];
      report.context_delivery = { scope: "Local Codex MCP result metadata; does not establish downstream display or model comprehension", pages: contextDelivery };
      node = worker.createNodeClient({ nodeId: "computer_local_mock", transport: { ...channel.node, send: async (message) => {
        if (toolMetadata && message.kind === "run.event" && !reportWriter?.finalized) {
          const received = { run_id: message.run_id, sequence: message.sequence,
            received_at: new Date().toISOString(), received_monotonic_ms: performance.now() };
          if (runtime === "codex" && message.event.type === "run.output" && message.event.payload.stream === "stdout") {
            const metadata = toolMetadata.record(received, message.event.payload.text);
            if (metadata) appendMetadata({ kind: "cli-mcp", ...metadata });
          } else if (message.event.type === "run.lifecycle" || message.event.type === "run.verification") {
            if (nodeMetadataCount >= 4096) nodeMetadataDropped++;
            else {
              nodeMetadataCount++;
              if (message.event.type === "run.lifecycle") {
                appendMetadata({ kind: "node-lifecycle", ...received, phase: message.event.payload.phase });
              } else {
                const measured = message.event.payload;
                appendMetadata({ kind: "node-verification", ...received,
                  request_id: /^verify_[0-9]+$/.test(measured.request_id) ? measured.request_id : undefined,
                  outcome: measured.outcome, check_count: measured.checks.length,
                  checks: measured.checks.slice(0, 64).map((check, index) => ({ index, duration_ms: check.duration_ms,
                    exit_code: check.exit_code, ...(check.observation ? { stage: check.observation.stage,
                      scope: check.observation.scope, case_count: check.observation.cases.length } : {}) })) });
              }
            }
          }
        }
        if (runtime === "codex" && message.kind === "run.event" && message.event.type === "run.output"
          && message.event.payload.stream === "stdout" && contextDelivery.length < 4096) {
          const page = contextPageMetadataFromCodexOutput(message.event.payload.text);
          if (page) contextDelivery.push({ run_id: message.run_id, ...page });
        }
        await channel.node.send(message);
      } }, adapter: registration.adapter,
        workspace: { allowedRoots: [workspace] }, uploadArtifact, verificationProfiles: [preparedVerifier], releaseProfiles: [preparedRelease] });
      node.start(); await node.ready();
      assertActive();
      const revisionSupported = verifierRuntime.productDesignRevisionVerificationSupported(preparedVerifier);
      report.design_revision_supported = revisionSupported;
      binding = attachNodeBinding(server.ctx, channel.serverTransport, "computer_local_mock", ["run-verification.v1", "product-stage-verification.v1", "verification-capabilities.v1",
        worker.MEASUREMENT_PLAN_FEATURE, worker.MEASUREMENT_PLAN_V2_FEATURE, "product-release.static.v1", worker.PRODUCT_RELEASE_ACCEPTANCE_FEATURE,
        ...(revisionSupported ? ["product-design-revision.v1"] : [])], () => true,
        [{ profile_id: "default", project_id: "proj_artoo", workspace_root: workspace, capabilities }],
        [{ profile_id: "default", project_id: "proj_artoo", workspace_root: workspace, verification_profile_id: "default", target_kind: "static_site", capabilities: releaseCapabilities }]);
      server.nodeRegistry.register("computer_local_mock", binding);
      const stopProcess = async (_ctx: unknown, runId: string) => binding!.dispatchRunStop(runId);
      const onError = (error: unknown) => { if (errors.length < 50) errors.push(safeMessage(error)); };
      const goalWorker = createGoalAutomationDispatcher(server.ctx, stopProcess, onError);
      const planning = createDiscussionDispatcher(server.ctx, stopProcess, onError);
      const assistant = createAssistantDispatcher(server.ctx, onError);
      const publishing = createProductReleaseDispatcher(server.ctx, onError);
      dispatchers.push(goalWorker, planning, assistant, publishing);
      const heartbeat = () => recordHeartbeatRuntimes(server!.ctx, "computer_local_mock", [{ runtime, status: "available", capabilities: [...registration.capabilities!] }]);
      await heartbeat();
      assertActive();
      const created = await server.app.inject({ method: "POST", url: "/api/v1/autonomous-goals", headers: { "idempotency-key": randomUUID() },
        payload: { project_id: "proj_artoo", objective: process.env.ARTOO_AGENT_TEAM_OBJECTIVE ?? defaultObjective,
          execution_mode: "agent_team", verification_profile_id: "default", release_profile_id: "default", max_retries: 3 } });
      expect(created.statusCode, created.body).toBe(201);
      const goalId = created.json().goal.id as string; report.goal_id = goalId;
      const deadline = Date.now() + duration;
      let completed = false, previousProgress = "";
      while (Date.now() < deadline) {
        assertActive(); await heartbeat(); assertActive(); await binding.drain();
        for (const dispatcher of [goalWorker, planning, assistant, publishing]) { assertActive(); await dispatcher.pump(); }
        assertActive();
        const state = await getGoalAutomation(server.ctx, goalId);
        await reviewDiagnostics.capture("progress"); assertActive();
        if (state?.last_error && validationHistory.at(-1)?.error !== safeMessage(state.last_error) && validationHistory.length < 50) {
          validationHistory.push({ observed_at: new Date().toISOString(), error: safeMessage(state.last_error) });
          report.validation_history = validationHistory;
          await capturePlanningDiagnostics();
          console.info(`[live-agent-team] feedback: ${safeMessage(state.last_error)}`);
        }
        // Persist bounded state changes. review_diagnostics explicitly labels its
        // redacted structured-summary content and excludes raw prompts/CLI/tool output.
        const progress = { status: state?.status, last_error: state?.last_error ? safeMessage(state.last_error) : null,
          design_revisions: await server.db.db.select({ id: productDesignRevisions.id, state: productDesignRevisions.state,
            design_task_id: productDesignRevisions.designTaskId, requesting_review_id: productDesignRevisions.requestingReviewId,
            accepted_run_id: productDesignRevisions.acceptedRunId, accepted_evidence_id: productDesignRevisions.acceptedEvidenceId,
            accepted_review_id: productDesignRevisions.acceptedReviewId }).from(productDesignRevisions).where(eq(productDesignRevisions.goalId, goalId)),
          tasks: await server.db.db.select({ id: tasks.id, title: tasks.title, status: tasks.status }).from(tasks).where(eq(tasks.goalId, goalId)).limit(100),
          runs: await server.db.db.select({ id: runs.id, task: runs.taskId, status: runs.status }).from(runs).limit(100) };
        const signature = JSON.stringify({ ...progress, review_diagnostics: reviewDiagnostics.snapshot() });
        if (signature !== previousProgress) {
          previousProgress = signature;
          report.progress = { observed_at: new Date().toISOString(), ...progress };
          saveProgress();
          console.info(`[live-agent-team] ${state?.status}: ${progress.tasks.filter((task) => task.status === "done").length}/${progress.tasks.length} tasks done; ${progress.runs.filter((run) => run.status === "running").length} runs active`);
        }
        if (state?.status === "completed") { completed = true; break; }
        if (state && ["failed", "cancelled"].includes(state.status)) throw new Error(`Live team stopped: ${state.last_error ?? state.status}`);
        await new Promise((done) => setTimeout(done, 500));
      }
      if (!completed) throw new Error(`Live Agent Team exceeded ${duration / 60000} minutes; last errors: ${errors.slice(-3).join("; ")}`);
      await binding.drain();
      const automation = await getGoalAutomation(server.ctx, goalId), release = await getGoalProductRelease(server.ctx, goalId);
      expect(automation).toMatchObject({ status: "completed", execution_mode: "agent_team", delivery: "published_product" });
      expect(automation!.planning_capability_snapshot).toEqual({ version: 1, computer_id: automation!.computer_id,
        project_id: "proj_artoo", workspace_root: workspace, verification_profile_id: "default", capabilities,
        release: { version: 1, capabilities: releaseCapabilities } });
      const [planningDiscussion] = await server.db.db.select().from(discussions).where(and(
        eq(discussions.id, automation!.discussion_id!), eq(discussions.goalId, goalId),
        eq(discussions.organizationId, server.ctx.organizationId)));
      expect(planningDiscussion).toBeDefined();
      const planningRuns = await server.db.db.select({ turn: assistantTurns, run: runs }).from(assistantTurns)
        .innerJoin(runs, eq(runs.id, assistantTurns.runId)).where(and(
          eq(assistantTurns.organizationId, server.ctx.organizationId), eq(assistantTurns.taskId, planningDiscussion!.taskId),
          eq(runs.organizationId, server.ctx.organizationId), eq(runs.taskId, planningDiscussion!.taskId)));
      expect(planningRuns.some(({ run, turn }) => run.status === "completed" && turn.status === "completed")).toBe(true);
      for (const { turn, run } of planningRuns) {
        const [pack] = await server.db.db.select().from(contextPacks).where(and(
          eq(contextPacks.id, run.contextPackId!), eq(contextPacks.organizationId, server.ctx.organizationId),
          eq(contextPacks.runId, run.id), eq(contextPacks.taskId, run.taskId)));
        expect(pack).toBeDefined();
        const [request] = await server.db.db.select().from(messages).where(and(
          eq(messages.id, turn.userMessageId), eq(messages.organizationId, server.ctx.organizationId),
          eq(messages.taskId, planningDiscussion!.taskId)));
        expect(request).toBeDefined();
        const context = ContextPackSchema.parse(pack!.payload);
        const envelope = AutonomousPlanningRequestV1Schema.parse(JSON.parse(context.conversation!.current_request));
        expect(envelope.request).toBe(request!.body);
        expect(envelope.planning_capability_snapshot).toEqual(automation!.planning_capability_snapshot);
        expect(context.policy).toMatchObject({ execution_mode: "discussion", filesystem_write_scope: [] });
        expect(context.verification_capabilities).toBeUndefined();
        expect(context.release_capabilities).toBeUndefined();
        expect(context.product_development).toBeUndefined();
        expect(context.review_subject).toBeUndefined();
        expect(run.verificationRequirement).toBeNull();
      }
      expect(release).toMatchObject({ status: "published", receipt: { outcome: "published", endpoint: releaseProfile.public_url } });
      const planTasks = await server.db.db.select().from(tasks).where(and(eq(tasks.goalId, goalId), eq(tasks.sourcePlanId, automation!.plan_id!)));
      expect(planTasks.length).toBeGreaterThanOrEqual(4); expect(planTasks.every((task) => task.status === "done")).toBe(true);
      const completedRuns = await server.db.db.select({ run: runs }).from(runs).innerJoin(tasks, eq(tasks.id, runs.taskId))
        .where(and(eq(tasks.goalId, goalId), eq(tasks.sourcePlanId, automation!.plan_id!), eq(runs.status, "completed"))).limit(100);
      expect(new Set(completedRuns.map(({ run }) => run.agentInstanceId)).size).toBeGreaterThan(1);
      const measurements: { run_id: string; evidence_id: string; payload: RunVerificationPayload }[] = [];
      const stages = new Set<string>();
      for (const { run } of completedRuns) {
        const evidence = await readRunVerificationEvidence(server.ctx, server.db.db, run.id);
        if (evidence?.payload.outcome === "passed") measurements.push({ run_id: run.id, evidence_id: evidence.id, payload: RunVerificationPayloadSchema.parse(evidence.payload) });
        const [pack] = await server.db.db.select().from(contextPacks).where(eq(contextPacks.id, run.contextPackId!));
        const context = ContextPackSchema.parse(pack!.payload);
        const stage = context.product_development?.stage; if (stage) stages.add(stage);
        if (stage && evidence?.payload.outcome === "passed") {
          expect(context.verification_capabilities).toEqual({ ...capabilities, profile_id: "default" });
          expect(context.release_capabilities).toEqual(releaseCapabilities);
          expect(evidence.payload.measurement_plan).toMatchObject({ version: 2, claim: "declared-mapping-feasibility", scope: "final", policy: measurementPolicy });
          if (evidence.payload.measurement_plan?.version !== 2) throw new Error("Expected a version 2 publication-aware measurement summary");
          expect(evidence.payload.measurement_plan.pending_release.length).toBeGreaterThan(0);
          const observation = evidence.payload.checks.find((check) => check.id === "browser-acceptance")?.observation;
          const { command_id, config_digest, contract_digest } = capabilities.checks[0]!;
          expect(observation).toMatchObject({ scope: "final", stage, capability_binding: {
            version: 1, profile_digest: capabilities.profile_digest, command_id, config_digest, contract_digest,
          } });
          if (stage !== "research") {
            if (observation?.version !== 3) throw new Error("Expected the configured v3 live acceptance observation");
            expect([...new Map(observation.cases.map(item => [item.viewport.id, item.viewport])).values()]
              .sort((a, b) => a.width - b.width)).toEqual(acceptanceViewports);
            expect(observation.cases.every(item => item.assertions > 0 && !!item.trace_ref && item.captures.length > 0
              && item.captures.every(capture => !!capture.screenshot_ref))).toBe(true);
            expect(observation.evidence_bundle).toBeDefined();
          }
        }
      }
      expect([...stages].sort()).toEqual(["design", "implementation", "research", "validation"]);
      const designRevisions = await server.db.db.select().from(productDesignRevisions).where(eq(productDesignRevisions.goalId, goalId));
      for (const revision of designRevisions) {
        expect(revision.state).toBe("accepted");
        const measured = measurements.find(item => item.run_id === revision.acceptedRunId && item.evidence_id === revision.acceptedEvidenceId);
        expect(measured?.payload.product_design_revision).toMatchObject({ revision_id: revision.id, scope: "all-declared-workspace-design-cases" });
      }
      report.design_revision_execution = { exercised: designRevisions.length > 0, count: designRevisions.length,
        accepted_run_ids: designRevisions.map(revision => revision.acceptedRunId) };
      const reviews = await server.db.db.select().from(autonomousReviews).where(eq(autonomousReviews.goalId, goalId));
      const accepted = reviews.filter((review) => review.status === "accepted");
      expect(accepted.length).toBeGreaterThanOrEqual(planTasks.length);
      for (const revision of designRevisions) {
        expect(accepted.find(review => review.id === revision.acceptedReviewId)).toMatchObject({
          taskId: revision.designTaskId, subjectRunId: revision.acceptedRunId, evidenceId: revision.acceptedEvidenceId,
        });
      }
      const peerMeasurements: { review_id: string; run_id: string; evidence_id: string; subject_digest: string | null;
        payload: RunVerificationPayload; response_excerpt?: string }[] = [];
      for (const review of accepted) {
        const [subject] = await server.db.db.select().from(runs).where(eq(runs.id, review.subjectRunId));
        expect(review.reviewerInstanceId).not.toBe(subject!.agentInstanceId);
        const [peerTurn] = await server.db.db.select().from(assistantTurns).where(eq(assistantTurns.id, review.turnId));
        expect(peerTurn?.status).toBe("completed");
        const [peerRun] = await server.db.db.select().from(runs).where(and(eq(runs.id, peerTurn!.runId!), eq(runs.taskId, review.reviewTaskId), eq(runs.status, "completed")));
        expect(peerRun).toBeDefined();
        const peerEvidence = await readRunVerificationEvidence(server.ctx, server.db.db, peerRun!.id);
        expect(peerEvidence?.payload).toMatchObject({ outcome: "passed", subject_digest: review.subjectDigest });
        const subjectEvidence = await readRunVerificationEvidence(server.ctx, server.db.db, subject!.id);
        expect(peerEvidence!.payload.measurement_plan).toEqual(subjectEvidence!.payload.measurement_plan);
        expect(peerEvidence!.payload.product_design_revision).toEqual(subjectEvidence!.payload.product_design_revision);
        const [response] = process.env.ARTOO_AGENT_TEAM_DIAGNOSTICS === "1" && peerTurn?.responseMessageId
          ? await server.db.db.select({ body: messages.body }).from(messages).where(eq(messages.id, peerTurn.responseMessageId)) : [];
        peerMeasurements.push({ review_id: review.id, run_id: peerRun!.id, evidence_id: peerEvidence!.id, subject_digest: peerEvidence!.payload.subject_digest,
          payload: RunVerificationPayloadSchema.parse(peerEvidence!.payload),
          ...(response ? { response_excerpt: safeMessage(response.body) } : {}) });
      }
      expect(release!.request.run_id).toBe(release!.run_id);
      expect(release!.receipt!.request).toEqual(release!.request);
      expect(release!.receipt!.artifact_digest).toBe(release!.request.subject_digest);
      const releasedMeasurement = measurements.find(item => item.run_id === release!.run_id && item.evidence_id === release!.evidence_id);
      expect(releasedMeasurement).toBeDefined();
      expect(releasedMeasurement!.payload).toMatchObject({ outcome: "passed", request_id: release!.request.verification_request_id,
        profile_id: release!.request.verification_profile_id, profile_digest: release!.request.verification_profile_digest,
        subject_digest: release!.request.subject_digest });
      // Parse and hash the same immutable bytes actually selected for publication.
      const researchBytes = readFileSync(join(releaseRoot, "artifacts", release!.request.subject_digest.slice(7),
        "content", ".artoo/product/research.json"));
      const research = ProductResearchReportSchema.parse(JSON.parse(researchBytes.toString("utf8")));
      expect(research.sources.length).toBeGreaterThan(0);
      if (research.measurement_plan?.version !== 2) throw new Error("Published research must retain its version 2 measurement plan");
      const hash = (bytes: string | Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      const criterionCount = research.requirements.filter(item => item.priority === "must")
        .reduce((sum, item) => sum + item.acceptance_criteria.length, 0);
      expect(releasedMeasurement!.payload.measurement_plan).toMatchObject({ research: {
        path: ".artoo/product/research.json", checksum: hash(researchBytes), size: researchBytes.length },
        measurement_plan_digest: hash(canonicalMeasurementPlanV2(research.measurement_plan)),
        must_criterion_count: criterionCount, mapped_criterion_count: criterionCount });
      const acceptance = release!.request.acceptance_binding;
      expect(acceptance).toBeDefined();
      expect(acceptance!.plan.id).toBe(automation!.plan_id);
      expect(acceptance!.release_binding).toEqual(releaseCapabilities.binding);
      expect(acceptance!.research).toEqual({ path: ".artoo/product/research.json", checksum: hash(researchBytes), size: researchBytes.length });
      expect(acceptance!.measurement_plan_digest).toBe(hash(canonicalMeasurementPlanV2(research.measurement_plan)));
      const finalSummary = releasedMeasurement!.payload.measurement_plan;
      if (finalSummary?.version !== 2) throw new Error("Published source must retain its pending publication criteria");
      expect(acceptance!.criteria).toEqual(finalSummary.pending_release.map(({ requirement_id, criterion_index, criterion_digest, claim_id }) =>
        ({ requirement_id, criterion_index, criterion_digest, claim_id })));
      expect(release!.receipt!.acceptance).toEqual({ version: 1, scope: "node-http-point-in-time",
        binding_digest: hash(canonicalReleaseAcceptanceBinding(acceptance!)), settled_criteria: acceptance!.criteria });
      const immutableContent = join(releaseRoot, "artifacts", release!.request.subject_digest.slice(7), "content");
      const finalDesign = ProductDesignV2Schema.parse(JSON.parse(readFileSync(join(immutableContent, ".artoo/product/design.json"), "utf8")));
      const finalValidation = ProductValidationReportV2Schema.parse(JSON.parse(readFileSync(join(immutableContent, ".artoo/product/validation.json"), "utf8")));
      const releaseCases = finalDesign.validation_cases.filter(test => test.method === "configured-static-release");
      expect(releaseCases.length).toBeGreaterThan(0);
      for (const test of releaseCases) {
        expect(finalValidation.cases.find(result => result.case_id === test.id)).toMatchObject({ method: "configured-static-release", outcome: "pending-release" });
      }
      const evidenceReader = await import(pathToFileURL(join(built, "browser-evidence.js")).href) as typeof import("../../artood/src/browser-evidence.js");
      const releasedPayload = releasedMeasurement!.payload;
      const releasedCheck = releasedPayload.checks.find(check => check.id === "browser-acceptance")!;
      const releasedObservation = releasedCheck.observation;
      if (releasedObservation?.version !== 3 || releasedObservation.scope !== "final") throw new Error("Released product needs final v3 browser evidence");
      expect(releasedObservation.stage).toBe("validation");
      expect(releasedObservation.cases.every(test => !releaseCases.some(releaseCase => releaseCase.id === test.case_id))).toBe(true);
      const grant = { evidenceRoot: browserEvidence, requestId: releasedPayload.request_id, profileId: releasedPayload.profile_id,
        profileDigest: releasedPayload.profile_digest, subjectDigest: releasedPayload.subject_digest!, checkId: releasedCheck.id,
        scope: "final" as const, ...releasedObservation.evidence_bundle };
      const releasedBrowserScope = releasedObservation.cases.map(item => {
        const evidence = evidenceReader.readBrowserEvidence(grant, item.trace_ref);
        if (evidence.mime_type !== "application/json") throw new Error("Expected a sealed operation trace");
        const trace = BrowserOperationTraceV3Schema.parse(JSON.parse(evidence.text));
        expect(trace.case_id).toBe(item.case_id); expect(trace.viewport).toEqual(item.viewport);
        let openPages = 1, maximumPages = 1;
        for (const operation of trace.operations) {
          if (operation.action === "open_page") maximumPages = Math.max(maximumPages, ++openPages);
          else if (operation.action === "close_page") openPages--;
        }
        return { case_id: item.case_id, viewport: item.viewport, trace_ref: item.trace_ref,
          actions: [...new Set(trace.operations.map(operation => operation.action))],
          keys: [...new Set(trace.operations.flatMap(operation => operation.action === "press" ? [operation.observation.key] : []))],
          maximum_concurrent_pages: maximumPages, captures: item.captures,
          closed_pages: trace.operations.filter(operation => operation.action === "close_page").map(operation => operation.page_id),
          storage_fault: item.storage_fault ?? null, storage_precondition: item.storage_precondition ?? null };
      });
      expect(readdirSync(researchRoot).filter((file) => file.endsWith(".json")).length).toBeGreaterThan(0);
      expect(existsSync(join(workspace, ".git"))).toBe(true);
      const response = await fetch(release!.receipt!.endpoint!);
      expect(response.status).toBe(200); expect(response.headers.get("x-artoo-artifact-digest")).toBe(release!.request.subject_digest);
      expect((await response.text()).length).toBeGreaterThan(30);
      const completion = await server.db.db.select({ type: eventLog.type }).from(eventLog).where(and(eq(eventLog.goalId, goalId), eq(eventLog.type, "product.release.completed")));
      expect(completion).toHaveLength(1);
      const goalCompletions = await server.db.db.select().from(eventLog).where(and(eq(eventLog.organizationId, server.ctx.organizationId),
        eq(eventLog.goalId, goalId), eq(eventLog.type, "goal.completed")));
      expect(goalCompletions).toHaveLength(1);
      const goalCompletion = goalCompletions[0]!;
      expect(goalCompletion).toMatchObject({ actorType: "system", actorId: "goal_runner", payload: {
        goal_id: goalId, trigger: "product_release_healthy", endpoint: release!.receipt!.endpoint } });
      const settlement = (goalCompletion.payload as { settlement?: Record<string, unknown> }).settlement;
      if (!settlement) throw new Error("Completed live goal has no publication acceptance settlement");
      // Validate the observation adopted by completion; a later report is a separate fact.
      let settledHealthSequence: number | null = null;
      if (settlement.health_event_id !== null) {
        if (typeof settlement.health_event_id !== "string") throw new Error("Settlement must identify its exact health observation or null");
        const [health] = await server.db.db.select().from(productReleaseHealthReports).where(and(
          eq(productReleaseHealthReports.organizationId, server.ctx.organizationId), eq(productReleaseHealthReports.releaseId, release!.id),
          eq(productReleaseHealthReports.computerId, release!.computer_id), eq(productReleaseHealthReports.eventId, settlement.health_event_id)));
        expect(health).toBeDefined();
        const observed = ProductReleaseHealthReportSchema.parse(health!.payload);
        expect(observed).toMatchObject({ state: "healthy", request: release!.request, release_profile_digest: release!.receipt!.release_profile_digest,
          artifact_digest: release!.request.subject_digest });
        settledHealthSequence = observed.sequence;
      }
      expect(settlement).toEqual({ version: 1, release_id: release!.id, run_id: release!.run_id, evidence_id: release!.evidence_id,
        subject_digest: release!.request.subject_digest, acceptance_binding_digest: hash(canonicalReleaseAcceptanceBinding(acceptance!)),
        research: acceptance!.research, criteria: acceptance!.criteria, publication_receipt_digest: hash(canonicalReleaseJson(release!.receipt!)),
        health_event_id: settlement.health_event_id, health_sequence: settledHealthSequence, scope: "node-http-point-in-time" });
      const usage = [];
      for (const run of await server.db.db.select({ id: runs.id }).from(runs).limit(100)) {
        const response = await server.app.inject({ url: `/api/v1/runs/${run.id}/usage` });
        expect(response.statusCode).toBe(200);
        const measurement = response.json().usage;
        if (measurement) usage.push({ run_id: run.id, input_tokens: measurement.input_tokens, output_tokens: measurement.output_tokens,
          cached_input_tokens: measurement.cached_input_tokens, cost_usd: measurement.cost_usd, currency: measurement.currency });
      }
      expect(usage.reduce((sum, item) => sum + (item.output_tokens ?? 0), 0)).toBeGreaterThan(0);
      assertActive();
      report = { ...report, pipeline_passed: true, completed_at: new Date().toISOString(), automation, release, stages: [...stages],
        completion_event: { id: goalCompletion.id, occurred_at: goalCompletion.occurredAt, settlement },
        contributor_ids: [...new Set(completedRuns.map(({ run }) => run.agentInstanceId))], verified_runs: measurements.slice(0, 100),
        reviews: accepted.map((review) => ({ id: review.id, subject_run_id: review.subjectRunId, reviewer_agent_instance_id: review.reviewerInstanceId, subject_digest: review.subjectDigest })),
        peer_verification: peerMeasurements, provider_usage: usage, released_browser_scope: releasedBrowserScope,
        planning_contexts: planningRuns.map(({ run, turn }) => ({ run_id: run.id, turn_id: turn.id, context_pack_id: run.contextPackId })),
        sources: research.sources.map(({ id, url, title, content_digest }) => ({ id, url, title, content_digest })), errors };
    } catch (error) {
      report.error = safeMessage(error);
      report.errors = errors;
      report.validation_history = validationHistory;
      if (cleanupStarted || reportWriter.finalized || testContext.signal.aborted) throw error;
      await reviewDiagnostics.capture("failure");
      if (server) report.run_summary = (await server.db.db.select({ id: runs.id, task: runs.taskId, agent: runs.agentInstanceId, status: runs.status, failure: runs.failureReason }).from(runs).limit(100))
        .map((run) => ({ ...run, failure: run.failure ? safeMessage(run.failure) : null }));
      await capturePlanningDiagnostics();
      if (server && process.env.ARTOO_AGENT_TEAM_DIAGNOSTICS === "1") {
        const failed = await server.db.db.select({ id: runs.id }).from(runs).where(eq(runs.status, "failed"))
          .orderBy(desc(runs.createdAt), desc(runs.id)).limit(3);
        // Raw CLI output can contain private reasoning or tool content. Keep failed
        // run identities and the separately projected metadata, never raw excerpts.
        report.failed_run_diagnostics = failed.map((run) => ({ run_id: run.id }));
      }
      throw error;
    } finally { saveProgress(); }
  }, duration + 120_000);
});
