import { sourceWorkspaceLineages, sourceCleanStops, sourceCleanGenerations } from "@artoo/db";
import { SOURCE_LIFECYCLE_CONTROL_REPLY_RESERVE_BYTES_V1 } from "@artoo/protocol";
import { SOURCE_CLEAN_RESTART_FEATURE_V1, SourceSupervisorLaunchV1Schema, SourceLifecycleRegistrationV1Schema,
  SourceSupervisedCleanClosureV1Schema, SourceCleanRestartCheckpointV1Schema, type SourceCleanStopIntentV1 } from "@artoo/domain";
import { createSourceLifecycleRegistry, settleSourceCleanGeneration } from "./services/source-clean-lifecycle-service.js";
import { assertSourceLineageDispatch } from "./services/source-lineage-fence.js";
import {goalProductHandoffs,goalProductHandoffOperations,goalProductHandoffDeliveries,deviceTokens} from "@artoo/db";
import { agents, discussions, goalImportedProductReviews, goalImportedProductReviewDeliveries } from "@artoo/db";
import { IMPORTED_PRODUCT_REVIEW_FEATURE_V1, ImportedProductReviewRequestV1Schema, ImportedProductReviewResultV1Schema, type ImportedProductReviewResultV1 } from "@artoo/domain";
import { ensureGoalImportedProductReview, advanceGoalImportedProductReview, createGoalImportedProductReviewBinding,
  importedProductReviewView, stopGoalImportedProductReviews } from "./services/imported-product-review-service.js";
import {getTableConfig} from "drizzle-orm/pg-core";
import {ProductSourceHandoffIntentV1Schema,ProductSourceOperationV1Schema,PRODUCT_SOURCE_OPERATIONS_FEATURE_V1,parseDeviceToken} from "@artoo/domain";
import type {ServerToNodeMessage, NodeToServerMessage, RuntimeAdapter} from "@artoo/protocol";
import {ensureGoalProductHandoff,requestGoalProductHandoffStop,createGoalProductHandoffBinding} from "./services/goal-product-handoff-service.js";
import {controlledDestinationResult} from "./test-fixtures/product-source-operation.js";
import { agentInstances, autonomousReviews, computers, contextPacks, runEventIngest, runEvidence, eventLog, goalAutomations, goals,
  messages, plans, productSourceSemanticTransfers, productSourceTransfers, runs, tasks } from "@artoo/db";
import { canonicalProductSourceTransferValueV1, ProductSourceExportV1Schema, ProductSourceExportV2Schema,
  ProductSourceTransferRequestV1Schema, ProductSourceTransferRequestV2Schema, productSourceExportDigestV2,
  productSourceTransferRequestDigestV1, productSourceTransferRequestDigestV2, ProductResearchReportV2Schema,
  MeasurementPlanPolicyV2Schema, evaluateDeclaredMeasurementPlanV2, VerificationObservationV3Schema,
  CONFIGURED_STATIC_PUBLICATION_STATEMENT, PRODUCT_SOURCE_TRANSFER_MEASUREMENT_V2_FEATURE_V1 } from "@artoo/domain";
import { eq, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { describe, expect, vi } from "vitest";
import { settledServerFixture } from "./test-fixtures/settled-server-fixture.js";
import { testDeviceAuthConfig } from "./config/device-auth.js";
import { createPairing, revokeDevice } from "./services/device-service.js";
import { admitProductSourceSemanticTransfer, admitProductSourceTransfer } from "./services/product-source-transfer-service.js";
import { prepareTransferReviewFixture } from "./test-fixtures/product-source-transfer-review.js";
import { measurementPlanEvidenceFixture } from "./test-fixtures/measurement-plan.js";
import { releaseAcceptanceFixture } from "./test-fixtures/release-acceptance.js";
import { verificationCapabilitiesV3Fixture } from "./test-fixtures/verification-capabilities.js";
import { verificationCapabilityBinding } from "./services/verification-capabilities.js";
import { buildTestServer, type TestServer } from "./test-support.js";
import * as blobs from "./content-addressed-blob.js";
import * as semanticExports from "./services/product-source-semantic-export-service.js";
import * as semanticTransfers from "./services/product-source-transfer-service.js";
import { ingestRunEvent, ingestWireRunEvent } from "./services/run-service.js";
import { qualifyRunEventMessage } from "./services/run-event-receipt.js";
import { assignTask, reviewTask } from "./services/lifecycle-service.js";
import { acceptPlan } from "./services/plan-service.js";
import { cancelGoal } from "./services/goal-service.js";
import { createGoalAutomationDispatcher } from "./services/goal-automation-service.js";
import { unsettledGoalExecutionCount, unsettledStandaloneExecutions } from "./services/execution-state.js";
import { attachNodeBinding } from "./node-binding.js";
import { ensureGoalProductRelease } from "./services/product-release-service.js";
import { goalImportedDesignContinuations, goalImportedDesignDeliveries } from "@artoo/db";
import { ImportedDesignContinuationRequestV1Schema, IMPORTED_DESIGN_CONTINUATION_FEATURE_V1, IMPORTED_DESIGN_CONTEXT_INSTRUCTION_V1 } from "@artoo/domain";
import { ensureGoalImportedDesignContinuation, createImportedDesignContinuationBinding, stopGoalImportedDesignContinuations } from "./services/imported-design-continuation-service.js";
import { createWebSocketTransport } from "@artoo/artood";
import { createArtoodNode } from "../../artood/src/node-runner.js";
import LifecycleWebSocket from "ws";
import { openSourceLifecycleObserver, sourceLifecycleObserverIdentity, sourceLifecycleObserverFailure, bindSourceLifecycleLaunch,
  prepareSourceCleanStop, closeSourceLifecycleObserver } from "../../artood/src/source-lifecycle-observer.js";
import * as cleanLocalConfiguration from "../../artood/src/windows-clean-local-configuration.js";
import * as localSourceNode from "../../artood/src/product-source-node.js";
import * as localSourceConfiguration from "../../artood/src/product-source-config.js";
import * as localVerification from "../../artood/src/verification.js";
import * as localPublication from "../../artood/src/product-release.js";
import * as localWindowsProcess from "../../artood/src/owned/windows-owned-process.js";
import * as localSupervisor from "../../artood/src/windows-supervisor-authority.js";
import * as localRecovery from "../../artood/src/windows-source-recovery.js";
import * as localGuardian from "../../artood/src/owned/windows-runtime-guardian.js";
import * as qualifiedReceipts from "./services/run-event-receipt.js";
import { goalImportedDesignCompletions, goalImportedDesignReviews, goalImportedDesignReviewDeliveries, users } from "@artoo/db";
import { ImportedDesignReviewRequestV1Schema, ImportedDesignReviewResultV1Schema, IMPORTED_DESIGN_REVIEW_FEATURE_V1, importedDesignReviewSubjectV1 } from "@artoo/domain";
import { ensureGoalImportedDesignReview, advanceGoalImportedDesignReview, createImportedDesignReviewBinding, stopGoalImportedDesignReviews } from "./services/imported-design-review-service.js";
import { controlledDesignVerification, importedCompletedDesignResultFixture } from "../../artood/src/test-fixtures/imported-design-review-request.js";
import { currentImportedDesignBoundary } from "./services/execution-state.js";
import { scheduleTask } from "./services/scheduler.js";
import { parseNodeToServer } from "./ws/ws-node-transport.js";
import { goalImportedExecutions, goalImportedExecutionDeliveries, goalImportedExecutionCompletions, goalImportedDesignReviewReceipts } from "@artoo/db";
import { ImportedExecutionRequestV1Schema, ImportedExecutionResultV1Schema, IMPORTED_EXECUTION_FEATURE_V1, TaskSpecSchema,
  importedExecutionContextV1, importedExecutionRequestDigestV1 } from "@artoo/domain";
import { ensureGoalImportedExecution, advanceGoalImportedExecution, createImportedExecutionBinding, stopGoalImportedExecutions } from "./services/imported-execution-service.js";
import { goalImportedExecutionReceipts, goalImportedExecutionReviews, goalImportedExecutionReviewReceipts,
  goalImportedExecutionRepairs, goalImportedExecutionRepairCompletions, goalImportedExecutionRepairReceipts } from "@artoo/db";
import { ImportedExecutionReviewRequestV1Schema, ImportedExecutionReviewResultV1Schema, ImportedExecutionRepairRequestV1Schema,
  ImportedExecutionRepairResultV1Schema, importedExecutionReviewSubjectV1, IMPORTED_EXECUTION_REVIEW_FEATURE_V1 } from "@artoo/domain";
import { ensureGoalImportedExecutionReview, advanceGoalImportedExecutionReview, createImportedExecutionReviewBinding } from "./services/imported-execution-review-service.js";
import { goalImportedValidations, goalImportedValidationCompletions, goalImportedValidationReceipts,
  goalImportedValidationReviews, goalImportedValidationReviewReceipts, goalImportedValidationPublications, productReleases } from "@artoo/db";
import { ImportedValidationRequestV1Schema, ImportedValidationResultV1Schema, ImportedValidationReviewRequestV1Schema,
  ImportedValidationReviewResultV1Schema, importedValidationOriginDigestV1, importedValidationReviewSubjectV1,
  IMPORTED_VALIDATION_FEATURE_V1, ProductReleaseRequestSchema, ProductReleaseReceiptSchema } from "@artoo/domain";
import { AutonomousTeamSchema, ProductSourceRoutingV1Schema } from "@artoo/domain";
import { ensureGoalImportedValidation, ensureGoalImportedValidationRepair, advanceGoalImportedValidation, createImportedValidationBinding } from "./services/imported-validation-service.js";
import { ensureGoalImportedValidationReview, advanceGoalImportedValidationReview, createImportedValidationReviewBinding } from "./services/imported-validation-review-service.js";
import { ingestProductReleaseReceipt, assertRecordedGoalReleaseCompletion } from "./services/product-release-service.js";
import { inspectFinalReleaseAcceptance, releaseAcceptanceBindingDigest } from "./services/release-acceptance.js";
import { inspectImportedValidationPublicationDispatch } from "./services/imported-validation-release-service.js";
import { ensureGoalImportedExecutionRepair, advanceGoalImportedExecutionRepair, createImportedExecutionRepairBinding,
  stopGoalImportedExecutionRepairs } from "./services/imported-execution-repair-service.js";
import { enforceGoalBudget } from "./services/budget-service.js";
import { productReleaseRetrySources } from "@artoo/db";
import { PRODUCT_RELEASE_RETRY_FEATURE_V1 } from "@artoo/domain";
import { assertProductReleaseRetryDispatch, assertProductReleaseRetryHistory } from "./services/product-release-retry-service.js";
import { nodeRecoveryRegistrations, nodeRecoveryAvailabilities, goalSourceRecoveries, goalSourceRecoveryCheckpoints,
  goalSourceRecoverySettlements, goalSourceRecoveryReceipts, goalRecoveryValidations, goalRecoveryValidationReviews,
  goalRecoveryValidationCompletions, goalRecoveryValidationReceipts, goalRecoveryValidationPublications } from "@artoo/db";
import { PRODUCT_SOURCE_RECOVERY_FEATURE_V1, IMPORTED_RECOVERY_VALIDATION_FEATURE_V1, IMPORTED_RECOVERY_VALIDATION_REVIEW_FEATURE_V1, ProductSourceRecoveryRegistrationV1Schema,
  ProductSourceRecoveryAvailabilityV1Schema, ProductSourceRecoveryRequestV1Schema, ProductSourceRecoveryResultV1Schema,
  ImportedRecoveryValidationRequestV1Schema, ImportedRecoveryValidationResultV1Schema,
  ImportedRecoveryValidationReviewRequestV1Schema, ImportedRecoveryValidationReviewResultV1Schema,
  importedRecoveryValidationReviewSubjectV1, productSourceRecoveryCheckpointDigestV1, importedExecutionAcceptedInputsV1,
  type RecoveryOperationRefV1 } from "@artoo/domain";
import { createSourceRecoveryBinding, ensureGoalSourceRecovery, advanceGoalSourceRecovery } from "./services/source-recovery-service.js";
import { createRecoveryValidationBinding, ensureGoalRecoveryValidation, ensureGoalRecoveryValidationRepair,
  advanceGoalRecoveryValidation } from "./services/recovery-validation-service.js";
import { createRecoveryValidationReviewBinding, ensureGoalRecoveryValidationReview, advanceGoalRecoveryValidationReview } from "./services/recovery-validation-review-service.js";
import { settleRecoveryPublications } from "./services/product-release-recovery-service.js";
import { buildAiDataSharingPolicy } from "./config/ai-data-sharing.js";
import { grantAiDataSharingConsent, requireAiSharingAuthorization, revokeAiDataSharingConsent } from "./services/ai-data-sharing-service.js";
import { goalSourceRecoveryDeliveries } from "@artoo/db";
import { goalCleanValidations, goalCleanValidationReviews, goalCleanValidationPublications, sourceCleanOperationSettlements } from "@artoo/db";
import { IMPORTED_CLEAN_VALIDATION_FEATURE_V1, IMPORTED_CLEAN_VALIDATION_REVIEW_FEATURE_V1, PRODUCT_RELEASE_CLEAN_FEATURE_V1,
  ImportedCleanValidationRequestV1Schema, ImportedCleanValidationResultV1Schema, ImportedCleanValidationReviewRequestV1Schema,
  ImportedCleanValidationReviewResultV1Schema, importedCleanValidationReviewSubjectV1, sourceCleanValidationOriginDigestV1 } from "@artoo/domain";
import { createCleanValidationBinding, ensureGoalCleanValidation, ensureGoalCleanValidationRepair, advanceGoalCleanValidation } from "./services/clean-validation-service.js";
import { createCleanValidationReviewBinding, ensureGoalCleanValidationReview, advanceGoalCleanValidationReview } from "./services/clean-validation-review-service.js";
import { settleCleanPublications } from "./services/product-release-clean-service.js";
import { inspectCleanValidationPublicationDispatch } from "./services/clean-validation-release-service.js";

const sha = (bytes: string | Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const hash = (value: unknown) => sha(canonicalProductSourceTransferValueV1(value));
describe("imported design continuation (controlled DB/protocol evidence, no native process)", () => {
  const timingCases = new Set([
    "H9 exact old operation set and unknown closure cannot reopen or publish the workspace",
    "H7 rejection creates one fresh repair with original retry budget and a complete new review",
    "H8 rejects H7 retry after the original destination session changes",
    "H7 failed publication remains one immutable attempt and cannot reopen accepted validation",
  ]);
  const fixtureTimingStarts = new WeakMap<object, number>();
  const lifecycle = settledServerFixture<{ server?: TestServer; directory: string }>(() => ({ directory: "" }), {
    observe(event, context) {
      if (!timingCases.has(context.task.name)) return;
      const now = performance.now(), started = fixtureTimingStarts.get(context) ?? now;
      fixtureTimingStarts.set(context, started);
      // Observe existing setup/body/drain/close events without changing fixture ownership or deadlines.
      console.error("[source-continuation-timing]", JSON.stringify({ case: context.task.name, clock: "fixture", event, elapsed_ms: now - started }));
    },
  });
  function tracePhases() {
    const name = lifecycle.context().task.name, started = performance.now();
    return async <T>(phase: string, operation: () => T | PromiseLike<T>): Promise<T> => {
      const spanStarted = performance.now();
      console.error("[source-continuation-timing]", JSON.stringify({ case: name, clock: "body", phase, event: "started", elapsed_ms: spanStarted - started }));
      let outcome: "fulfilled" | "rejected" = "rejected";
      try { const result = await operation(); outcome = "fulfilled"; return result; }
      finally {
        const ended = performance.now();
        // Emit immediately, including while original work drains after a timeout; never log source/token/error data.
        console.error("[source-continuation-timing]", JSON.stringify({ case: name, clock: "body", phase, event: "settled", outcome, elapsed_ms: ended - started, duration_ms: ended - spanStarted }));
      }
    };
  }
  const it = lifecycle.it, fixture = () => {
    const state = lifecycle.current();
    if (!state.server) throw new Error("This test's original server setup has not completed");
    return { server: state.server, directory: state.directory };
  };
  lifecycle.beforeEach(async state => {
    state.directory = await lifecycle.temporary();
    state.server = await lifecycle.acquire(buildTestServer({ artifactDir: state.directory, workspaceRoot: "/workspace/product", authConfig: { enforceApiAuth: true },
      deviceAuth: testDeviceAuthConfig({ devNodeToken: "dev", devControlEscape: false }), onResourceAcquired: resource => lifecycle.own(resource) }));
  });
  lifecycle.afterEach(() => { vi.restoreAllMocks(); });
  async function paired(name: string) {
    const code = await createPairing(fixture().server.ctx, { pepper: fixture().server.ctx.deviceAuth.pairingPepper, ttlMs: 60000 }, { createdByUserId: fixture().server.ctx.actorUserId });
    const response = await fixture().server.app.inject({ method: "POST", url: "/api/v1/devices/claim",
      payload: { code: code.code, platform: "windows", app_version: "fixture", display_name: name } });
    expect(response.statusCode).toBe(201);
    const device = response.json() as { device: { id: string }; node_token: string; control_token: string };
    const enrolled = await fixture().server.app.inject({ method: "POST", url: `/api/v1/devices/${device.device.id}/enroll`, payload: {},
      headers: { authorization: `Bearer ${device.control_token}` } });
    expect(enrolled.statusCode).toBe(200);
    const nodeId = enrolled.json().computer_id as string;
    await fixture().server.db.db.update(computers).set({ status: "online" }).where(eq(computers.id, nodeId));
    return { ...device, nodeId };
  }
  async function prepare(options: { malformed?: "metadata" | "omitted" | "duplicate"; skipExport?: boolean; originalReceiptRun?: boolean;
    measurementV2?: boolean; legacyResearch?: boolean; automatic?: boolean } = {}) {
    // Real WebSocket callbacks may run outside Vitest's async context. Capture
    // this case's original server while its fixture is live; its registered
    // resource owner still controls shutdown and database cleanup.
    const server = fixture().server, sharing = await requireAiSharingAuthorization(server.ctx);
    const source = await paired("source"), destination = await paired("destination"), other = await paired("other");
    await fixture().server.db.db.update(agentInstances).set({ computerId: source.nodeId }).where(eq(agentInstances.id, "instance_mock_coder"));
    const releaseFixture = options.measurementV2 ? releaseAcceptanceFixture("research") : undefined;
    const f = releaseFixture ?? measurementPlanEvidenceFixture(), sourceRelease = releaseFixture?.release, check = f.capabilities.checks[0]!;
    if (sourceRelease) {
      // A controlled v3 research attestation with zero browser cases, never native evidence.
      check.contract = verificationCapabilitiesV3Fixture(true).checks[0]!.contract;
      check.contract_digest = hash(check.contract);
      f.requirement.capability_binding = verificationCapabilityBinding(f.capabilities);
      f.context.verification_capabilities = { ...f.capabilities, profile_id: "default" };
      f.payload.checks[0]!.observation = VerificationObservationV3Schema.parse({ version: 3, format: "static-web-acceptance.v3",
        scope: "final", stage: "research", device_scale_factor: 1, cases: [],
        capability_binding: { version: 1, profile_digest: f.capabilities.profile_digest, ...f.requirement.capability_binding.checks[0] },
        evidence_bundle: { bundle_id: "controlled_research_bundle", manifest_digest: sha("controlled empty research bundle") } });
      f.payload.measurement_plan!.used_checks = f.requirement.capability_binding.checks;
    }
    const metadata = { id: `source_${"a".repeat(32)}`, url: "https://example.com/controlled-research", title: "Controlled research receipt",
      retrieved_at: "2026-11-05T00:00:00Z", content_digest: sha("controlled source bytes") };
    const report = { version: 1, objective: "Controlled report", assumptions: [],
      requirements: [{ id: "save", description: "Save an entry", priority: "must", acceptance_criteria: ["Saved entry is visible", "Saved entry count is shown"] }],
      sources: [metadata], findings: [{ summary: "Controlled source finding", source_ids: [metadata.id] }], decisions: [],
      measurement_plan: { version: 1, profile_digest: f.capabilities.profile_digest, entries: [0, 1].map(criterion_index => ({
        requirement_id: "save", criterion_index, command_id: check.command_id, config_digest: check.config_digest, contract_digest: check.contract_digest,
        actions: ["navigate", "assert_text"], keys: [], viewports: check.contract.viewports, needs: [] })) } };
    const researchReport = sourceRelease && !options.legacyResearch ? ProductResearchReportV2Schema.parse({ ...report,
      requirements: [{ ...report.requirements[0], acceptance_criteria: ["  Saved entry is visible  ", "Saved entry count is shown"] },
        { id: "publication", description: "Publish the configured product", priority: "must", acceptance_criteria: [CONFIGURED_STATIC_PUBLICATION_STATEMENT] }],
      measurement_plan: { ...report.measurement_plan, version: 2,
        entries: [...report.measurement_plan.entries.map(entry => ({ ...entry, method: "workspace-check" })),
          { method: "configured-static-release", requirement_id: "publication", criterion_index: 0,
            release_binding: sourceRelease.binding, claim_id: sourceRelease.contract.criterion.id,
            statement_digest: sourceRelease.contract.criterion.statement_digest }] } }) : report;
    const researchBytes = Buffer.from(JSON.stringify(researchReport)), researchPin = { path: ".artoo/product/research.json" as const, checksum: sha(researchBytes), size: researchBytes.length };
    f.payload.required_files = [researchPin];
    f.payload.measurement_plan!.research = researchPin;
    f.payload.measurement_plan!.measurement_plan_digest = hash(researchReport.measurement_plan);
    if (sourceRelease && !options.legacyResearch) {
      const { canonical_plan, ...partition } = evaluateDeclaredMeasurementPlanV2({ research: ProductResearchReportV2Schema.parse(researchReport),
        policy: MeasurementPlanPolicyV2Schema.parse(f.capabilities.measurement_plan_policy), capabilities: f.capabilities,
        releaseCapabilities: sourceRelease, digest: sha });
      if (f.payload.measurement_plan?.version !== 2) throw new Error("Controlled release fixture lacks summary 2");
      f.payload.measurement_plan = { ...f.payload.measurement_plan, ...partition, measurement_plan_digest: sha(canonical_plan) };
    }
    const review = await prepareTransferReviewFixture(fixture().server, f, sharing);
    expect(await review.inspect()).toMatchObject({ status: "accepted" });
    const now = fixture().server.ctx.clock.nowIso();
    await fixture().server.db.db.insert(plans).values({ id: "transfer_plan", organizationId: fixture().server.ctx.organizationId, goalId: "measurement_goal",
      version: 1, authorType: "system", authorId: "goal_runner", status: "accepted", createdAt: now, acceptedAt: now });
    await fixture().server.db.db.update(goals).set({ currentPlanId: "transfer_plan" }).where(eq(goals.id, "measurement_goal"));
    await fixture().server.db.db.update(tasks).set({ sourcePlanId: "transfer_plan", status: "done" }).where(eq(tasks.id, review.source.run.taskId));
    await fixture().server.db.db.update(autonomousReviews).set({ status: "accepted", verdict: review.verdict }).where(eq(autonomousReviews.id, "measurement_review"));
    await fixture().server.db.db.insert(goalAutomations).values({ goalId: "measurement_goal", organizationId: fixture().server.ctx.organizationId,
      actorUserId: fixture().server.ctx.actorUserId, consentId: sharing.consentId, policyVersion: sharing.policyVersion, status: "executing", planId: "transfer_plan",
      ...(options.automatic ? { sourceHandoff: { version: 1, mode: "automatic" }, executionMode: "agent_team" as const, releaseProfileId: sourceRelease!.binding.release_profile_id } : {}),
      computerId: source.nodeId, workspaceRoot: "/workspace/product", verificationProfileId: "default", createdAt: now, updatedAt: now });
    const destinationProfile = sourceRelease ? "destination-verify" : "default", destinationCapabilities = structuredClone(f.capabilities);
    if (sourceRelease) {
      destinationCapabilities.profile_digest = sha("controlled destination verifier");
      destinationCapabilities.checks[0]!.command_id = "destination-acceptance";
      destinationCapabilities.checks[0]!.config_digest = sha("controlled destination browser configuration");
    }
    const destinationRelease = sourceRelease ? { ...structuredClone(sourceRelease), binding: { ...sourceRelease.binding,
      release_profile_id: "destination-site", release_profile_digest: sha("controlled destination release"),
      workspace_root: "/destination/product", verification_profile_id: destinationProfile,
      verification_profile_digest: destinationCapabilities.profile_digest } } : undefined;
    fixture().server.ctx.supportsExecutionFeature = (nodeId, feature) => [source.nodeId, destination.nodeId].includes(nodeId)
      && ["product-source-transfer.v1", "product-source-transfer.v2", ...(sourceRelease ? [PRODUCT_SOURCE_TRANSFER_MEASUREMENT_V2_FEATURE_V1] : [])].includes(feature);
    fixture().server.ctx.supportsVerificationProfile = (nodeId, profile, project, workspace) => project === "proj_artoo"
      && (nodeId === destination.nodeId && profile === destinationProfile && workspace === "/destination/product"
        || !!sourceRelease && nodeId === source.nodeId && profile === "default" && workspace === "/workspace/product");
    fixture().server.ctx.getVerificationCapabilities = (nodeId, profile, project, workspace) => sourceRelease
      ? server.ctx.supportsVerificationProfile?.(nodeId, profile, project, workspace)
        ? structuredClone(nodeId === source.nodeId ? f.capabilities : destinationCapabilities) : undefined
      : structuredClone(f.capabilities);
    if (sourceRelease && destinationRelease) {
      fixture().server.ctx.supportsReleaseProfile = (nodeId, profile, project, workspace, verifier) => {
        const selected = nodeId === source.nodeId ? sourceRelease : nodeId === destination.nodeId ? destinationRelease : undefined;
        return !!selected && selected.binding.release_profile_id === profile && selected.binding.project_id === project
          && selected.binding.workspace_root === workspace && selected.binding.verification_profile_id === verifier;
      };
      fixture().server.ctx.getReleaseCapabilities = (nodeId, profile, project, workspace, verifier) =>
        server.ctx.supportsReleaseProfile?.(nodeId, profile, project, workspace, verifier)
          ? structuredClone(nodeId === source.nodeId ? sourceRelease : destinationRelease) : undefined;
    }
    const manifest = { entries: [{ path: ".artoo/product", kind: "directory" }, { path: "product", kind: "directory" }, { ...researchPin, kind: "file" }] };
    const files = [{ path: researchPin.path, base64: researchBytes.toString("base64") }];
    if (options.malformed === "duplicate") files.push(files[0]!);
    if (options.malformed === "omitted") files.splice(0);
    const capsule = { version: 1, kind: "artoo.product-source.v1", source: { project_id: "proj_artoo", profile_id: "default",
      profile_digest: f.payload.profile_digest, subject_digest: f.payload.subject_digest }, manifest, manifest_digest: sha(JSON.stringify(manifest)), files };
    const bytes = Buffer.from(JSON.stringify(capsule));
    const base = ProductSourceTransferRequestV1Schema.parse({ version: 1, kind: "product-source-transfer.v1", transfer_id: "semantic_fixture",
      organization_id: fixture().server.ctx.organizationId, project_id: "proj_artoo", goal_id: "measurement_goal", plan_id: "transfer_plan",
      authorization: { actor_user_id: fixture().server.ctx.actorUserId, consent_id: sharing.consentId, policy_version: sharing.policyVersion },
      source: { node_id: source.nodeId, task_id: review.source.run.taskId, run_id: review.source.run.id, evidence_id: review.source.evidence.id,
        verification_request_id: f.payload.request_id, profile_id: "default", profile_digest: f.payload.profile_digest, workspace_root: "/workspace/product",
        subject_digest: f.payload.subject_digest, review_id: "measurement_review", reviewer_run_id: review.peer.run.id, reviewer_evidence_id: review.peer.evidence.id,
        capsule_digest: sha(bytes), manifest_digest: capsule.manifest_digest, capsule_bytes: bytes.length },
      destination: { node_id: destination.nodeId, profile_id: destinationProfile, workspace_root: "/destination/product",
        capabilities: destinationCapabilities, capability_digest: hash(destinationCapabilities) } });
    review.source.context.goal_context = { version: 1, goal_id: "measurement_goal", objective: "Controlled transfer", acceptance_criteria: [],
      plan: { id: "transfer_plan", version: 1, rationale: "Controlled protocol fixture", spec_ref: null } };
    await fixture().server.db.db.update(contextPacks).set({ payload: review.source.context }).where(eq(contextPacks.id, review.source.run.contextPackId!));
    await fixture().server.db.db.update(eventLog).set({ sequence: 1 }).where(eq(eventLog.id, review.source.evidence.eventId));
    const verificationFrame = qualifyRunEventMessage({ kind: "run.event", node_id: source.nodeId, run_id: review.source.run.id,
      sequence: 1, event: { type: "run.verification", payload: review.source.evidence.payload } });
    await fixture().server.db.db.insert(runEventIngest).values({ nodeId: source.nodeId, runId: review.source.run.id, sequence: 1,
      eventId: review.source.evidence.eventId, bodyIdentity: verificationFrame.bodyIdentity, createdAt: now });
    await fixture().server.db.db.update(runs).set({ status: "running" }).where(eq(runs.id, review.source.run.id));
    await fixture().server.db.db.update(tasks).set({ status: "running" }).where(eq(tasks.id, review.source.run.taskId));
    const byteExport = ProductSourceExportV1Schema.parse({ version: 1, export_id: hash({ run_id: base.source.run_id,
      request_id: base.source.verification_request_id, capsule_digest: base.source.capsule_digest }),
      node_id: source.nodeId, run_id: base.source.run_id, task_id: base.source.task_id, project_id: base.project_id,
      goal_id: base.goal_id, plan_id: base.plan_id, verification_request_id: f.payload.request_id, profile_id: "default",
      profile_digest: f.payload.profile_digest, subject_digest: f.payload.subject_digest, context_digest: hash(review.source.context),
      verification_digest: hash(review.source.evidence.payload), capsule_digest: base.source.capsule_digest,
      manifest_digest: base.source.manifest_digest, capsule_bytes: bytes.length,
      author_closure: "windows-job-and-tools-closed.v1", execution_authorized: false });
    const provenanceMetadata = options.malformed === "metadata" ? { ...metadata, title: "Substituted original source" } : metadata;
    const provenance = { version: 1, chain_depth: 0, research: researchPin, sources: [{ metadata: provenanceMetadata, metadata_digest: hash(provenanceMetadata),
      origin: { node_id: source.nodeId, run_id: options.originalReceiptRun ? "original_retrieval_run" : base.source.run_id,
        task_id: options.originalReceiptRun ? "original_retrieval_task" : base.source.task_id, project_id: base.project_id,
        goal_id: base.goal_id, workspace_root: base.source.workspace_root }, content_bytes: Buffer.byteLength("controlled source bytes") }] };
    const proof = ProductSourceExportV2Schema.parse({ version: 2, byte_export: byteExport, stage: "research", source_capabilities: f.capabilities,
      research_provenance: provenance, research_provenance_digest: hash(provenance),
      ...(sourceRelease ? { measurement_v2: { version: 1, source_release: sourceRelease } } : {}) });
    const request = ProductSourceTransferRequestV2Schema.parse({ version: 2, kind: "product-source-transfer.v2", byte_request: base,
      source_export: proof, source_export_digest: productSourceExportDigestV2(proof, sha),
      command_pairs: [{ source_command_id: "acceptance", destination_command_id: destinationCapabilities.checks[0]!.command_id }],
      ...(destinationRelease ? { measurement_v2: { version: 1, destination_release: destinationRelease } } : {}) });
    const exportFrame = { kind: "run.event", node_id: source.nodeId, run_id: review.source.run.id, sequence: 2,
      event: { type: "run.product-source.export.v2", payload: proof } };
    const terminalFrame = { kind: "run.event", node_id: source.nodeId, run_id: review.source.run.id, sequence: 3,
      event: { type: "run.lifecycle", payload: { phase: "completed" } } };
    if (!options.skipExport) {
      await ingestWireRunEvent(fixture().server.ctx, exportFrame); await ingestWireRunEvent(fixture().server.ctx, terminalFrame);
      await fixture().server.db.db.update(tasks).set({ status: "done" }).where(eq(tasks.id, review.source.run.taskId));
    }
    const actor = { ...fixture().server.ctx, automationActor: { type: "system" as const, id: "goal_runner" as const } };
    const digest = productSourceTransferRequestDigestV2(request, sha);
    const url = `/api/v1/node/product-source-transfers-v2/${base.transfer_id}/content`;
    const headers = (token: string, override: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`,
      "x-artoo-transfer-request-digest": digest, "x-artoo-checksum": sha(bytes), ...override });
    const upload = (token = source.node_token, payload = bytes, extra: Record<string, string> = {}) => fixture().server.app.inject({ method: "PUT", url,
      headers: headers(token, { "content-type": "application/octet-stream", ...extra }), payload });
    const download = (token = destination.node_token) => fixture().server.app.inject({ method: "GET", url, headers: headers(token) });
    return { source, destination, other, review, request, base, actor, digest, bytes, upload, download, headers, url, proof, exportFrame, terminalFrame,
      sourceRelease, destinationRelease, researchBytes, researchReport };
  }

  async function prepareHandoff(automatic = false){
    const f=await prepare({measurementV2:true, automatic}),now=fixture().server.ctx.clock.nowIso();
    await fixture().server.db.db.update(tasks).set({sourcePlanSpecRef:"0"}).where(eq(tasks.id,f.base.source.task_id));
    await fixture().server.db.db.update(plans).set({taskSpecs:[{development_stage:"research",title:"Research",acceptance_criteria:["Source research accepted"]},
      {development_stage:"design",title:"Design",acceptance_criteria:["Design the product"],dependencies:[{ref:"0",type:"blocks"}]}]}).where(eq(plans.id,f.base.plan_id));
    await fixture().server.db.db.insert(tasks).values({id:"handoff_design",organizationId:fixture().server.ctx.organizationId,projectId:f.base.project_id,goalId:f.base.goal_id,
      sourcePlanId:f.base.plan_id,sourcePlanSpecRef:"1",title:"Next design",status:"ready",acceptanceCriteria:["Design the product"],createdByType:"system",createdById:"goal_runner",createdAt:now,updatedAt:now});
    const context=structuredClone(f.review.source.context);context.task.id="handoff_verification_task";context.workspace.root=f.base.destination.workspace_root;
    context.policy.filesystem_write_scope=[f.base.destination.workspace_root];context.verification_capabilities={...f.base.destination.capabilities,profile_id:f.base.destination.profile_id};
    context.release_capabilities=f.destinationRelease;
    const [originalGoal] = await fixture().server.db.db.select().from(goals).where(eq(goals.id, f.base.goal_id));
    const [originalPlan] = await fixture().server.db.db.select().from(plans).where(eq(plans.id, f.base.plan_id));
    context.goal_context = { version: 1, goal_id: f.base.goal_id, objective: originalGoal!.objective, acceptance_criteria: originalGoal!.acceptanceCriteria as string[],
      plan: { id: f.base.plan_id, version: originalPlan!.version, rationale: originalPlan!.rationale ?? "", spec_ref: "0" } };
    const intent=ProductSourceHandoffIntentV1Schema.parse({version:1,request:f.request,next_task_id:"handoff_design",destination_start:{run_id:"handoff_verification_run",
      task_id:context.task.id,agent_instance_id:"controlled_operation",runtime:"controlled_fixture",workspace:{root:context.workspace.root},context_pack:{id:"handoff_context",payload:context},
      policy_snapshot:context.policy,artifact_rules:{paths:[]},verification:{version:1,profile_id:f.base.destination.profile_id,request_id:"handoff_verification_request",
        expected_subject_digest:f.base.source.subject_digest,capability_binding:verificationCapabilityBinding(f.base.destination.capabilities),release_capability_binding:f.destinationRelease!.binding}}});
    const supports=f.actor.supportsExecutionFeature;f.actor.supportsExecutionFeature=(node,feature)=>feature===PRODUCT_SOURCE_OPERATIONS_FEATURE_V1||supports?.(node,feature)===true;
    const sent:ServerToNodeMessage[]=[];let current=true;
    const binding=(node:string,session="session-one")=>{const pairedNode=[f.source,f.destination,f.other].find(v=>v.nodeId===node)!;
      return createGoalProductHandoffBinding(f.actor,{identity:{computerId:node,deviceId:pairedNode.device.id,tokenLookup:parseDeviceToken(pairedNode.node_token)!.lookup},sessionId:session,isCurrent:()=>current,
        artifactDir:fixture().directory,transport:{send:async message=>{sent.push(message);}}});};
    const ops=async()=>fixture().server.db.db.select().from(goalProductHandoffOperations);
    return {...f,intent,sent,binding,ops,invalidate:()=>{current=false;}};
  }
  async function uploadHandoff(f:Awaited<ReturnType<typeof prepareHandoff>>){
    await ensureGoalProductHandoff(f.actor,f.intent);const operation=(await f.ops()).find(v=>v.kind==="upload")!;
    const binding=f.binding(f.source.nodeId),command=await binding.dispatch(operation.id);
    const response=await f.upload();expect(response.statusCode).toBe(200);
    const result={version:1 as const,operation_id:operation.id,payload_digest:operation.payloadDigest,request_digest:f.digest,outcome:"uploaded" as const,closed:true as const,receipt:response.json().transfer};
    await binding.receive({kind:"product.source.operation.result.v1",node_id:f.source.nodeId,command_id:command.id,payload:result});
    return {operation,binding,command,result};
  }
  // The source/H1 fixture above is copied from the R6 semantic-transfer suite.
  // All author/import/verifier/reviewer results below are explicitly controlled data.
  async function prepareImported() {
    const f = await prepareHandoff(); await uploadHandoff(f);
    const imported = (await f.ops()).find(row => row.kind === "import_verify")!;
    const importBinding = f.binding(f.destination.nodeId), command = await importBinding.dispatch(imported.id);
    const measured = controlledDestinationResult(ProductSourceOperationV1Schema.parse(imported.payload), f.researchBytes);
    await importBinding.receive({ kind: "product.source.operation.result.v1", node_id: f.destination.nodeId, command_id: command.id, payload: measured });
    await importBinding.qualify(imported.id);
    const [sourceInstance] = await fixture().server.db.db.select().from(agentInstances).where(eq(agentInstances.id, f.review.source.run.agentInstanceId));
    const [sourceAgent] = await fixture().server.db.db.select().from(agents).where(eq(agents.id, sourceInstance!.agentId));
    await fixture().server.db.db.insert(agents).values({ ...sourceAgent!, id: "imported_reviewer_agent", kind: "reviewer", capabilities: ["code.read", "code.review"] });
    await fixture().server.db.db.insert(agentInstances).values({ ...sourceInstance!, id: "imported_reviewer_instance", agentId: "imported_reviewer_agent",
      computerId: f.destination.nodeId, runtime: "codex", status: "idle", workspaceRoot: f.base.destination.workspace_root });
    const team = { version: 1, reviewer_instance_ids: ["review_instance", "imported_reviewer_instance"],
      members: ["research", "design", "implementation", "validation"].map((stage, index) => ({ stage, agent_instance_id: index % 2 ? "imported_reviewer_instance" : sourceInstance!.id })) };
    await fixture().server.db.db.update(goalAutomations).set({ team, executionMode: "agent_team" }).where(eq(goalAutomations.goalId, f.base.goal_id));
    const originalSupport = f.actor.supportsExecutionFeature;
    f.actor.supportsExecutionFeature = (node, feature) => feature === IMPORTED_PRODUCT_REVIEW_FEATURE_V1 ? node === f.destination.nodeId : originalSupport?.(node, feature) === true;
    const queued: { id: string; control: string }[] = [];
    f.actor.onImportedProductReviewQueued = async (id, control) => { queued.push({ id, control }); };
    const automation = async () => (await fixture().server.db.db.select().from(goalAutomations).where(eq(goalAutomations.goalId, f.base.goal_id)))[0]!;
    const ensure = async () => { const a = await automation(); return fixture().server.db.transaction(tx => ensureGoalImportedProductReview(f.actor, tx, a, f.base.transfer_id)); };
    const sent: ServerToNodeMessage[] = []; let current = true;
    const binding = (sessionId = "imported-session-one") => createGoalImportedProductReviewBinding(f.actor, {
      identity: { computerId: f.destination.nodeId, deviceId: f.destination.device.id, tokenLookup: parseDeviceToken(f.destination.node_token)!.lookup },
      sessionId, isCurrent: () => current, artifactDir: fixture().directory, transport: { send: async frame => { sent.push(frame); } },
    });
    return { ...f, ensure, automation, sent, queued, binding, expireSession: () => { current = false; } };
  }
  function reviewed(row: typeof goalImportedProductReviews.$inferSelect, research: Uint8Array): ImportedProductReviewResultV1 {
    const request = ImportedProductReviewRequestV1Schema.parse(row.request);
    const measure = (start: typeof request.before_start) => {
      const value = controlledDestinationResult({ ...request.operation, intent: { ...request.operation.intent, destination_start: start } }, research);
      if (value.outcome !== "verified") throw Error("Controlled measurement must be verified");
      return { admission: value.admission, fresh: value.fresh };
    };
    return ImportedProductReviewResultV1Schema.parse({ version: 1, review_id: row.id, request_digest: row.requestDigest, outcome: "reviewed", closed: true, execution_authorized: false,
      before: measure(request.before_start), after: measure(request.after_start),
      reviewer: { run_id: request.review_start.run_id, config_digest: hash(request.review_start), closure: "windows-job-and-tools-closed.v1" },
      verdict: { version: 1, review_id: row.id, transfer_id: row.handoffId, subject_digest: request.operation.intent.request.byte_request.source.subject_digest,
        source_export_digest: request.operation.intent.request.source_export_digest, outcome: "accepted", summary: "Controlled substantive imported research verdict; no model was invoked", findings: [] } });
  }
  async function ordinaryTask(id: string) {
    const now = fixture().server.ctx.clock.nowIso();
    await fixture().server.db.db.insert(tasks).values({ id, organizationId: fixture().server.ctx.organizationId, projectId: "proj_artoo", title: id,
      status: "ready", createdByType: "user", createdById: fixture().server.ctx.actorUserId, createdAt: now, updatedAt: now });
    return (instance: string) => assignTask({ ...fixture().server.ctx, onRunQueued: async () => {} }, id, { mode: "manual", agent_instance_id: instance });
  }
  async function otherInstance(computerId: string, id = "other_instance", workspaceRoot = "/unrelated/workspace") {
    const [source] = await fixture().server.db.db.select().from(agentInstances).where(eq(agentInstances.id, "instance_mock_coder"));
    await fixture().server.db.db.insert(agentInstances).values({ ...source!, id, computerId, runtime: "codex", status: "idle", workspaceRoot });
    return id;
  }
  async function prepareDispatcher(f: Pick<Awaited<ReturnType<typeof prepareHandoff>>, "base">) {
    const now = fixture().server.ctx.clock.nowIso();
    await fixture().server.db.db.insert(discussions).values({ id: "controlled_planning", organizationId: fixture().server.ctx.organizationId, goalId: f.base.goal_id,
      roomId: "measurement_room", threadRootId: "measurement_request", taskId: f.base.source.task_id, actorUserId: fixture().server.ctx.actorUserId,
      participants: [{ agent_instance_id: "instance_mock_coder", role: "Controlled planner" }, { agent_instance_id: "review_instance", role: "Controlled planning reviewer" }],
      rounds: 1, maxMinutes: 2, status: "ready", createdAt: now, updatedAt: now, deadlineAt: now });
    await fixture().server.db.db.update(goalAutomations).set({ discussionId: "controlled_planning" }).where(eq(goalAutomations.goalId, f.base.goal_id));
  }

  // Only the already-accepted research and node discovery are controlled here.
  // GoalRunner must create the very first handoff; this helper does not call its primitive.
  async function prepareAutomaticHandoff() {
    const f = await prepareHandoff(true), db = fixture().server.db.db, now = f.actor.clock.nowIso();
    const specs = ["research", "design", "implementation", "validation"].map((stage, index) => TaskSpecSchema.parse({ title: stage,
      development_stage: stage, acceptance_criteria: [stage], dependencies: index ? [{ ref: String(index - 1), type: "blocks" }] : [] }));
    await db.update(plans).set({ taskSpecs: specs }).where(eq(plans.id, f.base.plan_id));
    await db.update(tasks).set({ title: specs[1]!.title, acceptanceCriteria: specs[1]!.acceptance_criteria }).where(eq(tasks.id, "handoff_design"));
    for (const index of [2, 3]) await db.insert(tasks).values({ id: `automatic_stage_${index}`, organizationId: f.actor.organizationId,
      projectId: f.base.project_id, goalId: f.base.goal_id, sourcePlanId: f.base.plan_id, sourcePlanSpecRef: String(index), title: specs[index]!.title,
      acceptanceCriteria: specs[index]!.acceptance_criteria, status: "backlog", createdByType: "system", createdById: "goal_runner", createdAt: now, updatedAt: now });
    const [originalAgent] = await db.select().from(agents).where(eq(agents.id, "agent_mock_coder"));
    const [originalInstance] = await db.select().from(agentInstances).where(eq(agentInstances.id, "instance_mock_coder"));
    for (const suffix of ["a", "b"]) {
      await db.insert(agents).values({ ...originalAgent!, id: `automatic_agent_${suffix}`, capabilities: ["code.read", "code.modify", "code.review"] });
      await db.insert(agentInstances).values({ ...originalInstance!, id: `automatic_instance_${suffix}`, agentId: `automatic_agent_${suffix}`,
        computerId: f.destination.nodeId, runtime: "codex", workspaceRoot: f.base.destination.workspace_root, status: "idle" });
    }
    const team = AutonomousTeamSchema.parse({ version: 1, reviewer_instance_ids: ["instance_mock_coder", "review_instance"],
      members: specs.map(spec => ({ stage: spec.development_stage, agent_instance_id: spec.development_stage === "implementation" ? "review_instance" : "instance_mock_coder" })) });
    await db.update(goalAutomations).set({ team, agentInstanceId: "instance_mock_coder" }).where(eq(goalAutomations.goalId, f.base.goal_id));
    await prepareDispatcher(f);
    const originalSupport = f.actor.supportsExecutionFeature;
    const features = [IMPORTED_PRODUCT_REVIEW_FEATURE_V1, IMPORTED_DESIGN_CONTINUATION_FEATURE_V1, IMPORTED_DESIGN_REVIEW_FEATURE_V1,
      IMPORTED_EXECUTION_FEATURE_V1, IMPORTED_EXECUTION_REVIEW_FEATURE_V1, IMPORTED_VALIDATION_FEATURE_V1, "product-release.acceptance.v1"];
    f.actor.supportsExecutionFeature = (node, feature) => node === f.destination.nodeId && features.includes(feature) || originalSupport?.(node, feature) === true;
    f.actor.getPairedNodeSession = node => {
      const current = [f.source, f.destination].find(value => value.nodeId === node);
      return current ? { computerId: node, deviceId: current.device.id, tokenLookup: parseDeviceToken(current.node_token)!.lookup, sessionId: `controlled_${node}` } : undefined;
    };
    const sourceRoutes = ProductSourceRoutingV1Schema.parse({ version: 1, source_exports: [f.sourceRelease], destination_mappings: [] });
    const destinationRoutes = ProductSourceRoutingV1Schema.parse({ version: 1, source_exports: [], destination_mappings: [{
      source_release: f.sourceRelease, destination_release: f.destinationRelease, command_pairs: f.request.command_pairs }] });
    f.actor.getProductSourceRouting = node => node === f.source.nodeId ? structuredClone(sourceRoutes)
      : node === f.destination.nodeId ? structuredClone(destinationRoutes) : undefined;
    const automation = async () => (await db.select().from(goalAutomations).where(eq(goalAutomations.goalId, f.base.goal_id)))[0]!;
    return { ...f, team, automation };
  }

  it("GoalRunner creates the first cross-computer handoff and team from the original grant and accepted research", async () => {
    const f = await prepareAutomaticHandoff(), db = fixture().server.db.db, originalAutomation = await f.automation();
    const originalContext = await db.select().from(contextPacks).where(eq(contextPacks.id, f.review.source.run.contextPackId!));
    const originalExport = await db.select().from(eventLog).where(eq(eventLog.type, "run.product-source.export.v2"));
    expect(await db.select().from(goalProductHandoffs)).toHaveLength(0);
    const errors: unknown[] = [], dispatched: string[] = [], dispatcher = createGoalAutomationDispatcher(f.actor, async () => {}, error => { errors.push(error); });
    f.actor.onProductSourceOperationQueued = async id => { dispatched.push(id); };
    try { await dispatcher.pump(); await dispatcher.pump(); } finally { await dispatcher.stop(); }
    expect(errors).toEqual([]);
    const handoffs = await db.select().from(goalProductHandoffs); expect(handoffs).toHaveLength(1);
    const intent = ProductSourceHandoffIntentV1Schema.parse(handoffs[0]!.intent);
    expect(intent).toMatchObject({ next_task_id: "handoff_design", request: { source_export: f.proof, command_pairs: f.request.command_pairs,
      byte_request: { authorization: f.base.authorization, source: { node_id: f.source.nodeId }, destination: { node_id: f.destination.nodeId } } },
      destination_start: { agent_instance_id: "automatic_instance_a", context_pack: { payload: { goal_context: { plan: { id: f.base.plan_id, spec_ref: "0" } } } } } });
    expect(await f.ops()).toHaveLength(2);
    expect(dispatched).toEqual([(await f.ops()).find(row => row.kind === "upload")!.id]);
    const updated = await f.automation();
    expect(updated).toMatchObject({ computerId: originalAutomation.computerId, workspaceRoot: originalAutomation.workspaceRoot,
      planningCapabilitySnapshot: originalAutomation.planningCapabilitySnapshot, sourceHandoff: { version: 1, mode: "automatic" } });
    expect(AutonomousTeamSchema.parse(updated.team)).toEqual({ version: 1,
      reviewer_instance_ids: ["instance_mock_coder", "review_instance", "automatic_instance_a", "automatic_instance_b"],
      members: [{ stage: "research", agent_instance_id: "instance_mock_coder" }, { stage: "design", agent_instance_id: "automatic_instance_a" },
        { stage: "implementation", agent_instance_id: "automatic_instance_b" }, { stage: "validation", agent_instance_id: "automatic_instance_a" }] });
    expect(await db.select().from(contextPacks).where(eq(contextPacks.id, f.review.source.run.contextPackId!))).toEqual(originalContext);
    expect(await db.select().from(eventLog).where(eq(eventLog.type, "run.product-source.export.v2"))).toEqual(originalExport);
    expect(await db.select().from(eventLog).where(eq(eventLog.type, "goal.product-handoff.selected"))).toMatchObject([{ actorType: "system", actorId: "goal_runner",
      payload: { actor_user_id: f.actor.actorUserId, source_node_id: f.source.nodeId, destination_node_id: f.destination.nodeId } }]);
  });

  it("selects complementary specialists for design/validation and implementation", async () => {
    const f = await prepareAutomaticHandoff(), db = fixture().server.db.db;
    const [plan] = await db.select().from(plans).where(eq(plans.id, f.base.plan_id));
    const capabilities = [[], ["browser.navigate"], ["shell.run"], ["test.run"]];
    await db.update(plans).set({ taskSpecs: (plan!.taskSpecs as unknown[]).map((value, index) => ({ ...TaskSpecSchema.parse(value), required_capabilities: capabilities[index] })) })
      .where(eq(plans.id, f.base.plan_id));
    for (const index of [1, 2, 3]) await db.update(tasks).set({ requiredCapabilities: capabilities[index] })
      .where(eq(tasks.id, index === 1 ? "handoff_design" : `automatic_stage_${index}`));
    await db.update(computers).set({ capabilities: [] }).where(eq(computers.id, f.destination.nodeId));
    await db.update(agents).set({ capabilities: ["code.read", "code.modify", "code.review", "browser.navigate", "test.run"] }).where(eq(agents.id, "automatic_agent_a"));
    await db.update(agents).set({ capabilities: ["code.read", "code.modify", "code.review", "shell.run"] }).where(eq(agents.id, "automatic_agent_b"));
    const errors: unknown[] = [], dispatcher = createGoalAutomationDispatcher(f.actor, async () => {}, error => { errors.push(error); });
    try { await dispatcher.pump(); } finally { await dispatcher.stop(); }
    expect(errors).toEqual([]); expect(await db.select().from(goalProductHandoffs)).toHaveLength(1);
    expect(AutonomousTeamSchema.parse((await f.automation()).team).members).toEqual([
      { stage: "research", agent_instance_id: "instance_mock_coder" }, { stage: "design", agent_instance_id: "automatic_instance_a" },
      { stage: "implementation", agent_instance_id: "automatic_instance_b" }, { stage: "validation", agent_instance_id: "automatic_instance_a" }]);
  });

  it("selects a later prepared computer when the earlier one lacks an accepted stage capability", async () => {
    const f = await prepareAutomaticHandoff(), db = fixture().server.db.db;
    const [plan] = await db.select().from(plans).where(eq(plans.id, f.base.plan_id));
    await db.update(plans).set({ taskSpecs: (plan!.taskSpecs as unknown[]).map((value, index) => {
      const spec = TaskSpecSchema.parse(value); return index === 1 ? { ...spec, required_capabilities: ["desktop.operate"] } : spec;
    }) }).where(eq(plans.id, f.base.plan_id));
    await db.update(tasks).set({ requiredCapabilities: ["desktop.operate"] }).where(eq(tasks.id, "handoff_design"));
    for (const suffix of ["a", "b"]) {
      const [agent] = await db.select().from(agents).where(eq(agents.id, `automatic_agent_${suffix}`));
      const [instance] = await db.select().from(agentInstances).where(eq(agentInstances.id, `automatic_instance_${suffix}`));
      await db.insert(agents).values({ ...agent!, id: `qualified_agent_${suffix}`, capabilities: ["code.read", "code.modify", "code.review", "desktop.operate"] });
      await db.insert(agentInstances).values({ ...instance!, id: `qualified_instance_${suffix}`, agentId: `qualified_agent_${suffix}`, computerId: f.other.nodeId });
    }
    const support = f.actor.supportsExecutionFeature!, profile = f.actor.supportsVerificationProfile!, release = f.actor.supportsReleaseProfile!;
    const verifier = f.actor.getVerificationCapabilities!, publication = f.actor.getReleaseCapabilities!, routing = f.actor.getProductSourceRouting!, session = f.actor.getPairedNodeSession!;
    const mappedNode = (node: string) => node === f.other.nodeId ? f.destination.nodeId : node;
    f.actor.supportsExecutionFeature = (node, feature) => support(mappedNode(node), feature);
    f.actor.supportsVerificationProfile = (node, ...args) => profile(mappedNode(node), ...args);
    f.actor.supportsReleaseProfile = (node, ...args) => release(mappedNode(node), ...args);
    f.actor.getVerificationCapabilities = (node, ...args) => verifier(mappedNode(node), ...args);
    f.actor.getReleaseCapabilities = (node, ...args) => publication(mappedNode(node), ...args);
    f.actor.getProductSourceRouting = node => routing(mappedNode(node));
    f.actor.getPairedNodeSession = node => node === f.other.nodeId ? { computerId: node, deviceId: f.other.device.id,
      tokenLookup: parseDeviceToken(f.other.node_token)!.lookup, sessionId: "controlled_other" } : session(node);
    const errors: unknown[] = [], dispatcher = createGoalAutomationDispatcher(f.actor, async () => {}, error => { errors.push(error); });
    try { await dispatcher.pump(); } finally { await dispatcher.stop(); }
    expect(errors).toEqual([]); const handoffs = await db.select().from(goalProductHandoffs); expect(handoffs).toHaveLength(1);
    expect(ProductSourceHandoffIntentV1Schema.parse(handoffs[0]!.intent)).toMatchObject({ request: { byte_request: { destination: { node_id: f.other.nodeId } } },
      destination_start: { agent_instance_id: "qualified_instance_a" } });
  });

  it.each(["missing mapping", "one agent", "missing stage capability", "missing reviewer declarations", "occupied workspace", "missing paired session", "session replaced", "source export changed"] as const)
    ("keeps the original team and creates no handoff when %s", async failure => {
      const f = await prepareAutomaticHandoff(), db = fixture().server.db.db, originalAutomation = await f.automation();
      if (failure === "missing mapping") {
        const get = f.actor.getProductSourceRouting!;
        f.actor.getProductSourceRouting = node => node === f.destination.nodeId ? undefined : get(node);
      } else if (failure === "one agent") {
        await db.update(agentInstances).set({ agentId: "automatic_agent_a" }).where(eq(agentInstances.id, "automatic_instance_b"));
      } else if (failure === "missing stage capability") {
        const [plan] = await db.select().from(plans).where(eq(plans.id, f.base.plan_id));
        await db.update(plans).set({ taskSpecs: (plan!.taskSpecs as unknown[]).map((value, index) => {
          const spec = TaskSpecSchema.parse(value); return index === 2 ? { ...spec, required_capabilities: ["desktop.operate"] } : spec;
        }) }).where(eq(plans.id, f.base.plan_id));
        await db.update(tasks).set({ requiredCapabilities: ["desktop.operate"] }).where(eq(tasks.id, "automatic_stage_2"));
      } else if (failure === "missing reviewer declarations") {
        for (const suffix of ["a", "b"]) await db.update(agents).set({ capabilities: ["code.modify"] }).where(eq(agents.id, `automatic_agent_${suffix}`));
        await db.update(computers).set({ capabilities: ["code.read", "code.review"] }).where(eq(computers.id, f.destination.nodeId));
      } else if (failure === "occupied workspace") {
        await ordinaryTask("automatic_workspace_occupant_task");
        await otherInstance(f.destination.nodeId, "automatic_occupant_instance", f.base.destination.workspace_root);
        const [source] = await db.select().from(runs).where(eq(runs.id, f.base.source.run_id));
        await db.insert(runs).values({ ...source!, id: "controlled_workspace_occupant", taskId: "automatic_workspace_occupant_task", computerId: f.destination.nodeId,
          agentInstanceId: "automatic_occupant_instance", status: "running", contextPackId: null, workspaceRoot: f.base.destination.workspace_root });
      } else if (failure === "missing paired session") {
        const get = f.actor.getPairedNodeSession!; f.actor.getPairedNodeSession = node => node === f.destination.nodeId ? undefined : get(node);
      } else if (failure === "session replaced") {
        const get = f.actor.getPairedNodeSession!; let version = 0;
        f.actor.getPairedNodeSession = node => { const session = get(node); return node === f.destination.nodeId && session ? { ...session, sessionId: `replaced_${++version}` } : session; };
      } else {
        const get = f.actor.getProductSourceRouting!; let sourceReads = 0;
        f.actor.getProductSourceRouting = node => node === f.source.nodeId && ++sourceReads > 1 ? { version: 1, source_exports: [], destination_mappings: [] } : get(node);
      }
      const errors: unknown[] = [], dispatcher = createGoalAutomationDispatcher(f.actor, async () => {}, error => { errors.push(error); });
      try { await dispatcher.pump(); } finally { await dispatcher.stop(); }
      expect(await db.select().from(goalProductHandoffs)).toHaveLength(0); expect(await f.ops()).toHaveLength(0);
      expect(await f.automation()).toMatchObject({ team: originalAutomation.team, computerId: originalAutomation.computerId, status: "waiting" });
      expect(await db.select().from(eventLog).where(eq(eventLog.type, "goal.product-handoff.selected"))).toHaveLength(0);
      expect(errors.length).toBeGreaterThan(0);
    });

  async function prepareDesign() {
    const f = await prepareImported(), review = await f.ensure(), peer = f.binding(), command = await peer.dispatch(review.id);
    await peer.receive({ kind: "product.source.review.result.v1", node_id: f.destination.nodeId, command_id: command.id, payload: reviewed(review, f.researchBytes) });
    // H3 binds the materialized task to the exact accepted plan, rather than the H1 helper's display alias.
    await fixture().server.db.db.update(tasks).set({ title: "Design" }).where(eq(tasks.id, "handoff_design"));
    const [sourceAgent] = await fixture().server.db.db.select().from(agents).where(eq(agents.id, "agent_mock_coder"));
    const [sourceInstance] = await fixture().server.db.db.select().from(agentInstances).where(eq(agentInstances.id, "instance_mock_coder"));
    await fixture().server.db.db.insert(agents).values({ ...sourceAgent!, id: "design_writer_agent", capabilities: ["code.read", "code.modify", "code.review"] });
    await fixture().server.db.db.insert(agentInstances).values({ ...sourceInstance!, id: "design_writer_instance", agentId: "design_writer_agent",
      runtime: "codex", computerId: f.destination.nodeId, workspaceRoot: f.base.destination.workspace_root, status: "idle" });
    const a = await f.automation(), team = a.team as { members: { stage: string; agent_instance_id: string }[] };
    await fixture().server.db.db.update(goalAutomations).set({ team: { ...team, members: team.members.map(member => member.stage === "design"
      ? { ...member, agent_instance_id: "design_writer_instance" } : member) } }).where(eq(goalAutomations.goalId, f.base.goal_id));
    const support = f.actor.supportsExecutionFeature;
    f.actor.supportsExecutionFeature = (node, feature) => feature === IMPORTED_DESIGN_CONTINUATION_FEATURE_V1 ? node === f.destination.nodeId : support?.(node, feature) === true;
    f.actor.productSourceArtifactDir = fixture().directory;
    const sent: ServerToNodeMessage[] = [], queued: { id: string; control: string }[] = []; let current = true;
    f.actor.onImportedDesignContinuationQueued = async (id, control) => { queued.push({ id, control }); };
    const ensure = async () => { const automation = await f.automation(); return fixture().server.db.transaction(tx => ensureGoalImportedDesignContinuation(f.actor, tx, automation, review.id)); };
    const binding = (sessionId = "design-session") => createImportedDesignContinuationBinding(f.actor, {
      identity: { computerId: f.destination.nodeId, deviceId: f.destination.device.id, tokenLookup: parseDeviceToken(f.destination.node_token)!.lookup },
      sessionId, isCurrent: () => current, transport: { async send(frame) { sent.push(frame); } },
    });
    const failEvent = (runId: string) => ingestWireRunEvent(f.actor, { kind: "run.event", node_id: f.destination.nodeId, run_id: runId, sequence: 0,
      event: { type: "run.lifecycle", payload: { phase: "failed", reason: "Controlled precondition failure; no native execution" } } });
    return { ...f, review, ensureDesign: ensure, designBinding: binding, designSent: sent, designQueued: queued, failEvent, invalidateDesign: () => { current = false; } };
  }
  // H4 fixtures commit real DB lifecycle/evidence/dedicated receipts; the verifier/model payloads are controlled data.
  async function completedDesign(options: { omitEvidence?: boolean; legacy?: boolean } = {}) {
    const f = await prepareDesign(), row = await f.ensureDesign(), binding = f.designBinding(), command = await binding.dispatch(row.id);
    const request = ImportedDesignContinuationRequestV1Schema.parse(row.request), verification = controlledDesignVerification(request);
    const lifecycle = (sequence: number, phase: "started" | "completed") => ingestWireRunEvent(f.actor, { kind: "run.event", node_id: f.destination.nodeId,
      run_id: row.runId, sequence, event: { type: "run.lifecycle", payload: { phase } } });
    await lifecycle(0, "started");
    if (!options.omitEvidence) await ingestWireRunEvent(f.actor, { kind: "run.event", node_id: f.destination.nodeId, run_id: row.runId, sequence: 1,
      event: { type: "run.verification", payload: verification } });
    await lifecycle(options.omitEvidence ? 1 : 2, "completed");
    const result = importedCompletedDesignResultFixture(request, verification);
    if (options.legacy && result.outcome === "finished") delete result.verified_design;
    const message = { kind: "product.source.design.result.v1" as const, node_id: f.destination.nodeId, command_id: command.id, payload: result };
    if (!options.omitEvidence) await binding.receive(message);
    const identities = [f.source, f.destination].map(node => ({ computerId: node.nodeId, deviceId: node.device.id,
      tokenLookup: parseDeviceToken(node.node_token)!.lookup, sessionId: node.nodeId === f.destination.nodeId ? "design-session" : "source-session" }));
    let sessionValues = identities.map(value => ({ ...value }));
    f.actor.getPairedNodeSession = id => sessionValues.find(value => value.computerId === id);
    const support = f.actor.supportsExecutionFeature;
    f.actor.supportsExecutionFeature = (id, feature) => feature === IMPORTED_DESIGN_REVIEW_FEATURE_V1 ? id === f.destination.nodeId : support?.(id, feature) === true;
    const sent: ServerToNodeMessage[] = [], queued: { id: string; control: string }[] = []; let current = true;
    f.actor.onImportedDesignReviewQueued = async (id, control) => { queued.push({ id, control }); };
    const h4Binding = (sessionId = "design-session") => createImportedDesignReviewBinding(f.actor, { identity: identities[1]!, sessionId,
      isCurrent: () => current, transport: { async send(frame) { sent.push(frame); } } });
    const ensureH4 = async () => { const a = await f.automation(); return fixture().server.db.transaction(tx => ensureGoalImportedDesignReview(f.actor, tx, a, row.id)); };
    const advanceH4 = async () => { const a = await f.automation(); return fixture().server.db.transaction(tx => advanceGoalImportedDesignReview(f.actor, tx, a, row.id)); };
    return { ...f, row, request, verification, message, authorBinding: binding, ensureH4, advanceH4, h4Binding, h4Sent: sent, h4Queued: queued,
      invalidateH4: () => { current = false; }, replaceSession: (node = f.destination.nodeId) => { sessionValues = sessionValues.map(value => value.computerId === node ? { ...value, sessionId: "replacement-session" } : value); } };
  }
  function reviewedDesign(row: typeof goalImportedDesignReviews.$inferSelect) {
    const request = ImportedDesignReviewRequestV1Schema.parse(row.request), subject = importedDesignReviewSubjectV1(request, sha);
    if (request.continuation_result.outcome !== "finished" || !request.continuation_result.verified_design) throw Error("Controlled completed design missing");
    const verification = request.continuation_result.verified_design.verification;
    const measurement = (start: typeof request.before_start) => ({ run_id: start.run_id, config_digest: hash(start), closure: "windows-job-and-tools-closed.v1",
      scope: "all-declared-workspace-design-cases", verification: { ...structuredClone(verification), request_id: start.verification!.request_id } });
    return ImportedDesignReviewResultV1Schema.parse({ version: 1, review_id: row.id, request_digest: row.requestDigest, execution_authorized: false, outcome: "reviewed", closed: true,
      before: measurement(request.before_start), after: measurement(request.after_start), reviewer: { run_id: request.review_start.run_id, config_digest: hash(request.review_start), closure: "windows-job-and-tools-closed.v1" },
      verdict: { version: 1, review_id: row.id, continuation_id: row.continuationId, completed_design_digest: subject.completed_design_digest, subject_digest: subject.subject_digest,
        outcome: "accepted", summary: "Controlled independent design review; no native verifier or model was executed", findings: [] } });
  }
  async function prepareExecution(options: { accept?: boolean; receiptFailure?: boolean } = {}) {
    const f = await completedDesign(), now = f.actor.clock.nowIso();
    const [plan] = await fixture().server.db.db.select().from(plans).where(eq(plans.id, f.base.plan_id));
    const implementation = TaskSpecSchema.parse({ development_stage: "implementation", title: "Implement", acceptance_criteria: ["Implement accepted design"], dependencies: [{ ref: "1", type: "blocks" }] });
    const validation = TaskSpecSchema.parse({ development_stage: "validation", title: "Validate", acceptance_criteria: ["Validate implementation"], dependencies: [{ ref: "2", type: "blocks" }] });
    await fixture().server.db.db.update(plans).set({ taskSpecs: [...plan!.taskSpecs as unknown[], implementation, validation] }).where(eq(plans.id, plan!.id));
    for (const [offset, spec] of [implementation, validation].entries()) await fixture().server.db.db.insert(tasks).values({ id: offset === 0 ? "h5-implementation" : "h5-validation",
      organizationId: f.actor.organizationId, projectId: f.base.project_id, goalId: f.base.goal_id, sourcePlanId: plan!.id, sourcePlanSpecRef: String(offset + 2),
      title: spec.title, description: spec.description, requiredCapabilities: spec.required_capabilities, acceptanceCriteria: spec.acceptance_criteria,
      status: "backlog", createdByType: "system", createdById: "goal_runner", createdAt: now, updatedAt: now });
    const [writer] = await fixture().server.db.db.select().from(agentInstances).where(eq(agentInstances.id, "design_writer_instance"));
    await fixture().server.db.db.insert(agentInstances).values({ ...writer!, id: "implementation_writer_instance" });
    const automation = await f.automation(), team = automation.team as { members: { stage: string; agent_instance_id: string }[] };
    await fixture().server.db.db.update(goalAutomations).set({ team: { ...team, members: team.members.map(member => member.stage === "implementation"
      ? { ...member, agent_instance_id: "implementation_writer_instance" } : member) } }).where(eq(goalAutomations.goalId, f.base.goal_id));
    const support = f.actor.supportsExecutionFeature;
    f.actor.supportsExecutionFeature = (node, feature) => feature === IMPORTED_EXECUTION_FEATURE_V1 ? node === f.destination.nodeId : support?.(node, feature) === true;
    const h4 = await f.ensureH4();
    const peer = options.receiptFailure ? createImportedDesignReviewBinding(f.actor, { identity: { computerId: f.destination.nodeId, deviceId: f.destination.device.id,
      tokenLookup: parseDeviceToken(f.destination.node_token)!.lookup }, sessionId: "design-session", isCurrent: () => true,
      transport: { async send(frame) { if (frame.type === "product.source.design-review.receipt.v1") throw Error("controlled receipt send failure"); } } }) : f.h4Binding();
    const command = await peer.dispatch(h4.id), message = { kind: "product.source.design-review.result.v1" as const, node_id: f.destination.nodeId, command_id: command.id, payload: reviewedDesign(h4) };
    if (options.receiptFailure) await expect(peer.receive(message)).rejects.toThrow("controlled receipt"); else await peer.receive(message);
    if (options.accept !== false) await f.advanceH4();
    const ensureH5 = async () => { const current = await f.automation(); return fixture().server.db.transaction(tx => ensureGoalImportedExecution(f.actor, tx, current, h4.id)); };
    const advanceH5 = async () => { const current = await f.automation(); return fixture().server.db.transaction(tx => advanceGoalImportedExecution(f.actor, tx, current, h4.id)); };
    const sent: ServerToNodeMessage[] = [], queued: { id: string; control: string }[] = [];
    f.actor.onImportedExecutionQueued = async (id, control) => { queued.push({ id, control }); };
    const h5Binding = (sessionId = "design-session") => createImportedExecutionBinding(f.actor, { identity: { computerId: f.destination.nodeId,
      deviceId: f.destination.device.id, tokenLookup: parseDeviceToken(f.destination.node_token)!.lookup }, sessionId, isCurrent: () => true, transport: { async send(frame) { sent.push(frame); }, subscribe() { return () => {}; }, async close() {} } });
    return { ...f, h4, ensureH5, advanceH5, h5Binding, h5Sent: sent, h5Queued: queued };
  }
  function executionResult(row: typeof goalImportedExecutions.$inferSelect) {
    const request = ImportedExecutionRequestV1Schema.parse(row.request), h3 = request.review_request.continuation_result;
    if (h3.outcome !== "finished" || !h3.verified_design) throw Error("Controlled completed H3 required");
    const verification = structuredClone(h3.verified_design.verification), start = request.run_start, source = start.context_pack.payload.transferred_product_input;
    verification.request_id = start.verification!.request_id; verification.subject_digest = sha("controlled new implementation source");
    verification.required_files.push({ path: ".artoo/product/implementation.md", checksum: sha("implemented"), size: 11 });
    for (const check of verification.checks) { if (check.observation?.version !== 3) throw Error("Controlled v3 required"); check.observation.stage = "implementation"; }
    const bound = importedExecutionContextV1(request, sha);
    return ImportedExecutionResultV1Schema.parse({ version: 1, execution_id: row.id, request_digest: importedExecutionRequestDigestV1(request, sha), run_id: row.runId,
      outcome: "finished", closed: true, verified_execution: { version: 1, stage: "implementation", execution_id: row.id, request_digest: row.requestDigest,
        run_id: row.runId, run_start_digest: hash(start), author: request.writer, destination: h3.verified_design.destination,
        initial_subject_digest: bound.initial_subject_digest, subject_digest: verification.subject_digest, h4_review_id: request.review_request.review_id,
        h4_result_digest: bound.h4_result_digest, acceptance_event_id: request.acceptance_event_id,
        transfer_id: source.transfer_id, source_export_digest: source.source_export_digest, mapping_digest: source.mapping_digest, research_provenance_digest: source.research_provenance_digest,
        closure: "windows-job-and-tools-closed.v1", scope: "all-declared-workspace-implementation-cases", verification } });
  }
  async function executionEvents(f: Awaited<ReturnType<typeof prepareExecution>>, row: typeof goalImportedExecutions.$inferSelect, withEvidence = true) {
    const result = executionResult(row); if (result.outcome !== "finished" || !result.verified_execution) throw Error("Controlled H5 result required");
    const lifecycle = (sequence: number, phase: "started" | "completed") => ingestWireRunEvent(f.actor, { kind: "run.event", node_id: row.computerId, run_id: row.runId,
      sequence, event: { type: "run.lifecycle", payload: { phase } } });
    await lifecycle(0, "started");
    if (withEvidence) await ingestWireRunEvent(f.actor, { kind: "run.event", node_id: row.computerId, run_id: row.runId, sequence: 1, event: { type: "run.verification", payload: result.verified_execution.verification } });
    await lifecycle(withEvidence ? 2 : 1, "completed"); return result;
  }
  async function prepareH6() {
    const f = await prepareExecution(), h5 = await f.ensureH5(), peer = f.h5Binding(), command = await peer.dispatch(h5.id), result = await executionEvents(f, h5);
    await peer.receive({ kind: "product.source.execution.result.v1", node_id: h5.computerId, command_id: command.id, payload: result });
    await f.advanceH5();
    const support = f.actor.supportsExecutionFeature;
    f.actor.supportsExecutionFeature = (node, feature) => feature === IMPORTED_EXECUTION_REVIEW_FEATURE_V1 ? node === f.destination.nodeId : support?.(node, feature) === true;
    const [goal] = await fixture().server.db.db.select().from(goals).where(eq(goals.id, h5.goalId));
    await fixture().server.db.db.update(goals).set({ budgets: { ...goal!.budgets as object, max_retries: 3 } }).where(eq(goals.id, h5.goalId));
    const queued: { id: string; control: string; kind: string }[] = [], sent: ServerToNodeMessage[] = [];
    f.actor.onImportedExecutionReviewQueued = async (id, control) => { queued.push({ id, control, kind: "review" }); };
    f.actor.onImportedExecutionRepairQueued = async (id, control) => { queued.push({ id, control, kind: "repair" }); };
    const identity = { computerId: f.destination.nodeId, deviceId: f.destination.device.id, tokenLookup: parseDeviceToken(f.destination.node_token)!.lookup };
    const transport = { async send(frame: ServerToNodeMessage) { sent.push(frame); }, subscribe() { return () => {}; }, async close() {} };
    const h6Binding = (receiptFailure = false) => createImportedExecutionReviewBinding(f.actor, { identity, sessionId: "design-session", isCurrent: () => true,
      transport: { async send(frame) { if (receiptFailure && frame.type === "product.source.execution-review.receipt.v1") throw Error("controlled H6 receipt send failure"); await transport.send(frame); } } });
    const repairBinding = () => createImportedExecutionRepairBinding(f.actor, { identity, sessionId: "design-session", isCurrent: () => true, transport });
    const ensureH6 = async () => { const a = await f.automation(); return fixture().server.db.transaction(tx => ensureGoalImportedExecutionReview(f.actor, tx, a, h5.id)); };
    const advanceH6 = async () => { const a = await f.automation(); return fixture().server.db.transaction(tx => advanceGoalImportedExecutionReview(f.actor, tx, a, h5.id)); };
    const ensureRepair = async (reviewId: string) => { const a = await f.automation(); return fixture().server.db.transaction(tx => ensureGoalImportedExecutionRepair(f.actor, tx, a, reviewId)); };
    const advanceRepair = async (reviewId: string) => { const a = await f.automation(); return fixture().server.db.transaction(tx => advanceGoalImportedExecutionRepair(f.actor, tx, a, reviewId)); };
    return { ...f, h5, ensureH6, advanceH6, ensureRepair, advanceRepair, h6Binding, repairBinding, h6Queued: queued, h6Sent: sent };
  }
  function reviewedImplementation(row: typeof goalImportedExecutionReviews.$inferSelect, outcome: "accepted" | "rejected" = "accepted") {
    const request = ImportedExecutionReviewRequestV1Schema.parse(row.request), subject = importedExecutionReviewSubjectV1(request, sha);
    const measurement = (start: typeof request.before_start) => ({ run_id: start.run_id, config_digest: hash(start), closure: "windows-job-and-tools-closed.v1",
      scope: "all-declared-workspace-implementation-cases", verification: { ...structuredClone(request.source.verification), request_id: start.verification!.request_id } });
    return ImportedExecutionReviewResultV1Schema.parse({ version: 1, review_id: row.id, request_digest: row.requestDigest, execution_authorized: false,
      outcome: "reviewed", closed: true, before: measurement(request.before_start), after: measurement(request.after_start),
      reviewer: { run_id: request.review_start.run_id, config_digest: hash(request.review_start), closure: "windows-job-and-tools-closed.v1" },
      verdict: { version: 1, review_id: row.id, source_digest: subject.source_digest, subject_digest: subject.subject_digest, outcome,
        summary: "Controlled independent implementation verdict; no live model or verifier executed",
        findings: outcome === "rejected" ? [{ severity: "blocking", description: "Controlled missing saved-entry behavior", file: "index.html" }] : [] } });
  }
  async function rejectedImplementation(f: Awaited<ReturnType<typeof prepareH6>>) {
    const review = await f.ensureH6(), peer = f.h6Binding(), command = await peer.dispatch(review.id);
    await peer.receive({ kind: "product.source.execution-review.result.v1", node_id: review.computerId, command_id: command.id, payload: reviewedImplementation(review, "rejected") });
    return review;
  }
  function repairedImplementation(row: typeof goalImportedExecutionRepairs.$inferSelect) {
    const request = ImportedExecutionRepairRequestV1Schema.parse(row.request), verification = structuredClone(request.source.verification), start = request.run_start;
    verification.request_id = start.verification!.request_id; verification.subject_digest = sha(`controlled repaired implementation ${row.attemptIndex}`);
    verification.required_files = verification.required_files.map(file => file.path === ".artoo/product/implementation.md" ? { ...file, checksum: sha(`repair ${row.attemptIndex}`) } : file);
    const destination = request.execution_request.review_request.continuation_request.review_request.operation.intent.request.byte_request.destination;
    const source = start.context_pack.payload.transferred_product_input!;
    return ImportedExecutionRepairResultV1Schema.parse({ version: 1, repair_id: row.id, request_digest: row.requestDigest, run_id: row.runId, outcome: "finished", closed: true,
      verified_repair: { version: 1, stage: "implementation", repair_id: row.id, request_digest: row.requestDigest, run_id: row.runId, run_start_digest: hash(start), author: request.writer,
        destination: { node_id: destination.node_id, workspace_root: destination.workspace_root, profile_id: destination.profile_id, profile_digest: destination.capabilities.profile_digest },
        initial_subject_digest: request.source.subject_digest, subject_digest: verification.subject_digest, base_execution_id: row.baseExecutionId, review_id: row.reviewId,
        review_request_digest: request.review_request_digest, review_result_digest: request.review_result_digest,
        authorization_event_id: row.authorizationEventId, attempt_index: row.attemptIndex, transfer_id: source.transfer_id,
        source_export_digest: source.source_export_digest, mapping_digest: source.mapping_digest, research_provenance_digest: source.research_provenance_digest,
        closure: "windows-job-and-tools-closed.v1", scope: "all-declared-workspace-implementation-cases", verification } });
  }
  async function repairEvents(f: Awaited<ReturnType<typeof prepareH6>>, row: typeof goalImportedExecutionRepairs.$inferSelect, withEvidence = true) {
    const result = repairedImplementation(row); if (result.outcome !== "finished" || !result.verified_repair) throw Error("Controlled repair completion required");
    await ingestWireRunEvent(f.actor, { kind: "run.event", node_id: row.computerId, run_id: row.runId, sequence: 0, event: { type: "run.lifecycle", payload: { phase: "started" } } });
    if (withEvidence) await ingestWireRunEvent(f.actor, { kind: "run.event", node_id: row.computerId, run_id: row.runId, sequence: 1, event: { type: "run.verification", payload: result.verified_repair.verification } });
    await ingestWireRunEvent(f.actor, { kind: "run.event", node_id: row.computerId, run_id: row.runId, sequence: withEvidence ? 2 : 1, event: { type: "run.lifecycle", payload: { phase: "completed" } } });
    return result;
  }
  // H7 fixtures exercise real durable Server boundaries. Every model/verifier/HTTP result below is explicitly controlled data.
  async function prepareH7() {
    const f = await prepareH6(), automation = await f.automation();
    // This fixture has already accepted its plan. Preserve that planning link so
    // GoalRunner exercises H7/budget handling instead of starting new planning.
    await prepareDispatcher(f);
    const team = automation.team as { members: { stage: string; agent_instance_id: string }[] };
    await fixture().server.db.db.update(goalAutomations).set({ team: { ...team, members: team.members.map(member => member.stage === "validation"
      ? { ...member, agent_instance_id: "design_writer_instance" } : member) } }).where(eq(goalAutomations.goalId, f.base.goal_id));
    const h6 = await f.ensureH6(), h6Peer = f.h6Binding(), command = await h6Peer.dispatch(h6.id);
    await h6Peer.receive({ kind: "product.source.execution-review.result.v1", node_id: h6.computerId, command_id: command.id, payload: reviewedImplementation(h6) });
    await f.advanceH6();
    const support = f.actor.supportsExecutionFeature;
    f.actor.supportsExecutionFeature = (node, feature) => feature === IMPORTED_VALIDATION_FEATURE_V1 ? node === f.destination.nodeId : support?.(node, feature) === true;
    const identity = { computerId: f.destination.nodeId, deviceId: f.destination.device.id, tokenLookup: parseDeviceToken(f.destination.node_token)!.lookup };
    const sent: ServerToNodeMessage[] = [], queued: { id: string; control: string; kind: string }[] = [];
    const transport = { async send(frame: ServerToNodeMessage) { sent.push(frame); }, subscribe() { return () => {}; }, async close() {} };
    f.actor.onImportedValidationQueued = async (id, control) => { queued.push({ id, control, kind: "validation" }); };
    f.actor.onImportedValidationReviewQueued = async (id, control) => { queued.push({ id, control, kind: "validation-review" }); };
    const authorPeer = (receiptFailure = false, sessionId = "design-session") => createImportedValidationBinding(f.actor, { identity, sessionId, isCurrent: () => true,
      transport: { async send(frame) { if (receiptFailure && frame.type === "product.source.validation.receipt.v1") throw Error("controlled H7 author receipt failure"); await transport.send(frame); } } });
    const reviewPeer = (receiptFailure = false) => createImportedValidationReviewBinding(f.actor, { identity, sessionId: "design-session", isCurrent: () => true,
      transport: { async send(frame) { if (receiptFailure && frame.type === "product.source.validation-review.receipt.v1") throw Error("controlled H7 review receipt failure"); await transport.send(frame); } } });
    const ensure = async () => { const a = await f.automation(); return fixture().server.db.transaction(tx => ensureGoalImportedValidation(f.actor, tx, a, h6.id)); };
    const advanceAuthor = async (id: string) => { const a = await f.automation(); return fixture().server.db.transaction(tx => advanceGoalImportedValidation(f.actor, tx, a, id)); };
    const ensureReview = async (id: string) => { const a = await f.automation(); return fixture().server.db.transaction(tx => ensureGoalImportedValidationReview(f.actor, tx, a, id)); };
    const advanceReview = async (id: string) => { const a = await f.automation(); return fixture().server.db.transaction(tx => advanceGoalImportedValidationReview(f.actor, tx, a, id)); };
    const repair = async (id: string, kind: "review" | "failure" = "review") => { const a = await f.automation(); return fixture().server.db.transaction(tx => ensureGoalImportedValidationRepair(f.actor, tx, a, id, kind)); };
    return { ...f, h6, identity, authorPeer, reviewPeer, ensure, advanceAuthor, ensureReview, advanceReview, repair, validationSent: sent, validationQueued: queued };
  }
  function validationResult(row: typeof goalImportedValidations.$inferSelect, failure?: "author-failed" | "verification-failed") {
    const request = ImportedValidationRequestV1Schema.parse(row.request), start = request.run_start;
    const verification = structuredClone(request.origin.implementation_source.verification);
    verification.request_id = start.verification.request_id; verification.subject_digest = sha(`controlled validation source ${row.generation}`);
    verification.required_files = verification.required_files.map(file => file.path === ".artoo/product/implementation.md" ? { ...file, checksum: sha(`controlled H7 edit ${row.generation}`) } : file);
    verification.required_files.push({ path: ".artoo/product/validation.json", checksum: sha("controlled validation report"), size: 28 });
    for (const check of verification.checks) { if (check.observation?.version !== 3) throw Error("Controlled v3 required"); check.observation.stage = "validation"; }
    if (failure === "verification-failed") { verification.outcome = "failed"; verification.reason = "Controlled verifier assertion failed"; delete verification.measurement_plan;
      for (const check of verification.checks) { check.exit_code = 1; delete check.observation; } }
    const manifest = { directories: [".artoo", ".artoo/product"], files: request.origin.implementation_source.verification.required_files
      .map((file, index) => ({ ...file, reference: `controlled_baseline_${index}` })) };
    const destination = request.origin.execution_request.review_request.continuation_request.review_request.operation.intent.request.byte_request.destination;
    const completion = { version: 1, validation_id: row.id, request_digest: row.requestDigest, run_id: row.runId, root_validation_id: row.rootValidationId, generation: row.generation,
      origin_digest: importedValidationOriginDigestV1(request.origin, sha), author: request.writer, run_start_digest: hash(start),
      destination: { node_id: row.computerId, workspace_root: row.workspaceRoot, profile_id: destination.profile_id, profile_digest: destination.capabilities.profile_digest },
      initial_subject_digest: request.source.subject_digest, subject_digest: verification.subject_digest, authorization_event_id: row.authorizationEventId, attempt_index: row.attemptIndex,
      baseline: { version: 1, snapshot_id: `controlled_baseline_${row.generation}`, subject_digest: request.source.subject_digest, ...manifest, manifest_digest: hash(manifest) },
      closure: "windows-job-and-tools-closed.v1" };
    const control = { version: 1, validation_id: row.id, request_digest: row.requestDigest, run_id: row.runId, closed: true };
    return ImportedValidationResultV1Schema.parse(failure ? { ...control, outcome: "failed", reason: "Controlled closed failure", closed_failure: { ...completion,
      failure_kind: failure, reason: "Controlled closed failure", ...(failure === "verification-failed" ? { verification } : {}) } }
      : { ...control, outcome: "finished", verified_validation: { ...completion, stage: "validation", scope: "all-declared-workspace-validation-cases", verification } });
  }
  async function validationEvents(f: Awaited<ReturnType<typeof prepareH7>>, row: typeof goalImportedValidations.$inferSelect,
    options: { omitEvidence?: boolean; failure?: "author-failed" | "verification-failed" } = {}) {
    const result = validationResult(row, options.failure), verification = result.outcome === "finished" ? result.verified_validation.verification
      : result.outcome === "failed" ? result.closed_failure?.verification : undefined;
    let sequence = 0;
    await ingestWireRunEvent(f.actor, { kind: "run.event", node_id: row.computerId, run_id: row.runId, sequence: sequence++, event: { type: "run.lifecycle", payload: { phase: "started" } } });
    if (verification && !options.omitEvidence) await ingestWireRunEvent(f.actor, { kind: "run.event", node_id: row.computerId, run_id: row.runId, sequence: sequence++, event: { type: "run.verification", payload: verification } });
    await ingestWireRunEvent(f.actor, { kind: "run.event", node_id: row.computerId, run_id: row.runId, sequence, event: { type: "run.lifecycle",
      payload: options.failure ? { phase: "failed", reason: "Controlled validation failure" } : { phase: "completed" } } });
    return result;
  }
  async function completedValidation(f: Awaited<ReturnType<typeof prepareH7>>, row?: typeof goalImportedValidations.$inferSelect) {
    row ??= await f.ensure();
    const peer = f.authorPeer(), command = await peer.dispatch(row.id), result = await validationEvents(f, row);
    await peer.receive({ kind: "product.source.validation.result.v1", node_id: row.computerId, command_id: command.id, payload: result });
    return (await f.advanceAuthor(row.id)).validation;
  }
  function validationReviewResult(row: typeof goalImportedValidationReviews.$inferSelect, outcome: "accepted" | "rejected" = "accepted") {
    const request = ImportedValidationReviewRequestV1Schema.parse(row.request), subject = importedValidationReviewSubjectV1(request, sha);
    const measure = (start: typeof request.before_start) => ({ run_id: start.run_id, config_digest: hash(start), closure: "windows-job-and-tools-closed.v1",
      scope: "all-declared-workspace-validation-cases", verification: { ...structuredClone(request.source.verification!), request_id: start.verification.request_id } });
    return ImportedValidationReviewResultV1Schema.parse({ version: 1, review_id: row.id, request_digest: row.requestDigest, execution_authorized: false, outcome: "reviewed", closed: true,
      before: measure(request.before_start), after: measure(request.after_start), reviewer: { run_id: request.review_start.run_id, config_digest: hash(request.review_start), closure: "windows-job-and-tools-closed.v1" },
      verdict: { version: 1, review_id: row.id, validation_id: row.validationId, source_digest: subject.source_digest, subject_digest: subject.subject_digest, outcome,
        summary: "Controlled full-product verdict, not a live model review", findings: outcome === "rejected" ? [{ severity: "blocking", description: "Controlled regression in saved entries", file: "index.html" }] : [] } });
  }
  async function settleValidationReview(f: Awaited<ReturnType<typeof prepareH7>>, author: typeof goalImportedValidations.$inferSelect, outcome: "accepted" | "rejected" = "accepted") {
    const row = await f.ensureReview(author.id), peer = f.reviewPeer(), command = await peer.dispatch(row.id);
    await peer.receive({ kind: "product.source.validation-review.result.v1", node_id: row.computerId, command_id: command.id, payload: validationReviewResult(row, outcome) });
    return (await f.advanceReview(author.id)).review;
  }
  // H9 uses real database/session/delivery boundaries with explicitly controlled
  // guardian and verifier messages. These fixtures never establish native closure.
  async function prepareH9(kind: "author" | "publication" = "author") {
    const f = await prepareH7(), db = fixture().server.db.db, support = f.actor.supportsExecutionFeature;
    f.actor.supportsExecutionFeature = (node, feature) => [PRODUCT_SOURCE_RECOVERY_FEATURE_V1, IMPORTED_RECOVERY_VALIDATION_FEATURE_V1, IMPORTED_RECOVERY_VALIDATION_REVIEW_FEATURE_V1].includes(feature)
      ? node === f.destination.nodeId : support?.(node, feature) === true;
    const previousSession = f.actor.getPairedNodeSession!;
    let sessionId = "design-session";
    f.actor.getPairedNodeSession = node => node === f.destination.nodeId ? { ...f.identity, sessionId } : previousSession(node);
    const sent: ServerToNodeMessage[] = [], transport = { async send(frame: ServerToNodeMessage) { sent.push(frame); } };
    const peer = (session = sessionId, receiptFailure = false) => createSourceRecoveryBinding(f.actor, { identity: f.identity, sessionId: session,
      isCurrent: () => sessionId === session, transport: { async send(frame) {
        if (receiptFailure && frame.type === "product.source.recovery.receipt.v1") throw Error("controlled recovery receipt failure"); await transport.send(frame);
      } } });
    const registration = ProductSourceRecoveryRegistrationV1Schema.parse({ version: 1, registration_id: randomUUID(),
      binding: { version: 1, node_id: f.destination.nodeId, device_id: f.destination.device.id, guardian_instance_id: randomUUID(),
        store_identity_digest: sha("controlled retained store"), configuration_digest: sha("controlled protected configuration"),
        workspace_root: f.h6.workspaceRoot, workspace_identity_digest: sha("controlled original physical workspace") },
      epoch: { version: 1, epoch_id: randomUUID(), generation: 0, session_id: sessionId, roster_revision: 0, roster_digest: sha("controlled empty initial roster") } });
    expect(registration.binding.workspace_root).toBe(f.base.destination.workspace_root);
    await peer().register({ kind: "product.source.recovery.register.v1", node_id: f.destination.nodeId, payload: registration });
    expect(sent.at(-1)).toMatchObject({ type: "product.source.recovery.registered.v1", payload: { status: "accepted", registration_id: registration.registration_id } });
    const author = kind === "publication" ? await completedValidation(f) : await f.ensure();
    const operations: RecoveryOperationRefV1[] = [{ kind: "validation", operation_id: author.id, request_digest: author.requestDigest, run_id: author.runId }];
    let release: typeof productReleases.$inferSelect | undefined;
    if (kind === "publication") {
      const review = await settleValidationReview(f, author);
      operations.push({ kind: "validation_review", operation_id: review.id, request_digest: review.requestDigest });
      const a = await f.automation(); await fixture().server.db.transaction(tx => ensureGoalProductRelease(f.actor, tx, a));
      [release] = await db.select().from(productReleases).where(eq(productReleases.goalId, author.goalId));
      if (!release) throw Error("Controlled old publication missing");
      operations.push({ kind: "release", operation_id: release.id, request_digest: hash(release.request) });
    } else {
      await f.authorPeer().dispatch(author.id);
      await ingestWireRunEvent(f.actor, { kind: "run.event", node_id: author.computerId, run_id: author.runId, sequence: 0,
        event: { type: "run.lifecycle", payload: { phase: "started" } } });
    }
    operations.sort((a, b) => (a.kind + ":" + a.operation_id) < (b.kind + ":" + b.operation_id) ? -1 : 1);
    sessionId = "controlled-replacement-session";
    const availability = ProductSourceRecoveryAvailabilityV1Schema.parse({ version: 1, state: "recoverable", registration_id: registration.registration_id,
      binding: registration.binding, previous_epoch: { ...registration.epoch, roster_revision: operations.length, roster_digest: sha("controlled complete native roster") },
      current_session_id: sessionId, new_daemon_identity_digest: sha("controlled same-supervisor replacement"), operations });
    const advertise = (value = availability) => peer().available({ kind: "product.source.recovery.available.v1", node_id: f.destination.nodeId, payload: value });
    const ensureRecovery = async () => { const a = await f.automation(); const value = await fixture().server.db.transaction(tx => ensureGoalSourceRecovery(f.actor, tx, a, f.h6.id));
      if (!value) throw Error("Controlled recovery availability was not admitted"); return value; };
    const freshAuthor = async (recoveryId: string) => { const a = await f.automation(); return fixture().server.db.transaction(tx => ensureGoalRecoveryValidation(f.actor, tx, a, recoveryId)); };
    const advanceRecovery = async (recoveryId: string) => fixture().server.db.transaction(async tx => {
      const [row] = await tx.select().from(goalSourceRecoveries).where(eq(goalSourceRecoveries.id, recoveryId));
      if (!row) throw Error("Controlled recovery row missing"); return advanceGoalSourceRecovery(f.actor, tx, row);
    });
    const recoveredResult = (row: typeof goalSourceRecoveries.$inferSelect) => {
      const request = ProductSourceRecoveryRequestV1Schema.parse(row.request), original = ImportedValidationRequestV1Schema.parse(author.request).origin;
      const files = original.implementation_source.verification.required_files.map((file, index) => ({ ...file, reference: `controlled_recovery_baseline_${index}` }));
      const manifest = { directories: [".artoo", ".artoo/product"], files }, subject = sha("controlled unverified recovered workspace");
      return ProductSourceRecoveryResultV1Schema.parse({ version: 1, recovery_id: row.id, request_digest: row.requestDigest, outcome: "recovered", closed: true,
        checkpoint: { version: 1, recovery_id: row.id, request_digest: row.requestDigest, binding: request.binding,
          old_epoch_id: request.previous_epoch.epoch_id, new_epoch_id: randomUUID(), generation: request.previous_epoch.generation + 1,
          current_session_id: request.current_session_id, new_daemon_identity_digest: request.new_daemon_identity_digest, challenge_id: request.challenge_id,
          roster_revision: request.previous_epoch.roster_revision, roster_digest: request.previous_epoch.roster_digest, closure_set_digest: sha("controlled complete closure set"),
          operations: request.operations, subject_digest: subject, baseline: { version: 1, snapshot_id: "controlled_recovery_baseline", subject_digest: subject, ...manifest, manifest_digest: hash(manifest) },
          accepted_inputs: importedExecutionAcceptedInputsV1(original.execution_request), source_state: "unverified" } });
    };
    const registerFresh = async (result: ReturnType<typeof recoveredResult>) => {
      if (result.outcome !== "recovered") throw Error("Controlled recovered result required");
      await peer().register({ kind: "product.source.recovery.register.v1", node_id: f.destination.nodeId,
        payload: { ...registration, registration_id: randomUUID(), epoch: { version: 1, epoch_id: result.checkpoint.new_epoch_id,
          generation: result.checkpoint.generation, session_id: sessionId, roster_revision: 0, roster_digest: sha("controlled fresh empty epoch") } } });
    };
    return { ...f, oldAuthor: author, oldRelease: release, registration, availability, recoverySent: sent, recoveryPeer: peer, advertise,
      ensureRecovery, advanceRecovery, freshAuthor, recoveredResult, registerFresh, replaceSession: (next: string) => { sessionId = next; } };
  }
  it("H9 preserves the original explicit local-policy null consent through durable request admission", async () => {
    const f = await prepareH9(); await f.advertise(); const recovery = await f.ensureRecovery();
    const request = ProductSourceRecoveryRequestV1Schema.parse(recovery.request);
    expect(f.actor.aiDataSharingPolicy?.mode).toBe("local");
    expect(recovery.consentId).toBeNull();
    expect(request.authorization).toHaveProperty("consent_id", null);
    expect(request.authorization.policy_version).toBe(f.actor.aiDataSharingPolicy!.version);
    const { consent_id: _omitted, ...missing } = request.authorization;
    expect(ProductSourceRecoveryRequestV1Schema.safeParse({ ...request, authorization: missing }).success).toBe(false);
    expect((await f.recoveryPeer().dispatch(recovery.id)).type).toBe("product.source.recovery.v1");
  });
  it.each(["missing", "different grant"] as const)("H9 SQL rejects %s consent without confusing it with explicit local null", async mode => {
    const f = await prepareH9(), db = fixture().server.db.db; await f.advertise();
    const automation = await f.automation(), rollback = Error("controlled rollback of exact candidate request");
    const observed: { row?: typeof goalSourceRecoveries.$inferSelect; event?: typeof eventLog.$inferSelect } = {};
    await expect(fixture().server.db.transaction(async tx => {
      const row = await ensureGoalSourceRecovery(f.actor, tx, automation, f.h6.id);
      if (!row) throw Error("Controlled original recovery missing");
      observed.row = row;
      [observed.event] = await tx.select().from(eventLog).where(eq(eventLog.id, row.authorizationEventId));
      throw rollback;
    })).rejects.toBe(rollback);
    const { row, event } = observed;
    if (!row || !event) throw Error("Controlled original authorization transaction was not observed");
    expect(await db.select().from(goalSourceRecoveries)).toEqual([]);
    await db.insert(eventLog).values(event);
    const request = structuredClone(row.request) as { authorization: Record<string, unknown> };
    if (mode === "missing") delete request.authorization.consent_id;
    else request.authorization.consent_id = "different_original_grant";
    await expect(db.insert(goalSourceRecoveries).values({ ...row, request, requestDigest: hash(request) }))
      .rejects.toMatchObject({ cause: { code: "P0001", message: "Recovery request lost its exact history, availability or initiating authorization" } });
    expect(await db.select().from(goalSourceRecoveries)).toEqual([]);
  });
  it("H9 external consent remains exact and revocation or replacement blocks dispatch", async () => {
    const ctx = fixture().server.ctx;
    ctx.aiDataSharingPolicy = buildAiDataSharingPolicy({ mode: "external", providers: [
      { id: "controlled-external", name: "Controlled external fixture", privacy_url: "https://example.com/privacy" },
    ] });
    await grantAiDataSharingConsent(ctx, ctx.aiDataSharingPolicy.version);
    const sharing = await requireAiSharingAuthorization(ctx), f = await prepareH9();
    expect(sharing.consentId).not.toBeNull(); await f.advertise(); const recovery = await f.ensureRecovery();
    expect(recovery.consentId).toBe(sharing.consentId);
    expect(ProductSourceRecoveryRequestV1Schema.parse(recovery.request).authorization.consent_id).toBe(sharing.consentId);
    await revokeAiDataSharingConsent(f.actor);
    await expect(f.recoveryPeer().dispatch(recovery.id)).rejects.toMatchObject({ code: "ai_consent_required" });
    expect(await fixture().server.db.db.select().from(goalSourceRecoveryDeliveries)).toEqual([]);
    await grantAiDataSharingConsent(f.actor, f.actor.aiDataSharingPolicy!.version);
    expect((await requireAiSharingAuthorization(f.actor)).consentId).not.toBe(sharing.consentId);
    await expect(f.recoveryPeer().dispatch(recovery.id)).rejects.toMatchObject({ code: "ai_consent_required" });
    expect(await fixture().server.db.db.select().from(goalSourceRecoveryDeliveries)).toEqual([]);
  });
  async function settledH9(f: Awaited<ReturnType<typeof prepareH9>>) {
    await f.advertise(); const recovery = await f.ensureRecovery(), command = await f.recoveryPeer().dispatch(recovery.id), result = f.recoveredResult(recovery);
    await f.recoveryPeer().receive({ kind: "product.source.recovery.result.v1", node_id: recovery.computerId, command_id: command.id, payload: result });
    await f.registerFresh(result); await f.advanceRecovery(recovery.id);
    await fixture().server.db.transaction(tx => settleRecoveryPublications(f.actor, tx, recovery.id));
    return { recovery, result };
  }
  function recoveryValidationResult(row: typeof goalRecoveryValidations.$inferSelect) {
    const request = ImportedRecoveryValidationRequestV1Schema.parse(row.request), start = request.run_start;
    const verification = structuredClone(request.origin.implementation_source.verification);
    verification.request_id = start.verification.request_id; verification.subject_digest = sha(`controlled H9 final source ${row.generation}`);
    verification.required_files = verification.required_files.map(file => file.path === ".artoo/product/implementation.md" ? { ...file, checksum: sha("controlled H9 source edit") } : file);
    verification.required_files.push({ path: ".artoo/product/validation.json", checksum: sha("controlled H9 report"), size: 20 });
    for (const check of verification.checks) { if (check.observation?.version !== 3) throw Error("Controlled v3 required"); check.observation.stage = "validation"; }
    const initial = request.previous_source?.subject_digest ?? request.checkpoint.subject_digest;
    const manifest = { directories: request.checkpoint.baseline.directories, files: request.checkpoint.baseline.files };
    return ImportedRecoveryValidationResultV1Schema.parse({ version: 1, validation_id: row.id, request_digest: row.requestDigest, run_id: row.runId, closed: true, outcome: "finished",
      verified_validation: { version: 1, validation_id: row.id, request_digest: row.requestDigest, run_id: row.runId, recovery_id: row.recoveryId,
        checkpoint_digest: productSourceRecoveryCheckpointDigestV1(request.checkpoint, sha), root_validation_id: row.rootValidationId, generation: row.generation,
        origin_digest: importedValidationOriginDigestV1(request.origin, sha), author: request.writer, run_start_digest: hash(start),
        initial_subject_digest: initial, subject_digest: verification.subject_digest, authorization_event_id: row.authorizationEventId, attempt_index: row.attemptIndex,
        baseline: { ...request.checkpoint.baseline, snapshot_id: `controlled_H9_baseline_${row.generation}`, subject_digest: initial, ...manifest, manifest_digest: hash(manifest) },
        closure: "windows-job-and-tools-closed.v1", stage: "validation", scope: "all-declared-workspace-validation-cases", verification } });
  }
  async function completedH9Author(f: Awaited<ReturnType<typeof prepareH9>>, row: typeof goalRecoveryValidations.$inferSelect) {
    const peer = createRecoveryValidationBinding(f.actor, { identity: f.identity, sessionId: "controlled-replacement-session", isCurrent: () => true, transport: { async send() {} } });
    const command = await peer.dispatch(row.id), result = recoveryValidationResult(row);
    if (result.outcome !== "finished") throw Error("Controlled successful H9 result required");
    await ingestWireRunEvent(f.actor, { kind: "run.event", node_id: row.computerId, run_id: row.runId, sequence: 0, event: { type: "run.lifecycle", payload: { phase: "started" } } });
    await ingestWireRunEvent(f.actor, { kind: "run.event", node_id: row.computerId, run_id: row.runId, sequence: 1, event: { type: "run.verification", payload: result.verified_validation.verification } });
    await ingestWireRunEvent(f.actor, { kind: "run.event", node_id: row.computerId, run_id: row.runId, sequence: 2, event: { type: "run.lifecycle", payload: { phase: "completed" } } });
    // A generic completed lifecycle alone must not make a recovered task reviewable.
    expect((await fixture().server.db.db.select().from(tasks).where(eq(tasks.id, row.taskId)))[0]!.status).toBe("running");
    await peer.receive({ kind: "product.source.recovery-validation.result.v1", node_id: row.computerId, command_id: command.id, payload: result });
    const a = await f.automation(); return (await fixture().server.db.transaction(tx => advanceGoalRecoveryValidation(f.actor, tx, a, row.id))).validation;
  }
  async function acceptedH9Review(f: Awaited<ReturnType<typeof prepareH9>>, author: typeof goalRecoveryValidations.$inferSelect, outcome: "accepted" | "rejected" = "accepted") {
    const a = await f.automation(), row = await fixture().server.db.transaction(tx => ensureGoalRecoveryValidationReview(f.actor, tx, a, author.id));
    const request = ImportedRecoveryValidationReviewRequestV1Schema.parse(row.request), subject = importedRecoveryValidationReviewSubjectV1(request, sha);
    const measure = (start: typeof request.before_start) => ({ run_id: start.run_id, config_digest: hash(start), closure: "windows-job-and-tools-closed.v1",
      scope: "all-declared-workspace-validation-cases", verification: { ...structuredClone(request.source.verification!), request_id: start.verification.request_id } });
    const result = ImportedRecoveryValidationReviewResultV1Schema.parse({ version: 1, review_id: row.id, request_digest: row.requestDigest, execution_authorized: false,
      outcome: "reviewed", closed: true, before: measure(request.before_start), after: measure(request.after_start),
      reviewer: { run_id: request.review_start.run_id, config_digest: hash(request.review_start), closure: "windows-job-and-tools-closed.v1" },
      verdict: { version: 1, review_id: row.id, validation_id: author.id, source_digest: subject.source_digest, subject_digest: subject.subject_digest, outcome,
        summary: "Controlled new independent H9 verdict; no live model", findings: outcome === "rejected" ? [{ severity: "blocking", description: "Controlled recovered product regression" }] : [] } });
    expect(row.reviewerInstanceId).not.toBe(author.writerInstanceId); expect(row.reviewerAgentId).not.toBe(author.writerAgentId);
    const peer = createRecoveryValidationReviewBinding(f.actor, { identity: f.identity, sessionId: "controlled-replacement-session", isCurrent: () => true, transport: { async send() {} } });
    const command = await peer.dispatch(row.id); await peer.receive({ kind: "product.source.recovery-validation-review.result.v1", node_id: row.computerId, command_id: command.id, payload: result });
    return (await fixture().server.db.transaction(tx => advanceGoalRecoveryValidationReview(f.actor, tx, a, author.id))).review;
  }
  it("H9 exact old operation set and unknown closure cannot reopen or publish the workspace", async () => {
    const timed = tracePhases();
    const f = await timed("prepare-H9", prepareH9), db = fixture().server.db.db;
    if (f.availability.state !== "recoverable") throw Error("Controlled recoverable availability required");
    const invalidAvailability = { ...f.availability, previous_epoch: { ...f.availability.previous_epoch, roster_revision: 0, roster_digest: f.registration.epoch.roster_digest }, operations: [] };
    await timed("advertise-invalid-operation-set", () => f.advertise(invalidAvailability));
    await timed("assert-invalid-operation-set", () => expect(f.ensureRecovery()).rejects.toThrow("exact dispatched operation set"));
    await timed("advertise-original-operations", () => f.advertise()); const row = await timed("ensure-recovery", () => f.ensureRecovery());
    await timed("assert-idempotent-recovery", async () => { expect((await f.ensureRecovery()).id).toBe(row.id); });
    const command = await timed("dispatch-recovery", () => f.recoveryPeer().dispatch(row.id));
    await timed("receive-unknown-closure", () => f.recoveryPeer().receive({ kind: "product.source.recovery.result.v1", node_id: row.computerId, command_id: command.id,
      payload: { version: 1, recovery_id: row.id, request_digest: row.requestDigest, outcome: "unknown", closed: false, reason: "Controlled missing original terminal ACK" } }));
    await timed("assert-advance-unknown", async () => { expect((await f.advanceRecovery(row.id)).state).toBe("unknown"); });
    await timed("assert-fresh-author-needs-checkpoint", () => expect(f.freshAuthor(row.id)).rejects.toThrow("checkpoint"));
    await timed("assert-no-new-work-and-old-occupancy", async () => {
      expect(await db.select().from(goalSourceRecoveryCheckpoints)).toEqual([]); expect(await db.select().from(goalSourceRecoverySettlements)).toEqual([]);
      expect(await db.select().from(goalRecoveryValidations)).toEqual([]); expect(await db.select().from(productReleases)).toEqual([]);
      expect((await unsettledStandaloneExecutions(f.actor, db, { goalId: row.goalId })).some(value => value.kind === "validation" && value.id === f.oldAuthor.id)).toBe(true);
    });
  });
  it("H9 checkpoint needs a sent receipt and separate new epoch registration before one fresh author", async () => {
    const f = await prepareH9(), db = fixture().server.db.db, oldAuthor = (await db.select().from(goalImportedValidations))[0]!;
    await f.advertise(); const row = await f.ensureRecovery(), command = await f.recoveryPeer().dispatch(row.id), result = f.recoveredResult(row);
    const message = { kind: "product.source.recovery.result.v1" as const, node_id: row.computerId, command_id: command.id, payload: result };
    await expect(f.recoveryPeer("controlled-replacement-session", true).receive(message)).rejects.toThrow("controlled recovery receipt failure");
    await expect(f.advanceRecovery(row.id)).rejects.toThrow("receipt");
    await f.recoveryPeer().receive(message); await f.advanceRecovery(row.id);
    await expect(f.freshAuthor(row.id)).rejects.toThrow("registered fresh epoch");
    await f.registerFresh(result); const before = (await db.select().from(goals).where(eq(goals.id, row.goalId)))[0]!.retryCount;
    const [one, two] = await Promise.all([f.freshAuthor(row.id), f.freshAuthor(row.id)]);
    expect(one.id).toBe(two.id); expect(one.attemptIndex).toBe(before + 1); expect(one.runId).not.toBe(oldAuthor.runId);
    expect((await db.select().from(goals).where(eq(goals.id, row.goalId)))[0]!.retryCount).toBe(before + 1);
    expect((await db.select().from(goalImportedValidations))[0]).toEqual(oldAuthor);
    expect((await db.select().from(runs).where(eq(runs.id, oldAuthor.runId)))[0]).toMatchObject({ status: "failed", failureReason: "daemon_disconnect" });
    expect(await db.select().from(goalSourceRecoveryReceipts)).toHaveLength(1); expect(await db.select().from(goalSourceRecoverySettlements)).toHaveLength(1);
    await expect(db.update(goalSourceRecoveryCheckpoints).set({ checkpointDigest: sha("forged") }).where(eq(goalSourceRecoveryCheckpoints.recoveryId, row.id))).rejects.toMatchObject({ cause: { code: "P0001" } });
    await expect(db.delete(nodeRecoveryRegistrations).where(eq(nodeRecoveryRegistrations.id, f.registration.registration_id))).rejects.toMatchObject({ cause: { code: "P0001" } });
    const a = await f.automation(); await expect(fixture().server.db.transaction(tx => ensureGoalRecoveryValidationReview(f.actor, tx, a, one.id))).rejects.toThrow();
    await expect(fixture().server.db.transaction(tx => ensureGoalProductRelease(f.actor, tx, a))).rejects.toThrow();
  });
  it("H9 current goal and same-session authority remain required after stored closure", async () => {
    const f = await prepareH9(), { recovery } = await settledH9(f), db = fixture().server.db.db;
    f.replaceSession("unregistered-second-replacement"); await expect(f.freshAuthor(recovery.id)).rejects.toThrow();
    f.replaceSession("controlled-replacement-session");
    await db.update(goals).set({ status: "paused" }).where(eq(goals.id, recovery.goalId));
    await expect(f.freshAuthor(recovery.id)).rejects.toThrow();
    expect(await db.select().from(goalRecoveryValidations)).toEqual([]); expect(await db.select().from(goalSourceRecoveryCheckpoints)).toHaveLength(1);
  });
  it.each(["token", "budget"] as const)("H9 stored checkpoint cannot override revoked %s authorization", async change => {
    const f = await prepareH9(), { recovery } = await settledH9(f), db = fixture().server.db.db;
    const [before] = await db.select().from(goals).where(eq(goals.id, recovery.goalId));
    if (change === "token") await db.update(deviceTokens).set({ status: "revoked", revokedAt: f.actor.clock.nowIso() }).where(eq(deviceTokens.tokenLookup, f.identity.tokenLookup));
    else await db.update(goals).set({ budgets: { ...before!.budgets as object, max_retries: before!.retryCount } }).where(eq(goals.id, recovery.goalId));
    await expect(f.freshAuthor(recovery.id)).rejects.toThrow();
    expect(await db.select().from(goalRecoveryValidations)).toEqual([]);
    expect((await db.select().from(goals).where(eq(goals.id, recovery.goalId)))[0]!.retryCount).toBe(before!.retryCount);
  });
  it("H9 fresh source must complete verification and independent review before its first publication", async () => {
    const f = await prepareH9(), { recovery } = await settledH9(f), db = fixture().server.db.db;
    const author = await completedH9Author(f, await f.freshAuthor(recovery.id)), a = await f.automation();
    await expect(fixture().server.db.transaction(tx => ensureGoalProductRelease(f.actor, tx, a))).rejects.toThrow();
    const review = await acceptedH9Review(f, author), before = (await db.select().from(goals).where(eq(goals.id, recovery.goalId)))[0]!.retryCount;
    await fixture().server.db.transaction(tx => ensureGoalProductRelease(f.actor, tx, a));
    const [release] = await db.select().from(productReleases).where(eq(productReleases.goalId, recovery.goalId));
    expect(release!.runId).toBe(author.runId); expect(ProductReleaseRequestSchema.parse(release!.request).imported_recovery).toMatchObject({ recovery_id: recovery.id, review_id: review.id, validation_id: author.id });
    expect((await db.select().from(goals).where(eq(goals.id, recovery.goalId)))[0]!.retryCount).toBe(before);
    expect(await db.select().from(goalRecoveryValidationCompletions)).toHaveLength(1); expect(await db.select().from(goalRecoveryValidationReceipts)).toHaveLength(1);
    expect(await db.select().from(goalRecoveryValidationPublications)).toHaveLength(1);
  }, 60000);
  it("H9 rejected product review creates one finite repair with fresh author identity and cumulative budget", async () => {
    const f = await prepareH9(), { recovery } = await settledH9(f), db = fixture().server.db.db;
    const author = await completedH9Author(f, await f.freshAuthor(recovery.id)), review = await acceptedH9Review(f, author, "rejected"), a = await f.automation();
    const before = (await db.select().from(goals).where(eq(goals.id, recovery.goalId)))[0]!.retryCount;
    const create = () => fixture().server.db.transaction(tx => ensureGoalRecoveryValidationRepair(f.actor, tx, a, review.id));
    const [one, two] = await Promise.all([create(), create()]);
    expect(one.id).toBe(two.id); expect(one.parentValidationId).toBe(author.id); expect(one.recoveryId).toBe(recovery.id);
    expect(one.generation).toBe(1); expect(one.runId).not.toBe(author.runId); expect(one.contextPackId).not.toBe(author.contextPackId);
    const request = ImportedRecoveryValidationRequestV1Schema.parse(one.request);
    expect(request.previous_source!.validation_id).toBe(author.id); expect(request.predecessor).toMatchObject({ kind: "review", review_id: review.id });
    expect(request.previous_source).not.toHaveProperty("request");
    expect((await db.select().from(goals).where(eq(goals.id, recovery.goalId)))[0]!.retryCount).toBe(before + 1);
    await expect(db.update(goalRecoveryValidationReviews).set({ reviewerAgentId: author.writerAgentId }).where(eq(goalRecoveryValidationReviews.id, review.id))).rejects.toMatchObject({ cause: { code: "P0001" } });
    await expect(fixture().server.db.transaction(tx => ensureGoalProductRelease(f.actor, tx, a))).rejects.toThrow();
    expect(await db.select().from(productReleases)).toEqual([]);
  }, 60000);
  it("H9 nonempty interrupted publication preserves old history and consumes one extra retry only once", async () => {
    const f = await prepareH9("publication"), db = fixture().server.db.db, old = f.oldRelease!;
    expect(old.status).toBe("queued"); expect(old.receipt).toBeNull();
    await expect(db.update(productReleases).set({ status: "interrupted" }).where(eq(productReleases.id, old.id))).rejects.toThrow();
    const { recovery } = await settledH9(f), [interrupted] = await db.select().from(productReleases).where(eq(productReleases.id, old.id));
    expect(interrupted!.status).toBe("interrupted"); expect(interrupted!.request).toEqual(old.request); expect(interrupted!.receipt).toBeNull();
    expect(interrupted!.interruptedRecoveryId).toBe(recovery.id); expect(interrupted!.interruptionEventId).toBeTruthy(); expect(interrupted!.interruptionCheckpointDigest).toMatch(/^sha256:/);
    const author = await completedH9Author(f, await f.freshAuthor(recovery.id)); await acceptedH9Review(f, author);
    const a = await f.automation(), before = (await db.select().from(goals).where(eq(goals.id, recovery.goalId)))[0]!.retryCount;
    await fixture().server.db.transaction(tx => ensureGoalProductRelease(f.actor, tx, a));
    await fixture().server.db.transaction(tx => ensureGoalProductRelease(f.actor, tx, a));
    const releases = await db.select().from(productReleases).where(eq(productReleases.goalId, recovery.goalId)), fresh = releases.find(row => row.id !== old.id)!;
    expect(releases).toHaveLength(2); expect(fresh.recoveryOfReleaseId).toBe(old.id); expect(fresh.runId).toBe(author.runId);
    const newRequest = ProductReleaseRequestSchema.parse(fresh.request);
    expect(newRequest.retry).toBeUndefined(); expect(newRequest.imported_recovery!.authorization).toMatchObject({ event_id: fresh.recoveryAuthorizationEventId, attempt_index: before + 1 });
    expect((await db.select().from(goals).where(eq(goals.id, recovery.goalId)))[0]!.retryCount).toBe(before + 1);
    const publication = ProductReleaseRequestSchema.parse(old.request), late = ProductReleaseReceiptSchema.parse({ request: publication,
      release_profile_digest: publication.acceptance_binding!.release_binding.release_profile_digest, artifact_digest: publication.subject_digest,
      outcome: "failed", endpoint: null, previous_release_id: null, health_checks: [], reason: "Controlled late old publisher result" });
    await expect(ingestProductReleaseReceipt(f.actor, old.computerId, late)).rejects.toThrow();
    expect((await db.select().from(productReleases).where(eq(productReleases.id, old.id)))[0]).toEqual(interrupted);
  }, 60000);
  // These cases include the complete H1-H9 DB chain and two additional publication
  // decisions. Their own 90s budget does not alter any earlier test or fixture deadline.
  it.each(["author", "publication"] as const)("H9 %s recovery keeps goal-wide generations separate from two exact-source retries", async kind => {
    const f = await prepareH9(kind), db = fixture().server.db.db;
    const [initialGoal] = await db.select().from(goals).where(eq(goals.id, f.oldAuthor.goalId));
    await db.update(goals).set({ budgets: { ...initialGoal!.budgets as object, max_retries: 4 } }).where(eq(goals.id, initialGoal!.id));
    const support = f.actor.supportsExecutionFeature;
    f.actor.supportsExecutionFeature = (computer, feature) => feature === PRODUCT_RELEASE_RETRY_FEATURE_V1
      ? computer === f.destination.nodeId : support?.(computer, feature) === true;
    const { recovery } = await settledH9(f), author = await completedH9Author(f, await f.freshAuthor(recovery.id));
    await acceptedH9Review(f, author);
    const create = async () => { const a = await f.automation(); return fixture().server.db.transaction(tx => ensureGoalProductRelease(f.actor, tx, a)); };
    expect(await create()).toMatchObject({ status: "pending" });
    const session = f.actor.getPairedNodeSession!(author.computerId)!;
    const rows = () => db.select().from(productReleases).where(eq(productReleases.goalId, recovery.goalId));
    const [root] = (await rows()).filter(row => row.recoveryId === recovery.id);
    if (!root) throw Error("Controlled fresh recovery publication missing");
    const rootRequest = ProductReleaseRequestSchema.parse(root.request), base = kind === "publication" ? 1 : 0;
    expect(root.publicationGeneration).toBe(base); expect(rootRequest.retry).toBeUndefined();
    expect(root.recoveryOfReleaseId).toBe(f.oldRelease?.id ?? null);
    const beforeRuns = await db.select().from(runs), beforeReviews = await db.select().from(goalRecoveryValidationReviews);
    const [beforeGoal] = await db.select().from(goals).where(eq(goals.id, recovery.goalId));
    const interrupted = f.oldRelease && (await rows()).find(row => row.id === f.oldRelease!.id)!;
    let previous = root;
    const failures: ReturnType<typeof ProductReleaseReceiptSchema.parse>[] = [];
    for (const generation of [1, 2]) {
      const request = ProductReleaseRequestSchema.parse(previous.request);
      const failed = ProductReleaseReceiptSchema.parse({ request,
        release_profile_digest: request.acceptance_binding!.release_binding.release_profile_digest,
        artifact_digest: request.subject_digest, outcome: "rolled_back", endpoint: null, previous_release_id: null,
        health_checks: [{ path: "/", status_code: 503, body_digest: sha("Controlled complete HTTP 503 body"), passed: false, checked_at: f.actor.clock.nowIso() }],
        recovery_checks: [], reason: "Controlled settled 503 and listener closure; not a native HTTP observation",
        retry_source: { version: 1, source_id: `controlled-H9-${kind}-${generation}`, closure: "local-release-settled.v1",
          recovery: { kind: "listener-closed", active_release_id: null, active_artifact_digest: null } } });
      failures.push(failed);
      await ingestProductReleaseReceipt(f.actor, author.computerId, failed, () => true, session);
      expect(await create()).toMatchObject({ status: "pending" });
      const next = (await rows()).find(row => row.publicationGeneration === base + generation)!;
      expect(next).toMatchObject({ recoveryId: recovery.id, recoveryOfReleaseId: null, recoveryAuthorizationEventId: null,
        rootReleaseId: root.id, retryOfReleaseId: previous.id, runId: root.runId, evidenceId: root.evidenceId });
      const nextRequest = ProductReleaseRequestSchema.parse(next.request);
      expect(nextRequest.retry).toMatchObject({ generation, root_release_id: root.id, previous_release_id: previous.id,
        authorization: { actor_user_id: rootRequest.imported_recovery!.authorization.actor_user_id, attempt_index: beforeGoal!.retryCount + generation } });
      expect(nextRequest.imported_recovery).toEqual(rootRequest.imported_recovery);
      const [decision] = await db.select().from(eventLog).where(eq(eventLog.id, next.retryAuthorizationEventId!));
      expect(decision).toMatchObject({ actorType: "system", actorId: "goal_runner", payload: { generation } });
      await fixture().server.db.transaction(tx => assertProductReleaseRetryDispatch(f.actor, tx, next, session));
      await fixture().server.db.transaction(tx => assertProductReleaseRetryHistory(f.actor, tx, previous));
      // The SQL helper accepts the actual root relation and rejects grafted recovery lineage.
      await db.execute(sql`SELECT assert_product_release_recovery_retry_v1(p) FROM product_releases p WHERE id=${next.id}`);
      await expect(db.execute(sql`SELECT assert_product_release_recovery_retry_v1(jsonb_populate_record(NULL::product_releases,
        to_jsonb(p) || jsonb_build_object('recovery_authorization_event_id', ${root.recoveryAuthorizationEventId}::text)))
        FROM product_releases p WHERE id=${next.id}`)).rejects.toMatchObject({ cause: { code: "P0001" } });
      await expect(db.update(productReleases).set({ publicationGeneration: next.publicationGeneration + 1 }).where(eq(productReleases.id, next.id)))
        .rejects.toMatchObject({ cause: { code: "P0001" } });
      await expect(db.update(goalRecoveryValidationPublications).set({ origin: { ...nextRequest.imported_recovery!, validation_id: "forged-author" } })
        .where(eq(goalRecoveryValidationPublications.releaseId, next.id))).rejects.toMatchObject({ cause: { code: "P0001" } });
      // Delivery and decision replay keep both the original counter and source immutable.
      await ingestProductReleaseReceipt(f.actor, author.computerId, failed, () => true, session);
      expect(await create()).toMatchObject({ status: "pending" });
      expect((await db.select().from(goals).where(eq(goals.id, recovery.goalId)))[0]!.retryCount).toBe(beforeGoal!.retryCount + generation);
      expect((await rows()).length).toBe(base + generation + 1);
      previous = next;
    }
    const finalRequest = ProductReleaseRequestSchema.parse(previous.request), capabilities = f.destinationRelease!;
    const receipt = ProductReleaseReceiptSchema.parse({ request: finalRequest,
      release_profile_digest: finalRequest.acceptance_binding!.release_binding.release_profile_digest,
      artifact_digest: finalRequest.subject_digest, outcome: "published", endpoint: "http://127.0.0.1:18182/", previous_release_id: null,
      health_checks: capabilities.contract.health_checks.map(check => ({ path: check.path, status_code: 200, body_digest: sha("Controlled fresh publication"),
        passed: true, checked_at: f.actor.clock.nowIso() })),
      acceptance: { version: 1, scope: "node-http-point-in-time", binding_digest: releaseAcceptanceBindingDigest(finalRequest.acceptance_binding!),
        settled_criteria: finalRequest.acceptance_binding!.criteria } });
    await ingestProductReleaseReceipt(f.actor, author.computerId, receipt, () => true, session);
    for (const failed of failures) await ingestProductReleaseReceipt(f.actor, author.computerId, failed, () => true, session);
    expect(await db.select().from(runs)).toEqual(beforeRuns);
    expect(await db.select().from(goalRecoveryValidationReviews)).toEqual(beforeReviews);
    expect((await db.select().from(goalRecoveryValidationPublications)).filter(row => row.recoveryId === recovery.id)).toHaveLength(3);
    if (interrupted) {
      expect((await rows()).find(row => row.id === interrupted.id)).toEqual(interrupted);
      expect(interrupted.receipt).toBeNull();
      await expect(db.update(productReleases).set({ status: "failed", receipt: failures[0]! }).where(eq(productReleases.id, interrupted.id)))
        .rejects.toMatchObject({ cause: { code: "P0001" } });
    }
    expect((await db.select().from(goals).where(eq(goals.id, recovery.goalId)))[0]!.retryCount).toBe(beforeGoal!.retryCount + 2);
  }, 90000);
  it("H7 first author is unique, consumes no retry, and preserves H6 and original A automation", async () => {
    const f = await prepareH7(), a = await f.automation(), h6Before = await fixture().server.db.db.select().from(goalImportedExecutionReviews), retry = (await fixture().server.db.db.select().from(goals).where(eq(goals.id, a.goalId)))[0]!.retryCount;
    const [one, two] = await Promise.all([f.ensure(), f.ensure()]);
    expect(one.id).toBe(two.id); expect(one).toMatchObject({ kind: "initial", generation: 0, rootValidationId: one.id, taskId: "h5-validation", attemptIndex: retry });
    expect(await unsettledGoalExecutionCount(f.actor, fixture().server.db.db, a.goalId)).toBe(1);
    const request = ImportedValidationRequestV1Schema.parse(one.request);
    expect(request.run_start.context_pack.payload.goal_context!.plan!.spec_ref).toBe("3");
    expect(request.run_start.context_pack.payload.product_development!.accepted_inputs!.files.map(file => file.path).sort()).toEqual([".artoo/product/design.json", ".artoo/product/research.json"]);
    expect(await f.automation()).toEqual(a); expect(await fixture().server.db.db.select().from(goalImportedExecutionReviews)).toEqual(h6Before);
    await expect(assignTask(f.actor, one.taskId, { mode: "manual", agent_instance_id: one.writerInstanceId })).rejects.toThrow();
  });
  it("H7 author completion requires actual committed evidence and a separate sent receipt", async () => {
    const f = await prepareH7(), row = await f.ensure(), peer = f.authorPeer(true), command = await peer.dispatch(row.id), result = await validationEvents(f, row);
    expect((await fixture().server.db.db.select().from(tasks).where(eq(tasks.id, row.taskId)))[0]!.status).toBe("running");
    const message = { kind: "product.source.validation.result.v1" as const, node_id: row.computerId, command_id: command.id, payload: result };
    await expect(peer.receive(message)).rejects.toThrow("controlled H7 author receipt");
    await expect(f.advanceAuthor(row.id)).rejects.toThrow("receipt");
    await f.authorPeer().receive(message); await f.advanceAuthor(row.id);
    expect((await fixture().server.db.db.select().from(tasks).where(eq(tasks.id, row.taskId)))[0]!.status).toBe("review");
    expect(await fixture().server.db.db.select().from(goalImportedValidationCompletions)).toHaveLength(1);
    expect(await fixture().server.db.db.select().from(goalImportedValidationReceipts)).toHaveLength(1);
  });
  it("H7 cannot mint successful source from lifecycle and claimed verifier JSON alone", async () => {
    const f = await prepareH7(), row = await f.ensure(), peer = f.authorPeer(), command = await peer.dispatch(row.id), result = await validationEvents(f, row, { omitEvidence: true });
    await expect(peer.receive({ kind: "product.source.validation.result.v1", node_id: row.computerId, command_id: command.id, payload: result })).rejects.toThrow("committed passed");
    expect(await fixture().server.db.db.select().from(goalImportedValidationCompletions)).toEqual([]);
    expect((await fixture().server.db.db.select().from(tasks).where(eq(tasks.id, row.taskId)))[0]!.status).toBe("running");
  });
  it("H7 completion replay rereads committed verification ownership after an earlier success", async () => {
    const f = await prepareH7(), row = await f.ensure(), peer = f.authorPeer(), command = await peer.dispatch(row.id), result = await validationEvents(f, row);
    const message = { kind: "product.source.validation.result.v1" as const, node_id: row.computerId, command_id: command.id, payload: result };
    await peer.receive(message);
    const db = fixture().server.db.db;
    const priorCompletions = await db.select().from(goalImportedValidationCompletions), priorReceipts = await db.select().from(goalImportedValidationReceipts);
    const [evidence] = await db.select().from(runEvidence).where(eq(runEvidence.runId, row.runId));
    expect(evidence).toBeDefined(); expect(priorCompletions).toHaveLength(1); expect(priorReceipts).toHaveLength(1);
    const [original] = await db.select().from(eventLog).where(eq(eventLog.id, evidence!.eventId));
    expect(original).toMatchObject({ type: "run.verification", runId: row.runId, actorId: row.computerId });
    try {
      // This is the existing fixture's DB evidence-revocation boundary. No
      // immutable H7 completion/receipt row or SQL trigger is changed.
      const [changed] = await db.update(eventLog).set({ actorId: "controlled-revoked-h7-node" }).where(eq(eventLog.id, original!.id)).returning();
      expect(changed!.actorId).toBe("controlled-revoked-h7-node");
      await expect(peer.receive(message)).rejects.toThrow("H7 success requires exact committed passed Node evidence");
      expect(await db.select().from(goalImportedValidationCompletions)).toEqual(priorCompletions);
      expect(await db.select().from(goalImportedValidationReceipts)).toEqual(priorReceipts);
    } finally {
      await db.update(eventLog).set({ actorId: original!.actorId }).where(eq(eventLog.id, original!.id));
    }
    await peer.receive(message);
    expect(await db.select().from(goalImportedValidationCompletions)).toEqual(priorCompletions);
    expect(await db.select().from(goalImportedValidationReceipts)).toEqual(priorReceipts);
  });
  it("H7 durable author/completion/receipt facts reject SQL rewrites without changing original rows", async () => {
    const f = await prepareH7(), row = await completedValidation(f);
    const [completion] = await fixture().server.db.db.select().from(goalImportedValidationCompletions), [receipt] = await fixture().server.db.db.select().from(goalImportedValidationReceipts);
    await expect(fixture().server.db.db.update(goalImportedValidations).set({ attemptIndex: row.attemptIndex + 1 }).where(eq(goalImportedValidations.id, row.id)))
      .rejects.toMatchObject({ cause: { code: "P0001", message: "H7 author identity, result and readiness are immutable" } });
    await expect(fixture().server.db.db.update(goalImportedValidationCompletions).set({ sourceDigest: sha("forged source") }).where(eq(goalImportedValidationCompletions.validationId, row.id)))
      .rejects.toMatchObject({ cause: { code: "P0001", message: "H7 completion provenance is immutable" } });
    await expect(fixture().server.db.db.delete(goalImportedValidationReceipts).where(eq(goalImportedValidationReceipts.validationId, row.id))).rejects.toMatchObject({ cause: { code: "P0001" } });
    expect((await fixture().server.db.db.select().from(goalImportedValidations).where(eq(goalImportedValidations.id, row.id)))[0]).toEqual(row);
    expect((await fixture().server.db.db.select().from(goalImportedValidationCompletions))[0]).toEqual(completion);
    expect((await fixture().server.db.db.select().from(goalImportedValidationReceipts))[0]).toEqual(receipt);
  });
  it("H7 final acceptance requires its separate review receipt and retains the author task until receipt send", async () => {
    const f = await prepareH7(), author = await completedValidation(f), row = await f.ensureReview(author.id), peer = f.reviewPeer(true), command = await peer.dispatch(row.id);
    const message = { kind: "product.source.validation-review.result.v1" as const, node_id: row.computerId, command_id: command.id, payload: validationReviewResult(row) };
    await expect(peer.receive(message)).rejects.toThrow("controlled H7 review receipt"); await expect(f.advanceReview(author.id)).rejects.toThrow("receipt");
    expect((await fixture().server.db.db.select().from(tasks).where(eq(tasks.id, author.taskId)))[0]!.status).toBe("review");
    await f.reviewPeer().receive(message); await f.advanceReview(author.id);
    expect(await fixture().server.db.db.select().from(goalImportedValidationReviewReceipts)).toHaveLength(1);
    expect((await fixture().server.db.db.select().from(tasks).where(eq(tasks.id, author.taskId)))[0]!.status).toBe("done");
    const [accepted] = await fixture().server.db.db.select().from(goalImportedValidationReviews).where(eq(goalImportedValidationReviews.id, row.id));
    const [acceptance] = await fixture().server.db.db.select().from(eventLog).where(eq(eventLog.id, accepted!.acceptanceEventId!));
    expect(acceptance).toMatchObject({ type: "goal.imported-validation-review.accepted", runId: author.runId,
      payload: { review_id: row.id, validation_id: author.id } });
    expect(acceptance!.payload).not.toMatchObject({ validation_id: author.writerInstanceId });
  });
  it("H7 rejection creates one fresh repair with original retry budget and a complete new review", async () => {
    const timed = tracePhases();
    const f = await timed("prepare-H7", prepareH7), author = await timed("complete-original-author", () => completedValidation(f)),
      rejected = await timed("settle-rejected-review", () => settleValidationReview(f, author, "rejected"));
    const oldH6 = await fixture().server.db.db.select().from(goalImportedExecutionReviews), oldContext = ImportedValidationRequestV1Schema.parse(author.request).run_start.context_pack.payload;
    const [one, two] = await timed("concurrent-repair", () => Promise.all([f.repair(rejected.id), f.repair(rejected.id)]));
    expect(one.id).toBe(two.id); expect(one).toMatchObject({ rootValidationId: author.id, parentValidationId: author.id, generation: 1, attemptIndex: author.attemptIndex + 1 });
    const repaired = ImportedValidationRequestV1Schema.parse(one.request);
    expect(repaired.run_start.context_pack.payload.goal_context).toEqual(oldContext.goal_context); expect(repaired.run_start.context_pack.payload.product_development!.accepted_inputs).toEqual(oldContext.product_development!.accepted_inputs);
    expect(repaired.source).not.toHaveProperty("source"); expect(repaired.source).not.toHaveProperty("origin"); expect(repaired.run_start.context_pack.payload.review_feedback!.entries[0]!.comment).toContain("saved entries");
    await timed("complete-repaired-author", () => completedValidation(f, one)); const next = await timed("ensure-new-review", () => f.ensureReview(one.id)), request = ImportedValidationReviewRequestV1Schema.parse(next.request);
    expect(next.id).not.toBe(rejected.id); expect(request.review_start.context_pack.payload.task.description).toContain("COMPLETE final product");
    expect(request.review_start.context_pack.payload.task.description).toContain("baseline.files[].reference"); expect(request.review_start.context_pack.payload.task.description).toContain("report truthfulness");
    await timed("assert-old-review-not-dispatchable", () => expect(f.reviewPeer().dispatch(rejected.id)).rejects.toThrow());
    await timed("assert-original-H6-unchanged", async () => { expect(await fixture().server.db.db.select().from(goalImportedExecutionReviews)).toEqual(oldH6); });
  });
  it.each(["author-failed", "verification-failed"] as const)("H7 retries only the typed and actually closed %s source", async failure => {
    const f = await prepareH7(), author = await f.ensure(), peer = f.authorPeer(), command = await peer.dispatch(author.id), result = await validationEvents(f, author, { failure });
    await peer.receive({ kind: "product.source.validation.result.v1", node_id: author.computerId, command_id: command.id, payload: result });
    const ready = await f.advanceAuthor(author.id); expect(ready.validation.readyKind).toBe("repair");
    await expect(f.ensureReview(author.id)).rejects.toThrow("verified H7");
    const repair = await f.repair(author.id, "failure"); expect((await f.repair(author.id, "failure")).id).toBe(repair.id);
    expect(repair.attemptIndex).toBe(author.attemptIndex + 1); expect(ImportedValidationRequestV1Schema.parse(repair.request).predecessor!.kind).toBe("failure");
  });
  it("H7 unknown closure retains occupancy and cannot authorize repair, review or publication", async () => {
    const f = await prepareH7(), author = await f.ensure(), peer = f.authorPeer(), command = await peer.dispatch(author.id);
    await peer.receive({ kind: "product.source.validation.result.v1", node_id: author.computerId, command_id: command.id,
      payload: { version: 1, validation_id: author.id, request_digest: author.requestDigest, run_id: author.runId, outcome: "uncertain", closed: false, reason: "Controlled missing Job close evidence" } });
    expect(await unsettledGoalExecutionCount(f.actor, fixture().server.db.db, author.goalId)).toBe(1);
    await expect(f.repair(author.id, "failure")).rejects.toThrow(); await expect(f.ensureReview(author.id)).rejects.toThrow();
    const a = await f.automation(); await expect(fixture().server.db.transaction(tx => ensureGoalProductRelease(f.actor, tx, a))).rejects.toThrow();
    expect(await fixture().server.db.db.select().from(productReleases)).toEqual([]);
  });
  it("H7 closed failed reviewer retry consumes the same original budget and rejected review requires an author", async () => {
    const f = await prepareH7(), author = await completedValidation(f), review = await f.ensureReview(author.id), peer = f.reviewPeer(), command = await peer.dispatch(review.id);
    await peer.receive({ kind: "product.source.validation-review.result.v1", node_id: review.computerId, command_id: command.id,
      payload: { version: 1, review_id: review.id, request_digest: review.requestDigest, execution_authorized: false, outcome: "failed", closed: true, reason: "Controlled failed reviewer with closure" } });
    const retried = await f.ensureReview(author.id); expect(retried.id).not.toBe(review.id); expect(retried.retryOf).toBe(review.id); expect(retried.attemptIndex).toBe(review.attemptIndex + 1);
    expect((await f.ensureReview(author.id)).id).toBe(retried.id);
    const nextCommand = await peer.dispatch(retried.id);
    await peer.receive({ kind: "product.source.validation-review.result.v1", node_id: retried.computerId, command_id: nextCommand.id, payload: validationReviewResult(retried, "rejected") });
    expect((await f.ensureReview(author.id)).id).toBe(retried.id);
    await fixture().server.db.db.update(goals).set({ retryCount: 3 }).where(eq(goals.id, author.goalId));
    await expect(f.repair(retried.id)).rejects.toThrow("retry budget"); expect(await fixture().server.db.db.select().from(goalImportedValidations)).toHaveLength(1);
  });
  it("H7 pause and session replacement preserve history without creating new author or publication authority", async () => {
    const f = await prepareH7(), author = await f.ensure(), peer = f.authorPeer(), command = await peer.dispatch(author.id), result = await validationEvents(f, author);
    await fixture().server.db.db.update(goals).set({ status: "paused" }).where(eq(goals.id, author.goalId));
    await peer.receive({ kind: "product.source.validation.result.v1", node_id: author.computerId, command_id: command.id, payload: result });
    await expect(f.advanceAuthor(author.id)).rejects.toThrow("paused");
    await expect(f.authorPeer(false, "other-session").dispatch(author.id)).rejects.toThrow();
    expect((await f.authorPeer(false, "other-session").dispatch(author.id, "status")).type).toBe("product.source.validation.status.v1");
    expect(await fixture().server.db.db.select().from(goalImportedValidationReviews)).toEqual([]); expect(await fixture().server.db.db.select().from(productReleases)).toEqual([]);
  });
  it("H7 GoalRunner exhausts the original elapsed budget and queues stop while retaining unknown process occupancy", async () => {
    const f = await prepareH7(), author = await f.ensure(), [goal] = await fixture().server.db.db.select().from(goals).where(eq(goals.id, author.goalId));
    await fixture().server.db.db.update(goals).set({ budgets: { ...goal!.budgets as object, max_elapsed_ms: 1 },
      runningSince: new Date(Date.parse(f.actor.clock.nowIso()) - 1000).toISOString() }).where(eq(goals.id, author.goalId));
    const errors: unknown[] = [], dispatcher = createGoalAutomationDispatcher(f.actor, async () => {}, error => { errors.push(error); });
    await dispatcher.pump(); await dispatcher.stop(); expect(errors).toEqual([]);
    expect((await f.automation()).status).toBe("failed"); expect(f.validationQueued).toContainEqual({ id: author.id, control: "stop", kind: "validation" });
    expect(await unsettledGoalExecutionCount(f.actor, fixture().server.db.db, author.goalId)).toBe(1);
    expect(await fixture().server.db.db.select().from(goalImportedValidations)).toHaveLength(1);
  });
  async function prepareH7Publication() {
    const f = await prepareH7(), a = await f.automation(), author = await completedValidation(f), review = await settleValidationReview(f, author);
    const request = ImportedValidationRequestV1Schema.parse(author.request);
    const capabilities = request.origin.execution_request.review_request.continuation_request.review_request.operation.intent.request.measurement_v2!.destination_release;
    // Keep prepare()'s exact A and B profile readers: publication rechecks both
    // original measurement-v2 associations even though only B publishes.
    const create = async () => { const a = await f.automation(); return fixture().server.db.transaction(tx => ensureGoalProductRelease(f.actor, tx, a)); };
    await create(); const [release] = await fixture().server.db.db.select().from(productReleases).where(eq(productReleases.goalId, author.goalId));
    if (!release) throw Error("Controlled H7 publisher row missing");
    const publication = ProductReleaseRequestSchema.parse(release.request);
    const receipt = ProductReleaseReceiptSchema.parse({ request: publication, release_profile_digest: capabilities.binding.release_profile_digest,
      artifact_digest: publication.subject_digest, outcome: "published", endpoint: "http://127.0.0.1:18182/", previous_release_id: null,
      health_checks: capabilities.contract.health_checks.map(check => ({ path: check.path, status_code: 200, body_digest: sha("controlled HTTP bytes"), passed: true, checked_at: f.actor.clock.nowIso() })),
      acceptance: { version: 1, scope: "node-http-point-in-time", binding_digest: releaseAcceptanceBindingDigest(publication.acceptance_binding!), settled_criteria: publication.acceptance_binding!.criteria } });
    return { ...f, originalAutomation: a, author, review, capabilities, release, publication, receipt, create };
  }
  it("H8 automatically retries an original closed H7 publication failure without rerunning its accepted author", async context => {
    type Phase = "prepare-publication" | "ingest-original-failure" | "retry-pump-and-stop" | "retry-dispatch-binding"
      | "publication-binding" | "ingest-retry-success" | "replay-original-failure" | "final-pump-and-stop" | "recorded-completion";
    const started = performance.now(), phases: { phase: Phase; started_ms: number; ended_ms?: number }[] = [];
    const timed = async <T>(phase: Phase, operation: () => Promise<T>): Promise<T> => {
      const span: (typeof phases)[number] = { phase, started_ms: performance.now() - started };
      phases.push(span);
      try { return await operation(); } finally { span.ended_ms = performance.now() - started; }
    };
    // Keep body-relative spans when fixture cleanup drains work after a timeout; report only fixed labels and timings.
    context.onTestFailed(() => { console.error("H8 publication retry phase timings", JSON.stringify(phases)); });
    const f = await timed("prepare-publication", prepareH7Publication), support = f.actor.supportsExecutionFeature;
    f.actor.supportsExecutionFeature = (computer, feature) => feature === PRODUCT_RELEASE_RETRY_FEATURE_V1
      ? computer === f.author.computerId : support?.(computer, feature) === true;
    const session = f.actor.getPairedNodeSession!(f.author.computerId)!;
    const failed = ProductReleaseReceiptSchema.parse({ request: f.publication, release_profile_digest: f.capabilities.binding.release_profile_digest,
      artifact_digest: null, outcome: "failed", endpoint: null, previous_release_id: null, health_checks: [],
      reason: "Controlled H8 original listener closure", retry_source: { version: 1, source_id: "controlled-H8-H7-source",
        closure: "local-release-settled.v1", recovery: { kind: "listener-closed", active_release_id: null, active_artifact_digest: null } } });
    const originalRuns = await fixture().server.db.db.select().from(runs), [beforeGoal] = await fixture().server.db.db.select().from(goals).where(eq(goals.id, f.author.goalId));
    await timed("ingest-original-failure", () => ingestProductReleaseReceipt(f.actor, f.author.computerId, failed, () => true, session));
    expect(await fixture().server.db.db.select().from(productReleaseRetrySources)).toHaveLength(1);
    const errors: unknown[] = [], dispatcher = createGoalAutomationDispatcher(f.actor, async () => {}, error => { errors.push(error); });
    await timed("retry-pump-and-stop", async () => { await dispatcher.pump(); await dispatcher.stop(); }); expect(errors).toEqual([]);
    const releases = await fixture().server.db.db.select().from(productReleases).where(eq(productReleases.goalId, f.author.goalId));
    expect(releases).toHaveLength(2);
    const next = releases.find(item => item.publicationGeneration === 1)!;
    const request = ProductReleaseRequestSchema.parse(next.request);
    expect(request.retry).toMatchObject({ previous_release_id: f.release.id, root_release_id: f.release.id, generation: 1,
      authorization: { actor_user_id: f.originalAutomation.actorUserId, attempt_index: beforeGoal!.retryCount + 1 } });
    expect(request.imported_validation).toEqual(f.publication.imported_validation); expect(request.acceptance_binding).toEqual(f.publication.acceptance_binding);
    expect(next.runId).toBe(f.release.runId); expect(next.evidenceId).toBe(f.release.evidenceId);
    expect(await fixture().server.db.db.select().from(runs)).toEqual(originalRuns);
    expect(await fixture().server.db.db.select().from(goalImportedValidationPublications)).toHaveLength(2);
    await timed("retry-dispatch-binding", () => fixture().server.db.transaction(tx => assertProductReleaseRetryDispatch(f.actor, tx, next, session)));
    await timed("publication-binding", () => fixture().server.db.transaction(tx => inspectImportedValidationPublicationDispatch(f.actor, tx, next)));
    const retryReceipt = ProductReleaseReceiptSchema.parse({ ...f.receipt, request });
    await timed("ingest-retry-success", () => ingestProductReleaseReceipt(f.actor, f.author.computerId, retryReceipt, () => true, session));
    // An old receipt replay resolves its exact historical H7 publication relation.
    await timed("replay-original-failure", () => ingestProductReleaseReceipt(f.actor, f.author.computerId, failed, () => true, session));
    const finalErrors: unknown[] = [], finalDispatcher = createGoalAutomationDispatcher(f.actor, async () => {}, error => { finalErrors.push(error); });
    await timed("final-pump-and-stop", async () => { await finalDispatcher.pump(); await finalDispatcher.stop(); }); expect(finalErrors).toEqual([]);
    expect((await fixture().server.db.db.select().from(goals).where(eq(goals.id, f.author.goalId)))[0]!.status).toBe("completed");
    await timed("recorded-completion", () => fixture().server.db.transaction(tx => assertRecordedGoalReleaseCompletion(f.actor, tx, f.originalAutomation)));
    expect((await fixture().server.db.db.select().from(productReleases).where(eq(productReleases.id, f.release.id)))[0]!.receipt).toEqual(failed);
    expect((await f.automation()).computerId).toBe(f.originalAutomation.computerId);
  });
  it("H8 rejects H7 retry after the original destination session changes", async () => {
    const timed = tracePhases();
    const f = await timed("prepare-publication", prepareH7Publication), support = f.actor.supportsExecutionFeature;
    f.actor.supportsExecutionFeature = (computer, feature) => feature === PRODUCT_RELEASE_RETRY_FEATURE_V1
      ? computer === f.author.computerId : support?.(computer, feature) === true;
    const session = f.actor.getPairedNodeSession!(f.author.computerId)!;
    const failed = ProductReleaseReceiptSchema.parse({ request: f.publication, release_profile_digest: f.capabilities.binding.release_profile_digest,
      artifact_digest: null, outcome: "failed", endpoint: null, previous_release_id: null, health_checks: [],
      retry_source: { version: 1, source_id: "controlled-H8-stale-session", closure: "local-release-settled.v1",
        recovery: { kind: "listener-closed", active_release_id: null, active_artifact_digest: null } } });
    await timed("ingest-original-failure", () => ingestProductReleaseReceipt(f.actor, f.author.computerId, failed, () => true, session));
    const current = f.actor.getPairedNodeSession!;
    f.actor.getPairedNodeSession = computer => computer === f.author.computerId ? { ...session, sessionId: "replacement" } : current(computer);
    await timed("assert-stale-session-no-retry", () => expect(f.create()).resolves.toMatchObject({ status: "failed" }));
    await timed("assert-original-publication-only", async () => {
      expect(await fixture().server.db.db.select().from(productReleases)).toHaveLength(1);
      expect(await fixture().server.db.db.select().from(goalImportedValidationPublications)).toHaveLength(1);
    });
  });
  it("H7 publishes its exact accepted B source and settles through the existing publisher without retargeting A", async () => {
    const f = await prepareH7Publication();
    // The source research review remains in this same original goal throughout its imported stages.
    const originalReviews = await fixture().server.db.db.select().from(autonomousReviews).where(eq(autonomousReviews.goalId, f.author.goalId));
    expect(originalReviews).toHaveLength(1);
    expect(originalReviews[0]).toMatchObject({ id: "measurement_review", goalId: f.author.goalId, subjectRunId: "measurement_author_run", status: "accepted" });
    expect(f.release.computerId).toBe(f.author.computerId); expect(f.release.computerId).not.toBe(f.originalAutomation.computerId);
    expect(f.publication.imported_validation).toMatchObject({ validation_id: f.author.id, review_id: f.review.id, acceptance_event_id: f.review.acceptanceEventId });
    expect(await fixture().server.db.db.select().from(goalImportedValidationPublications)).toHaveLength(1);
    const source = await fixture().server.db.transaction(tx => inspectImportedValidationPublicationDispatch(f.actor, tx, f.release));
    expect(source!.importedOrigin!.releaseOrigin).toEqual(f.publication.imported_validation);
    await expect(ingestProductReleaseReceipt(f.actor, f.author.computerId, { ...f.receipt, request: { ...f.publication,
      imported_validation: { ...f.publication.imported_validation!, subject_digest: sha("wrong source") } } })).rejects.toThrow();
    await ingestProductReleaseReceipt(f.actor, f.author.computerId, f.receipt);
    const errors: unknown[] = [], dispatcher = createGoalAutomationDispatcher(f.actor, async () => {}, error => { errors.push(error); });
    await dispatcher.pump(); await dispatcher.stop(); expect(errors).toEqual([]);
    expect((await fixture().server.db.db.select().from(goals).where(eq(goals.id, f.author.goalId)))[0]!.status).toBe("completed");
    const after = await f.automation(); expect(after).toMatchObject({ computerId: f.originalAutomation.computerId, workspaceRoot: f.originalAutomation.workspaceRoot,
      verificationProfileId: f.originalAutomation.verificationProfileId, releaseProfileId: f.originalAutomation.releaseProfileId, planningCapabilitySnapshot: f.originalAutomation.planningCapabilitySnapshot });
    await fixture().server.db.transaction(tx => assertRecordedGoalReleaseCompletion(f.actor, tx, after));
    expect(await fixture().server.db.db.select().from(autonomousReviews).where(eq(autonomousReviews.goalId, f.author.goalId))).toEqual(originalReviews);
    expect(await fixture().server.db.db.select().from(autonomousReviews).where(eq(autonomousReviews.subjectRunId, f.author.runId))).toEqual([]);
  });
  it("H7 accepts immutable late publication history after pause but cannot dispatch, complete or retry it", async () => {
    const f = await prepareH7Publication();
    await fixture().server.db.db.update(goals).set({ status: "paused" }).where(eq(goals.id, f.author.goalId));
    await expect(fixture().server.db.transaction(tx => inspectImportedValidationPublicationDispatch(f.actor, tx, f.release))).rejects.toThrow("paused");
    await ingestProductReleaseReceipt(f.actor, f.author.computerId, f.receipt);
    expect((await fixture().server.db.db.select().from(productReleases))[0]!.status).toBe("published");
    const errors: unknown[] = [], dispatcher = createGoalAutomationDispatcher(f.actor, async () => {}, error => { errors.push(error); });
    await dispatcher.pump(); await dispatcher.stop(); expect(errors).toEqual([]);
    expect((await fixture().server.db.db.select().from(goals).where(eq(goals.id, f.author.goalId)))[0]!.status).toBe("paused");
    expect(await fixture().server.db.db.select().from(goalImportedValidations)).toHaveLength(1);
    expect(await fixture().server.db.db.select().from(productReleases)).toHaveLength(1);
  });
  it("H7 failed publication remains one immutable attempt and cannot reopen accepted validation", async () => {
    const timed = tracePhases();
    const f = await timed("prepare-publication", prepareH7Publication), failed = ProductReleaseReceiptSchema.parse({ request: f.publication,
      release_profile_digest: f.capabilities.binding.release_profile_digest, artifact_digest: null, outcome: "failed", endpoint: null,
      previous_release_id: null, health_checks: [], reason: "Controlled publisher failure" });
    await timed("ingest-original-failure", () => ingestProductReleaseReceipt(f.actor, f.author.computerId, failed));
    await timed("assert-failed-publication-not-retried", async () => { expect((await f.create()).status).toBe("failed"); });
    await timed("assert-one-publication", async () => { expect(await fixture().server.db.db.select().from(productReleases)).toHaveLength(1); });
    await timed("assert-accepted-validation-not-repaired", () => expect(f.repair(f.review.id)).rejects.toThrow());
    const [origin] = await timed("read-publication-origin", () => fixture().server.db.db.select().from(goalImportedValidationPublications));
    await timed("assert-immutable-publication-origin", () => expect(fixture().server.db.db.update(goalImportedValidationPublications).set({ sourceDigest: sha("changed publication") }).where(eq(goalImportedValidationPublications.releaseId, f.release.id)))
      .rejects.toMatchObject({ cause: { code: "P0001", message: "H7 publication origin is immutable" } }));
    await timed("assert-original-origin-unchanged", async () => { expect((await fixture().server.db.db.select().from(goalImportedValidationPublications))[0]).toEqual(origin); });
  });
  it("H7 NodeBinding uses dedicated status/stop and never routes its author through ordinary start", async () => {
    const f = await prepareH7(), author = await f.ensure(), request = ImportedValidationRequestV1Schema.parse(author.request), sent: ServerToNodeMessage[] = [];
    let ready = false;
    const binding = attachNodeBinding(f.actor, { async send(frame) { sent.push(frame); }, subscribe() { return () => {}; }, async close() {} }, author.computerId,
      [IMPORTED_VALIDATION_FEATURE_V1], () => true, [], [], [], () => false, "windows", { identity: f.identity, sessionId: "design-session", artifactDir: fixture().directory,
        qualifiedRunEventReceiptsReady: () => ready });
    try {
      expect(binding.supportsExecutionFeature(IMPORTED_VALIDATION_FEATURE_V1)).toBe(false);
      await expect(binding.dispatchImportedValidation!(author.id, "start")).rejects.toThrow(); ready = true;
      await expect(binding.dispatchRunStart(author.runId)).rejects.toThrow("dedicated");
      await binding.dispatchImportedValidation!(author.id, "start"); await binding.dispatchRunResume(author.runId);
      expect(sent.some(frame => frame.type === "product.source.validation.status.v1")).toBe(true);
      const stopping = binding.dispatchRunStop(author.runId); let settled = false; void stopping.then(() => { settled = true; });
      // Await the persisted stop intent without inventing a process lifecycle or release event.
      await vi.waitFor(() => expect(sent.some(frame => frame.type === "product.source.validation.stop.v1")).toBe(true));
      expect(settled).toBe(false);
      const command = sent.find(frame => frame.type === "product.source.validation.stop.v1")!;
      binding.receive(parseNodeToServer(JSON.stringify({ kind: "product.source.validation.result.v1", node_id: author.computerId, command_id: command.id,
        payload: { version: 1, validation_id: author.id, request_digest: author.requestDigest, run_id: request.run_start.run_id, outcome: "cancelled_before_start", closed: true } }))!);
      await binding.drain(); await stopping;
      expect(await unsettledGoalExecutionCount(f.actor, fixture().server.db.db, author.goalId)).toBe(0);
    } finally { binding.close(); }
  });

  it("H6 reserves independent participants, requires its receipt, and accepts only implementation while H7 remains fenced", async () => {
    const f = await prepareH6(), row = await f.ensureH6(), initialRuns = await fixture().server.db.db.select().from(runs);
    expect((await f.ensureH6()).id).toBe(row.id); expect(row.authorAgentId).not.toBe(row.reviewerAgentId); expect(row.authorInstanceId).not.toBe(row.reviewerInstanceId);
    expect(await unsettledGoalExecutionCount(f.actor, fixture().server.db.db, row.goalId)).toBe(1);
    const operations = await unsettledStandaloneExecutions(f.actor, fixture().server.db.db, { goalId: row.goalId });
    expect(operations.find(op => op.id === row.id)).toMatchObject({ kind: "execution_review", participantInstanceIds: [row.authorInstanceId, row.reviewerInstanceId] });
    expect(operations.find(op => op.id === row.id)).not.toHaveProperty("runId");
    const badPeer = f.h6Binding(true), command = await badPeer.dispatch(row.id), message = { kind: "product.source.execution-review.result.v1" as const,
      node_id: row.computerId, command_id: command.id, payload: reviewedImplementation(row) };
    await expect(badPeer.receive(message)).rejects.toThrow("controlled H6 receipt");
    await expect(f.advanceH6()).rejects.toThrow("receipt");
    expect((await fixture().server.db.db.select().from(tasks).where(eq(tasks.id, row.taskId)))[0]!.status).toBe("review");
    await f.h6Binding().receive(message); await f.advanceH6();
    expect((await fixture().server.db.db.select().from(tasks).where(eq(tasks.id, row.taskId)))[0]!.status).toBe("done");
    expect((await fixture().server.db.db.select().from(tasks).where(eq(tasks.id, "h5-validation")))[0]!.status).toBe("backlog");
    expect((await fixture().server.db.db.select().from(runs)).length).toBe(initialRuns.length);
    await expect(assignTask(f.actor, "h5-validation", { mode: "manual", agent_instance_id: row.authorInstanceId })).rejects.toThrow();
    expect(await currentImportedDesignBoundary(f.actor, fixture().server.db.db, row.goalId, row.planId)).toBeDefined();
  });
  it("H6 repair consumes the original shared retry counter exactly once and preserves real authorization feedback", async () => {
    const f = await prepareH6(), review = await rejectedImplementation(f);
    await fixture().server.db.db.update(goals).set({ retryCount: 1 }).where(eq(goals.id, review.goalId));
    const [one, two] = await Promise.all([f.ensureRepair(review.id), f.ensureRepair(review.id)]);
    expect(one.id).toBe(two.id); expect(one.attemptIndex).toBe(2); expect(one.taskId).toBe(f.h5.taskId); expect(one.runId).not.toBe(f.h5.runId);
    expect((await fixture().server.db.db.select().from(goals).where(eq(goals.id, review.goalId)))[0]!.retryCount).toBe(2);
    expect(await unsettledGoalExecutionCount(f.actor, fixture().server.db.db, review.goalId)).toBe(1);
    const [event] = await fixture().server.db.db.select().from(eventLog).where(eq(eventLog.id, one.authorizationEventId));
    expect(event).toMatchObject({ type: "goal.imported-execution-repair.authorized", actorType: "system", actorId: "goal_runner", runId: one.runId,
      payload: { actor_user_id: f.actor.actorUserId, previous_retry_count: 1, attempt_index: 2 } });
    const request = ImportedExecutionRepairRequestV1Schema.parse(one.request);
    expect(request.run_start.context_pack.payload.review_feedback!.entries[0]).toMatchObject({ event_id: event!.id, position: event!.position });
    expect(request.run_start.context_pack.payload.review_feedback!.entries[0]!.comment).toContain("Controlled missing saved-entry behavior");
    const peer = f.repairBinding(); expect((await peer.dispatch(one.id)).id).toBe((await peer.dispatch(one.id)).id);
    expect((await fixture().server.db.db.select().from(goals).where(eq(goals.id, review.goalId)))[0]!.retryCount).toBe(2);
    await expect(fixture().server.db.db.update(goalImportedExecutionRepairs).set({ attemptIndex: 1 }).where(eq(goalImportedExecutionRepairs.id, one.id)))
      .rejects.toMatchObject({ cause: { code: "P0001", message: "H6 repair identity/result/readiness is immutable" } });
    expect((await fixture().server.db.db.select().from(goalImportedExecutionRepairs).where(eq(goalImportedExecutionRepairs.id, one.id)))[0]!.attemptIndex).toBe(2);
  });
  it("H6 repaired completion needs committed evidence and receipt, then gets a fresh nonrecursive review source", async () => {
    const f = await prepareH6(), review = await rejectedImplementation(f), row = await f.ensureRepair(review.id), peer = f.repairBinding(), command = await peer.dispatch(row.id);
    const result = await repairEvents(f, row);
    expect((await fixture().server.db.db.select().from(tasks).where(eq(tasks.id, row.taskId)))[0]!.status).toBe("running");
    await peer.receive({ kind: "product.source.execution-repair.result.v1", node_id: row.computerId, command_id: command.id, payload: result });
    await f.advanceRepair(review.id); const next = await f.ensureH6(), request = ImportedExecutionReviewRequestV1Schema.parse(next.request);
    expect(next.id).not.toBe(review.id); expect(next.sourceKind).toBe("repair"); expect(next.sourceOperationId).toBe(row.id);
    expect(request.source).not.toHaveProperty("execution_request"); expect(request.source).not.toHaveProperty("review_request");
    expect(request.before_start.run_id).not.toBe(ImportedExecutionReviewRequestV1Schema.parse(review.request).before_start.run_id);
    await expect(f.h6Binding().dispatch(review.id)).rejects.toThrow("superseded");
    const reviewPeer = f.h6Binding(), reviewedCommand = await reviewPeer.dispatch(next.id);
    await reviewPeer.receive({ kind: "product.source.execution-review.result.v1", node_id: next.computerId, command_id: reviewedCommand.id, payload: reviewedImplementation(next) });
    await f.advanceH6(); expect((await fixture().server.db.db.select().from(tasks).where(eq(tasks.id, row.taskId)))[0]!.status).toBe("done");
    expect((await fixture().server.db.db.select().from(tasks).where(eq(tasks.id, "h5-validation")))[0]!.status).toBe("backlog");
    expect((await fixture().server.db.db.select().from(goalImportedExecutionRepairCompletions)).length).toBe(1);
    expect((await fixture().server.db.db.select().from(goalImportedExecutionRepairReceipts)).length).toBe(1);
  });
  it("H6 rejects exhausted original goal budgets without changing task, counter or repair authorization", async () => {
    const f = await prepareH6(), review = await rejectedImplementation(f);
    await fixture().server.db.db.update(goals).set({ retryCount: 3 }).where(eq(goals.id, review.goalId));
    await expect(f.ensureRepair(review.id)).rejects.toThrow("retry budget");
    expect(await fixture().server.db.db.select().from(goalImportedExecutionRepairs)).toEqual([]);
    expect((await fixture().server.db.db.select().from(goals).where(eq(goals.id, review.goalId)))[0]!.retryCount).toBe(3);
    expect((await fixture().server.db.db.select().from(tasks).where(eq(tasks.id, review.taskId)))[0]!.status).toBe("review");
  });
  it("H6 repeated rejection uses the original cumulative retry limit across fresh sources", async () => {
    const f = await prepareH6();
    for (const attempt of [1, 2, 3]) {
      const review = await rejectedImplementation(f), row = await f.ensureRepair(review.id), peer = f.repairBinding(), command = await peer.dispatch(row.id);
      expect(row.attemptIndex).toBe(attempt);
      const result = await repairEvents(f, row);
      await peer.receive({ kind: "product.source.execution-repair.result.v1", node_id: row.computerId, command_id: command.id, payload: result });
      await f.advanceRepair(review.id);
    }
    const finalReview = await rejectedImplementation(f);
    await expect(f.ensureRepair(finalReview.id)).rejects.toThrow("retry budget");
    expect((await fixture().server.db.db.select().from(goals).where(eq(goals.id, finalReview.goalId)))[0]!.retryCount).toBe(3);
    expect((await fixture().server.db.db.select().from(goalImportedExecutionRepairs)).length).toBe(3);
    expect((await fixture().server.db.db.select().from(tasks).where(eq(tasks.id, finalReview.taskId)))[0]!.status).toBe("review");
  }, 120000);
  it("H6 GoalRunner durably fails on exhausted retries without creating a repair or ordinary run", async () => {
    const f = await prepareH6(), review = await rejectedImplementation(f);
    await prepareDispatcher(f); await fixture().server.db.db.update(goals).set({ retryCount: 3 }).where(eq(goals.id, review.goalId));
    const before = await fixture().server.db.db.select({ id: runs.id }).from(runs), errors: unknown[] = [], ordinary: string[] = [];
    f.actor.onRunQueued = async id => { ordinary.push(id); };
    const dispatcher = createGoalAutomationDispatcher(f.actor, async () => {}, error => { errors.push(error); });
    await dispatcher.pump(); await dispatcher.stop();
    expect(errors.some(error => error instanceof Error && error.message.includes("retry budget"))).toBe(true);
    expect(await f.automation()).toMatchObject({ status: "failed", lastError: "Goal retry budget would be exceeded" });
    expect(await fixture().server.db.db.select().from(goalImportedExecutionRepairs)).toEqual([]); expect(ordinary).toEqual([]);
    expect(await fixture().server.db.db.select({ id: runs.id }).from(runs)).toEqual(before);
    expect((await fixture().server.db.db.select().from(goals).where(eq(goals.id, review.goalId)))[0]!.retryCount).toBe(3);
  });
  it("H6 original elapsed budget durably pauses and queues repair stop while retaining unconfirmed occupancy", async () => {
    const f = await prepareH6(), review = await rejectedImplementation(f), row = await f.ensureRepair(review.id);
    await prepareDispatcher(f); const [goal] = await fixture().server.db.db.select().from(goals).where(eq(goals.id, row.goalId));
    await fixture().server.db.db.update(goals).set({ runningSince: "2000-01-01T00:00:00Z", budgets: { ...goal!.budgets as object, max_elapsed_ms: 1 } }).where(eq(goals.id, row.goalId));
    expect(await enforceGoalBudget(f.actor, row.goalId)).toMatchObject({ enforced: true, action: "pause" });
    const errors: unknown[] = [], dispatcher = createGoalAutomationDispatcher(f.actor, async () => {}, error => { errors.push(error); });
    await dispatcher.pump(); await dispatcher.stop();
    expect(errors).toEqual([]); expect(await f.automation()).toMatchObject({ status: "waiting", lastError: "Goal is paused; no new work will start." });
    expect((await fixture().server.db.db.select().from(goals).where(eq(goals.id, row.goalId)))[0]!.status).toBe("paused");
    expect((await fixture().server.db.db.select().from(goalImportedExecutionRepairs).where(eq(goalImportedExecutionRepairs.id, row.id)))[0]!.stopRequested).toBe(true);
    expect(f.h6Queued).toContainEqual({ kind: "repair", id: row.id, control: "stop" });
    expect(await unsettledGoalExecutionCount(f.actor, fixture().server.db.db, row.goalId)).toBe(1);
    await expect(f.repairBinding().dispatch(row.id)).rejects.toThrow();
    expect(f.h6Sent.some(frame => frame.type === "product.source.execution-repair.v1")).toBe(false);
  });
  it("H6 NodeBinding waits for qualified receipts, uses dedicated repair status and forbids ordinary start", async () => {
    const f = await prepareH6(), review = await rejectedImplementation(f), row = await f.ensureRepair(review.id), sent: ServerToNodeMessage[] = [];
    let ready = false;
    const binding = attachNodeBinding(f.actor, { async send(frame) { sent.push(frame); }, subscribe() { return () => {}; }, async close() {} }, row.computerId,
      [IMPORTED_EXECUTION_REVIEW_FEATURE_V1], () => true, [], [], [], () => false, "windows", {
        identity: f.actor.getPairedNodeSession!(row.computerId)!, sessionId: "design-session", artifactDir: fixture().directory, qualifiedRunEventReceiptsReady: () => ready,
      });
    try {
      expect(binding.supportsExecutionFeature(IMPORTED_EXECUTION_REVIEW_FEATURE_V1)).toBe(false);
      await expect(binding.dispatchImportedExecutionRepair!(row.id, "start")).rejects.toThrow("paired receipt session");
      ready = true; await binding.dispatchImportedExecutionRepair!(row.id, "start");
      await expect(binding.dispatchRunStart(row.runId)).rejects.toThrow("dedicated single-use");
      await binding.dispatchRunResume(row.runId);
      expect(sent.some(frame => frame.type === "product.source.execution-repair.status.v1")).toBe(true);
      expect(sent.some(frame => frame.type === "run.start" || frame.type === "run.resume")).toBe(false);
      const command = sent.find(frame => frame.type === "product.source.execution-repair.v1")!, result = await repairEvents(f, row);
      const parsed = parseNodeToServer(JSON.stringify({ kind: "product.source.execution-repair.result.v1", node_id: row.computerId, command_id: command.id, payload: result }));
      expect(parsed).not.toBeNull(); binding.receive(parsed!); await binding.drain();
      expect((await fixture().server.db.db.select().from(goalImportedExecutionRepairReceipts)).length).toBe(1);
    } finally { binding.close(); }
  });
  it.each(["source-session", "destination-session", "pause", "elapsed", "team", "token", "stop"])("H6 repair rejects %s changed between authorization and delivery", async change => {
    const f = await prepareH6(), review = await rejectedImplementation(f), row = await f.ensureRepair(review.id), peer = f.repairBinding();
    if (change === "source-session") f.replaceSession(f.source.nodeId);
    if (change === "destination-session") f.replaceSession();
    if (change === "pause") await fixture().server.db.db.update(goals).set({ status: "paused" }).where(eq(goals.id, row.goalId));
    if (change === "elapsed") { const [goal] = await fixture().server.db.db.select().from(goals).where(eq(goals.id, row.goalId));
      await fixture().server.db.db.update(goals).set({ runningSince: "2000-01-01T00:00:00Z", budgets: { ...goal!.budgets as object, max_elapsed_ms: 1 } }).where(eq(goals.id, row.goalId)); }
    if (change === "team") { const a = await f.automation(), team = a.team as { members: { stage: string; agent_instance_id: string }[] };
      await fixture().server.db.db.update(goalAutomations).set({ team: { ...team, members: team.members.map(item => item.stage === "implementation" ? { ...item, agent_instance_id: "review_instance" } : item) } }).where(eq(goalAutomations.goalId, row.goalId)); }
    if (change === "token") await fixture().server.db.db.update(deviceTokens).set({ status: "revoked", revokedAt: f.actor.clock.nowIso() }).where(eq(deviceTokens.tokenLookup, parseDeviceToken(f.destination.node_token)!.lookup));
    if (change === "stop") await stopGoalImportedExecutionRepairs(f.actor, row.goalId);
    await expect(peer.dispatch(row.id)).rejects.toThrow(); expect(f.h6Sent.filter(frame => frame.type === "product.source.execution-repair.v1")).toEqual([]);
    expect((await fixture().server.db.db.select().from(goals).where(eq(goals.id, row.goalId)))[0]!.retryCount).toBe(1);
  });
  it("H6 uncertain repair closure retains its real run once and cannot reconsume the prior rejection", async () => {
    const f = await prepareH6(), review = await rejectedImplementation(f), row = await f.ensureRepair(review.id), peer = f.repairBinding(), command = await peer.dispatch(row.id);
    await repairEvents(f, row);
    await peer.receive({ kind: "product.source.execution-repair.result.v1", node_id: row.computerId, command_id: command.id,
      payload: { version: 1, repair_id: row.id, request_digest: row.requestDigest, run_id: row.runId, outcome: "uncertain", closed: false, reason: "Controlled unresolved native closure" } });
    expect(await unsettledGoalExecutionCount(f.actor, fixture().server.db.db, row.goalId)).toBe(1);
    expect((await f.ensureRepair(review.id)).id).toBe(row.id); expect((await f.advanceRepair(review.id)).reason).toContain("fenced");
    await expect(f.ensureH6()).rejects.toThrow("review-ready");
  });
  it("H6 cannot promote a finished repair without matching committed final evidence", async () => {
    const f = await prepareH6(), review = await rejectedImplementation(f), row = await f.ensureRepair(review.id), peer = f.repairBinding(), command = await peer.dispatch(row.id);
    const result = await repairEvents(f, row, false);
    await expect(peer.receive({ kind: "product.source.execution-repair.result.v1", node_id: row.computerId, command_id: command.id, payload: result })).rejects.toThrow("evidence");
    expect(await fixture().server.db.db.select().from(goalImportedExecutionRepairCompletions)).toEqual([]);
    expect((await fixture().server.db.db.select().from(tasks).where(eq(tasks.id, row.taskId)))[0]!.status).toBe("running");
  });
  it("H6 stores a late repair closure after pause without admitting review or H7", async () => {
    const f = await prepareH6(), review = await rejectedImplementation(f), row = await f.ensureRepair(review.id), peer = f.repairBinding(), command = await peer.dispatch(row.id);
    const result = await repairEvents(f, row);
    await fixture().server.db.db.update(goals).set({ status: "paused" }).where(eq(goals.id, row.goalId));
    await peer.receive({ kind: "product.source.execution-repair.result.v1", node_id: row.computerId, command_id: command.id, payload: result });
    expect((await fixture().server.db.db.select().from(goalImportedExecutionRepairCompletions)).length).toBe(1);
    expect((await fixture().server.db.db.select().from(goalImportedExecutionRepairReceipts)).length).toBe(1);
    await expect(f.advanceRepair(review.id)).rejects.toThrow("current running goal");
    expect((await fixture().server.db.db.select().from(tasks).where(eq(tasks.id, row.taskId)))[0]!.status).toBe("running");
    expect((await fixture().server.db.db.select().from(tasks).where(eq(tasks.id, "h5-validation")))[0]!.status).toBe("backlog");
  });
  it("H6 database review and receipt records remain immutable after rejected verdict delivery", async () => {
    const f = await prepareH6(), row = await rejectedImplementation(f);
    expect((await fixture().server.db.db.select().from(goalImportedExecutionReceipts)).length).toBe(1);
    expect((await fixture().server.db.db.select().from(goalImportedExecutionReviewReceipts)).length).toBe(1);
    const [originalReview] = await fixture().server.db.db.select().from(goalImportedExecutionReviews).where(eq(goalImportedExecutionReviews.id, row.id));
    const [originalReceipt] = await fixture().server.db.db.select().from(goalImportedExecutionReviewReceipts).where(eq(goalImportedExecutionReviewReceipts.reviewId, row.id));
    expect(originalReview!.result).toMatchObject({ verdict: { outcome: "rejected" } });
    await expect(fixture().server.db.db.update(goalImportedExecutionReviews).set({ result: reviewedImplementation(row, "accepted") }).where(eq(goalImportedExecutionReviews.id, row.id)))
      .rejects.toMatchObject({ cause: { code: "P0001", message: "H6 identity/result/acceptance is immutable" } });
    expect((await fixture().server.db.db.select().from(goalImportedExecutionReviews).where(eq(goalImportedExecutionReviews.id, row.id)))[0]).toEqual(originalReview);
    await expect(fixture().server.db.db.update(goalImportedExecutionReviewReceipts).set({ sessionId: "replacement-session" }).where(eq(goalImportedExecutionReviewReceipts.reviewId, row.id)))
      .rejects.toMatchObject({ cause: { code: "P0001", message: "implementation receipt history is immutable" } });
    expect((await fixture().server.db.db.select().from(goalImportedExecutionReviewReceipts).where(eq(goalImportedExecutionReviewReceipts.reviewId, row.id)))[0]).toEqual(originalReceipt);
    expect((await f.advanceH6()).reason).toContain("separate bounded repair");
  });
  it("H5 separately requires H4 plan acceptance and receipt send before reservation", async () => {
    const f = await prepareExecution({ accept: false });
    expect(await fixture().server.db.db.select().from(goalImportedDesignReviewReceipts)).toHaveLength(1);
    await expect(f.ensureH5()).rejects.toThrow("accepted H4");
    await f.advanceH4(); expect((await f.ensureH5()).reviewId).toBe(f.h4.id);
  });
  it("H5 does not treat accepted H4 plus a failed receipt send as admission", async () => {
    const f = await prepareExecution({ receiptFailure: true });
    expect(await fixture().server.db.db.select().from(goalImportedDesignReviewReceipts)).toEqual([]);
    await expect(f.ensureH5()).rejects.toThrow("receipt provenance");
  });
  it("H5 reserves exactly one implementation with foreign research/local design pins and counts its real run once", async () => {
    const f = await prepareExecution(), automation = await f.automation(), row = await f.ensureH5();
    expect((await f.ensureH5()).id).toBe(row.id); expect(row.actorUserId).toBe(f.actor.actorUserId);
    const request = ImportedExecutionRequestV1Schema.parse(row.request), pins = request.run_start.context_pack.payload.product_development!.accepted_inputs!.files;
    expect(pins[0]).toMatchObject({ source_run_id: f.base.source.run_id, evidence_id: f.base.source.evidence_id });
    expect(pins[1]).toMatchObject({ source_run_id: f.row.runId, evidence_id: row.designEvidenceId });
    expect(request.run_start.context_pack.payload.transferred_product_input).toEqual(f.request.run_start.context_pack.payload.transferred_product_input);
    expect((await f.automation()).computerId).toBe(automation.computerId); expect((await f.automation()).workspaceRoot).toBe(automation.workspaceRoot);
    expect(await unsettledGoalExecutionCount(f.actor, fixture().server.db.db, row.goalId)).toBe(1);
    expect((await fixture().server.db.db.select().from(tasks).where(eq(tasks.id, "h5-validation")))[0]!.status).toBe("backlog");
    const binding = f.h5Binding(), command = await binding.dispatch(row.id); expect(await binding.dispatch(row.id)).toEqual(command);
    expect(await fixture().server.db.db.select().from(goalImportedExecutionDeliveries)).toHaveLength(1);
    await expect(fixture().server.db.transaction(tx => scheduleTask(tx, f.actor, ["code.read"], { mode: "manual", projectId: f.base.project_id, branchBacked: false, agentInstanceId: row.writerInstanceId }))).rejects.toThrow();
    await expect(fixture().server.db.db.update(goalImportedExecutions).set({ acceptanceEventId: "substitution" })).rejects.toThrow();
  });
  it("H5 delays review until dedicated verified closure; GoalRunner then stops at H6 and never starts ordinary work", async () => {
    const f = await prepareExecution(), row = await f.ensureH5(), binding = f.h5Binding(), command = await binding.dispatch(row.id), result = await executionEvents(f, row);
    expect((await fixture().server.db.db.select().from(tasks).where(eq(tasks.id, row.taskId)))[0]!.status).toBe("running");
    const message = { kind: "product.source.execution.result.v1" as const, node_id: row.computerId, command_id: command.id, payload: result };
    expect(parseNodeToServer(JSON.stringify(message))).toEqual(message); await binding.receive(message); await binding.receive(message);
    expect(await fixture().server.db.db.select().from(goalImportedExecutionCompletions)).toHaveLength(1);
    expect((await fixture().server.db.db.select().from(tasks).where(eq(tasks.id, row.taskId)))[0]!.status).toBe("running");
    expect((await f.advanceH5()).reason).toContain("H6");
    expect((await fixture().server.db.db.select().from(tasks).where(eq(tasks.id, row.taskId)))[0]!.status).toBe("review");
    await expect(reviewTask(f.actor, row.taskId, { outcome: "accepted" })).rejects.toThrow("ordinary task review");
    const releaseAutomation = { ...await f.automation(), releaseProfileId: "release" };
    // H7 now owns publication admission; an earlier H5 source remains ineligible.
    await expect(fixture().server.db.transaction(tx => ensureGoalProductRelease(f.actor, tx, releaseAutomation))).rejects.toThrow("dedicated accepted H7 final source");
    await prepareDispatcher(f); const ordinary: string[] = [], errors: unknown[] = []; f.actor.onRunQueued = async id => { ordinary.push(id); };
    const dispatcher = createGoalAutomationDispatcher(f.actor, async () => {}, error => { errors.push(error); }); await dispatcher.pump(); await dispatcher.stop();
    expect(errors).toEqual([]); expect(ordinary).toEqual([]); expect((await f.automation()).lastError).toContain("H6");
  });
  it("H5 finished without committed verification never makes its task reviewable", async () => {
    const f = await prepareExecution(), row = await f.ensureH5(), binding = f.h5Binding(), command = await binding.dispatch(row.id), forged = await executionEvents(f, row, false);
    await expect(binding.receive({ kind: "product.source.execution.result.v1", node_id: row.computerId, command_id: command.id, payload: forged })).rejects.toThrow("evidence");
    const result = ImportedExecutionResultV1Schema.parse({ version: 1, execution_id: row.id, request_digest: row.requestDigest, run_id: row.runId, outcome: "finished", closed: true });
    await binding.receive({ kind: "product.source.execution.result.v1", node_id: row.computerId, command_id: command.id, payload: result });
    expect((await f.advanceH5()).reason).toContain("fenced");
    expect((await fixture().server.db.db.select().from(tasks).where(eq(tasks.id, row.taskId)))[0]!.status).not.toBe("review");
    expect(await fixture().server.db.db.select().from(goalImportedExecutionCompletions)).toEqual([]);
  });
  it.each(["source-session", "destination-session", "pause", "team", "actor", "design-task", "design-spec", "consent", "token", "stop"])("H5 rejects %s between reservation and delivery", async change => {
    const f = await prepareExecution(), row = await f.ensureH5(), binding = f.h5Binding();
    if (change.endsWith("session")) f.replaceSession(change === "source-session" ? f.source.nodeId : f.destination.nodeId);
    if (change === "pause") await fixture().server.db.db.update(goals).set({ status: "paused" }).where(eq(goals.id, row.goalId));
    if (change === "design-task") await fixture().server.db.db.update(tasks).set({ title: "Changed accepted design" }).where(eq(tasks.id, f.h4.taskId));
    if (change === "design-spec") {
      const [plan] = await fixture().server.db.db.select().from(plans).where(eq(plans.id, row.planId));
      const specs = structuredClone(plan!.taskSpecs) as { title: string }[]; specs[1]!.title = "Changed design plan";
      await fixture().server.db.db.update(plans).set({ taskSpecs: specs }).where(eq(plans.id, row.planId));
    }
    if (change === "consent") f.actor.aiDataSharingPolicy = null;
    if (change === "token") await fixture().server.db.db.update(deviceTokens).set({ expiresAt: "2000-01-01T00:00:00Z" }).where(eq(deviceTokens.tokenLookup, parseDeviceToken(f.destination.node_token)!.lookup));
    if (change === "team") { const a = await f.automation(); await fixture().server.db.db.update(goalAutomations).set({ team: { ...a.team as object, reviewer_instance_ids: [] } }).where(eq(goalAutomations.goalId, row.goalId)); }
    if (change === "actor") {
      const [original] = await fixture().server.db.db.select().from(users).where(eq(users.id, f.actor.actorUserId));
      await fixture().server.db.db.insert(users).values({ ...original!, id: "h5-other-user", email: "controlled-h5-other@example.invalid" });
      await fixture().server.db.db.update(goalAutomations).set({ actorUserId: "h5-other-user" }).where(eq(goalAutomations.goalId, row.goalId));
    }
    if (change === "stop") await stopGoalImportedExecutions(f.actor, row.goalId);
    await expect(binding.dispatch(row.id)).rejects.toThrow(); expect(f.h5Sent).toEqual([]);
    expect(await unsettledGoalExecutionCount(f.actor, fixture().server.db.db, row.goalId)).toBe(1);
  });
  it("H5 retains occupancy after terminal events when dedicated closure is uncertain", async () => {
    const f = await prepareExecution(), row = await f.ensureH5(), binding = f.h5Binding(), command = await binding.dispatch(row.id);
    await executionEvents(f, row);
    await binding.receive({ kind: "product.source.execution.result.v1", node_id: row.computerId, command_id: command.id,
      payload: { version: 1, execution_id: row.id, request_digest: row.requestDigest, run_id: row.runId, outcome: "uncertain", closed: false, reason: "Controlled tool closure uncertainty" } });
    expect(await unsettledGoalExecutionCount(f.actor, fixture().server.db.db, row.goalId)).toBe(1);
    await stopGoalImportedExecutions(f.actor, row.goalId); expect(f.h5Queued).toContainEqual({ id: row.id, control: "stop" });
    expect((await fixture().server.db.db.select().from(tasks).where(eq(tasks.id, row.taskId)))[0]!.status).not.toBe("review");
  });
  it("H5 persists late verified closure after pause but cannot make the implementation reviewable", async () => {
    const f = await prepareExecution(), row = await f.ensureH5(), binding = f.h5Binding(), command = await binding.dispatch(row.id), result = await executionEvents(f, row);
    await fixture().server.db.db.update(goals).set({ status: "paused" }).where(eq(goals.id, row.goalId));
    await binding.receive({ kind: "product.source.execution.result.v1", node_id: row.computerId, command_id: command.id, payload: result });
    expect(await fixture().server.db.db.select().from(goalImportedExecutionCompletions)).toHaveLength(1);
    await expect(f.advanceH5()).rejects.toThrow("Transfer requires its current running goal, accepted plan and original automation authorization");
    expect((await fixture().server.db.db.select().from(tasks).where(eq(tasks.id, row.taskId)))[0]!.status).not.toBe("review");
  });

  it("H4 commits exact H3 provenance, reserves both participants, accepts only through GoalRunner, and stops at H5", async () => {
    const f = await completedDesign(), beforeRuns = await fixture().server.db.db.select({ id: runs.id }).from(runs), row = await f.ensureH4();
    expect((await f.ensureH4()).id).toBe(row.id);
    const [completion] = await fixture().server.db.db.select().from(goalImportedDesignCompletions);
    expect(completion).toMatchObject({ continuationId: f.row.id, runId: f.row.runId, sessionId: "design-session" }); expect(completion!.receiptSentAt).not.toBeNull();
    expect(await unsettledGoalExecutionCount(f.actor, fixture().server.db.db, f.base.goal_id)).toBe(1);
    for (const agentInstanceId of [row.authorInstanceId, row.reviewerInstanceId]) {
      expect(await unsettledStandaloneExecutions(f.actor, fixture().server.db.db, { agentInstanceId })).toHaveLength(1);
      await expect(fixture().server.db.transaction(tx => scheduleTask(tx, f.actor, ["code.read"], { mode: "manual", projectId: f.base.project_id, branchBacked: false, agentInstanceId }))).rejects.toThrow();
    }
    const binding = f.h4Binding(), command = await binding.dispatch(row.id), result = reviewedDesign(row);
    expect(await binding.dispatch(row.id)).toEqual(command);
    expect(command.type).toBe("product.source.design-review.v1");
    const message = { kind: "product.source.design-review.result.v1" as const, node_id: f.destination.nodeId, command_id: command.id, payload: result };
    await binding.receive(message); await binding.receive(message);
    expect((await fixture().server.db.db.select().from(tasks).where(eq(tasks.id, row.taskId)))[0]!.status).toBe("review");
    expect(await unsettledGoalExecutionCount(f.actor, fixture().server.db.db, f.base.goal_id)).toBe(0);
    await expect(reviewTask(f.actor, row.taskId, { outcome: "accepted" })).rejects.toThrow("ordinary task review");
    expect((await f.advanceH4()).reason).toContain("H5");
    const [accepted] = await fixture().server.db.db.select().from(goalImportedDesignReviews);
    expect(accepted!.acceptedAt).not.toBeNull(); expect(accepted!.acceptanceEventId).not.toBeNull();
    expect((await fixture().server.db.db.select().from(eventLog).where(eq(eventLog.taskId, row.taskId))).some(event => event.type === "task.updated"
      && (event.payload as { status?: string; imported_design_review_id?: string }).status === "done"
      && (event.payload as { imported_design_review_id?: string }).imported_design_review_id === row.id)).toBe(true);
    expect((await fixture().server.db.db.select().from(tasks).where(eq(tasks.id, row.taskId)))[0]!.status).toBe("done");
    expect((await fixture().server.db.db.select().from(goals).where(eq(goals.id, row.goalId)))[0]!.status).toBe("running");
    expect(await fixture().server.db.db.select({ id: runs.id }).from(runs)).toEqual(beforeRuns);
    const releaseAutomation = { ...await f.automation(), releaseProfileId: "release" };
    // H7 now owns publication admission; an earlier H4 source remains ineligible.
    await expect(fixture().server.db.transaction(tx => ensureGoalProductRelease(f.actor, tx, releaseAutomation))).rejects.toThrow("dedicated accepted H7 final source");
    const now = f.actor.clock.nowIso();
    const [plan] = await fixture().server.db.db.select().from(plans).where(eq(plans.id, row.planId));
    await fixture().server.db.db.update(plans).set({ taskSpecs: [...plan!.taskSpecs as unknown[], { development_stage: "implementation", title: "H5 bypass probe", acceptance_criteria: ["Build"] }] }).where(eq(plans.id, row.planId));
    await fixture().server.db.db.insert(tasks).values({ id: "h5-bypass", organizationId: f.actor.organizationId, projectId: f.base.project_id, goalId: row.goalId,
      sourcePlanId: row.planId, sourcePlanSpecRef: "2", title: "H5 bypass probe", status: "ready", createdByType: "system", createdById: "goal_runner", createdAt: now, updatedAt: now });
    const implementationInstance = (releaseAutomation.team as { members: { stage: string; agent_instance_id: string }[] }).members.find(member => member.stage === "implementation")!.agent_instance_id;
    await expect(assignTask(f.actor, "h5-bypass", { mode: "manual", agent_instance_id: implementationInstance }, undefined,
      { ...f.request.run_start.verification!, profile_id: releaseAutomation.verificationProfileId })).rejects.toThrow("H5");
    await prepareDispatcher(f); const errors: unknown[] = [], ordinary: string[] = []; f.actor.onRunQueued = async id => { ordinary.push(id); };
    const dispatcher = createGoalAutomationDispatcher(f.actor, async () => {}, error => { errors.push(error); }); await dispatcher.pump(); await dispatcher.stop();
    expect(errors).toEqual([]); expect(ordinary).toEqual([]); expect((await f.automation()).lastError).toContain("H5");
    await expect(fixture().server.db.db.update(goalImportedDesignReviews).set({ resultDigest: sha("substitution") })).rejects.toThrow();
    await expect(fixture().server.db.db.delete(goalImportedDesignCompletions)).rejects.toThrow();
  });
  it("H4 rejects lifecycle-only H3 and verifier JSON that lacks persisted run evidence", async () => {
    const f = await completedDesign({ omitEvidence: true });
    await expect(f.authorBinding.receive(f.message)).rejects.toThrow("committed passed node evidence");
    expect(await fixture().server.db.db.select().from(goalImportedDesignCompletions)).toEqual([]);
    const legacy = { ...f.message, payload: { version: 1 as const, continuation_id: f.row.id, request_digest: f.row.requestDigest, run_id: f.row.runId, outcome: "finished" as const, closed: true as const } };
    await f.authorBinding.receive(legacy); await expect(f.ensureH4()).rejects.toThrow("lifecycle completion");
    await expect(f.authorBinding.receive(f.message)).rejects.toThrow("immutable");
    expect(await fixture().server.db.db.select().from(goalImportedDesignReviews)).toEqual([]);
  });
  it.each(["plan", "task", "evidence", "context", "team", "reviewer-agent", "author-stop", "profile", "user", "consent", "token", "source-session", "destination-session", "budget"])("H4 revalidates %s after reservation and before wire start", async change => {
    const f = await completedDesign(), row = await f.ensureH4(), binding = f.h4Binding();
    if (change === "plan") await fixture().server.db.db.update(plans).set({ rationale: "Changed rationale" }).where(eq(plans.id, f.base.plan_id));
    if (change === "task") await fixture().server.db.db.update(tasks).set({ acceptanceCriteria: ["Changed"] }).where(eq(tasks.id, row.taskId));
    if (change === "evidence") await fixture().server.db.db.update(eventLog).set({ actorId: "another-node" }).where(eq(eventLog.runId, f.row.runId));
    if (change === "context") await fixture().server.db.db.update(contextPacks).set({ payload: {} }).where(eq(contextPacks.id, f.row.contextPackId));
    if (change === "team") await fixture().server.db.db.update(goalAutomations).set({ team: { ...((await f.automation()).team as object), reviewer_instance_ids: [row.authorInstanceId] } }).where(eq(goalAutomations.goalId, row.goalId));
    if (change === "reviewer-agent") await fixture().server.db.db.update(agentInstances).set({ agentId: row.authorAgentId }).where(eq(agentInstances.id, row.reviewerInstanceId));
    if (change === "author-stop") await stopGoalImportedDesignContinuations(f.actor, row.goalId);
    if (change === "profile") f.actor.getVerificationCapabilities = () => undefined;
    if (change === "user") {
      const [original] = await fixture().server.db.db.select().from(users).where(eq(users.id, f.actor.actorUserId));
      await fixture().server.db.db.insert(users).values({ ...original!, id: "different-user", email: "controlled-other@example.invalid" });
      await fixture().server.db.db.update(goalAutomations).set({ actorUserId: "different-user" }).where(eq(goalAutomations.goalId, row.goalId));
    }
    if (change === "consent") f.actor.aiDataSharingPolicy = null;
    if (change === "token") await fixture().server.db.db.update(deviceTokens).set({ expiresAt: "2000-01-01T00:00:00Z" }).where(eq(deviceTokens.tokenLookup, parseDeviceToken(f.destination.node_token)!.lookup));
    if (change === "source-session") f.replaceSession(f.source.nodeId);
    if (change === "destination-session") f.replaceSession();
    if (change === "budget") await fixture().server.db.db.update(goals).set({ runningSince: "2000-01-01T00:00:00Z", budgets: { max_elapsed_ms: 1 } }).where(eq(goals.id, row.goalId));
    await expect(binding.dispatch(row.id)).rejects.toThrow(); expect(f.h4Sent).toEqual([]);
    expect(await unsettledStandaloneExecutions(f.actor, fixture().server.db.db, { goalId: row.goalId })).toHaveLength(1);
  });
  it("H4 stop before start records only dedicated closure; uncertainty cannot release either participant", async () => {
    const f = await completedDesign(), row = await f.ensureH4(), binding = f.h4Binding();
    await stopGoalImportedDesignReviews(f.actor, row.goalId); const stop = await binding.dispatch(row.id, "stop");
    await expect(binding.dispatch(row.id)).rejects.toThrow();
    const result = { version: 1 as const, review_id: row.id, request_digest: row.requestDigest, execution_authorized: false as const, outcome: "uncertain" as const, closed: false as const, reason: "Controlled closure is unknown" };
    await binding.receive({ kind: "product.source.design-review.result.v1", node_id: row.computerId, command_id: stop.id, payload: result });
    for (const agentInstanceId of [row.authorInstanceId, row.reviewerInstanceId]) expect(await unsettledStandaloneExecutions(f.actor, fixture().server.db.db, { agentInstanceId })).toHaveLength(1);
    await expect(binding.receive({ kind: "product.source.design-review.result.v1", node_id: row.computerId, command_id: stop.id,
      payload: { ...result, outcome: "cancelled_before_start", closed: true } })).rejects.toThrow("immutable");
    expect((await f.advanceH4()).reason).toContain("fenced");
  });
  it("H4 new sessions may query/stop but cannot start or replay success; paused goals record closure without acceptance", async () => {
    const f = await completedDesign(), row = await f.ensureH4(), first = f.h4Binding(), command = await first.dispatch(row.id), result = reviewedDesign(row);
    f.replaceSession(); const next = f.h4Binding("replacement-session");
    await expect(next.dispatch(row.id)).rejects.toThrow("new session");
    const status = await next.dispatch(row.id, "status");
    await expect(next.receive({ kind: "product.source.design-review.result.v1", node_id: row.computerId, command_id: status.id, payload: result })).rejects.toThrow("earlier paired admission");
    await fixture().server.db.db.update(goals).set({ status: "paused" }).where(eq(goals.id, row.goalId));
    await next.receive({ kind: "product.source.design-review.result.v1", node_id: row.computerId, command_id: status.id,
      payload: { version: 1, review_id: row.id, request_digest: row.requestDigest, outcome: "failed", closed: true, execution_authorized: false, reason: "Controlled closed failure after reconnect" } });
    expect((await fixture().server.db.db.select().from(goalImportedDesignReviews))[0]!.acceptedAt).toBeNull();
    expect((await fixture().server.db.db.select().from(tasks).where(eq(tasks.id, row.taskId)))[0]!.status).toBe("review");
    expect(await unsettledGoalExecutionCount(f.actor, fixture().server.db.db, row.goalId)).toBe(0);
    expect(command.type).toBe("product.source.design-review.v1");
  });
  it("H4 admission and results pass through the qualified NodeBinding parser without ordinary run projection, then pause prevents acceptance", async () => {
    const f = await completedDesign(), row = await f.ensureH4(), sent: ServerToNodeMessage[] = [];
    let ready = false;
    const binding = attachNodeBinding(f.actor, { async send(frame) { sent.push(frame); }, subscribe() { return () => {}; }, async close() {} }, row.computerId,
      [IMPORTED_DESIGN_REVIEW_FEATURE_V1], () => true, [], [], [], () => false, "windows", {
        identity: f.actor.getPairedNodeSession!(row.computerId)!, sessionId: "design-session", artifactDir: fixture().directory, qualifiedRunEventReceiptsReady: () => ready,
      });
    try {
      expect(binding.supportsExecutionFeature(IMPORTED_DESIGN_REVIEW_FEATURE_V1)).toBe(false);
      await expect(binding.dispatchImportedDesignReview!(row.id, "start")).rejects.toThrow("paired receipt session");
      ready = true; await binding.dispatchImportedDesignReview!(row.id, "start");
      const command = sent.find(frame => frame.type === "product.source.design-review.v1")!;
      const result = reviewedDesign(row), frame = parseNodeToServer(JSON.stringify({ kind: "product.source.design-review.result.v1", node_id: row.computerId, command_id: command.id, payload: result }));
      expect(frame).not.toBeNull(); binding.receive(frame!); await binding.drain();
      expect((await fixture().server.db.db.select().from(goalImportedDesignReviews))[0]!.result).toEqual(result);
      expect(sent.some(frame => frame.type === "product.source.design-review.receipt.v1")).toBe(true);
      expect(sent.some(frame => frame.type === "run.start")).toBe(false);
      await fixture().server.db.db.update(goals).set({ status: "paused" }).where(eq(goals.id, row.goalId));
      await expect(f.advanceH4()).rejects.toThrow();
      expect((await fixture().server.db.db.select().from(goalImportedDesignReviews))[0]!.acceptedAt).toBeNull();
      expect((await fixture().server.db.db.select().from(tasks).where(eq(tasks.id, row.taskId)))[0]!.status).toBe("review");
    } finally { binding.close(); }
    expect(binding.getPairedNodeSession!()).toBeUndefined();
  });
  it("H4 serializes competing DB reservations and scopes the H5 fence to the current imported plan", async () => {
    const f = await completedDesign();
    const settled = await Promise.allSettled([f.ensureH4(), f.ensureH4()]);
    expect(settled.some(value => value.status === "fulfilled")).toBe(true); expect(await fixture().server.db.db.select().from(goalImportedDesignReviews)).toHaveLength(1);
    const [row] = await fixture().server.db.db.select().from(goalImportedDesignReviews);
    await expect((await ordinaryTask("author_reserved"))(row!.authorInstanceId)).rejects.toThrow();
    await expect((await ordinaryTask("reviewer_reserved"))(row!.reviewerInstanceId)).rejects.toThrow();
    expect(await currentImportedDesignBoundary(f.actor, fixture().server.db.db, row!.goalId, row!.planId)).toBeDefined();
    const now = f.actor.clock.nowIso(); await fixture().server.db.db.insert(plans).values({ id: "replacement-plan", organizationId: f.actor.organizationId, goalId: row!.goalId,
      version: 2, authorType: "user", authorId: f.actor.actorUserId, status: "proposed", taskSpecs: [], createdAt: now });
    await expect(acceptPlan(f.actor, "replacement-plan")).rejects.toThrow();
    await stopGoalImportedDesignReviews(f.actor, row!.goalId); const binding = f.h4Binding(), stop = await binding.dispatch(row!.id, "stop");
    await binding.receive({ kind: "product.source.design-review.result.v1", node_id: row!.computerId, command_id: stop.id,
      payload: { version: 1, review_id: row!.id, request_digest: row!.requestDigest, outcome: "cancelled_before_start", closed: true, execution_authorized: false, reason: "Controlled never-started closure" } });
    await fixture().server.db.db.update(goals).set({ currentPlanId: "replacement-plan" }).where(eq(goals.id, row!.goalId));
    expect(await currentImportedDesignBoundary(f.actor, fixture().server.db.db, row!.goalId)).toBeUndefined();
    expect(await currentImportedDesignBoundary(f.actor, fixture().server.db.db, row!.goalId, row!.planId)).toBeUndefined();
  });
  async function eventually(predicate: () => boolean | Promise<boolean>, label: string) {
    const deadline = performance.now() + 8000;
    while (performance.now() < deadline) {
      if (await predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    throw Error(`Controlled WebSocket wait expired: ${label}`);
  }
  async function openOrdinaryDesignSocket(f: Awaited<ReturnType<typeof prepareDesign>>, options: { dev?: boolean; advertise?: boolean } = {}) {
    // The transfer/review capabilities remain controlled fixture data. H3 readiness
    // itself is read exclusively from the actual credential-bound WS NodeBinding.
    const support = f.actor.supportsExecutionFeature;
    Object.assign(fixture().server.ctx, { supportsVerificationProfile: f.actor.supportsVerificationProfile,
      getVerificationCapabilities: f.actor.getVerificationCapabilities, supportsReleaseProfile: f.actor.supportsReleaseProfile,
      getReleaseCapabilities: f.actor.getReleaseCapabilities });
    fixture().server.ctx.supportsExecutionFeature = (node, feature) => feature === IMPORTED_DESIGN_CONTINUATION_FEATURE_V1
      ? fixture().server.nodeRegistry.get(node)?.supportsExecutionFeature(feature) === true : support?.(node, feature) === true;
    const address = fixture().server.app.server.listening ? fixture().server.app.server.address() : undefined;
    const port = address && typeof address === "object" ? address.port : new URL(await fixture().server.app.listen({ port: 0, host: "127.0.0.1" })).port;
    const frames: ServerToNodeMessage[] = []; let fatal = false;
    const transport = createWebSocketTransport({ url: `ws://127.0.0.1:${port}/api/v1/node?token=${options.dev ? "dev" : f.destination.node_token}`,
      acknowledgeRunEvents: true, onFatalDisconnect: () => { fatal = true; },
      hello: { kind: "node.hello", node_id: f.destination.nodeId, protocol_version: "2026-06-11", artood_version: "controlled-ws-fixture",
        machine: { hostname: "controlled-native-windows", os: "windows", arch: "x64" },
        execution_features: options.advertise === false ? [] : [IMPORTED_DESIGN_CONTINUATION_FEATURE_V1] } });
    lifecycle.own(transport); transport.subscribe(frame => { frames.push(frame); }); await transport.ready;
    return { transport, frames, fatal: () => fatal };
  }
  it("reserves one real design run, preserves source input provenance and counts that exact run only once", async () => {
    const f = await prepareDesign(); await fixture().server.db.db.update(goals).set({ budgets: { max_concurrent_runs: 1 } }).where(eq(goals.id, f.base.goal_id));
    const before = await fixture().server.db.db.select().from(runs), row = await f.ensureDesign(); expect((await f.ensureDesign()).id).toBe(row.id);
    const request = ImportedDesignContinuationRequestV1Schema.parse(row.request), [run] = await fixture().server.db.db.select().from(runs).where(eq(runs.id, row.runId));
    expect((await fixture().server.db.db.select().from(runs)).length).toBe(before.length + 1);
    expect(run).toMatchObject({ taskId: "handoff_design", agentInstanceId: "design_writer_instance", computerId: f.destination.nodeId, status: "queued", requestedByUserId: f.actor.actorUserId });
    expect(request.run_start.context_pack.payload.product_development!.accepted_inputs!.files[0]).toMatchObject({ source_task_id: f.base.source.task_id, source_run_id: f.base.source.run_id, evidence_id: f.base.source.evidence_id });
    expect(request.run_start.context_pack.payload.product_development!.instructions).toContain(IMPORTED_DESIGN_CONTEXT_INSTRUCTION_V1);
    expect(request.run_start.context_pack.payload.transferred_product_input.initial_subject_digest).toBe(f.base.source.subject_digest);
    expect(request.run_start.verification!.expected_subject_digest).toBeUndefined();
    expect(await unsettledGoalExecutionCount(f.actor, fixture().server.db.db, f.base.goal_id)).toBe(1);
    const binding = f.designBinding(), command = await binding.dispatch(row.id); expect(await binding.dispatch(row.id)).toEqual(command);
    expect(f.designSent[0]).toMatchObject({ type: "product.source.design.v1", payload: { continuation_id: row.id } });
    await binding.acknowledge({ kind: "product.source.design.ack.v1", node_id: f.destination.nodeId, command_id: command.id, status: "accepted",
      payload: { version: 1, continuation_id: row.id, request_digest: row.requestDigest, run_id: row.runId } });
    expect((await fixture().server.db.db.select().from(goalImportedDesignContinuations))[0]!.result).toBeNull();
    await expect(binding.receive({ kind: "product.source.design.result.v1", node_id: f.destination.nodeId, command_id: command.id,
      payload: { version: 1, continuation_id: row.id, request_digest: row.requestDigest, run_id: row.runId, outcome: "finished", closed: true } })).rejects.toThrow("ordered ordinary terminal event");
  });
  it("settles stop-before-start from its durable exact run tombstone without inventing a verifier event", async () => {
    const f = await prepareDesign(), row = await f.ensureDesign(), binding = f.designBinding();
    await stopGoalImportedDesignContinuations(f.actor, f.base.goal_id);
    expect(f.designQueued).toEqual([{ id: row.id, control: "stop" }]);
    const stop = await binding.dispatch(row.id, "stop");
    expect(stop).toMatchObject({ type: "product.source.design.stop.v1", payload: { continuation_id: row.id, request_digest: row.requestDigest, run_id: row.runId } });
    const result = { version: 1 as const, continuation_id: row.id, request_digest: row.requestDigest, run_id: row.runId, outcome: "cancelled_before_start" as const, closed: true as const };
    await binding.receive({ kind: "product.source.design.result.v1", node_id: f.destination.nodeId, command_id: stop.id, payload: result });
    await binding.receive({ kind: "product.source.design.result.v1", node_id: f.destination.nodeId, command_id: stop.id, payload: result });
    expect((await fixture().server.db.db.select().from(runs).where(eq(runs.id, row.runId)))[0]!.status).toBe("cancelled");
    expect(await fixture().server.db.db.select().from(runEvidence).where(eq(runEvidence.runId, row.runId))).toEqual([]);
    expect(await unsettledGoalExecutionCount(f.actor, fixture().server.db.db, f.base.goal_id)).toBe(0);
    await expect(binding.dispatch(row.id)).rejects.toThrow();
  });
  it.each([false, true])("requires ordinary failure first and retains uncertainty after the real run becomes terminal, uncertain=%s", async uncertain => {
    const f = await prepareDesign(), row = await f.ensureDesign(), binding = f.designBinding(), command = await binding.dispatch(row.id);
    await f.failEvent(row.runId);
    const result = uncertain ? { version: 1 as const, continuation_id: row.id, request_digest: row.requestDigest, run_id: row.runId,
      outcome: "uncertain" as const, closed: false as const, reason: "Controlled closure remains unknown" } : { version: 1 as const, continuation_id: row.id,
      request_digest: row.requestDigest, run_id: row.runId, outcome: "failed" as const, closed: true as const, reason: "Controlled process closure confirmed after the failed event" };
    await binding.receive({ kind: "product.source.design.result.v1", node_id: f.destination.nodeId, command_id: command.id, payload: result });
    expect(await unsettledGoalExecutionCount(f.actor, fixture().server.db.db, f.base.goal_id)).toBe(uncertain ? 1 : 0);
    if (uncertain) {
      const neighbor = await otherInstance(f.destination.nodeId, "same_root_instance", f.base.destination.workspace_root);
      await expect((await ordinaryTask("same_root_task"))(neighbor)).rejects.toThrow("source operation");
      await expect(binding.receive({ kind: "product.source.design.result.v1", node_id: f.destination.nodeId, command_id: command.id,
        payload: { ...result, outcome: "failed", closed: true, reason: "Substituted closure" } })).rejects.toThrow("immutable");
    }
  });
  it.each(["pause", "plan", "task-spec", "writer-runtime", "writer-workspace", "profile", "expired-token", "session", "elapsed"])("rechecks %s before exposing a writer start", async change => {
    const f = await prepareDesign(), row = await f.ensureDesign(), binding = f.designBinding();
    if (change === "pause") await fixture().server.db.db.update(goals).set({ status: "paused" }).where(eq(goals.id, f.base.goal_id));
    if (change === "plan") await fixture().server.db.db.update(plans).set({ rationale: "Changed accepted plan" }).where(eq(plans.id, f.base.plan_id));
    if (change === "task-spec") await fixture().server.db.db.update(tasks).set({ acceptanceCriteria: ["Changed task criterion"] }).where(eq(tasks.id, row.taskId));
    if (change === "writer-runtime") await fixture().server.db.db.update(agentInstances).set({ runtime: "claude" }).where(eq(agentInstances.id, row.writerInstanceId));
    if (change === "writer-workspace") await fixture().server.db.db.update(agentInstances).set({ workspaceRoot: "/another/workspace" }).where(eq(agentInstances.id, row.writerInstanceId));
    if (change === "profile") f.actor.getVerificationCapabilities = () => undefined;
    if (change === "expired-token") await fixture().server.db.db.update(deviceTokens).set({ expiresAt: "2000-01-01T00:00:00Z" }).where(eq(deviceTokens.tokenLookup, parseDeviceToken(f.destination.node_token)!.lookup));
    if (change === "session") f.invalidateDesign();
    if (change === "elapsed") await fixture().server.db.db.update(goals).set({ runningSince: "2000-01-01T00:00:00Z", budgets: { max_elapsed_ms: 1 } }).where(eq(goals.id, f.base.goal_id));
    await expect(binding.dispatch(row.id)).rejects.toThrow(); expect(f.designSent).toEqual([]);
    expect((await fixture().server.db.db.select().from(goalImportedDesignContinuations))[0]!.request).toEqual(row.request);
  });
  it("permits only status or stop after an exposed start crosses a session and refuses ordinary starts", async () => {
    const f = await prepareDesign(), row = await f.ensureDesign(), first = f.designBinding("first"); await first.dispatch(row.id);
    const next = f.designBinding("second"); await expect(next.dispatch(row.id)).rejects.toThrow("new session");
    expect(await next.dispatch(row.id, "status")).toMatchObject({ type: "product.source.design.status.v1", payload: { run_id: row.runId } });
    const binding = attachNodeBinding(f.actor, { async send() {}, subscribe() { return () => {}; }, async close() {} }, f.destination.nodeId);
    try { await expect(binding.dispatchRunStart(row.runId)).rejects.toThrow("dedicated single-use"); } finally { binding.close(); }
    await fixture().server.db.db.update(tasks).set({ status: "ready" }).where(eq(tasks.id, row.taskId));
    await expect(assignTask(f.actor, row.taskId, { mode: "manual", agent_instance_id: row.writerInstanceId })).rejects.toThrow("dedicated single-use");
  });
  it("queues only dedicated H3 through GoalRunner after commit and protects its one-use SQL identity", async () => {
    const f = await prepareDesign(); await prepareDispatcher(f);
    const errors: unknown[] = [], ordinary: string[] = [];
    f.actor.onRunQueued = async id => { ordinary.push(id); };
    const dispatcher = createGoalAutomationDispatcher(f.actor, async () => {}, error => { errors.push(error); });
    await dispatcher.pump(); await dispatcher.stop();
    expect(errors).toEqual([]); expect(ordinary).toEqual([]);
    const [row] = await fixture().server.db.db.select().from(goalImportedDesignContinuations);
    expect(row).toBeDefined(); expect(f.designQueued).toEqual([{ id: row!.id, control: "start" }]);
    await expect(fixture().server.db.db.update(goalImportedDesignContinuations).set({ requestDigest: sha("changed") })).rejects.toThrow();
    await expect(fixture().server.db.db.delete(goalImportedDesignContinuations)).rejects.toThrow();
    expect(getTableConfig(goalImportedDesignContinuations).uniqueConstraints).toHaveLength(3);
  });
  it("does not turn a closed design result into acceptance, another ordinary writer, or goal completion", async () => {
    const f = await prepareDesign(), row = await f.ensureDesign(), binding = f.designBinding(), command = await binding.dispatch(row.id);
    await f.failEvent(row.runId);
    // Dedicated finished means the execution has closed. The persisted ordinary failure
    // remains authoritative, and this result supplies no node-owned verification.
    await binding.receive({ kind: "product.source.design.result.v1", node_id: f.destination.nodeId, command_id: command.id,
      payload: { version: 1, continuation_id: row.id, request_digest: row.requestDigest, run_id: row.runId, outcome: "finished", closed: true } });
    const before = await fixture().server.db.db.select({ id: runs.id }).from(runs), errors: unknown[] = [], ordinary: string[] = [];
    f.actor.onRunQueued = async id => { ordinary.push(id); };
    await prepareDispatcher(f);
    const dispatcher = createGoalAutomationDispatcher(f.actor, async () => {}, error => { errors.push(error); });
    await dispatcher.pump(); await dispatcher.stop();
    expect(errors).toEqual([]); expect(ordinary).toEqual([]); expect(f.designQueued).toEqual([]);
    expect(await fixture().server.db.db.select({ id: runs.id }).from(runs)).toEqual(before);
    expect(await f.automation()).toMatchObject({ status: "waiting", lastError: "Imported design requires reconciliation before continuation: finished" });
    expect((await fixture().server.db.db.select().from(goals).where(eq(goals.id, f.base.goal_id)))[0]!.status).toBe("running");
    expect((await fixture().server.db.db.select().from(tasks).where(eq(tasks.id, row.taskId)))[0]!.status).not.toBe("done");
    expect(await fixture().server.db.db.select().from(runEvidence).where(eq(runEvidence.runId, row.runId))).toEqual([]);
  });
  it("admits ordinary paired Windows H3 only after schema readiness and resolves stop only after its committed event and dedicated closed result", async () => {
    const f = await prepareDesign(), row = await f.ensureDesign(), realCheck = qualifiedReceipts.requireQualifiedReceiptSchema;
    let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(qualifiedReceipts, "requireQualifiedReceiptSchema").mockImplementationOnce(async ctx => { await pending; await realCheck(ctx); });
    const peer = await openOrdinaryDesignSocket(f);
    try {
      await eventually(() => !!fixture().server.nodeRegistry.get(f.destination.nodeId), "ordinary paired registration");
      const binding = fixture().server.nodeRegistry.get(f.destination.nodeId)!;
      expect(binding.supportsExecutionFeature(IMPORTED_DESIGN_CONTINUATION_FEATURE_V1)).toBe(false);
      await expect(binding.dispatchImportedDesignContinuation!(row.id, "start")).rejects.toThrow("configured native Windows writer");
      expect(peer.frames.some(frame => frame.type === "product.source.design.v1")).toBe(false);
      release(); await eventually(() => binding.supportsExecutionFeature(IMPORTED_DESIGN_CONTINUATION_FEATURE_V1), "qualified ordinary receipts");
      await binding.dispatchImportedDesignContinuation!(row.id, "start");
      await eventually(() => peer.frames.some(frame => frame.type === "product.source.design.v1"), "dedicated start");
      let stopResolved = false; const stopped = binding.dispatchRunStop(row.runId).then(() => { stopResolved = true; });
      void stopped.catch(() => {});
      await eventually(() => peer.frames.some(frame => frame.type === "product.source.design.stop.v1"), "dedicated stop");
      const stop = peer.frames.find(frame => frame.type === "product.source.design.stop.v1")!;
      if (stop.type !== "product.source.design.stop.v1") throw Error("Expected dedicated stop");
      await peer.transport.send({ kind: "product.source.design.ack.v1", node_id: f.destination.nodeId, command_id: stop.id, status: "accepted", payload: stop.payload });
      await eventually(async () => (await fixture().server.db.db.select().from(goalImportedDesignDeliveries).where(eq(goalImportedDesignDeliveries.id, stop.id)))[0]?.ack != null, "dedicated ACK committed");
      expect(stopResolved).toBe(false);
      const frame = { kind: "run.event" as const, node_id: f.destination.nodeId, run_id: row.runId, sequence: 0,
        event: { type: "run.lifecycle" as const, payload: { phase: "failed" as const, reason: "Controlled WS closure; no native process" } } };
      // Real ordinary transport resolves this send only after the server sends its
      // accepted full-frame receipt following the committed terminal transaction.
      await peer.transport.send(frame);
      expect((await fixture().server.db.db.select().from(runEventIngest).where(eq(runEventIngest.runId, row.runId)))[0]?.bodyIdentity).toBe(qualifyRunEventMessage(frame).bodyIdentity);
      expect(stopResolved).toBe(false);
      await peer.transport.send({ kind: "product.source.design.result.v1", node_id: f.destination.nodeId, command_id: stop.id,
        payload: { ...stop.payload, outcome: "failed", closed: true, reason: "Controlled ordinary terminal event and process closure" } });
      await stopped;
      expect((await fixture().server.db.db.select().from(goalImportedDesignContinuations).where(eq(goalImportedDesignContinuations.id, row.id)))[0]!.result).toMatchObject({ outcome: "failed", closed: true });
      expect(peer.frames.some(frame => frame.type === "node.session.ready")).toBe(false);
    } finally { release(); }
  });
  it.each(["resolved", "rejected"])("cannot revive or unregister an ordinary H3 binding when schema readiness is %s after replacement and rechecks an expired paired token", async late => {
    const f = await prepareDesign(), row = await f.ensureDesign(), realCheck = qualifiedReceipts.requireQualifiedReceiptSchema;
    let release!: () => void, reject!: (error: Error) => void; const pending = new Promise<void>((resolve, no) => { release = resolve; reject = no; });
    vi.spyOn(qualifiedReceipts, "requireQualifiedReceiptSchema").mockImplementationOnce(async ctx => { await pending; await realCheck(ctx); });
    const previous = await openOrdinaryDesignSocket(f);
    try {
      await eventually(() => !!fixture().server.nodeRegistry.get(f.destination.nodeId), "first ordinary binding");
      const first = fixture().server.nodeRegistry.get(f.destination.nodeId)!;
      const next = await openOrdinaryDesignSocket(f);
      await eventually(() => fixture().server.nodeRegistry.get(f.destination.nodeId) !== first && fixture().server.nodeRegistry.get(f.destination.nodeId)?.supportsExecutionFeature(IMPORTED_DESIGN_CONTINUATION_FEATURE_V1) === true, "replacement qualified binding");
      if (late === "rejected") { reject(Error("Controlled late schema rejection")); await eventually(previous.fatal, "old rejected schema closes old socket"); }
      else { release(); await realCheck(fixture().server.ctx); }
      expect(first.supportsExecutionFeature(IMPORTED_DESIGN_CONTINUATION_FEATURE_V1)).toBe(false);
      await expect(first.dispatchImportedDesignContinuation!(row.id, "start")).rejects.toThrow("no longer current");
      expect(next.transport.connected).toBe(true); expect(next.fatal()).toBe(false);
      expect(fixture().server.nodeRegistry.get(f.destination.nodeId)!.supportsExecutionFeature(IMPORTED_DESIGN_CONTINUATION_FEATURE_V1)).toBe(true);
      await fixture().server.db.db.update(deviceTokens).set({ expiresAt: "2000-01-01T00:00:00Z" }).where(eq(deviceTokens.tokenLookup, parseDeviceToken(f.destination.node_token)!.lookup));
      await expect(fixture().server.nodeRegistry.get(f.destination.nodeId)!.dispatchImportedDesignContinuation!(row.id, "status")).rejects.toThrow("credential is no longer current");
      expect(next.frames.some(frame => frame.type.startsWith("product.source.design"))).toBe(false);
    } finally { release(); }
  });
  it("fails closed for unavailable ordinary H3 receipt schema without changing the immutable writer", async () => {
    const f = await prepareDesign(), row = await f.ensureDesign();
    vi.spyOn(qualifiedReceipts, "requireQualifiedReceiptSchema").mockRejectedValueOnce(Error("Controlled missing receipt schema"));
    const peer = await openOrdinaryDesignSocket(f);
    await eventually(() => peer.fatal() && !fixture().server.nodeRegistry.get(f.destination.nodeId), "H3 schema rejection closes socket");
    expect(peer.frames.some(frame => frame.type.startsWith("product.source.design"))).toBe(false);
    expect((await fixture().server.db.db.select().from(goalImportedDesignContinuations).where(eq(goalImportedDesignContinuations.id, row.id)))[0]!.result).toBeNull();
  });
  it("gives neither dev nodes H3 authority nor ordinary non-H3 nodes a new schema handshake", async () => {
    const f = await prepareDesign(), row = await f.ensureDesign(), probe = vi.spyOn(qualifiedReceipts, "requireQualifiedReceiptSchema");
    const ordinary = await openOrdinaryDesignSocket(f, { advertise: false });
    await eventually(() => !!fixture().server.nodeRegistry.get(f.destination.nodeId), "ordinary non-H3 registration");
    expect(probe).not.toHaveBeenCalled(); expect(ordinary.fatal()).toBe(false);
    const previous = fixture().server.nodeRegistry.get(f.destination.nodeId)!;
    await openOrdinaryDesignSocket(f, { dev: true });
    await eventually(() => !!fixture().server.nodeRegistry.get(f.destination.nodeId) && fixture().server.nodeRegistry.get(f.destination.nodeId) !== previous, "dev registration");
    const dev = fixture().server.nodeRegistry.get(f.destination.nodeId)!;
    expect(probe).not.toHaveBeenCalled(); expect(dev.supportsExecutionFeature(IMPORTED_DESIGN_CONTINUATION_FEATURE_V1)).toBe(false);
    await expect(dev.dispatchImportedDesignContinuation!(row.id, "start")).rejects.toThrow("paired receipt session");
  });

  // These cases exercise real DB constraints and the production registry/dispatch
  // services. Every physical identity/closure below is explicitly controlled
  // fixture data; none establishes a native process or live product acceptance.
  async function prepareCleanLifecycle() {
    const f = await prepareH7(), support = f.actor.supportsExecutionFeature, pairedSession = f.actor.getPairedNodeSession!;
    f.actor.supportsExecutionFeature = (node, feature) => [SOURCE_CLEAN_RESTART_FEATURE_V1, PRODUCT_SOURCE_RECOVERY_FEATURE_V1].includes(feature)
      ? node === f.destination.nodeId : support?.(node, feature) === true;
    let sessionId = "design-session", connected = true;
    f.actor.getPairedNodeSession = node => node === f.destination.nodeId ? { ...f.identity, sessionId } : pairedSession(node);
    const registry = createSourceLifecycleRegistry(f.actor);
    lifecycle.own({ async close() { registry.close(); } });
    const parent = registry.open(f.identity, () => connected);
    const registration = ProductSourceRecoveryRegistrationV1Schema.parse({ version: 1, registration_id: randomUUID(),
      binding: { version: 1, node_id: f.destination.nodeId, device_id: f.destination.device.id, guardian_instance_id: randomUUID(),
        store_identity_digest: sha("controlled clean genesis store"), configuration_digest: sha("controlled exact initial launch configuration"),
        workspace_root: f.h6.workspaceRoot, workspace_identity_digest: sha("controlled clean workspace identity") },
      epoch: { version: 1, epoch_id: randomUUID(), generation: 0, session_id: sessionId, roster_revision: 0, roster_digest: sha("controlled clean empty roster") } });
    const launch = SourceSupervisorLaunchV1Schema.parse({ version: 1, observer_id: parent.hello.observer_id,
      supervisor: { pid: 41001, creationTime: "1000000001", image: "C:\\controlled\\Supervisor.exe", sid: "S-1-5-21-1" },
      launch_identity_digest: sha("controlled original native launch"), runtime_manifest_digest: sha("controlled runtime manifest"),
      stable: { version: 1, node_id: f.destination.nodeId, device_id: f.destination.device.id,
        store_family_identity_digest: sha("controlled generation store family"), genesis_store_identity_digest: registration.binding.store_identity_digest,
        workspace_root: f.h6.workspaceRoot, workspace_identity_digest: registration.binding.workspace_identity_digest,
        stable_configuration_digest: sha("controlled stable verifier and publication configuration") } });
    const registered = SourceLifecycleRegistrationV1Schema.parse({ version: 1, launch, registration });
    const registerGuardian = async (value: typeof registration) => {
      const session = sessionId;
      const peer = createSourceRecoveryBinding(f.actor, { identity: f.identity, sessionId: session, isCurrent: () => session === sessionId,
        transport: { async send() {} } });
      await peer.register({ kind: "product.source.recovery.register.v1", node_id: f.destination.nodeId, payload: value });
    };
    await registerGuardian(registration);
    await expect(registry.registerDaemon(f.identity, sessionId, registered)).rejects.toThrow("independently bound original launcher");
    await parent.bindLaunch(parent.hello.challenge, launch);
    const accepted = await registry.registerDaemon(f.identity, sessionId, registered);
    expect(await registry.registerDaemon(f.identity, sessionId, registered)).toEqual(accepted);
    return { ...f, registry, parent, registration, launch, registered, accepted, registerGuardian,
      disconnect() { connected = false; parent.close(); }, setSession(next: string) { sessionId = next; } };
  }
  function controlledCleanClosure(intent: SourceCleanStopIntentV1) {
    return SourceSupervisedCleanClosureV1Schema.parse({ version: 1, kind: "whole-supervisor-job-closed.v1", stop_id: intent.stop_id,
      intent_digest: hash(intent), observer_id: intent.launch.observer_id, supervisor: intent.launch.supervisor,
      launch_identity_digest: intent.launch.launch_identity_digest, native_terminal_digest: sha("controlled native terminal projection"),
      retained_history_digest: sha("controlled complete retained history inventory"),
      incarnations: [{ generation: 0, identity: { ...intent.launch.supervisor, pid: 41002, creationTime: "1000000002", image: "C:\\controlled\\node.exe" },
        root_wait_observed: true, exit_code: 0, stdout_eof: true, stderr_eof: true, input_settled: true, atomic_job_member: true }],
      normal_daemon_shutdown: true, graceful_stop_armed: true, graceful_stop_timed_out: false,
      job_empty_observed: true, forced_job_termination: false,
      parent: { spawned: true, exited: true, closed: true, stdout_eof: true, stderr_eof: true, exit_code: 0, close_code: 0,
        signal: null, close_signal: null, inputs_unchanged: true } });
  }
  it("rolls back clean prepare and claim when their complete replies exceed the remaining connection budget", async () => {
    const f = await prepareCleanLifecycle(), db = fixture().server.db.db, budget = SOURCE_LIFECYCLE_CONTROL_REPLY_RESERVE_BYTES_V1;
    const originalLineage = await db.select().from(sourceWorkspaceLineages), originalEvents = await db.select().from(eventLog);
    await expect(f.parent.prepareStop(f.parent.hello.challenge, budget)).rejects.toThrow("bounded transport or retained reply budget");
    expect(await db.select().from(sourceCleanStops)).toEqual([]);
    expect(await db.select().from(sourceCleanGenerations)).toEqual([]);
    expect(await db.select().from(sourceWorkspaceLineages)).toEqual(originalLineage);
    expect(await db.select().from(eventLog)).toEqual(originalEvents);
    await expect(f.parent.commitStop(f.parent.hello.challenge, {})).rejects.toThrow("no prepared clean-stop intent");
    const intent = await f.parent.prepareStop(f.parent.hello.challenge);
    expect(Buffer.byteLength(JSON.stringify(intent), "utf8")).toBeGreaterThan(budget);
    const preparedStops = await db.select().from(sourceCleanStops), preparedEvents = await db.select().from(eventLog);
    const preparedLineage = await db.select().from(sourceWorkspaceLineages);
    await expect(f.parent.prepareStop(f.parent.hello.challenge, budget)).rejects.toThrow("bounded transport or retained reply budget");
    expect(await db.select().from(sourceCleanStops)).toEqual(preparedStops);
    expect(await db.select().from(eventLog)).toEqual(preparedEvents);
    expect(await db.select().from(sourceWorkspaceLineages)).toEqual(preparedLineage);
    await f.parent.commitStop(f.parent.hello.challenge, controlledCleanClosure(intent)); f.disconnect();
    const successor = f.registry.open(f.identity, () => true), closedLineage = await db.select().from(sourceWorkspaceLineages);
    const closedEvents = await db.select().from(eventLog);
    await expect(successor.claimRestart(successor.hello.challenge, intent.stop_id, budget)).rejects.toThrow("bounded transport or retained reply budget");
    expect(await db.select().from(sourceCleanGenerations)).toEqual([]);
    expect(await db.select().from(sourceWorkspaceLineages)).toEqual(closedLineage);
    expect(await db.select().from(eventLog)).toEqual(closedEvents);
    const grant = await successor.claimRestart(successor.hello.challenge, intent.stop_id);
    expect(Buffer.byteLength(JSON.stringify(grant), "utf8")).toBeGreaterThan(budget);
    const reservedGenerations = await db.select().from(sourceCleanGenerations), reservedEvents = await db.select().from(eventLog);
    const reservedLineage = await db.select().from(sourceWorkspaceLineages);
    await expect(successor.claimRestart(successor.hello.challenge, intent.stop_id, budget)).rejects.toThrow("bounded transport or retained reply budget");
    expect(await db.select().from(sourceCleanGenerations)).toEqual(reservedGenerations);
    expect(await db.select().from(eventLog)).toEqual(reservedEvents);
    expect(await db.select().from(sourceWorkspaceLineages)).toEqual(reservedLineage);
    expect(await successor.claimRestart(successor.hello.challenge, intent.stop_id)).toEqual(grant);
  }, 60000);
  it("clean lifecycle freezes every start but preserves status and cannot replace a disconnected original observer", async () => {
    const f = await prepareCleanLifecycle(), db = fixture().server.db.db, author = await f.ensure();
    await f.authorPeer().dispatch(author.id);
    const intent = await f.parent.prepareStop(f.parent.hello.challenge);
    expect(intent.operations).toEqual([{ kind: "validation", operation_id: author.id, request_digest: author.requestDigest, run_id: author.runId }]);
    expect(await f.parent.prepareStop(f.parent.hello.challenge)).toEqual(intent);
    await expect(f.authorPeer().dispatch(author.id)).rejects.toThrow("retained clean-stop");
    await expect(fixture().server.db.transaction(tx => assertSourceLineageDispatch(f.actor, tx, f.destination.nodeId, "C:\\another-workspace")))
      .rejects.toThrow("retained clean-stop");
    const status = await f.authorPeer().dispatch(author.id, "status"); expect(status.type).toBe("product.source.validation.status.v1");
    const closure = controlledCleanClosure(intent);
    await expect(f.parent.commitStop(f.parent.hello.challenge, { ...closure, parent: { ...closure.parent, stdout_eof: false } })).rejects.toThrow();
    expect((await db.select().from(sourceCleanStops))[0]!.closure).toBeNull();
    f.disconnect();
    await expect(f.parent.commitStop(f.parent.hello.challenge, closure)).rejects.toThrow("no longer live");
    const replacement = f.registry.open(f.identity, () => true);
    await expect(replacement.commitStop(replacement.hello.challenge, closure)).rejects.toThrow("no prepared clean-stop intent");
    await expect(replacement.claimRestart(replacement.hello.challenge, intent.stop_id)).rejects.toThrow("unobserved or uncommitted");
    expect((await db.select().from(sourceWorkspaceLineages))[0]!.state).toBe("closing");
    expect(await db.select().from(sourceCleanGenerations)).toEqual([]);
  });
  it("clean lifecycle retains history and reserves only one successor after its exact committed closure", async () => {
    const f = await prepareCleanLifecycle(), db = fixture().server.db.db;
    const intruder = f.registry.open(f.identity, () => true), forgedLaunch = { ...f.launch, observer_id: intruder.hello.observer_id };
    await intruder.bindLaunch(intruder.hello.challenge, forgedLaunch);
    await expect(f.registry.registerDaemon(f.identity, "design-session", { ...f.registered, launch: forgedLaunch })).rejects.toThrow("retained physical workspace lineage");
    const intent = await f.parent.prepareStop(f.parent.hello.challenge), closure = controlledCleanClosure(intent);
    const receipt = await f.parent.commitStop(f.parent.hello.challenge, closure);
    expect(await f.parent.commitStop(f.parent.hello.challenge, closure)).toEqual(receipt);
    await expect(f.parent.commitStop(f.parent.hello.challenge, { ...closure, retained_history_digest: sha("different history") })).rejects.toThrow("original closure");
    f.disconnect(); f.setSession("controlled-clean-successor-session");
    const successor = f.registry.open(f.identity, () => true), grant = await successor.claimRestart(successor.hello.challenge, intent.stop_id);
    expect(grant.predecessor).toEqual(receipt); expect(grant.predecessor_history_digest).toBe(closure.retained_history_digest);
    expect(await successor.claimRestart(successor.hello.challenge, intent.stop_id)).toEqual(grant);
    const competitor = f.registry.open(f.identity, () => true);
    await expect(competitor.claimRestart(competitor.hello.challenge, intent.stop_id)).rejects.toThrow("retained successor");
    await expect(db.delete(sourceCleanStops).where(eq(sourceCleanStops.id, intent.stop_id)))
      .rejects.toMatchObject({ cause: { code: "P0001", message: "Clean stop history is immutable" } });
    await expect(db.delete(sourceCleanGenerations).where(eq(sourceCleanGenerations.id, grant.generation_id)))
      .rejects.toMatchObject({ cause: { code: "P0001", message: "A claimed source generation cannot be discarded" } });
    expect((await db.select().from(sourceWorkspaceLineages))[0]!.state).toBe("reserved");
    expect((await db.select().from(sourceCleanGenerations))).toHaveLength(1);
    expect((await db.select().from(nodeRecoveryRegistrations))).toHaveLength(1);
    expect(await db.select().from(productReleases)).toEqual([]);
  });
  it("clean lifecycle commits a fresh unverified checkpoint and lets only the original GoalRunner settle its lineage", async () => {
    const f = await prepareCleanLifecycle(), db = fixture().server.db.db;
    const intent = await f.parent.prepareStop(f.parent.hello.challenge), closure = controlledCleanClosure(intent);
    await f.parent.commitStop(f.parent.hello.challenge, closure); f.disconnect();
    const sessionId = "controlled-clean-successor-session"; f.setSession(sessionId);
    const successor = f.registry.open(f.identity, () => true), grant = await successor.claimRestart(successor.hello.challenge, intent.stop_id);
    const launch = SourceSupervisorLaunchV1Schema.parse({ ...f.launch, observer_id: successor.hello.observer_id,
      supervisor: { ...f.launch.supervisor, pid: 42001, creationTime: "2000000001" }, launch_identity_digest: sha("controlled fresh launch") });
    await successor.bindLaunch(successor.hello.challenge, launch);
    const registration = ProductSourceRecoveryRegistrationV1Schema.parse({ ...f.registration, registration_id: randomUUID(),
      binding: { ...f.registration.binding, guardian_instance_id: randomUUID(), store_identity_digest: sha("controlled new store"), configuration_digest: sha("controlled exact fresh launch configuration") },
      epoch: { ...f.registration.epoch, epoch_id: randomUUID(), session_id: sessionId } });
    await f.registerGuardian(registration);
    const registered = SourceLifecycleRegistrationV1Schema.parse({ version: 1, launch, registration, successor_grant_digest: hash(grant) });
    const ack = await f.registry.registerDaemon(f.identity, sessionId, registered);
    expect(ack.restart_grant).toEqual(grant);
    const manifest = { directories: [".artoo", ".artoo/product"], files: grant.origin.implementation_source.verification.required_files
      .map((file, index) => ({ ...file, reference: `controlled_clean_baseline_${index}` })) }, subject = sha("controlled clean unverified source");
    const checkpoint = SourceCleanRestartCheckpointV1Schema.parse({ version: 1, lineage_id: grant.lineage_id, generation_id: grant.generation_id,
      grant_digest: hash(grant), lifecycle_registration: registered, predecessor_history_digest: closure.retained_history_digest, subject_digest: subject,
      baseline: { version: 1, snapshot_id: "controlled_clean_snapshot", subject_digest: subject, ...manifest, manifest_digest: hash(manifest) },
      accepted_inputs: importedExecutionAcceptedInputsV1(grant.origin.execution_request), source_state: "unverified" });
    await expect(f.registry.checkpoint(f.identity, sessionId, { ...checkpoint, predecessor_history_digest: sha("another predecessor") })).rejects.toThrow("unverified baseline");
    const receipt = await f.registry.checkpoint(f.identity, sessionId, checkpoint);
    expect(await f.registry.checkpoint(f.identity, sessionId, checkpoint)).toEqual(receipt);
    await expect(fixture().server.db.transaction(tx => settleSourceCleanGeneration({ ...f.actor, automationActor: undefined }, tx, grant.generation_id)))
      .rejects.toThrow("initiating user's GoalRunner");
    const settle = () => fixture().server.db.transaction(tx => settleSourceCleanGeneration(f.actor, tx, grant.generation_id));
    const settled = await settle(); expect((await settle()).generation.settlementEventId).toBe(settled.generation.settlementEventId);
    expect((await db.select().from(sourceWorkspaceLineages))[0]).toMatchObject({ state: "recovery", currentRegistrationId: registration.registration_id,
      currentGenerationId: grant.generation_id, initialRegistration: f.registered });
    await expect(fixture().server.db.transaction(tx => assertSourceLineageDispatch(f.actor, tx, f.destination.nodeId, f.h6.workspaceRoot)))
      .rejects.toThrow("dedicated fresh validation");
    expect((await db.select().from(sourceCleanStops))[0]!.closure).toEqual(closure);
    expect(await db.select().from(nodeRecoveryRegistrations)).toHaveLength(2);
    expect(await db.select().from(goalSourceRecoveries)).toEqual([]);
    expect(await db.select().from(goalRecoveryValidations)).toEqual([]);
    expect(await db.select().from(productReleases)).toEqual([]);
  });
  async function prepareCleanCheckpoint(kind: "author" | "publication" = "author",
    connectSuccessor?: (prehistory: Awaited<ReturnType<typeof prepareCleanLifecycle>>) => Promise<string>) {
    const f = await prepareCleanLifecycle(), db = fixture().server.db.db, support = f.actor.supportsExecutionFeature;
    f.actor.supportsExecutionFeature = (node, feature) => [IMPORTED_CLEAN_VALIDATION_FEATURE_V1, IMPORTED_CLEAN_VALIDATION_REVIEW_FEATURE_V1,
      PRODUCT_RELEASE_CLEAN_FEATURE_V1, PRODUCT_RELEASE_RETRY_FEATURE_V1].includes(feature) ? node === f.destination.nodeId : support?.(node, feature) === true;
    const oldAuthor = kind === "publication" ? await completedValidation(f) : await f.ensure();
    let oldRelease: typeof productReleases.$inferSelect | undefined;
    if (kind === "publication") {
      await settleValidationReview(f, oldAuthor);
      const a = await f.automation(); await fixture().server.db.transaction(tx => ensureGoalProductRelease(f.actor, tx, a));
      [oldRelease] = await db.select().from(productReleases).where(eq(productReleases.goalId, a.goalId));
      if (!oldRelease) throw Error("Controlled original queued publication missing");
    } else {
      await f.authorPeer().dispatch(oldAuthor.id);
      await ingestWireRunEvent(f.actor, { kind: "run.event", node_id: oldAuthor.computerId, run_id: oldAuthor.runId, sequence: 0,
        event: { type: "run.lifecycle", payload: { phase: "started" } } });
    }
    const intent = await f.parent.prepareStop(f.parent.hello.challenge), closure = controlledCleanClosure(intent);
    await f.parent.commitStop(f.parent.hello.challenge, closure); f.disconnect();
    const sessionId = connectSuccessor ? await connectSuccessor(f) : "controlled-clean-successor-session"; f.setSession(sessionId);
    const successor = f.registry.open(f.identity, () => true), grant = await successor.claimRestart(successor.hello.challenge, intent.stop_id);
    const launch = SourceSupervisorLaunchV1Schema.parse({ ...f.launch, observer_id: successor.hello.observer_id,
      supervisor: { ...f.launch.supervisor, pid: 42001, creationTime: "2000000001" }, launch_identity_digest: sha("controlled fresh launch") });
    await successor.bindLaunch(successor.hello.challenge, launch);
    const registration = ProductSourceRecoveryRegistrationV1Schema.parse({ ...f.registration, registration_id: randomUUID(),
      binding: { ...f.registration.binding, guardian_instance_id: randomUUID(), store_identity_digest: sha("controlled new store"), configuration_digest: sha("controlled exact fresh launch configuration") },
      epoch: { ...f.registration.epoch, epoch_id: randomUUID(), session_id: sessionId } });
    await f.registerGuardian(registration);
    const registered = SourceLifecycleRegistrationV1Schema.parse({ version: 1, launch, registration, successor_grant_digest: hash(grant) });
    await f.registry.registerDaemon(f.identity, sessionId, registered);
    const manifest = { directories: [".artoo", ".artoo/product"], files: grant.origin.implementation_source.verification.required_files
      .map((file, index) => ({ ...file, reference: `controlled_clean_baseline_${index}` })) }, subject = sha("controlled clean unverified source");
    const checkpoint = SourceCleanRestartCheckpointV1Schema.parse({ version: 1, lineage_id: grant.lineage_id, generation_id: grant.generation_id,
      grant_digest: hash(grant), lifecycle_registration: registered, predecessor_history_digest: closure.retained_history_digest, subject_digest: subject,
      baseline: { version: 1, snapshot_id: "controlled_clean_snapshot", subject_digest: subject, ...manifest, manifest_digest: hash(manifest) },
      accepted_inputs: importedExecutionAcceptedInputsV1(grant.origin.execution_request), source_state: "unverified" });
    const receipt = await f.registry.checkpoint(f.identity, sessionId, checkpoint);
    const settle = () => fixture().server.db.transaction(async tx => {
      const value = await settleSourceCleanGeneration(f.actor, tx, grant.generation_id);
      await settleCleanPublications(f.actor, tx, grant.generation_id); return value;
    });
    const freshAuthor = async () => { const a = await f.automation(); return fixture().server.db.transaction(tx => ensureGoalCleanValidation(f.actor, tx, a, grant.generation_id)); };
    return { ...f, oldAuthor, oldRelease, intent, closure, grant, checkpoint, receipt, settle, freshAuthor };
  }
  async function plannedStopParent() {
    // Native launch/registration and prior model evidence are controlled. The
    // paired parent WebSocket, client request/abort, registry and DB transitions
    // are production code; no readiness result or protocol reply is fabricated.
    const f = await prepareH6(); await prepareDispatcher(f);
    const automation = await f.automation(), team = automation.team as { members: { stage: string; agent_instance_id: string }[] };
    await fixture().server.db.db.update(goalAutomations).set({ team: { ...team, members: team.members.map(member => member.stage === "validation"
      ? { ...member, agent_instance_id: "design_writer_instance" } : member) } }).where(eq(goalAutomations.goalId, f.base.goal_id));
    const support = f.actor.supportsExecutionFeature, pairedSession = f.actor.getPairedNodeSession!;
    f.actor.supportsExecutionFeature = (node, feature) => [SOURCE_CLEAN_RESTART_FEATURE_V1, PRODUCT_SOURCE_RECOVERY_FEATURE_V1,
      IMPORTED_VALIDATION_FEATURE_V1].includes(feature) ? node === f.destination.nodeId : support?.(node, feature) === true;
    let sessionId = "design-session";
    const identity = { computerId: f.destination.nodeId, deviceId: f.destination.device.id, tokenLookup: parseDeviceToken(f.destination.node_token)!.lookup };
    f.actor.getPairedNodeSession = node => node === f.destination.nodeId ? { ...identity, sessionId } : pairedSession(node);
    const server = fixture().server;
    Object.assign(server.ctx, { getPairedNodeSession: f.actor.getPairedNodeSession, supportsExecutionFeature: f.actor.supportsExecutionFeature,
      supportsVerificationProfile: f.actor.supportsVerificationProfile, getVerificationWorkspace: f.actor.getVerificationWorkspace,
      getVerificationCapabilities: f.actor.getVerificationCapabilities, supportsReleaseProfile: f.actor.supportsReleaseProfile,
      getReleaseCapabilities: f.actor.getReleaseCapabilities });
    // This spy only observes the original object returned by the real WS route.
    const registry = server.ctx.sourceLifecycle as ReturnType<typeof createSourceLifecycleRegistry>;
    const opened = vi.spyOn(registry, "open"), address = server.app.server.listening ? server.app.server.address() : undefined;
    const port = address && typeof address === "object" ? address.port : new URL(await server.app.listen({ port: 0, host: "127.0.0.1" })).port;
    const observer = await openSourceLifecycleObserver({ nodeUrl: `ws://127.0.0.1:${port}/api/v1/node?token=${f.destination.node_token}`, nodeId: f.destination.nodeId });
    const controller = new AbortController();
    let outcome: { intent: SourceCleanStopIntentV1; error?: never } | { error: unknown; intent?: never } | undefined;
    let waiting: Promise<void> | undefined, closing: Promise<void> | undefined;
    const close = () => closing ??= (async () => {
      controller.abort(Error("Controlled parent fixture cleanup"));
      await waiting; await closeSourceLifecycleObserver(observer);
    })();
    lifecycle.own({ close });
    const parent = opened.mock.results.at(-1)!.value as ReturnType<typeof registry.open>;
    expect(parent.hello.observer_id).toBe(sourceLifecycleObserverIdentity(observer).observer_id);
    const registration = ProductSourceRecoveryRegistrationV1Schema.parse({ version: 1, registration_id: randomUUID(),
      binding: { version: 1, node_id: f.destination.nodeId, device_id: f.destination.device.id, guardian_instance_id: randomUUID(),
        store_identity_digest: sha("controlled planned-stop store"), configuration_digest: sha("controlled planned-stop configuration"),
        workspace_root: f.base.destination.workspace_root, workspace_identity_digest: sha("controlled planned-stop workspace") },
      epoch: { version: 1, epoch_id: randomUUID(), generation: 0, session_id: sessionId, roster_revision: 0, roster_digest: sha("controlled empty roster") } });
    const launch = SourceSupervisorLaunchV1Schema.parse({ version: 1, observer_id: parent.hello.observer_id,
      supervisor: { pid: 43001, creationTime: "3000000001", image: "C:\\controlled\\Supervisor.exe", sid: "S-1-5-21-1" },
      launch_identity_digest: sha("controlled planned-stop launch"), runtime_manifest_digest: sha("controlled planned-stop bundle"),
      stable: { version: 1, node_id: f.destination.nodeId, device_id: f.destination.device.id,
        store_family_identity_digest: sha("controlled planned-stop family"), genesis_store_identity_digest: registration.binding.store_identity_digest,
        workspace_root: registration.binding.workspace_root, workspace_identity_digest: registration.binding.workspace_identity_digest,
        stable_configuration_digest: sha("controlled planned-stop stable configuration") } });
    await bindSourceLifecycleLaunch(observer, launch);
    await expect(parent.isReadyForPlannedStop(parent.hello.challenge)).rejects.toThrow("original registered initial generation");
    const peer = createSourceRecoveryBinding(f.actor, { identity, sessionId, isCurrent: () => true, transport: { async send() {} } });
    await peer.register({ kind: "product.source.recovery.register.v1", node_id: identity.computerId, payload: registration });
    await registry.registerDaemon(identity, sessionId, SourceLifecycleRegistrationV1Schema.parse({ version: 1, launch, registration }));
    const inspected = vi.spyOn(parent, "isReadyForPlannedStop");
    return { ...f, parent, observer, inspected, launch, registration, close, setSession(value: string) { sessionId = value; },
      wait() {
        if (waiting) throw Error("One original planned wait per fixture");
        waiting = prepareSourceCleanStop(observer, { waitForAcceptedH6: true, signal: controller.signal }).then(
          intent => { outcome = { intent }; }, error => { outcome = { error }; });
      },
      cancel() { controller.abort(Error("Controlled user stop")); },
      async outcome() { await eventually(() => outcome !== undefined, "original planned-stop response or cancellation"); return outcome!; },
      async acceptH6() {
        const review = await f.ensureH6(), binding = f.h6Binding(), command = await binding.dispatch(review.id);
        await binding.receive({ kind: "product.source.execution-review.result.v1", node_id: f.destination.nodeId,
          command_id: command.id, payload: reviewedImplementation(review) });
        await f.advanceH6(); return review;
      },
    };
  }
  it("waits on the real original parent connection until H6 acceptance, then freezes exactly one bound clean stop", async () => {
    const f = await plannedStopParent(), db = fixture().server.db.db;
    try {
      f.wait(); await eventually(() => f.inspected.mock.calls.length >= 2, "two real pre-H6 eligibility observations");
      expect(await db.select().from(sourceCleanStops)).toEqual([]);
      expect((await db.select().from(sourceWorkspaceLineages))[0]).toMatchObject({ state: "active", revision: 0 });
      const review = await f.acceptH6(), outcome = await f.outcome();
      if (outcome.error !== undefined) throw outcome.error;
      expect(outcome.intent).toMatchObject({ launch: f.launch, registration: f.registration, goal_id: f.base.goal_id, origin: { review_id: review.id }, operations: [] });
      const stops = await db.select().from(sourceCleanStops);
      expect(stops).toHaveLength(1); expect(stops[0]!.intent).toEqual(outcome.intent);
      expect((await db.select().from(sourceWorkspaceLineages))[0]).toMatchObject({ state: "closing", revision: 1 });
      // A local retry cannot reset the original one-shot request. The service's
      // existing exact prepare idempotency remains available on this observer.
      await expect(prepareSourceCleanStop(f.observer, { waitForAcceptedH6: true })).rejects.toThrow("one original bound launch");
      expect(await f.parent.prepareStop(f.parent.hello.challenge)).toEqual(outcome.intent);
      expect(await db.select().from(sourceCleanStops)).toHaveLength(1);
      expect(await db.select().from(goalImportedValidations)).toEqual([]);
    } finally { await f.close(); }
  }, 60000);
  it("cancels the real pending parent wait on user stop and removes its server polling without a clean freeze", async () => {
    const f = await plannedStopParent();
    try {
      f.wait(); await eventually(() => f.inspected.mock.calls.length >= 1, "pending original parent wait");
      f.cancel(); expect((await f.outcome()).error).toMatchObject({ message: "Planned clean transition cancelled by user stop" });
      await f.close(); const count = f.inspected.mock.calls.length;
      await new Promise(resolve => setTimeout(resolve, 1100));
      expect(f.inspected).toHaveBeenCalledTimes(count);
      await expect(f.parent.isReadyForPlannedStop(f.parent.hello.challenge)).rejects.toThrow("no longer live");
      expect(await fixture().server.db.db.select().from(sourceCleanStops)).toEqual([]);
      expect((await fixture().server.db.db.select().from(sourceWorkspaceLineages))[0]).toMatchObject({ state: "active", revision: 0 });
    } finally { await f.close(); }
  }, 60000);
  it("ignores an actual prepared reply delivered after cancellation and retains its uncommitted lineage without restart authority", async () => {
    const f = await plannedStopParent(), emit = LifecycleWebSocket.prototype.emit;
    let delayed: { receiver: LifecycleWebSocket; args: Parameters<typeof emit> } | undefined, observerFailed = false;
    void sourceLifecycleObserverFailure(f.observer).then(() => { observerFailed = true; });
    // Delay only the actual incoming prepared frame. Its bytes, original request,
    // authenticated socket and Server freeze are unchanged; no reply is invented.
    const delivery = vi.spyOn(LifecycleWebSocket.prototype, "emit").mockImplementation(function (this: LifecycleWebSocket, ...args: Parameters<typeof emit>) {
      if (!delayed && args[0] === "message" && Buffer.isBuffer(args[1])) {
        const frame = JSON.parse(args[1].toString("utf8")) as { type?: string };
        if (frame.type === "node.source-clean-stop.prepared.v1") { delayed = { receiver: this, args }; return true; }
      }
      return Reflect.apply(emit, this, args);
    });
    try {
      await f.acceptH6(); f.wait(); await eventually(() => delayed !== undefined, "actual prepared reply pending delivery");
      f.cancel(); expect((await f.outcome()).error).toMatchObject({ message: "Planned clean transition cancelled by user stop" });
      await f.close();
      expect(delayed!.receiver.listenerCount("message")).toBeGreaterThan(0);
      Reflect.apply(emit, delayed!.receiver, delayed!.args); await Promise.resolve();
      expect(observerFailed).toBe(false);
      await expect(prepareSourceCleanStop(f.observer, { waitForAcceptedH6: true })).rejects.toThrow("Original live source lifecycle observer");
      const stops = await fixture().server.db.db.select().from(sourceCleanStops);
      expect(stops).toHaveLength(1); expect(stops[0]).toMatchObject({ closure: null, receipt: null });
      expect(await fixture().server.db.db.select().from(sourceCleanGenerations)).toEqual([]);
    } finally { try { await f.close(); } finally { delivery.mockRestore(); } }
  }, 60000);
  it("terminates the original planned wait if its paired daemon session changes instead of treating that failure as not-yet-ready", async () => {
    const f = await plannedStopParent();
    try {
      f.wait(); await eventually(() => f.inspected.mock.calls.length >= 1, "original session eligibility check");
      f.setSession("controlled-replaced-daemon-session");
      expect((await f.outcome()).error).toBeInstanceOf(Error);
      expect(await fixture().server.db.db.select().from(sourceCleanStops)).toEqual([]);
      expect((await fixture().server.db.db.select().from(sourceWorkspaceLineages))[0]).toMatchObject({ state: "active", revision: 0 });
    } finally { await f.close(); }
  }, 60000);
  it.each(["connected", "feature-withdrawn", "disconnected"])("keeps accepted H6 behind the retained clean GoalRunner gate when %s", async state => {
    const f = await prepareCleanLifecycle(), db = fixture().server.db.db;
    if (state === "feature-withdrawn") {
      const supported = f.actor.supportsExecutionFeature;
      f.actor.supportsExecutionFeature = (node, feature) => node === f.destination.nodeId && feature === SOURCE_CLEAN_RESTART_FEATURE_V1 ? false : supported?.(node, feature) === true;
    }
    if (state === "disconnected") {
      const sessions = f.actor.getPairedNodeSession;
      f.actor.getPairedNodeSession = node => node === f.destination.nodeId ? undefined : sessions?.(node);
    }
    const errors: unknown[] = [], ordinary: string[] = [];
    f.actor.onRunQueued = async id => { ordinary.push(id); };
    const dispatcher = createGoalAutomationDispatcher(f.actor, async () => {}, error => { errors.push(error); });
    try { await dispatcher.pump(); } finally { await dispatcher.stop(); }
    expect(errors).toEqual([]); expect(ordinary).toEqual([]); expect(f.validationQueued).toEqual([]);
    expect(await f.automation()).toMatchObject({ status: "waiting", lastError: "Waiting for the planned native Windows transition after accepted H6." });
    expect(await db.select().from(sourceCleanStops)).toEqual([]); expect(await db.select().from(goalImportedValidations)).toEqual([]);
    expect(await db.select().from(goalSourceRecoveries)).toEqual([]); expect(await db.select().from(productReleases)).toEqual([]);
  }, 60000);
  it("commits fresh H6 acceptance and the clean wait in the same GoalRunner tick without queuing ordinary H7", async () => {
    const f = await plannedStopParent(), db = fixture().server.db.db;
    try {
      const review = await f.ensureH6(), binding = f.h6Binding(), command = await binding.dispatch(review.id);
      await binding.receive({ kind: "product.source.execution-review.result.v1", node_id: f.destination.nodeId,
        command_id: command.id, payload: reviewedImplementation(review) });
      expect((await db.select().from(goalImportedExecutionReviews).where(eq(goalImportedExecutionReviews.id, review.id)))[0]!.acceptedAt).toBeNull();
      const errors: unknown[] = [], ordinary: string[] = [];
      f.actor.onRunQueued = async id => { ordinary.push(id); };
      const dispatcher = createGoalAutomationDispatcher(f.actor, async () => {}, error => { errors.push(error); });
      try { await dispatcher.pump(); } finally { await dispatcher.stop(); }
      expect(errors).toEqual([]); expect(ordinary).toEqual([]);
      expect((await db.select().from(goalImportedExecutionReviews).where(eq(goalImportedExecutionReviews.id, review.id)))[0]!.acceptedAt).not.toBeNull();
      expect(await f.automation()).toMatchObject({ status: "waiting", lastError: "Waiting for the planned native Windows transition after accepted H6." });
      expect(await db.select().from(goalImportedValidations)).toEqual([]); expect(await db.select().from(productReleases)).toEqual([]);
    } finally { await f.close(); }
  }, 60000);
  const cleanDiscoveryFeatures = [SOURCE_CLEAN_RESTART_FEATURE_V1, IMPORTED_CLEAN_VALIDATION_FEATURE_V1,
    IMPORTED_CLEAN_VALIDATION_REVIEW_FEATURE_V1, PRODUCT_RELEASE_CLEAN_FEATURE_V1];
  async function observedCleanSuccessor(f: Awaited<ReturnType<typeof prepareCleanLifecycle>>,
    options: { clean?: boolean; importedValidation?: boolean } = {}) {
    // Only the local native/profile admissions and the H6/H7 prehistory are
    // controlled. The node, hello, receipt negotiation, WS registry, dispatch
    // and inactive-controller rejection below are the production implementations.
    // The historical workspace spelling is protocol data, not a physical fixture.
    const server = fixture().server, history = { ...f.actor }, destination = f.destination.nodeId;
    const live: Pick<typeof server.ctx, "supportsExecutionFeature" | "supportsVerificationProfile" | "getVerificationWorkspace"
      | "getVerificationCapabilities" | "supportsReleaseProfile" | "getReleaseCapabilities" | "getPairedNodeSession" | "getProductSourceRouting"> = {
      supportsExecutionFeature: (node, feature) => node === destination
        ? server.nodeRegistry.get(node)?.supportsExecutionFeature(feature) === true : history.supportsExecutionFeature?.(node, feature) === true,
      supportsVerificationProfile: (node, id, project, workspace) => node === destination
        ? server.nodeRegistry.get(node)?.supportsVerificationProfile(id, project, workspace) === true : history.supportsVerificationProfile?.(node, id, project, workspace) === true,
      getVerificationWorkspace: (node, id, project, workspace) => node === destination
        ? server.nodeRegistry.get(node)?.getVerificationWorkspace(id, project, workspace) : history.getVerificationWorkspace?.(node, id, project, workspace),
      getVerificationCapabilities: (node, id, project, workspace) => node === destination
        ? server.nodeRegistry.get(node)?.getVerificationCapabilities?.(id, project, workspace) : history.getVerificationCapabilities?.(node, id, project, workspace),
      supportsReleaseProfile: (node, id, project, workspace, verifier) => node === destination
        ? server.nodeRegistry.get(node)?.supportsReleaseProfile?.(id, project, workspace, verifier) === true : history.supportsReleaseProfile?.(node, id, project, workspace, verifier) === true,
      getReleaseCapabilities: (node, id, project, workspace, verifier) => node === destination
        ? server.nodeRegistry.get(node)?.getReleaseCapabilities?.(id, project, workspace, verifier) : history.getReleaseCapabilities?.(node, id, project, workspace, verifier),
      getPairedNodeSession: node => node === destination ? server.nodeRegistry.get(node)?.getPairedNodeSession?.() : history.getPairedNodeSession?.(node),
      getProductSourceRouting: node => node === destination ? server.nodeRegistry.get(node)?.getProductSourceRouting?.() : history.getProductSourceRouting?.(node),
    };
    Object.assign(f.actor, live); Object.assign(server.ctx, live);
    const capabilities = f.base.destination.capabilities, publication = f.destinationRelease;
    if (!publication) throw Error("Controlled clean history requires publication capabilities");
    const profile: localVerification.PreparedVerificationProfile = { id: f.base.destination.profile_id,
      project_id: f.base.project_id, workspace_root: f.base.destination.workspace_root, digest: capabilities.profile_digest,
      capabilities, measurement_plan_policy: capabilities.measurement_plan_policy, commands: [], required_files: [], subject_paths: [], trustedFiles: [] };
    const release: localPublication.PreparedReleaseProfile = { id: publication.binding.release_profile_id, project_id: f.base.project_id,
      verification_profile_id: profile.id, verifier: profile, digest: publication.binding.release_profile_digest,
      storage_root: join(fixture().directory, "controlled-publication"), output_path: "dist", public_url: "http://127.0.0.1:1",
      listen_host: "127.0.0.1", listen_port: 1, health_checks: [{ path: "/" }], health_timeout_ms: 1000, criterion_acceptance: { version: 1 } };
    const profiles = [profile], releases = [release], roots = [profile.workspace_root];
    const backend = Object.freeze({}) as localWindowsProcess.PreparedWindowsProcessBackend;
    const supervisor = Object.freeze({}) as localSupervisor.PreparedWindowsDaemonSupervisorAuthority;
    const recovery = Object.freeze({}) as localRecovery.PreparedWindowsSourceRecoveryConfiguration;
    const clean = Object.freeze({}) as cleanLocalConfiguration.PreparedCleanDaemonConfiguration;
    const storage = Object.freeze({}) as localGuardian.WindowsGuardianLocalConfiguration["storage"];
    const sourceFile = join(fixture().directory, "controlled-source.json"), store = join(fixture().directory, "controlled-new-store");
    const control = join(fixture().directory, "controlled-new-control"), original = { bytes: Buffer.from("controlled local configuration"), identity: "controlled-local-identity" };
    const localConfig: ReturnType<typeof localSourceConfiguration.prepareProductSourceConfiguration> = {
      file: sourceFile, directory: fixture().directory, storage, original, read: () => original,
      config: { version: 1, storeRoot: store, gitExecutable: join(fixture().directory, "never-run-git.exe"),
        recovery: { version: 1, deviceId: f.destination.device.id, workspaceRoot: profile.workspace_root, controlDirectory: control } },
    };
    const address = server.app.server.listening ? server.app.server.address() : undefined;
    const port = address && typeof address === "object" ? address.port : new URL(await server.app.listen({ port: 0, host: "127.0.0.1" })).port;
    const frames: ServerToNodeMessage[] = [], sent: NodeToServerMessage[] = [];
    class ObservingWebSocket extends WebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener("message", event => { frames.push(JSON.parse(String(event.data)) as ServerToNodeMessage); });
      }
      override send(data: Parameters<WebSocket["send"]>[0]) {
        if (typeof data === "string") sent.push(JSON.parse(data) as NodeToServerMessage);
        super.send(data);
      }
    }
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    const cleanupReason = Error("Controlled pending native admission released during fixture cleanup");
    let releaseBootstrap!: (error: Error) => void, node: ReturnType<typeof createArtoodNode> | undefined, closing: Promise<void> | undefined;
    const bootstrapPending = new Promise<localGuardian.PreparedWindowsGuardian>((_resolve, reject) => { releaseBootstrap = reject; });
    // Observe rejection even when discovery fails before a native admission starts.
    const bootstrapSettled = bootstrapPending.then(() => { throw Error("This fixture must never activate a native Guardian"); }, error => {
      if (error !== cleanupReason) throw error;
    });
    const close = () => closing ??= (async () => {
      const stopped = node?.stop(); releaseBootstrap(cleanupReason);
      try { await stopped; await bootstrapSettled; }
      finally { Object.defineProperty(process, "platform", platform); }
    })();
    lifecycle.own({ close });
    vi.spyOn(localWindowsProcess, "assertWindowsProcessBackend").mockImplementation(value => { expect(value).toBe(backend); });
    vi.spyOn(localVerification, "prepareVerificationProfiles").mockImplementation((values, allowed) => {
      expect(values).toBe(profiles); expect(allowed).toEqual(roots); return profiles;
    });
    vi.spyOn(localVerification, "attachWindowsVerificationBackend").mockImplementation((value, native) => { expect(value).toBe(profile); expect(native).toBe(backend); });
    vi.spyOn(localVerification, "readWindowsVerificationBackend").mockImplementation(value => { expect(value).toBe(profile); return backend; });
    vi.spyOn(localPublication, "prepareReleaseProfiles").mockImplementation((values, verifiers) => {
      expect(values).toBe(releases); expect(verifiers).toBe(profiles); return releases;
    });
    vi.spyOn(localPublication, "releaseProfileExecutionSupported").mockImplementation(value => { expect(value).toBe(release); return true; });
    vi.spyOn(localPublication, "readReleaseCapabilities").mockImplementation(value => { expect(value).toBe(release); return publication; });
    vi.spyOn(localSourceConfiguration, "prepareProductSourceConfiguration").mockImplementation(value => {
      expect(value).toEqual({ file: sourceFile, allowedRoots: roots }); return localConfig;
    });
    vi.spyOn(localSupervisor, "prepareWindowsDaemonSupervisorAuthority").mockImplementation(async (value, selection) => {
      expect(value).toBe(backend); expect(selection).toEqual({ requireLifetime: true }); return supervisor;
    });
    const admission = vi.spyOn(cleanLocalConfiguration, "assertCleanDaemonControllerConfiguration").mockImplementation((value, selection) => {
      expect(value).toBe(clean); expect(selection.nodeId).toBe(destination);
      expect(selection.profiles).toBe(profiles); expect(selection.profiles[0]).toBe(profile);
      expect(selection.releases).toBe(releases); expect(selection.releases[0]).toBe(release); expect(release.verifier).toBe(profile);
    });
    vi.spyOn(localRecovery, "windowsGuardianConfiguration").mockImplementation((value, sessionId) => {
      expect(value).toBe(recovery); expect(sessionId).toBe(server.nodeRegistry.get(destination)?.getPairedNodeSession?.()?.sessionId);
      return { nodeId: destination, deviceId: f.destination.device.id, sessionId, configurationDigest: sha("controlled native admission"),
        storeDirectory: store, workspaceRoot: profile.workspace_root, storage, controlDirectory: control, controlStorage: storage,
        supervisor, topology: "supervisor-plain-daemon.v1" };
    });
    vi.spyOn(localRecovery, "recoveryConfigurationBackend").mockImplementation(value => { expect(value).toBe(recovery); return backend; });
    const bootstrap = vi.spyOn(localGuardian, "bootstrapWindowsGuardian").mockImplementation((value, local) => {
      expect(value).toBe(backend); expect(local.storeDirectory).toBe(store); expect(local.supervisor).toBe(supervisor); return bootstrapPending;
    });
    const source: ReturnType<typeof localSourceNode.prepareProductSourceNode> = {
      get runtime(): ReturnType<typeof localSourceNode.prepareProductSourceNode>["runtime"] { throw Error("Controlled source has no active runtime"); },
      recoveryRequired: true, recoveryConfiguration: recovery,
      features: ["product-source-transfer.v1", "product-source-transfer.v2", PRODUCT_SOURCE_TRANSFER_MEASUREMENT_V2_FEATURE_V1,
        PRODUCT_SOURCE_OPERATIONS_FEATURE_V1, IMPORTED_PRODUCT_REVIEW_FEATURE_V1, IMPORTED_DESIGN_CONTINUATION_FEATURE_V1,
        IMPORTED_DESIGN_REVIEW_FEATURE_V1, IMPORTED_EXECUTION_FEATURE_V1, IMPORTED_EXECUTION_REVIEW_FEATURE_V1,
        IMPORTED_VALIDATION_FEATURE_V1, PRODUCT_SOURCE_RECOVERY_FEATURE_V1, ...cleanDiscoveryFeatures],
      routing: { version: 1, source_exports: [], destination_mappings: [] },
      qualifyRecovery: value => { expect(value).toBe(supervisor); },
      activateRecovery: vi.fn(() => { throw Error("This fixture must not activate a source runtime"); }),
      semanticClient: { upload: vi.fn(), download: vi.fn() }, importedReview: true, importedDesign: true,
      importedDesignReview: true, importedExecution: true, importedExecutionReview: true, importedValidation: options.importedValidation !== false,
      assertCurrent() {}, assertDiscovery() {}, close() {},
    };
    vi.spyOn(localSourceNode, "prepareProductSourceNode").mockImplementation(value => {
      expect(value.nodeId).toBe(destination); expect(value.file).toBe(sourceFile); expect(value.profiles).toBe(profiles);
      expect(value.releaseProfiles).toBe(releases); expect(value.windowsBackend).toBe(backend); return source;
    });
    const adapter: RuntimeAdapter = { runtimeId: "controlled-unreachable", start: vi.fn(async () => { throw Error("No model or adapter may run in this fixture"); }),
      async *streamEvents() {}, async stop() {}, async collectArtifacts() { return []; } };
    node = createArtoodNode({ url: `ws://127.0.0.1:${port}/api/v1/node?token=${f.destination.node_token}`,
      hello: { kind: "node.hello", node_id: destination, protocol_version: "2026-06-11", artood_version: "controlled-clean-ws-fixture",
        machine: { hostname: "controlled-native-windows", os: "windows", arch: "x64" }, execution_features: [...cleanDiscoveryFeatures] },
      adapter, workspace: { allowedRoots: roots }, verificationProfiles: profiles, releaseProfiles: releases,
      windowsProcessBackend: backend, productSourceConfigFile: sourceFile, requireSupervisorLifetime: true, acknowledgeRunEvents: true,
      ...(options.clean === false ? {} : { prepareCleanLifecycle: (value: localSupervisor.PreparedWindowsDaemonSupervisorAuthority) => { expect(value).toBe(supervisor); return clean; } }),
      WebSocketImpl: ObservingWebSocket });
    return { node, frames, sent, adapter, source, admission, close,
      async connect() {
        await node!.start();
        await eventually(() => bootstrap.mock.calls.length === 1
          && server.nodeRegistry.get(destination)?.supportsExecutionFeature(IMPORTED_VALIDATION_FEATURE_V1) === true,
        "real clean successor receipt negotiation and recovery session");
        const session = server.nodeRegistry.get(destination)?.getPairedNodeSession?.();
        if (!session) throw Error("Real successor session is unavailable");
        expect(session).toMatchObject(f.identity);
        expect(frames).toContainEqual(expect.objectContaining({ type: "product.source.recovery.session.v1", payload: expect.objectContaining({ session_id: session.sessionId }) }));
        return session.sessionId;
      },
    };
  }
  it("discovers clean controllers through the real paired node hello and dispatches without bypassing checkpoint activation", async () => {
    let observed: Awaited<ReturnType<typeof observedCleanSuccessor>> | undefined;
    try {
      const f = await prepareCleanCheckpoint("author", async prehistory => {
        observed = await observedCleanSuccessor(prehistory); return observed.connect();
      });
      const connection = observed!;
      const hello = connection.sent.find(frame => frame.kind === "node.hello");
      expect(hello?.kind).toBe("node.hello");
      if (hello?.kind !== "node.hello") throw Error("Real node hello was not observed");
      expect(hello.execution_features).toEqual(expect.arrayContaining(cleanDiscoveryFeatures));
      expect(connection.admission).toHaveBeenCalledTimes(1);
      const binding = fixture().server.nodeRegistry.get(f.destination.nodeId)!;
      for (const feature of cleanDiscoveryFeatures) expect(binding.supportsExecutionFeature(feature)).toBe(true);
      expect(f.checkpoint.lifecycle_registration.registration.epoch.session_id).toBe(binding.getPairedNodeSession!()!.sessionId);
      await f.settle(); const author = await f.freshAuthor();
      await binding.dispatchCleanValidation!(author.id, "start");
      await eventually(() => connection.frames.some(frame => frame.type === "product.source.clean-validation.v1"), "real clean author command");
      const command = connection.frames.find(frame => frame.type === "product.source.clean-validation.v1")!;
      expect(command).toMatchObject({ type: "product.source.clean-validation.v1", payload: { validation_id: author.id, run_start: { run_id: author.runId } } });
      await eventually(() => connection.sent.some(frame => frame.kind === "command.ack" && frame.command_id === command.id
        && frame.status === "rejected"), "real inactive clean-controller rejection");
      expect(connection.sent).toContainEqual(expect.objectContaining({ kind: "command.ack", command_id: command.id, status: "rejected",
        error_code: "process_start_failed", message: "Original clean lifecycle is unavailable" }));
      expect(connection.adapter.start).not.toHaveBeenCalled(); expect(connection.source.activateRecovery).not.toHaveBeenCalled();
      expect(await fixture().server.db.db.select().from(goalCleanValidationReviews)).toEqual([]);
      expect(await fixture().server.db.db.select().from(goalCleanValidationPublications)).toEqual([]);
    } finally { await observed?.close(); }
  }, 60000);
  it("strips caller clean claims from a real paired hello without local clean admission and refuses clean checkpoint and dispatch", async () => {
    let observed: Awaited<ReturnType<typeof observedCleanSuccessor>> | undefined;
    let prehistory: Awaited<ReturnType<typeof prepareCleanLifecycle>> | undefined;
    try {
      await expect(prepareCleanCheckpoint("author", async value => {
        prehistory = value; observed = await observedCleanSuccessor(value, { clean: false }); return observed.connect();
      })).rejects.toThrow("lacks the clean-restart contract");
      const connection = observed!, binding = fixture().server.nodeRegistry.get(prehistory!.destination.nodeId)!;
      const hello = connection.sent.find(frame => frame.kind === "node.hello");
      if (hello?.kind !== "node.hello") throw Error("Real node hello was not observed");
      for (const feature of cleanDiscoveryFeatures) {
        expect(hello.execution_features).not.toContain(feature); expect(binding.supportsExecutionFeature(feature)).toBe(false);
      }
      expect(connection.admission).not.toHaveBeenCalled();
      const [generation] = await fixture().server.db.db.select().from(sourceCleanGenerations);
      expect(generation).toMatchObject({ checkpoint: null, receipt: null, settledAt: null });
      const automation = await prehistory!.automation();
      await expect(fixture().server.db.transaction(tx => ensureGoalCleanValidation(prehistory!.actor, tx, automation, generation!.id)))
        .rejects.toThrow("committed fresh checkpoint");
      await expect(binding.dispatchCleanValidation!("unadmitted-clean-validation", "start")).rejects.toThrow("current native author feature");
      expect(connection.frames.some(frame => frame.type === "product.source.clean-validation.v1")).toBe(false);
      expect(connection.adapter.start).not.toHaveBeenCalled(); expect(connection.source.activateRecovery).not.toHaveBeenCalled();
      expect(await fixture().server.db.db.select().from(goalCleanValidations)).toEqual([]);
    } finally { await observed?.close(); }
  }, 60000);
  it("refuses clean discovery before hello when the local imported validation controller chain is incomplete", async () => {
    const f = await prepareCleanLifecycle(), connection = await observedCleanSuccessor(f, { importedValidation: false });
    try {
      await expect(connection.node.start()).rejects.toThrow("installed validation, review and publisher controllers");
      expect(connection.sent.some(frame => frame.kind === "node.hello")).toBe(false);
      expect(fixture().server.nodeRegistry.get(f.destination.nodeId)).toBeUndefined();
      expect(connection.admission).not.toHaveBeenCalled(); expect(connection.adapter.start).not.toHaveBeenCalled();
      expect(await fixture().server.db.db.select().from(goalCleanValidations)).toEqual([]);
    } finally { await connection.close(); }
  }, 60000);
  function cleanValidationResult(row: typeof goalCleanValidations.$inferSelect) {
    const request = ImportedCleanValidationRequestV1Schema.parse(row.request), start = request.run_start;
    const verification = structuredClone(request.origin.implementation_source.verification);
    verification.request_id = start.verification.request_id; verification.subject_digest = sha(`controlled clean final source ${row.generation}`);
    verification.required_files = verification.required_files.map(file => file.path === ".artoo/product/implementation.md" ? { ...file, checksum: sha("controlled clean source edit") } : file);
    verification.required_files.push({ path: ".artoo/product/validation.json", checksum: sha("controlled clean report"), size: 20 });
    for (const check of verification.checks) { if (check.observation?.version !== 3) throw Error("Controlled v3 required"); check.observation.stage = "validation"; }
    const initial = request.previous_source?.subject_digest ?? request.restart.checkpoint.subject_digest;
    const manifest = { directories: request.restart.checkpoint.baseline.directories, files: request.restart.checkpoint.baseline.files };
    return ImportedCleanValidationResultV1Schema.parse({ version: 1, validation_id: row.id, request_digest: row.requestDigest, run_id: row.runId, closed: true, outcome: "finished",
      verified_validation: { version: 1, validation_id: row.id, request_digest: row.requestDigest, run_id: row.runId, clean_generation_id: row.cleanGenerationId,
        restart_digest: sourceCleanValidationOriginDigestV1(request.restart, sha), root_validation_id: row.rootValidationId, generation: row.generation,
        origin_digest: importedValidationOriginDigestV1(request.origin, sha), author: request.writer, run_start_digest: hash(start),
        initial_subject_digest: initial, subject_digest: verification.subject_digest, authorization_event_id: row.authorizationEventId, attempt_index: row.attemptIndex,
        baseline: { ...request.restart.checkpoint.baseline, snapshot_id: `controlled_clean_baseline_${row.generation}`, subject_digest: initial, ...manifest, manifest_digest: hash(manifest) },
        closure: "windows-job-and-tools-closed.v1", stage: "validation", scope: "all-declared-workspace-validation-cases", verification } });
  }
  async function completedCleanAuthor(f: Awaited<ReturnType<typeof prepareCleanCheckpoint>>, row: typeof goalCleanValidations.$inferSelect) {
    const peer = createCleanValidationBinding(f.actor, { identity: f.identity, sessionId: "controlled-clean-successor-session", isCurrent: () => true, transport: { async send() {} } });
    const command = await peer.dispatch(row.id), result = cleanValidationResult(row);
    if (result.outcome !== "finished") throw Error("Controlled successful clean result required");
    await ingestWireRunEvent(f.actor, { kind: "run.event", node_id: row.computerId, run_id: row.runId, sequence: 0, event: { type: "run.lifecycle", payload: { phase: "started" } } });
    await ingestWireRunEvent(f.actor, { kind: "run.event", node_id: row.computerId, run_id: row.runId, sequence: 1, event: { type: "run.verification", payload: result.verified_validation.verification } });
    await ingestWireRunEvent(f.actor, { kind: "run.event", node_id: row.computerId, run_id: row.runId, sequence: 2, event: { type: "run.lifecycle", payload: { phase: "completed" } } });
    // A generic completed lifecycle alone must not make a recovered task reviewable.
    expect((await fixture().server.db.db.select().from(tasks).where(eq(tasks.id, row.taskId)))[0]!.status).toBe("running");
    await peer.receive({ kind: "product.source.clean-validation.result.v1", node_id: row.computerId, command_id: command.id, payload: result });
    const a = await f.automation(); return (await fixture().server.db.transaction(tx => advanceGoalCleanValidation(f.actor, tx, a, row.id))).validation;
  }
  async function acceptedCleanReview(f: Awaited<ReturnType<typeof prepareCleanCheckpoint>>, author: typeof goalCleanValidations.$inferSelect, outcome: "accepted" | "rejected" = "accepted") {
    const a = await f.automation(), row = await fixture().server.db.transaction(tx => ensureGoalCleanValidationReview(f.actor, tx, a, author.id));
    const request = ImportedCleanValidationReviewRequestV1Schema.parse(row.request), subject = importedCleanValidationReviewSubjectV1(request, sha);
    const measure = (start: typeof request.before_start) => ({ run_id: start.run_id, config_digest: hash(start), closure: "windows-job-and-tools-closed.v1",
      scope: "all-declared-workspace-validation-cases", verification: { ...structuredClone(request.source.verification!), request_id: start.verification.request_id } });
    const result = ImportedCleanValidationReviewResultV1Schema.parse({ version: 1, review_id: row.id, request_digest: row.requestDigest, execution_authorized: false,
      outcome: "reviewed", closed: true, before: measure(request.before_start), after: measure(request.after_start),
      reviewer: { run_id: request.review_start.run_id, config_digest: hash(request.review_start), closure: "windows-job-and-tools-closed.v1" },
      verdict: { version: 1, review_id: row.id, validation_id: author.id, source_digest: subject.source_digest, subject_digest: subject.subject_digest, outcome,
        summary: "Controlled new independent clean verdict; no live model", findings: outcome === "rejected" ? [{ severity: "blocking", description: "Controlled recovered product regression" }] : [] } });
    expect(row.reviewerInstanceId).not.toBe(author.writerInstanceId); expect(row.reviewerAgentId).not.toBe(author.writerAgentId);
    const peer = createCleanValidationReviewBinding(f.actor, { identity: f.identity, sessionId: "controlled-clean-successor-session", isCurrent: () => true, transport: { async send() {} } });
    const command = await peer.dispatch(row.id); await peer.receive({ kind: "product.source.clean-validation-review.result.v1", node_id: row.computerId, command_id: command.id, payload: result });
    return (await fixture().server.db.transaction(tx => advanceGoalCleanValidationReview(f.actor, tx, a, author.id))).review;
  }
  it("clean restart settles every old operation once and requires fresh author evidence and independent review", async () => {
    const f = await prepareCleanCheckpoint(), db = fixture().server.db.db, before = await f.automation();
    await expect(f.freshAuthor()).rejects.toThrow("GoalRunner settlement");
    expect(await unsettledGoalExecutionCount(f.actor, db, before.goalId)).toBe(1);
    const old = (await db.select().from(goalImportedValidations).where(eq(goalImportedValidations.id, f.oldAuthor.id)))[0]!;
    const settled = await f.settle();
    const operations = await db.select().from(sourceCleanOperationSettlements);
    expect(operations).toHaveLength(f.intent.operations.length);
    expect(operations[0]).toMatchObject({ generationId: f.grant.generation_id, kind: "validation", operationId: old.id,
      requestDigest: old.requestDigest, runId: old.runId, eventId: settled.generation.settlementEventId });
    expect(await unsettledGoalExecutionCount(f.actor, db, before.goalId)).toBe(0);
    expect((await db.select().from(runs).where(eq(runs.id, old.runId)))[0]).toMatchObject({ status: "failed", failureReason: "daemon_disconnect" });
    expect((await db.select().from(goalImportedValidations).where(eq(goalImportedValidations.id, old.id)))[0]).toEqual(old);
    await expect(db.delete(sourceCleanOperationSettlements)).rejects.toMatchObject({ cause: { code: "P0001" } });
    const one = await f.freshAuthor(), two = await f.freshAuthor(); expect(two.id).toBe(one.id);
    expect(one).toMatchObject({ cleanGenerationId: f.grant.generation_id, generation: 0, kind: "initial", attemptIndex: old.attemptIndex + 1 });
    const request = ImportedCleanValidationRequestV1Schema.parse(one.request);
    expect(request.restart).toMatchObject({ kind: "clean-restart.v1", grant: f.grant, checkpoint: f.checkpoint, receipt: f.receipt,
      settlement_event_id: settled.generation.settlementEventId });
    expect(request.run_start.context_pack.payload.imported_recovery_validation).toBeUndefined();
    expect(await unsettledGoalExecutionCount(f.actor, db, before.goalId)).toBe(1);
    // Replaying the original settlement must not re-enumerate the new active author.
    expect((await f.settle()).generation.settlementEventId).toBe(settled.generation.settlementEventId);
    expect(await f.registry.checkpoint(f.identity, "controlled-clean-successor-session", f.checkpoint)).toEqual(f.receipt);
    await expect(assignTask(f.actor, one.taskId, { mode: "manual", agent_instance_id: one.writerInstanceId })).rejects.toThrow();
    const author = await completedCleanAuthor(f, one);
    const a = await f.automation(); await expect(fixture().server.db.transaction(tx => ensureGoalProductRelease(f.actor, tx, a))).rejects.toThrow();
    const review = await acceptedCleanReview(f, author); expect(review.acceptedAt).not.toBeNull();
    expect(await unsettledGoalExecutionCount(f.actor, db, before.goalId)).toBe(0);
    expect(await f.automation()).toEqual(before);
    expect(await db.select().from(goalSourceRecoveries)).toEqual([]);
    expect(await db.select().from(goalRecoveryValidations)).toEqual([]);
  }, 60000);
  it("clean author dispatch rejects a replaced session or a changed settled checkpoint and never copies old review authority", async () => {
    const f = await prepareCleanCheckpoint(), db = fixture().server.db.db; await f.settle(); const author = await f.freshAuthor();
    await expect(db.update(sourceCleanGenerations).set({ checkpoint: { ...f.checkpoint, predecessor_history_digest: sha("changed") } })
      .where(eq(sourceCleanGenerations.id, f.grant.generation_id))).rejects.toMatchObject({ cause: { code: "P0001" } });
    const sent: ServerToNodeMessage[] = [], peer = createCleanValidationBinding(f.actor, { identity: f.identity,
      sessionId: "controlled-clean-successor-session", isCurrent: () => true, transport: { async send(frame) { sent.push(frame); } } });
    f.setSession("another-new-process-session");
    await expect(peer.dispatch(author.id)).rejects.toThrow(); expect(sent).toEqual([]);
    expect(await db.select().from(goalCleanValidationReviews)).toEqual([]);
    expect(await db.select().from(goalCleanValidationPublications)).toEqual([]);
    expect((await db.select().from(goals).where(eq(goals.id, author.goalId)))[0]!.retryCount).toBe(author.attemptIndex);
  });
  it("clean substantive rejection consumes only the original bounded repair budget", async () => {
    const f = await prepareCleanCheckpoint(), db = fixture().server.db.db; await f.settle();
    const author = await completedCleanAuthor(f, await f.freshAuthor()), review = await acceptedCleanReview(f, author, "rejected");
    const [goal] = await db.select().from(goals).where(eq(goals.id, author.goalId));
    await db.update(goals).set({ budgets: { ...goal!.budgets as object, max_retries: author.attemptIndex } }).where(eq(goals.id, author.goalId));
    const a = await f.automation(), repair = () => fixture().server.db.transaction(tx => ensureGoalCleanValidationRepair(f.actor, tx, a, review.id));
    await expect(repair()).rejects.toThrow("retry budget");
    expect(await db.select().from(goalCleanValidations)).toHaveLength(1);
    await db.update(goals).set({ budgets: { ...goal!.budgets as object, max_retries: author.attemptIndex + 1 } }).where(eq(goals.id, author.goalId));
    const next = await repair(); expect((await repair()).id).toBe(next.id);
    expect(next).toMatchObject({ cleanGenerationId: f.grant.generation_id, rootValidationId: author.rootValidationId,
      generation: 1, kind: "repair", predecessorId: review.id, attemptIndex: author.attemptIndex + 1 });
    const request = ImportedCleanValidationRequestV1Schema.parse(next.request);
    expect(request.previous_source?.validation_id).toBe(author.id); expect(request.restart).toEqual(ImportedCleanValidationRequestV1Schema.parse(author.request).restart);
    expect(await db.select().from(productReleases)).toEqual([]);
  }, 60000);
  it("clean publication retains interrupted history and uses a new author, review and one bounded exact-source retry", async () => {
    const f = await prepareCleanCheckpoint("publication"), db = fixture().server.db.db, old = f.oldRelease!;
    const [goal] = await db.select().from(goals).where(eq(goals.id, old.goalId));
    await db.update(goals).set({ budgets: { ...goal!.budgets as object, max_retries: 5 } }).where(eq(goals.id, old.goalId));
    await f.settle();
    const interrupted = (await db.select().from(productReleases).where(eq(productReleases.id, old.id)))[0]!;
    expect(interrupted).toMatchObject({ status: "interrupted", receipt: null, request: old.request, interruptedRecoveryId: null,
      interruptedCleanGenerationId: f.grant.generation_id });
    expect(await db.select().from(productReleaseRetrySources)).toEqual([]);
    expect(await db.select().from(sourceCleanOperationSettlements)).toHaveLength(3);
    const author = await completedCleanAuthor(f, await f.freshAuthor()); await acceptedCleanReview(f, author);
    const create = async () => { const a = await f.automation(); return fixture().server.db.transaction(tx => ensureGoalProductRelease(f.actor, tx, a)); };
    expect(await create()).toMatchObject({ status: "pending" });
    const rows = () => db.select().from(productReleases).where(eq(productReleases.goalId, author.goalId));
    const root = (await rows()).find(row => row.cleanGenerationId === f.grant.generation_id)!;
    expect(root).toMatchObject({ status: "queued", publicationGeneration: 1, cleanOfReleaseId: old.id, recoveryId: null });
    expect(root.runId).not.toBe(old.runId); expect(root.evidenceId).not.toBe(old.evidenceId);
    const request = ProductReleaseRequestSchema.parse(root.request), session = f.actor.getPairedNodeSession!(author.computerId)!;
    expect(request.imported_clean).toMatchObject({ clean_generation_id: f.grant.generation_id, interrupted_release_id: old.id, validation_id: author.id });
    expect(request.imported_recovery).toBeUndefined(); expect(request.imported_validation).toBeUndefined();
    await fixture().server.db.transaction(tx => inspectCleanValidationPublicationDispatch(f.actor, tx, root));
    const failed = ProductReleaseReceiptSchema.parse({ request, release_profile_digest: request.acceptance_binding!.release_binding.release_profile_digest,
      artifact_digest: request.subject_digest, outcome: "rolled_back", endpoint: null, previous_release_id: null,
      health_checks: [{ path: "/", status_code: 503, body_digest: sha("controlled clean HTTP failure"), passed: false, checked_at: f.actor.clock.nowIso() }],
      recovery_checks: [], reason: "Controlled listener closure; no native HTTP observation", retry_source: { version: 1, source_id: "controlled-clean-release-failure",
        closure: "local-release-settled.v1", recovery: { kind: "listener-closed", active_release_id: null, active_artifact_digest: null } } });
    await expect(ingestProductReleaseReceipt(f.actor, author.computerId, failed, () => true, { ...session, sessionId: "foreign" })).rejects.toThrow();
    await ingestProductReleaseReceipt(f.actor, author.computerId, failed, () => true, session);
    expect(await create()).toMatchObject({ status: "pending" });
    const retry = (await rows()).find(row => row.publicationGeneration === 2)!;
    expect(retry).toMatchObject({ cleanGenerationId: f.grant.generation_id, cleanOfReleaseId: null, cleanAuthorizationEventId: null,
      rootReleaseId: root.id, retryOfReleaseId: root.id, runId: author.runId, evidenceId: root.evidenceId });
    const finalRequest = ProductReleaseRequestSchema.parse(retry.request);
    expect(finalRequest.imported_clean).toEqual(request.imported_clean); expect(finalRequest.retry?.generation).toBe(1);
    await fixture().server.db.transaction(tx => inspectCleanValidationPublicationDispatch(f.actor, tx, retry));
    await db.execute(sql`SELECT assert_product_release_clean_retry_v1(p) FROM product_releases p WHERE id=${retry.id}`);
    await expect(db.update(goalCleanValidationPublications).set({ origin: { ...request.imported_clean!, validation_id: "foreign" } })
      .where(eq(goalCleanValidationPublications.releaseId, retry.id))).rejects.toMatchObject({ cause: { code: "P0001" } });
    const receipt = ProductReleaseReceiptSchema.parse({ request: finalRequest, release_profile_digest: finalRequest.acceptance_binding!.release_binding.release_profile_digest,
      artifact_digest: finalRequest.subject_digest, outcome: "published", endpoint: "http://127.0.0.1:18182/", previous_release_id: null,
      health_checks: f.destinationRelease!.contract.health_checks.map(check => ({ path: check.path, status_code: 200, body_digest: sha("controlled clean published response"), passed: true,
        checked_at: f.actor.clock.nowIso() })), acceptance: { version: 1, scope: "node-http-point-in-time", binding_digest: releaseAcceptanceBindingDigest(finalRequest.acceptance_binding!),
        settled_criteria: finalRequest.acceptance_binding!.criteria } });
    await ingestProductReleaseReceipt(f.actor, author.computerId, receipt, () => true, session);
    expect(await create()).toMatchObject({ status: "succeeded", endpoint: receipt.endpoint });
    expect((await rows()).find(row => row.id === old.id)).toEqual(interrupted);
    expect(await db.select().from(goalCleanValidationReviews)).toHaveLength(1);
    expect(await db.select().from(goalCleanValidationPublications)).toHaveLength(2);
    expect(await db.select().from(goalSourceRecoveries)).toEqual([]);
  }, 90000);
  // Receipt-recovery regressions use the real migrated PGlite DB and real service
  // receive/dispatcher code. Only model/verifier results and the recording
  // transport are controlled. The separate loopback case uses the actual WS path.
  type RecoveryReceiptFamily = "design" | "design-review" | "execution" | "execution-review" | "execution-repair" | "validation" | "validation-review";
  type RecoveryReceiptActor = import("./context.js").ServerContext;
  type RecoveryReceiptBase = Pick<Awaited<ReturnType<typeof prepareDesign>>, "actor" | "destination" | "source" | "base">;
  const recoveryReceiptFamilies: RecoveryReceiptFamily[] = ["design", "design-review", "execution", "execution-review", "execution-repair", "validation", "validation-review"];
  const recoveryReceiptTables = {
    design: { row: "goal_imported_design_continuations", marker: "goal_imported_design_completions", key: "continuation_id", feature: IMPORTED_DESIGN_CONTINUATION_FEATURE_V1, completion: "goal_imported_design_completions" },
    "design-review": { row: "goal_imported_design_reviews", marker: "goal_imported_design_review_receipts", key: "review_id", feature: IMPORTED_DESIGN_REVIEW_FEATURE_V1, completion: null },
    execution: { row: "goal_imported_executions", marker: "goal_imported_execution_receipts", key: "execution_id", feature: IMPORTED_EXECUTION_FEATURE_V1, completion: "goal_imported_execution_completions" },
    "execution-review": { row: "goal_imported_execution_reviews", marker: "goal_imported_execution_review_receipts", key: "review_id", feature: IMPORTED_EXECUTION_REVIEW_FEATURE_V1, completion: null },
    "execution-repair": { row: "goal_imported_execution_repairs", marker: "goal_imported_execution_repair_receipts", key: "repair_id", feature: IMPORTED_EXECUTION_REVIEW_FEATURE_V1, completion: "goal_imported_execution_repair_completions" },
    validation: { row: "goal_imported_validations", marker: "goal_imported_validation_receipts", key: "validation_id", feature: IMPORTED_VALIDATION_FEATURE_V1, completion: "goal_imported_validation_completions" },
    "validation-review": { row: "goal_imported_validation_reviews", marker: "goal_imported_validation_review_receipts", key: "review_id", feature: IMPORTED_VALIDATION_FEATURE_V1, completion: null },
  } as const;
  async function recoveryReceiptRows(table: string, key: string, id: string) {
    // Both identifiers are selected exclusively from the fixed local table map.
    const result = await fixture().server.db.db.execute(sql`select * from ${sql.identifier(table)} where ${sql.identifier(key)} = ${id}`);
    expect(Array.isArray(result.rows)).toBe(true);
    return result.rows as Record<string, unknown>[];
  }
  async function recoveryReceiptState(family: RecoveryReceiptFamily, id: string) {
    const table = recoveryReceiptTables[family];
    const [row] = await recoveryReceiptRows(table.row, "id", id);
    const stored = await recoveryReceiptRows(table.marker, table.key, id);
    const completion = table.completion ? await recoveryReceiptRows(table.completion, table.key, id) : [];
    return { row, completion, marker: family === "design" ? stored.filter(value => value.receipt_sent_at !== null) : stored };
  }
  function recoveryReceiptControl(f: RecoveryReceiptBase, family: RecoveryReceiptFamily) {
    const server = fixture().server;
    const identity = { computerId: f.destination.nodeId, deviceId: f.destination.device.id, tokenLookup: parseDeviceToken(f.destination.node_token)!.lookup };
    const sessionId = "design-session", frames: ServerToNodeMessage[] = [];
    let current = true, sendHook: ((frame: ServerToNodeMessage) => Promise<void>) | undefined;
    const priorSession = f.actor.getPairedNodeSession;
    f.actor.getPairedNodeSession = id => id === identity.computerId ? { ...identity, sessionId } : priorSession?.(id);
    const support = f.actor.supportsExecutionFeature, feature = recoveryReceiptTables[family].feature;
    f.actor.supportsExecutionFeature = (id, value) => value === feature && id === identity.computerId || support?.(id, value) === true;
    const options = { identity, sessionId, isCurrent: () => current, transport: {
      async send(frame: ServerToNodeMessage) { frames.push(frame); await sendHook?.(frame); },
      subscribe() { return () => {}; }, async close() {},
    } };
    return { server, identity, sessionId, frames, options, invalidate: () => { current = false; },
      onSend: (hook?: (frame: ServerToNodeMessage) => Promise<void>) => { sendHook = hook; } };
  }
  function recoveryReceiptCase(f: RecoveryReceiptBase, family: RecoveryReceiptFamily, id: string,
    control: ReturnType<typeof recoveryReceiptControl>, peer: object, command: ServerToNodeMessage, result: unknown, receive: () => Promise<void>) {
    const callbacks: { computerId: string; family: RecoveryReceiptFamily; id: string }[] = [];
    let beforeRecovery: (() => Promise<void>) | undefined;
    // The test's entry point is the existing dispatcher.pump. On the old source
    // this callback is never called, so red is an absent resend/marker, not an
    // import or missing-export error. No result is replayed to receive after loss.
    Object.assign(f.actor, { redeliverImportedSourceReceipt: async (computerId: string, candidate: RecoveryReceiptFamily, operationId: string) => {
      callbacks.push({ computerId, family: candidate, id: operationId });
      expect({ computerId, family: candidate, id: operationId }).toEqual({ computerId: f.destination.nodeId, family, id });
      await beforeRecovery?.();
      const method = (peer as { redeliverCommittedReceipt?: (id: string) => Promise<void> }).redeliverCommittedReceipt;
      if (!method) throw Error("Dispatcher called an unavailable receipt recovery method");
      await method.call(peer, operationId);
    } });
    const receipts = () => control.frames.filter(frame => frame.type === `product.source.${family}.receipt.v1`);
    return { ...f, ...control, family, id, command, result, receive, peer, callbacks, receipts,
      receiveWithCommand: (commandId: string) => (peer as { receive(message: unknown): Promise<void> }).receive({
        kind: `product.source.${family}.result.v1`, node_id: f.destination.nodeId, command_id: commandId, payload: result }),
      state: () => recoveryReceiptState(family, id), beforeRecovery: (hook: () => Promise<void>) => { beforeRecovery = hook; } };
  }
  type RecoveryReceiptVariant = "normal" | "changes_requested" | "rejected" | "failed" | "closed-failure" | "legacy" | "uncertain" | "cancelled";
  async function prepareRecoveryReceipt(family: RecoveryReceiptFamily, variant: RecoveryReceiptVariant = "normal") {
    if (family === "design") {
      const f = await prepareDesign(), row = await f.ensureDesign(), c = recoveryReceiptControl(f, family);
      const peer = createImportedDesignContinuationBinding(f.actor, c.options), command = await peer.dispatch(row.id);
      const request = ImportedDesignContinuationRequestV1Schema.parse(row.request), verification = controlledDesignVerification(request);
      await ingestWireRunEvent(f.actor, { kind: "run.event", node_id: row.computerId, run_id: row.runId, sequence: 0, event: { type: "run.lifecycle", payload: { phase: "started" } } });
      await ingestWireRunEvent(f.actor, { kind: "run.event", node_id: row.computerId, run_id: row.runId, sequence: 1, event: { type: "run.verification", payload: verification } });
      await ingestWireRunEvent(f.actor, { kind: "run.event", node_id: row.computerId, run_id: row.runId, sequence: 2, event: { type: "run.lifecycle", payload: { phase: "completed" } } });
      const result = importedCompletedDesignResultFixture(request, verification);
      if (variant === "legacy" && result.outcome === "finished") delete result.verified_design;
      return recoveryReceiptCase(f, family, row.id, c, peer, command, result, () => peer.receive({ kind: "product.source.design.result.v1", node_id: row.computerId, command_id: command.id, payload: result }));
    }
    if (family === "design-review") {
      const f = await completedDesign(), row = await f.ensureH4(), c = recoveryReceiptControl(f, family);
      const peer = createImportedDesignReviewBinding(f.actor, c.options), command = await peer.dispatch(row.id), normal = reviewedDesign(row);
      const result = variant === "changes_requested" && normal.outcome === "reviewed" ? ImportedDesignReviewResultV1Schema.parse({ ...normal,
        verdict: { ...normal.verdict, outcome: "changes_requested", findings: [{ severity: "blocking", description: "Controlled required design changes", file: "design.md" }] } })
        : ["failed", "uncertain", "cancelled"].includes(variant) ? ImportedDesignReviewResultV1Schema.parse({ version: 1, review_id: row.id,
          request_digest: row.requestDigest, execution_authorized: false, outcome: variant === "cancelled" ? "cancelled_before_start" : variant,
          closed: variant !== "uncertain", reason: "Controlled non-accepting review result" }) : normal;
      return recoveryReceiptCase(f, family, row.id, c, peer, command, result, () => peer.receive({ kind: "product.source.design-review.result.v1", node_id: row.computerId, command_id: command.id, payload: result }));
    }
    if (family === "execution") {
      const f = await prepareExecution(), row = await f.ensureH5(), c = recoveryReceiptControl(f, family);
      const peer = createImportedExecutionBinding(f.actor, c.options), command = await peer.dispatch(row.id), result = await executionEvents(f, row);
      return recoveryReceiptCase(f, family, row.id, c, peer, command, result, () => peer.receive({ kind: "product.source.execution.result.v1", node_id: row.computerId, command_id: command.id, payload: result }));
    }
    if (family === "execution-review") {
      const f = await prepareH6(), row = await f.ensureH6(), c = recoveryReceiptControl(f, family);
      const peer = createImportedExecutionReviewBinding(f.actor, c.options), command = await peer.dispatch(row.id);
      const result = variant === "failed" ? ImportedExecutionReviewResultV1Schema.parse({ version: 1, review_id: row.id, request_digest: row.requestDigest,
        execution_authorized: false, outcome: "failed", closed: true, reason: "Controlled closed implementation review failure" })
        : reviewedImplementation(row, variant === "rejected" ? "rejected" : "accepted");
      return recoveryReceiptCase(f, family, row.id, c, peer, command, result, () => peer.receive({ kind: "product.source.execution-review.result.v1", node_id: row.computerId, command_id: command.id, payload: result }));
    }
    if (family === "execution-repair") {
      const f = await prepareH6(), review = await rejectedImplementation(f), row = await f.ensureRepair(review.id), c = recoveryReceiptControl(f, family);
      const peer = createImportedExecutionRepairBinding(f.actor, c.options), command = await peer.dispatch(row.id), result = await repairEvents(f, row);
      return recoveryReceiptCase(f, family, row.id, c, peer, command, result, () => peer.receive({ kind: "product.source.execution-repair.result.v1", node_id: row.computerId, command_id: command.id, payload: result }));
    }
    const f = await prepareH7();
    if (family === "validation") {
      const row = await f.ensure(), c = recoveryReceiptControl(f, family), peer = createImportedValidationBinding(f.actor, c.options), command = await peer.dispatch(row.id);
      const result = await validationEvents(f, row, variant === "closed-failure" ? { failure: "author-failed" } : {});
      return recoveryReceiptCase(f, family, row.id, c, peer, command, result, () => peer.receive({ kind: "product.source.validation.result.v1", node_id: row.computerId, command_id: command.id, payload: result }));
    }
    const author = await completedValidation(f), row = await f.ensureReview(author.id), c = recoveryReceiptControl(f, family);
    const peer = createImportedValidationReviewBinding(f.actor, c.options), command = await peer.dispatch(row.id);
    const result = variant === "failed" ? ImportedValidationReviewResultV1Schema.parse({ version: 1, review_id: row.id, request_digest: row.requestDigest,
      execution_authorized: false, outcome: "failed", closed: true, reason: "Controlled closed final review failure" }) : validationReviewResult(row);
    return recoveryReceiptCase(f, family, row.id, c, peer, command, result, () => peer.receive({ kind: "product.source.validation-review.result.v1", node_id: row.computerId, command_id: command.id, payload: result }));
  }
  async function installRecoveryMarkerFault(family: RecoveryReceiptFamily, id: string, deferred = false) {
    const db = fixture().server.db.db, table = recoveryReceiptTables[family], literal = id.replaceAll("'", "''");
    const functionName = "test_receipt_marker_fault_r1", triggerName = "test_receipt_marker_fault_r1";
    // No production trigger is disabled or replaced. A deferred constraint
    // trigger is an actual COMMIT-time fault; unsupported engines must fail this
    // test, never silently skip it or relabel callback failure as commit failure.
    await db.execute(sql.raw(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'controlled receipt marker rollback: ${family}' USING ERRCODE = 'P0001'; END $$`));
    const when = `NEW.${table.key} = '${literal}'${family === "design" ? " AND NEW.receipt_sent_at IS NOT NULL AND OLD.receipt_sent_at IS NULL" : ""}`;
    await db.execute(sql.raw(`CREATE ${deferred ? "CONSTRAINT " : ""}TRIGGER ${triggerName} ${deferred ? "AFTER" : "BEFORE"} ${family === "design" ? "UPDATE" : "INSERT"} ON ${table.marker} ${deferred ? "DEFERRABLE INITIALLY DEFERRED " : ""}FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION ${functionName}()`));
    let removed = false;
    return async () => { if (removed) return; await db.execute(sql.raw(`DROP TRIGGER ${triggerName} ON ${table.marker}`));
      await db.execute(sql.raw(`DROP FUNCTION ${functionName}()`)); removed = true; };
  }
  function observeRecoveryTransactions() {
    const client = fixture().server.db, original = client.transaction.bind(client);
    const failures: { callbackReturned: boolean; error: unknown }[] = [];
    const observer = vi.spyOn(client, "transaction").mockImplementation(async function<T>(fn: (tx: import("@artoo/storage").DrizzleDb) => Promise<T>): Promise<T> {
      let callbackReturned = false;
      try { return await original(async tx => { const value = await fn(tx); callbackReturned = true; return value; }); }
      catch (error) { failures.push({ callbackReturned, error }); throw error; }
    });
    return { failures, restore: () => observer.mockRestore() };
  }
  function recoveryDispatcher(actor: RecoveryReceiptActor, errors: unknown[]) {
    const worker = createGoalAutomationDispatcher(actor, async () => { throw Error("Receipt maintenance must not stop or start a process"); }, error => { errors.push(error); });
    lifecycle.own({ close: () => worker.stop() }); return worker;
  }
  async function freezeRecoveryProgress(f: Awaited<ReturnType<typeof prepareRecoveryReceipt>>) {
    const db = fixture().server.db.db;
    await db.update(goals).set({ status: "paused" }).where(eq(goals.id, f.base.goal_id));
    // Automation has no "paused" status. A supported terminal status keeps this
    // fixture outside ACTIVE so the assertions isolate maintenance from advance.
    await db.update(goalAutomations).set({ status: "failed" }).where(eq(goalAutomations.goalId, f.base.goal_id));
  }
  async function recoveryBusinessState(f: RecoveryReceiptBase) {
    const db = fixture().server.db.db;
    return { goals: await db.select().from(goals).where(eq(goals.id, f.base.goal_id)),
      automations: await db.select().from(goalAutomations).where(eq(goalAutomations.goalId, f.base.goal_id)),
      runs: await db.select().from(runs), tasks: await db.select().from(tasks), reviews: await db.select().from(autonomousReviews),
      releases: await db.select().from(productReleases),
      designs: await db.select().from(goalImportedDesignContinuations), designReviews: await db.select().from(goalImportedDesignReviews),
      executions: await db.select().from(goalImportedExecutions), executionReviews: await db.select().from(goalImportedExecutionReviews),
      repairs: await db.select().from(goalImportedExecutionRepairs), validations: await db.select().from(goalImportedValidations),
      validationReviews: await db.select().from(goalImportedValidationReviews),
      capacity: await unsettledGoalExecutionCount(f.actor, db, f.base.goal_id),
      unsettled: await unsettledStandaloneExecutions(f.actor, db, { goalId: f.base.goal_id }) };
  }
  it.each(recoveryReceiptFamilies.flatMap(family => [false, true].map(deferred => ({ family, deferred }))))(
    "receipt recovery survives real marker rollback and worker reconstruction: $family deferred=$deferred", async ({ family, deferred }) => {
      const f = await prepareRecoveryReceipt(family), removeFault = await installRecoveryMarkerFault(family, f.id, deferred), transactions = observeRecoveryTransactions();
      try {
        await expect(f.receive()).rejects.toThrow();
        expect(f.receipts()).toHaveLength(1);
        expect(transactions.failures).toHaveLength(1);
        expect(transactions.failures[0]!.callbackReturned).toBe(deferred);
        expect(String((transactions.failures[0]!.error as { cause?: unknown }).cause ?? transactions.failures[0]!.error)).toContain("controlled receipt marker rollback");
        const committed = await f.state();
        expect(committed.row?.result).toEqual(f.result); expect(committed.marker).toEqual([]);
        if (recoveryReceiptTables[family].completion) expect(committed.completion).toHaveLength(1);
        await freezeRecoveryProgress(f);
        const before = await recoveryBusinessState(f), firstErrors: unknown[] = [], first = recoveryDispatcher(f.actor, firstErrors);
        await first.pump(); await first.stop();
        expect(f.receipts()).toHaveLength(2); expect(firstErrors).toHaveLength(1); expect((await f.state()).marker).toEqual([]);
        await removeFault(); transactions.restore();
        const errors: unknown[] = [], reconstructed = recoveryDispatcher(f.actor, errors);
        await Promise.all([reconstructed.pump(), reconstructed.pump()]); await reconstructed.pump(); await reconstructed.stop();
        // Old code's first observable failure is absence of the automatic send.
        expect(f.receipts()).toHaveLength(3); expect(errors).toEqual([]);
        expect(f.receipts()[1]).toEqual(f.receipts()[0]); expect(f.receipts()[2]).toEqual(f.receipts()[0]);
        const recovered = await f.state(); expect(recovered.marker).toHaveLength(1);
        expect(recovered.marker[0]).toMatchObject({ delivery_id: f.command.id, session_id: f.sessionId, result_digest: hash(f.result) });
        expect(recovered.row).toEqual(committed.row); expect(await recoveryBusinessState(f)).toEqual(before);
      } finally { transactions.restore(); await removeFault(); }
    });
  it.each([
    { family: "execution-review", variant: "rejected" }, { family: "validation", variant: "closed-failure" }, { family: "validation-review", variant: "failed" },
  ] as const)("receipt recovery includes obligated non-success result $family/$variant", async ({ family, variant }) => {
    const f = await prepareRecoveryReceipt(family, variant), removeFault = await installRecoveryMarkerFault(family, f.id);
    try { await expect(f.receive()).rejects.toThrow(); expect((await f.state()).row?.result).toEqual(f.result); expect((await f.state()).marker).toEqual([]); }
    finally { await removeFault(); }
    await freezeRecoveryProgress(f); const before = await recoveryBusinessState(f), errors: unknown[] = [], worker = recoveryDispatcher(f.actor, errors);
    await worker.pump(); await worker.stop(); expect(f.receipts()).toHaveLength(2); expect(errors).toEqual([]);
    expect((await f.state()).marker).toHaveLength(1); expect(await recoveryBusinessState(f)).toEqual(before);
  });
  it.each([
    { family: "design", variant: "legacy" }, { family: "design-review", variant: "changes_requested" }, { family: "design-review", variant: "failed" },
    { family: "design-review", variant: "cancelled" }, { family: "execution-review", variant: "failed" },
  ] as const)("receipt recovery excludes no-marker obligation $family/$variant", async ({ family, variant }) => {
    const f = await prepareRecoveryReceipt(family, variant); await f.receive(); await freezeRecoveryProgress(f);
    const before = await recoveryBusinessState(f), errors: unknown[] = [], worker = recoveryDispatcher(f.actor, errors);
    await worker.pump(); await worker.pump(); await worker.stop();
    expect(f.receipts()).toHaveLength(1); expect(f.callbacks).toEqual([]); expect(errors).toEqual([]);
    expect((await f.state()).marker).toEqual([]); expect(await recoveryBusinessState(f)).toEqual(before);
  });
  it("receipt recovery excludes uncertain review while preserving the existing paused-goal stop path", async () => {
    const f = await prepareRecoveryReceipt("design-review", "uncertain"); await f.receive(); await freezeRecoveryProgress(f);
    const errors: unknown[] = [], worker = recoveryDispatcher(f.actor, errors); await worker.pump(); await worker.stop();
    expect(f.receipts()).toHaveLength(1); expect(f.callbacks).toEqual([]); expect((await f.state()).marker).toEqual([]);
    expect((await f.state()).row?.result).toEqual(f.result);
    // The existing pending-review path is allowed to persist/send Stop. It must
    // not be suppressed to manufacture a no-business-change assertion here.
    expect((await f.state()).row?.stop_requested).toBe(true); expect(errors).toEqual([]);
  });
  it.each((["design", "execution-review"] as const).flatMap(family => (["status", "stop"] as const).map(control => ({ family, control }))))(
    "receipt recovery retains the first result's $control command identity for $family", async ({ family, control }) => {
      const f = await prepareRecoveryReceipt(family);
      const peer = f.peer as { dispatch(id: string, control: "status" | "stop"): Promise<ServerToNodeMessage>; requestStop?(id: string): Promise<void> };
      if (control === "stop") {
        if (family === "design") await peer.requestStop!(f.id);
        else await (await import("./services/imported-execution-review-service.js")).stopGoalImportedExecutionReviews(f.actor, f.base.goal_id);
      }
      const command = await peer.dispatch(f.id, control), removeFault = await installRecoveryMarkerFault(family, f.id);
      expect(command.id).not.toBe(f.command.id);
      try { await expect(f.receiveWithCommand(command.id)).rejects.toThrow(); } finally { await removeFault(); }
      await freezeRecoveryProgress(f); const before = await recoveryBusinessState(f), errors: unknown[] = [], worker = recoveryDispatcher(f.actor, errors);
      await worker.pump(); await worker.stop(); expect(f.receipts()).toHaveLength(2); expect(errors).toEqual([]);
      expect(f.receipts()[0]).toMatchObject({ id: command.id, idempotency_key: `receipt:${command.id}` }); expect(f.receipts()[1]).toEqual(f.receipts()[0]);
      expect((await f.state()).marker[0]).toMatchObject({ delivery_id: command.id, session_id: f.sessionId, result_digest: hash(f.result) });
      if (control === "stop") expect((await f.state()).row?.stop_requested).toBe(true);
      expect(await recoveryBusinessState(f)).toEqual(before);
    });
  it.each(["design", "execution-review"] as const)("receipt recovery does not rewrite a normal status reply to the original result command: %s", async family => {
    const f = await prepareRecoveryReceipt(family), removeFault = await installRecoveryMarkerFault(family, f.id);
    try { await expect(f.receive()).rejects.toThrow(); } finally { await removeFault(); }
    const command = await (f.peer as { dispatch(id: string, control: "status"): Promise<ServerToNodeMessage> }).dispatch(f.id, "status");
    await f.receiveWithCommand(command.id);
    expect(f.receipts()).toHaveLength(2); expect(f.receipts()[1]).toMatchObject({ id: command.id, idempotency_key: `receipt:${command.id}` });
    expect((await f.state()).marker[0]).toMatchObject({ delivery_id: f.command.id, session_id: f.sessionId, result_digest: hash(f.result) });
  });
  it("receipt recovery rejects a replacement binding directly even when device and token are unchanged", async () => {
    const f = await prepareRecoveryReceipt("execution-review"), removeFault = await installRecoveryMarkerFault(f.family, f.id);
    try { await expect(f.receive()).rejects.toThrow(); } finally { await removeFault(); }
    const before = await f.state(), frames: ServerToNodeMessage[] = [];
    const replacement = createImportedExecutionReviewBinding(f.actor, { identity: f.identity, sessionId: "replacement-session", isCurrent: () => true,
      transport: { async send(frame) { frames.push(frame); } } });
    // This is an additional trusted-boundary regression. Primary old-code red
    // comes from the earlier pump tests, never this new-method existence check.
    const recover = (replacement as { redeliverCommittedReceipt?: (id: string) => Promise<void> }).redeliverCommittedReceipt;
    expect(typeof recover).toBe("function"); await expect(recover!.call(replacement, f.id)).rejects.toThrow("original");
    expect(frames).toEqual([]); expect(await f.state()).toEqual(before);
  });
  it("receipt recovery retries a failed transport send without a second node result", async () => {
    const f = await prepareRecoveryReceipt("validation-review");
    f.onSend(async frame => { if (frame.type === "product.source.validation-review.receipt.v1") throw Error("Controlled receipt transport failure"); });
    await expect(f.receive()).rejects.toThrow("Controlled receipt transport failure");
    expect((await f.state()).row?.result).toEqual(f.result); expect((await f.state()).marker).toEqual([]);
    f.onSend(); await freezeRecoveryProgress(f); const errors: unknown[] = [], worker = recoveryDispatcher(f.actor, errors);
    await worker.pump(); await worker.stop(); expect(f.receipts()).toHaveLength(2); expect(errors).toEqual([]); expect((await f.state()).marker).toHaveLength(1);
  });
  it.each(["device", "expired-token", "member", "replaced-session", "feature", "current-before-send", "current-after-send"] as const)(
    "receipt recovery refuses a stale authority boundary: %s", async change => {
      const f = await prepareRecoveryReceipt("execution-review"), removeFault = await installRecoveryMarkerFault(f.family, f.id);
      try { await expect(f.receive()).rejects.toThrow(); } finally { await removeFault(); }
      await freezeRecoveryProgress(f); const committed = await f.state(), db = fixture().server.db.db;
      if (change === "device") f.beforeRecovery(async () => { await revokeDevice(f.actor, f.destination.device.id); });
      if (change === "expired-token") f.beforeRecovery(async () => { await db.update(deviceTokens).set({ expiresAt: "2000-01-01T00:00:00Z" }).where(eq(deviceTokens.tokenLookup, f.identity.tokenLookup)); });
      if (change === "member") f.beforeRecovery(async () => { await db.execute(sql`insert into member_suspensions (user_id, organization_id, suspended_by_user_id, reason, suspended_at) values (${f.actor.actorUserId}, ${f.actor.organizationId}, ${f.actor.actorUserId}, 'Controlled receipt recovery revocation', ${f.actor.clock.nowIso()})`); });
      if (change === "replaced-session") {
        const prior = f.actor.getPairedNodeSession; f.actor.getPairedNodeSession = id => { const value = prior?.(id); return value && id === f.destination.nodeId ? { ...value, sessionId: "replacement-session" } : value; };
      }
      if (change === "feature") f.actor.supportsExecutionFeature = () => false;
      if (change === "current-before-send") f.beforeRecovery(async () => { f.invalidate(); });
      if (change === "current-after-send") f.onSend(async frame => { if (frame.type === "product.source.execution-review.receipt.v1") f.invalidate(); });
      const errors: unknown[] = [], worker = recoveryDispatcher(f.actor, errors); await worker.pump(); await worker.stop();
      expect(f.receipts()).toHaveLength(change === "current-after-send" ? 2 : 1);
      if (!["replaced-session", "feature"].includes(change)) expect(errors).toHaveLength(1);
      expect((await f.state()).marker).toEqual([]); expect((await f.state()).row).toEqual(committed.row);
    });
  it("receipt recovery stop waits for the real in-flight send and does not start more maintenance", async () => {
    const f = await prepareRecoveryReceipt("execution-review"), removeFault = await installRecoveryMarkerFault(f.family, f.id);
    try { await expect(f.receive()).rejects.toThrow(); } finally { await removeFault(); }
    await freezeRecoveryProgress(f); let enter!: () => void, release!: () => void, stopped = false;
    const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    f.onSend(async frame => { if (frame.type === "product.source.execution-review.receipt.v1") { enter(); await gate; } });
    const errors: unknown[] = [], worker = recoveryDispatcher(f.actor, errors), pumping = worker.pump();
    void pumping.catch(() => {});
    try {
      // Observe either entry or actual pump completion; old code must fail here,
      // without waiting indefinitely for a new implementation's callback.
      await Promise.race([entered, pumping]); expect(f.receipts()).toHaveLength(2);
      const stopping = worker.stop().then(() => { stopped = true; }); await Promise.resolve();
      expect(stopped).toBe(false); release(); await pumping; await stopping;
      await worker.pump(); expect(f.receipts()).toHaveLength(2); expect((await f.state()).marker).toHaveLength(1); expect(errors).toEqual([]);
    } finally { release(); await pumping; await worker.stop(); }
  });
  it.each(["paused", "stopped", "cancelled", "budget-exhausted"] as const)(
    "receipt recovery records only committed history while business progression is %s", async status => {
      const f = await prepareRecoveryReceipt("execution-review"), db = fixture().server.db.db;
      const stopReview = (await import("./services/imported-execution-review-service.js")).stopGoalImportedExecutionReviews;
      // Exercise the existing durable stop path before result closure. This
      // preserves stopRequested while receive commits an already-started result.
      if (status === "stopped") await stopReview(f.actor, f.base.goal_id);
      const removeFault = await installRecoveryMarkerFault(f.family, f.id);
      try { await expect(f.receive()).rejects.toThrow(); } finally { await removeFault(); }
      if (status === "cancelled") {
        await cancelGoal(f.actor, f.base.goal_id);
        await db.update(goalAutomations).set({ status: "cancelled" }).where(eq(goalAutomations.goalId, f.base.goal_id));
      } else {
        await freezeRecoveryProgress(f);
        if (status === "budget-exhausted") {
          await db.update(goals).set({ runningSince: "2000-01-01T00:00:00Z", budgets: { max_elapsed_ms: 1, max_retries: 0 } }).where(eq(goals.id, f.base.goal_id));
          await db.update(goalAutomations).set({ status: "failed", lastError: "Controlled previously exhausted budget" }).where(eq(goalAutomations.goalId, f.base.goal_id));
        }
      }
      const before = await recoveryBusinessState(f), state = await f.state(), errors: unknown[] = [], worker = recoveryDispatcher(f.actor, errors);
      if (status === "stopped") expect(state.row?.stop_requested).toBe(true);
      await worker.pump(); await worker.pump(); await worker.stop();
      expect(f.receipts()).toHaveLength(2); expect(errors).toEqual([]); expect((await f.state()).marker).toHaveLength(1);
      expect((await f.state()).row).toEqual(state.row); expect(await recoveryBusinessState(f)).toEqual(before);
    });
  it("receipt recovery scheduler rotates A:a B:b A:z after persistent delivery failures (controlled snapshots)", async () => {
    // This case isolates the real scheduler with explicit controlled DB snapshots;
    // the real transaction/credential/send tests above carry the DB evidence.
    // In particular this test does not claim that fabricated rows passed SQL.
    const calls: { computerId: string; family: RecoveryReceiptFamily; id: string }[] = [], errors: unknown[] = [];
    const rows = [{ id: "a", computerId: "A" }, { id: "b", computerId: "B" }, { id: "z", computerId: "A" }].map(value => ({
      ...value, goalId: "controlled-goal", resultSessionId: `${value.computerId}-session`,
      result: ImportedValidationReviewResultV1Schema.parse({ version: 1, review_id: value.id, request_digest: sha(value.id),
        execution_authorized: false, outcome: "failed", closed: true, reason: "Controlled closed review awaiting receipt" }),
    }));
    const transaction = vi.fn(async () => { throw Error("No business transaction is expected in scheduler-only evidence"); });
    const select = (fields?: Record<string, unknown>) => {
      let tableName = "";
      const query = { from(table: Parameters<typeof getTableConfig>[0]) { tableName = getTableConfig(table).name; return query; },
        innerJoin() { return query; }, leftJoin() { return query; },
        async where() { return tableName === "goal_imported_validation_reviews" ? rows.map(operation => fields && "operation" in fields ? { operation, receipt: null } : operation) : []; } };
      return query;
    };
    const actor = { ...fixture().server.ctx, db: { db: { select }, transaction } as unknown as RecoveryReceiptActor["db"],
      supportsExecutionFeature: () => true,
      getPairedNodeSession: (computerId: string) => ({ computerId, deviceId: `${computerId}-device`, tokenLookup: `${computerId}-lookup`, sessionId: `${computerId}-session` }),
    };
    Object.assign(actor, { redeliverImportedSourceReceipt: async (computerId: string, family: RecoveryReceiptFamily, id: string) => {
      calls.push({ computerId, family, id }); throw Error("Controlled persistent receipt transport failure");
    } });
    const worker = recoveryDispatcher(actor, errors);
    for (let round = 0; round < 4; round++) {
      const before = calls.length; await worker.pump(); const current = calls.slice(before);
      expect(current).toHaveLength(2); expect(new Set(current.map(value => value.computerId)).size).toBe(current.length);
    }
    await worker.stop();
    for (const id of ["a", "b", "z"]) expect(calls.filter(value => value.id === id).length).toBeGreaterThanOrEqual(2);
    expect(errors).toHaveLength(calls.length); expect(transaction).not.toHaveBeenCalled();
    rows.splice(0, rows.length, ...Array.from({ length: 11 }, (_, index) => {
      const id = `quota-${String(index).padStart(2, "0")}`, computerId = `computer-${index}`;
      return { id, computerId, goalId: "controlled-goal", resultSessionId: `${computerId}-session`,
        result: ImportedValidationReviewResultV1Schema.parse({ version: 1, review_id: id, request_digest: sha(id),
          execution_authorized: false, outcome: "failed", closed: true, reason: "Controlled batch limit" }) };
    }));
    const batch = recoveryDispatcher(actor, errors), before = calls.length; await batch.pump(); await batch.stop();
    const quotaCalls = calls.slice(before); expect(quotaCalls).toHaveLength(8);
    expect(new Set(quotaCalls.map(value => value.computerId)).size).toBe(8); expect(transaction).not.toHaveBeenCalled();
  });
  it("receipt recovery loops back a committed design receipt after an actual marker rollback", async () => {
    const f = await prepareDesign(), server = fixture().server, row = await f.ensureDesign(), peer = await openOrdinaryDesignSocket(f);
    await eventually(() => server.nodeRegistry.get(f.destination.nodeId)?.supportsExecutionFeature(IMPORTED_DESIGN_CONTINUATION_FEATURE_V1) === true, "receipt recovery paired readiness");
    const binding = server.nodeRegistry.get(f.destination.nodeId)!; await binding.dispatchImportedDesignContinuation!(row.id, "start");
    await eventually(() => peer.frames.some(frame => frame.type === "product.source.design.v1"), "receipt recovery loopback start");
    const original = peer.frames.find(frame => frame.type === "product.source.design.v1")!;
    if (original.type !== "product.source.design.v1") throw Error("Expected design command");
    const request = ImportedDesignContinuationRequestV1Schema.parse(row.request), verification = controlledDesignVerification(request), result = importedCompletedDesignResultFixture(request, verification);
    await peer.transport.send({ kind: "run.event", node_id: row.computerId, run_id: row.runId, sequence: 0, event: { type: "run.lifecycle", payload: { phase: "started" } } });
    await peer.transport.send({ kind: "run.event", node_id: row.computerId, run_id: row.runId, sequence: 1, event: { type: "run.verification", payload: verification } });
    await peer.transport.send({ kind: "run.event", node_id: row.computerId, run_id: row.runId, sequence: 2, event: { type: "run.lifecycle", payload: { phase: "completed" } } });
    const removeFault = await installRecoveryMarkerFault("design", row.id, true), transactions = observeRecoveryTransactions();
    try {
      await peer.transport.send({ kind: "product.source.design.result.v1", node_id: row.computerId, command_id: original.id, payload: result });
      await eventually(() => peer.frames.filter(frame => frame.type === "product.source.design.receipt.v1").length === 1 && transactions.failures.length === 1, "receipt sent and deferred marker commit rejected");
      expect(transactions.failures[0]!.callbackReturned).toBe(true);
      const state = await recoveryReceiptState("design", row.id); expect(state.row?.result).toEqual(result); expect(state.marker).toEqual([]);
      await removeFault(); transactions.restore();
      await server.db.db.update(goals).set({ status: "paused" }).where(eq(goals.id, f.base.goal_id));
      await server.db.db.update(goalAutomations).set({ status: "failed" }).where(eq(goalAutomations.goalId, f.base.goal_id));
      const before = await recoveryBusinessState(f), errors: unknown[] = [], worker = recoveryDispatcher(server.ctx, errors);
      await worker.pump(); await worker.stop();
      await eventually(() => peer.frames.filter(frame => frame.type === "product.source.design.receipt.v1").length === 2, "automatic receipt re-sent over original loopback session");
      const receipts = peer.frames.filter(frame => frame.type === "product.source.design.receipt.v1");
      expect(receipts[1]).toEqual(receipts[0]); expect((await recoveryReceiptState("design", row.id)).marker).toHaveLength(1);
      expect(errors).toEqual([]); expect(await recoveryBusinessState(f)).toEqual(before);
      expect(peer.frames.filter(frame => frame.type === "product.source.design.v1")).toHaveLength(1);
    } finally { transactions.restore(); await removeFault(); }
  });
});
