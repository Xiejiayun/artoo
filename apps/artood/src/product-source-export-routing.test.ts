import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { ApplicationCapabilitiesV1Schema, ContextPackSchema, productDevelopmentContext, type MeasurementPlanPolicy, type ProductSourceExportV1,
  type ProductSourceExportV2, type RunVerificationPayload } from "@artoo/domain";
import type { NodeToServerMessage, RuntimeAdapter, ServerToNodeMessage } from "@artoo/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNodeClient } from "./node-client.js";
import * as verification from "./verification.js";
import * as execution from "./process-adapter.js";
import * as sourceRuntime from "./product-source-runtime.js";
import * as productRelease from "./product-release.js";
import { prepareStaticWebCapabilities } from "./web-acceptance.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!, roots: string[] = [];
const digest = `sha256:${"a".repeat(64)}`;
afterEach(() => {
  vi.restoreAllMocks(); Object.defineProperty(process, "platform", platform);
  const parent = `${realpathSync.native(tmpdir())}${sep}artoo-source-export-routing-`;
  for (const root of roots.splice(0)) {
    if (!root.startsWith(parent)) throw new Error("Unexpected routing fixture cleanup path");
    rmSync(root, { recursive: true, force: true });
  }
});

describe("product source export stage routing (controlled authority mocks; no native execution)", () => {
  it.each([
    ["research", 1, true, false, "v2"],
    ["research", 1, false, false, "v1"],
    ["research", 2, true, false, "v1"],
    ["research", 2, true, true, "v2"],
    ["research", 1, false, true, "v1"],
    ["design", 1, true, false, "v1"],
    ["implementation", 1, true, false, "v1"],
    ["validation", 1, true, false, "v1"],
    ["design", 2, true, true, "v1"],
    ["implementation", 2, true, true, "v1"],
    ["validation", 2, true, true, "v1"],
    ["research", 0, false, false, "none"],
    ["design", 0, false, false, "none"],
    ["implementation", 0, false, false, "none"],
    ["validation", 0, false, false, "none"],
  ] as const)("completes %s with policy %i, legacy opt-in %s, prepared v2 opt-in %s through %s export", async (stage, policyVersion, enabled, enabledV2, expected) => {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    const workspace = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-source-export-routing-"))); roots.push(workspace);
    const application = expected === "none";
    const policy: MeasurementPlanPolicy = policyVersion === 1 ? { version: 1, coverage: "every-must-criterion" }
      : { version: 2, coverage: "every-must-criterion", methods: ["workspace-check", "configured-static-release"] };
    // This test checks NodeClient's routing/completion boundary. Native provenance
    // is deliberately mocked here and is covered by the separate native fixture.
    const app = ApplicationCapabilitiesV1Schema.parse({ version: 1, kind: "local-application-development", claim: "configured",
      config_digest: digest, contract_digest: digest, source_paths: ["product/client", "product/server", ".artoo/product/application.json"],
      definition_format: "artoo.application-definition.v1", test_scope: "normal-api-browser-reopen", failure_recovery: "unsupported",
      browser_viewport: { width: 1280, height: 900, device_scale_factor: 1 }, publication: "unsupported", qualified_for_product: false });
    const staticWeb = prepareStaticWebCapabilities({ browser_program: { version: 3, viewports: [{ id: "desktop", width: 1280, height: 900 }] } });
    const profile: verification.PreparedVerificationProfile = { id: "profile", project_id: "project", workspace_root: workspace,
      commands: [], required_files: [], subject_paths: [".artoo/product", "product"], digest, trustedFiles: [],
      capabilities: application ? { version: 1, profile_digest: digest, application: app,
        checks: [{ command_id: "check", config_digest: staticWeb.config_digest, contract_digest: staticWeb.contract_digest, contract: staticWeb.contract }] }
        : { version: 1, profile_digest: digest, measurement_plan_policy: policy, checks: [] } };
    const publisher = productRelease.createProductReleaseExecutor([]), record = vi.spyOn(publisher, "recordVerification");
    vi.spyOn(productRelease, "createProductReleaseExecutor").mockReturnValue(publisher);
    vi.spyOn(verification, "prepareVerificationProfiles").mockReturnValue([profile]);
    vi.spyOn(verification, "selectVerificationProfile").mockReturnValue(profile);
    vi.spyOn(verification, "assertVerificationWorkspaceBoundary").mockImplementation(() => {});
    vi.spyOn(execution, "bindWindowsVerifiedExecution").mockReturnValue({} as execution.WindowsVerifiedExecutionAdmission);
    vi.spyOn(execution, "assertWindowsVerifiedExecutionClosed").mockImplementation(() => {});
    vi.spyOn(sourceRuntime, "assertProductSourceRuntimeConfiguration").mockImplementation(() => {});
    vi.spyOn(sourceRuntime, "assertProductSourceWorkspaceBoundary").mockImplementation(() => {});
    vi.spyOn(sourceRuntime, "claimProductSourceRun").mockImplementation(() => {});
    const release = vi.spyOn(sourceRuntime, "releaseProductSourceRun").mockImplementation(() => {});
    vi.spyOn(sourceRuntime, "productSourceSemanticExportEnabled").mockReturnValue(enabled);
    const v2Gate = vi.spyOn(sourceRuntime, "productSourceMeasurementV2ExportEnabled").mockReturnValue(enabledV2);
    const evidence: RunVerificationPayload = { version: 1, request_id: "verify", profile_id: profile.id, profile_digest: digest,
      subject_digest: digest, outcome: "passed", required_files: [], checks: [{ id: "check", exit_code: 0, duration_ms: 1, output_digest: digest }] };
    vi.spyOn(verification, "runVerification").mockResolvedValue(evidence);
    const byteProof: ProductSourceExportV1 = { version: 1, export_id: digest, node_id: "node", run_id: "run", task_id: "task", project_id: "project",
      goal_id: "goal", plan_id: "plan", verification_request_id: "verify", profile_id: "profile", profile_digest: digest, subject_digest: digest,
      context_digest: digest, verification_digest: digest, capsule_digest: digest, manifest_digest: digest, capsule_bytes: 1,
      author_closure: "windows-job-and-tools-closed.v1", execution_authorized: false };
    const bytes = vi.spyOn(sourceRuntime, "captureProductSourceExport").mockReturnValue(byteProof);
    const semantic = vi.spyOn(sourceRuntime, "captureProductSourceExportV2").mockImplementation((_runtime, input) => {
      // Reproduce the narrower capture boundary, so an incorrectly routed later
      // stage fails the complete node loop instead of only a boolean assertion.
      if (input.runStart.context_pack.payload?.product_development?.stage !== "research"
        || input.profile.capabilities?.measurement_plan_policy?.version !== 1 && !enabledV2) throw new Error("Unsupported semantic stage/policy");
      return { version: 2, byte_export: byteProof } as ProductSourceExportV2;
    });
    const context = ContextPackSchema.parse({ task: { id: "task", title: "Routing fixture", description: "Controlled routing fixture", acceptance_criteria: [] },
      project: { id: "project", name: "Fixture", default_workspace: workspace }, workspace: { root: workspace, file_scope: [] },
      policy: { filesystem_write_scope: [workspace], requires_approval: [] }, memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] },
      product_development: productDevelopmentContext(stage), ...(application ? {
        app_delivery: { version: 1, kind: "local-application-development" }, verification_capabilities: { ...profile.capabilities, profile_id: profile.id },
      } : {}) });
    const messages: NodeToServerMessage[] = []; let receive: ((message: ServerToNodeMessage) => void) | undefined;
    const adapter: RuntimeAdapter = { runtimeId: "fixture", async start() { return { runId: "run" }; },
      async *streamEvents() { yield { type: "run.lifecycle", payload: { phase: "completed" } }; }, async stop() {}, async collectArtifacts() { return []; } };
    const runtime = {} as sourceRuntime.PreparedProductSourceRuntime;
    const client = createNodeClient({ nodeId: "node", adapter, workspace: { allowedRoots: [workspace] }, productSourceRuntime: runtime,
      verificationProfiles: [profile], transport: { send: async message => { messages.push(message); }, subscribe: handler => { receive = handler; return () => {}; } } });
    client.start();
    try {
      receive!({ kind: "command", id: "start", idempotency_key: "run:start", type: "run.start", payload: {
        run_id: "run", task_id: "task", agent_instance_id: "agent", runtime: "fixture", workspace: { root: workspace }, context_pack: { id: "context", payload: context },
        policy_snapshot: { filesystem_write_scope: [workspace], requires_approval: [] }, artifact_rules: { paths: [] },
        verification: { version: 1, request_id: "verify", profile_id: profile.id,
          ...(application ? { application: { version: 1, config_digest: digest, contract_digest: digest } } : {}) } } });
      await vi.waitFor(() => {
        expect(messages.some(message => message.kind === "command.ack" && message.status === "rejected")).toBe(false);
        expect(messages.some(message => message.kind === "run.event" && message.event.type === "run.lifecycle" && message.event.payload.phase === "failed")).toBe(false);
        expect(messages.some(message => message.kind === "run.event" && message.event.type === "run.lifecycle" && message.event.payload.phase === "completed")).toBe(true);
        expect(release).toHaveBeenCalledWith(runtime, "run");
      });
      const events = messages.filter(message => message.kind === "run.event");
      if (application) {
        expect(events.map(message => message.event.type)).toEqual(["run.verification", "run.lifecycle"]);
        expect(events.map(message => message.sequence)).toEqual([0, 1]);
        expect(bytes).not.toHaveBeenCalled(); expect(semantic).not.toHaveBeenCalled(); expect(record).not.toHaveBeenCalled();
        return;
      }
      expect(record).toHaveBeenCalledOnce();
      expect(events.map(message => message.event.type)).toEqual(["run.verification", `run.product-source.export.${expected}`, "run.lifecycle"]);
      expect(events.map(message => message.sequence)).toEqual([0, 1, 2]);
      expect(expected === "v2" ? semantic : bytes).toHaveBeenCalledTimes(1);
      expect(expected === "v2" ? bytes : semantic).not.toHaveBeenCalled();
      if (stage === "research" && policyVersion === 2) expect(v2Gate).toHaveBeenCalledWith(runtime, profile);
      else expect(v2Gate).not.toHaveBeenCalled();
    } finally { await client.stop(true); }
  });
});
