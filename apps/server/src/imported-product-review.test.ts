import {goalProductHandoffs,goalProductHandoffOperations,goalProductHandoffDeliveries,deviceTokens} from "@artoo/db";
import { agents, discussions, goalImportedProductReviews, goalImportedProductReviewDeliveries } from "@artoo/db";
import { IMPORTED_PRODUCT_REVIEW_FEATURE_V1, ImportedProductReviewRequestV1Schema, ImportedProductReviewResultV1Schema, type ImportedProductReviewResultV1 } from "@artoo/domain";
import { ensureGoalImportedProductReview, advanceGoalImportedProductReview, createGoalImportedProductReviewBinding,
  importedProductReviewView, stopGoalImportedProductReviews } from "./services/imported-product-review-service.js";
import {getTableConfig} from "drizzle-orm/pg-core";
import {ProductSourceHandoffIntentV1Schema,ProductSourceOperationV1Schema,PRODUCT_SOURCE_OPERATIONS_FEATURE_V1,parseDeviceToken} from "@artoo/domain";
import type {ServerToNodeMessage} from "@artoo/protocol";
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
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { MemoryArtifactStore } from "./test-fixtures/memory-artifact-store.js";
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
import { goalResearchDestinationPools as revisionPools, goalResearchDestinationSlots as revisionSlots, goalResearchRevisions as researchRevisions, goalImportedDesignContinuations } from "@artoo/db";
import { GoalBudgetsSchema, ResearchDestinationPoolSnapshotV1Schema, ResearchRevisionIntentV1Schema, PRODUCT_RESEARCH_REVISION_FEATURE_V1, VerificationRequirementSchema } from "@artoo/domain";
import { ensureGoalResearchRevision } from "./services/research-revision-service.js";
import { researchRevisionGoalDigest, researchRevisionPlanDigest,
  readCurrentResearchHandoff, resolveResearchRevisionOrigin, researchRevisionContext } from "./services/research-revision-origin-service.js";
import { persistResearchDestinationPool } from "./services/research-destination-pool-service.js";
import { assertResearchHandoffDestinationOwner } from "./services/research-handoff-guard.js";
import { createAssistantDispatcher } from "./services/assistant-service.js";

const sha = (bytes: string | Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const hash = (value: unknown) => sha(canonicalProductSourceTransferValueV1(value));
describe("imported destination review orchestration (controlled DB/protocol evidence, no native process)", () => {
  let server: TestServer, directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "artoo-semantic-transfer-"));
    server = await buildTestServer({ artifactDir: directory, workspaceRoot: "/workspace/product", authConfig: { enforceApiAuth: true },
      deviceAuth: testDeviceAuthConfig({ devNodeToken: "dev", devControlEscape: false }) });
  });
  afterEach(async () => {
    vi.restoreAllMocks(); await server?.close();
    if (directory) {
      const target = resolve(directory), root = resolve(tmpdir()) + sep;
      if (!target.startsWith(root) || !target.slice(root.length).startsWith("artoo-semantic-transfer-")) throw new Error("Unsafe fixture cleanup path");
      await rm(target, { recursive: true, force: true });
    }
  });
  async function paired(name: string) {
    const code = await createPairing(server.ctx, { pepper: server.ctx.deviceAuth.pairingPepper, ttlMs: 60000 }, { createdByUserId: server.ctx.actorUserId });
    const response = await server.app.inject({ method: "POST", url: "/api/v1/devices/claim",
      payload: { code: code.code, platform: "windows", app_version: "fixture", display_name: name } });
    expect(response.statusCode).toBe(201);
    const device = response.json() as { device: { id: string }; node_token: string; control_token: string };
    const enrolled = await server.app.inject({ method: "POST", url: `/api/v1/devices/${device.device.id}/enroll`, payload: {},
      headers: { authorization: `Bearer ${device.control_token}` } });
    expect(enrolled.statusCode).toBe(200);
    const nodeId = enrolled.json().computer_id as string;
    await server.db.db.update(computers).set({ status: "online" }).where(eq(computers.id, nodeId));
    return { ...device, nodeId };
  }
  async function prepare(options: { malformed?: "metadata" | "omitted" | "duplicate"; skipExport?: boolean; originalReceiptRun?: boolean;
    measurementV2?: boolean; legacyResearch?: boolean; revision?: boolean } = {}) {
    const source = await paired("source"), destination = await paired("destination"), other = await paired("other");
    await server.db.db.update(agentInstances).set({ computerId: source.nodeId }).where(eq(agentInstances.id, "instance_mock_coder"));
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
    const review = await prepareTransferReviewFixture(server, f);
    expect(await review.inspect()).toMatchObject({ status: "accepted" });
    const now = server.ctx.clock.nowIso();
    await server.db.db.insert(plans).values({ id: "transfer_plan", organizationId: server.ctx.organizationId, goalId: "measurement_goal",
      version: 1, authorType: "system", authorId: "goal_runner", status: "accepted", createdAt: now, acceptedAt: now });
    await server.db.db.update(goals).set({ currentPlanId: "transfer_plan" }).where(eq(goals.id, "measurement_goal"));
    await server.db.db.update(tasks).set({ sourcePlanId: "transfer_plan", status: "done" }).where(eq(tasks.id, review.source.run.taskId));
    await server.db.db.update(autonomousReviews).set({ status: "accepted", verdict: review.verdict }).where(eq(autonomousReviews.id, "measurement_review"));
    await server.db.db.insert(goalAutomations).values({ goalId: "measurement_goal", organizationId: server.ctx.organizationId,
      actorUserId: server.ctx.actorUserId, policyVersion: server.ctx.aiDataSharingPolicy!.version, status: "executing", planId: "transfer_plan",
      ...(options.revision ? { executionMode: "agent_team", releaseProfileId: sourceRelease!.binding.release_profile_id,
        agentInstanceId: review.source.run.agentInstanceId,
        planningCapabilitySnapshot: { version: 1, computer_id: source.nodeId, project_id: "proj_artoo", workspace_root: "/workspace/product",
          verification_profile_id: "default", capabilities: f.capabilities, release: { version: 1, capabilities: sourceRelease } },
        sourceHandoff: { version: 1, mode: "automatic", research_revision: { version: 1, strategy: "configured_pool" } } } : {}),
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
    server.ctx.supportsExecutionFeature = (nodeId, feature) => [source.nodeId, destination.nodeId].includes(nodeId)
      && ["product-source-transfer.v1", "product-source-transfer.v2", ...(sourceRelease ? [PRODUCT_SOURCE_TRANSFER_MEASUREMENT_V2_FEATURE_V1] : [])].includes(feature);
    server.ctx.supportsVerificationProfile = (nodeId, profile, project, workspace) => project === "proj_artoo"
      && (nodeId === destination.nodeId && profile === destinationProfile && workspace === "/destination/product"
        || !!sourceRelease && nodeId === source.nodeId && profile === "default" && workspace === "/workspace/product");
    server.ctx.getVerificationCapabilities = (nodeId, profile, project, workspace) => sourceRelease
      ? server.ctx.supportsVerificationProfile?.(nodeId, profile, project, workspace)
        ? structuredClone(nodeId === source.nodeId ? f.capabilities : destinationCapabilities) : undefined
      : structuredClone(f.capabilities);
    if (sourceRelease && destinationRelease) {
      server.ctx.supportsReleaseProfile = (nodeId, profile, project, workspace, verifier) => {
        const selected = nodeId === source.nodeId ? sourceRelease : nodeId === destination.nodeId ? destinationRelease : undefined;
        return !!selected && selected.binding.release_profile_id === profile && selected.binding.project_id === project
          && selected.binding.workspace_root === workspace && selected.binding.verification_profile_id === verifier;
      };
      server.ctx.getReleaseCapabilities = (nodeId, profile, project, workspace, verifier) =>
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
      organization_id: server.ctx.organizationId, project_id: "proj_artoo", goal_id: "measurement_goal", plan_id: "transfer_plan",
      authorization: { actor_user_id: server.ctx.actorUserId, consent_id: null, policy_version: server.ctx.aiDataSharingPolicy!.version },
      source: { node_id: source.nodeId, task_id: review.source.run.taskId, run_id: review.source.run.id, evidence_id: review.source.evidence.id,
        verification_request_id: f.payload.request_id, profile_id: "default", profile_digest: f.payload.profile_digest, workspace_root: "/workspace/product",
        subject_digest: f.payload.subject_digest, review_id: "measurement_review", reviewer_run_id: review.peer.run.id, reviewer_evidence_id: review.peer.evidence.id,
        capsule_digest: sha(bytes), manifest_digest: capsule.manifest_digest, capsule_bytes: bytes.length },
      destination: { node_id: destination.nodeId, profile_id: destinationProfile, workspace_root: "/destination/product",
        capabilities: destinationCapabilities, capability_digest: hash(destinationCapabilities) } });
    review.source.context.goal_context = { version: 1, goal_id: "measurement_goal", objective: "Controlled transfer", acceptance_criteria: [],
      plan: { id: "transfer_plan", version: 1, rationale: "Controlled protocol fixture", spec_ref: null } };
    await server.db.db.update(contextPacks).set({ payload: review.source.context }).where(eq(contextPacks.id, review.source.run.contextPackId!));
    await server.db.db.update(eventLog).set({ sequence: 1 }).where(eq(eventLog.id, review.source.evidence.eventId));
    const verificationFrame = qualifyRunEventMessage({ kind: "run.event", node_id: source.nodeId, run_id: review.source.run.id,
      sequence: 1, event: { type: "run.verification", payload: review.source.evidence.payload } });
    await server.db.db.insert(runEventIngest).values({ nodeId: source.nodeId, runId: review.source.run.id, sequence: 1,
      eventId: review.source.evidence.eventId, bodyIdentity: verificationFrame.bodyIdentity, createdAt: now });
    await server.db.db.update(runs).set({ status: "running" }).where(eq(runs.id, review.source.run.id));
    await server.db.db.update(tasks).set({ status: "running" }).where(eq(tasks.id, review.source.run.taskId));
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
      await ingestWireRunEvent(server.ctx, exportFrame); await ingestWireRunEvent(server.ctx, terminalFrame);
      await server.db.db.update(tasks).set({ status: "done" }).where(eq(tasks.id, review.source.run.taskId));
    }
    const actor = { ...server.ctx, automationActor: { type: "system" as const, id: "goal_runner" as const } };
    const digest = productSourceTransferRequestDigestV2(request, sha);
    const url = `/api/v1/node/product-source-transfers-v2/${base.transfer_id}/content`;
    const headers = (token: string, override: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`,
      "x-artoo-transfer-request-digest": digest, "x-artoo-checksum": sha(bytes), ...override });
    const upload = (token = source.node_token, payload = bytes, extra: Record<string, string> = {}) => server.app.inject({ method: "PUT", url,
      headers: headers(token, { "content-type": "application/octet-stream", ...extra }), payload });
    const download = (token = destination.node_token) => server.app.inject({ method: "GET", url, headers: headers(token) });
    return { source, destination, other, review, request, base, actor, digest, bytes, upload, download, headers, url, proof, exportFrame, terminalFrame,
      sourceRelease, destinationRelease, researchBytes, researchReport };
  }

  async function prepareHandoff(revision = false){
    const f=await prepare({measurementV2:true, revision}),now=server.ctx.clock.nowIso();
    await server.db.db.update(tasks).set({sourcePlanSpecRef:"0"}).where(eq(tasks.id,f.base.source.task_id));
    await server.db.db.update(plans).set({taskSpecs:[{development_stage:"research",title:"Research",acceptance_criteria:["Source research accepted"]},
      {development_stage:"design",title:"Design",acceptance_criteria:["Design the product"],dependencies:[{ref:"0",type:"blocks"}]}]}).where(eq(plans.id,f.base.plan_id));
    await server.db.db.insert(tasks).values({id:"handoff_design",organizationId:server.ctx.organizationId,projectId:f.base.project_id,goalId:f.base.goal_id,
      sourcePlanId:f.base.plan_id,sourcePlanSpecRef:"1",title:"Next design",status:"ready",acceptanceCriteria:["Design the product"],createdByType:"system",createdById:"goal_runner",createdAt:now,updatedAt:now});
    if (revision) {
      const [sourceTask] = await server.db.db.select().from(tasks).where(eq(tasks.id, f.base.source.task_id));
      await server.db.db.update(plans).set({ taskSpecs: [{ development_stage: "research", title: sourceTask!.title,
        description: sourceTask!.description, acceptance_criteria: sourceTask!.acceptanceCriteria, required_capabilities: sourceTask!.requiredCapabilities },
      { development_stage: "design", title: "Next design", acceptance_criteria: ["Design the product"], dependencies: [{ ref: "0", type: "blocks" }] },
      { development_stage: "implementation", title: "Implement", acceptance_criteria: ["Implement the product"], dependencies: [{ ref: "1", type: "blocks" }] },
      { development_stage: "validation", title: "Validate", acceptance_criteria: ["Validate the product"], dependencies: [{ ref: "2", type: "blocks" }] }] }).where(eq(plans.id, f.base.plan_id));
      await server.db.db.insert(tasks).values(["implementation", "validation"].map((stage, index) => ({ id: `revision_${stage}`, organizationId: server.ctx.organizationId,
        projectId: f.base.project_id, goalId: f.base.goal_id, sourcePlanId: f.base.plan_id, sourcePlanSpecRef: String(index + 2),
        title: stage === "implementation" ? "Implement" : "Validate", status: "backlog", acceptanceCriteria: [stage === "implementation" ? "Implement the product" : "Validate the product"],
        createdByType: "system", createdById: "goal_runner", createdAt: now, updatedAt: now })));
      await server.db.db.update(agentInstances).set({ runtime: "codex", status: "idle", workspaceRoot: f.base.source.workspace_root })
        .where(sql`${agentInstances.id} in ('instance_mock_coder','review_instance')`);
      const [writer] = await server.db.db.select().from(agentInstances).where(eq(agentInstances.id, "instance_mock_coder"));
      for (const agentId of [writer!.agentId, "review_agent"]) {
        const [agent] = await server.db.db.select().from(agents).where(eq(agents.id, agentId));
        await server.db.db.update(agents).set({ capabilities: [...new Set([...(agent!.capabilities as string[]), "code.read", "code.modify", "code.review"])] }).where(eq(agents.id, agentId));
      }
      await server.db.db.update(runs).set({ runtimeId: "codex", modelProfileId: writer!.modelProfileId, effortProfileId: writer!.effortProfileId })
        .where(sql`${runs.id} in ('measurement_author_run','measurement_peer_run')`);
      await server.db.db.insert(agentInstances).values({ ...writer!, id: "destination_writer_instance", computerId: f.destination.nodeId,
        workspaceRoot: f.base.destination.workspace_root });
      const [goal] = await server.db.db.select().from(goals).where(eq(goals.id, f.base.goal_id));
      await server.db.db.update(goals).set({ budgets: { ...GoalBudgetsSchema.parse(goal!.budgets), max_retries: 1 } }).where(eq(goals.id, f.base.goal_id));
    }
    const context=structuredClone(f.review.source.context);context.task.id="handoff_verification_task";context.workspace.root=f.base.destination.workspace_root;
    context.policy.filesystem_write_scope=[f.base.destination.workspace_root];context.verification_capabilities={...f.base.destination.capabilities,profile_id:f.base.destination.profile_id};
    context.release_capabilities=f.destinationRelease;
    const [originalGoal] = await server.db.db.select().from(goals).where(eq(goals.id, f.base.goal_id));
    const [originalPlan] = await server.db.db.select().from(plans).where(eq(plans.id, f.base.plan_id));
    context.goal_context = { version: 1, goal_id: f.base.goal_id, objective: originalGoal!.objective, acceptance_criteria: originalGoal!.acceptanceCriteria as string[],
      plan: { id: f.base.plan_id, version: originalPlan!.version, rationale: originalPlan!.rationale ?? "", spec_ref: "0" } };
    const intent=ProductSourceHandoffIntentV1Schema.parse({version:1,request:f.request,next_task_id:"handoff_design",destination_start:{run_id:"handoff_verification_run",
      task_id:context.task.id,agent_instance_id:revision ? "destination_writer_instance" : "controlled_operation",runtime:revision ? "codex" : "controlled_fixture",workspace:{root:context.workspace.root},context_pack:{id:"handoff_context",payload:context},
      policy_snapshot:context.policy,artifact_rules:{paths:[]},verification:{version:1,profile_id:f.base.destination.profile_id,request_id:"handoff_verification_request",
        expected_subject_digest:f.base.source.subject_digest,capability_binding:verificationCapabilityBinding(f.base.destination.capabilities),release_capability_binding:f.destinationRelease!.binding}}});
    const supports=f.actor.supportsExecutionFeature;f.actor.supportsExecutionFeature=(node,feature)=>feature===PRODUCT_SOURCE_OPERATIONS_FEATURE_V1||supports?.(node,feature)===true;
    const sent:ServerToNodeMessage[]=[];let current=true;
    const binding=(node:string,session="session-one")=>{const pairedNode=[f.source,f.destination,f.other].find(v=>v.nodeId===node)!;
      return createGoalProductHandoffBinding(f.actor,{identity:{computerId:node,deviceId:pairedNode.device.id,tokenLookup:parseDeviceToken(pairedNode.node_token)!.lookup},sessionId:session,isCurrent:()=>current,
        artifactStore:server.ctx.artifactStore,artifactDir:directory,transport:{send:async message=>{sent.push(message);}}});};
    const ops=async()=>server.db.db.select().from(goalProductHandoffOperations);
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
  async function prepareImported(revision = false) {
    const f = await prepareHandoff(revision); await uploadHandoff(f);
    const imported = (await f.ops()).find(row => row.kind === "import_verify")!;
    const importBinding = f.binding(f.destination.nodeId), command = await importBinding.dispatch(imported.id);
    const measured = controlledDestinationResult(ProductSourceOperationV1Schema.parse(imported.payload), f.researchBytes);
    await importBinding.receive({ kind: "product.source.operation.result.v1", node_id: f.destination.nodeId, command_id: command.id, payload: measured });
    await importBinding.qualify(imported.id);
    const [sourceInstance] = await server.db.db.select().from(agentInstances).where(eq(agentInstances.id, f.review.source.run.agentInstanceId));
    const [sourceAgent] = await server.db.db.select().from(agents).where(eq(agents.id, sourceInstance!.agentId));
    await server.db.db.insert(agents).values({ ...sourceAgent!, id: "imported_reviewer_agent", kind: "reviewer", capabilities: ["code.read", "code.review", ...(revision ? ["code.modify"] : [])] });
    await server.db.db.insert(agentInstances).values({ ...sourceInstance!, id: "imported_reviewer_instance", agentId: "imported_reviewer_agent",
      computerId: f.destination.nodeId, runtime: "codex", status: "idle", workspaceRoot: f.base.destination.workspace_root });
    const team = { version: 1, reviewer_instance_ids: ["review_instance", "imported_reviewer_instance"],
      members: ["research", "design", "implementation", "validation"].map((stage, index) => ({ stage, agent_instance_id: index % 2 ? "imported_reviewer_instance" : sourceInstance!.id })) };
    await server.db.db.update(goalAutomations).set({ team, executionMode: "agent_team" }).where(eq(goalAutomations.goalId, f.base.goal_id));
    const originalSupport = f.actor.supportsExecutionFeature;
    f.actor.supportsExecutionFeature = (node, feature) => feature === IMPORTED_PRODUCT_REVIEW_FEATURE_V1 ? node === f.destination.nodeId : originalSupport?.(node, feature) === true;
    const queued: { id: string; control: string }[] = [];
    f.actor.onImportedProductReviewQueued = async (id, control) => { queued.push({ id, control }); };
    const automation = async () => (await server.db.db.select().from(goalAutomations).where(eq(goalAutomations.goalId, f.base.goal_id)))[0]!;
    const ensure = async () => { const a = await automation(); return server.db.transaction(tx => ensureGoalImportedProductReview(f.actor, tx, a, f.base.transfer_id)); };
    const sent: ServerToNodeMessage[] = []; let current = true;
    const binding = (sessionId = "imported-session-one") => createGoalImportedProductReviewBinding(f.actor, {
      identity: { computerId: f.destination.nodeId, deviceId: f.destination.device.id, tokenLookup: parseDeviceToken(f.destination.node_token)!.lookup },
      sessionId, isCurrent: () => current, artifactStore: server.ctx.artifactStore, artifactDir: directory, transport: { send: async frame => { sent.push(frame); } },
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
  // Prepared slot candidates are controlled; pool persistence, H1/H2 admission,
  // credentials, capsule bytes and all SQL guards use their actual services.
  async function prepareRevision(outcome: "changes_requested" | "accepted" | "uncertain" = "changes_requested") {
    const f = await prepareImported(true), db = server.db.db;
    const instance = async (id: string) => (await db.select().from(agentInstances).where(eq(agentInstances.id, id)))[0]!;
    const sourceWriter = await instance("instance_mock_coder"), sourceReviewer = await instance("review_instance");
    const destinationWriter = await instance("destination_writer_instance"), destinationReviewer = await instance("imported_reviewer_instance");
    const laterRoot = "/destination/research-revision-1";
    await db.insert(agentInstances).values([{ ...destinationWriter, id: "revision_writer_1", workspaceRoot: laterRoot },
      { ...destinationReviewer, id: "revision_reviewer_1", workspaceRoot: laterRoot }]);
    const role = (value: typeof sourceWriter) => ({ instance_id: value.id, agent_id: value.agentId, runtime: value.runtime,
      model_profile_id: value.modelProfileId, effort_profile_id: value.effortProfileId });
    const mapping = { source_release: f.sourceRelease!, destination_release: f.destinationRelease!, command_pairs: f.request.command_pairs };
    const laterCapabilities = { ...f.base.destination.capabilities, profile_digest: sha("controlled revision verifier 1") };
    const laterMapping = { ...mapping, destination_release: { ...mapping.destination_release, binding: { ...mapping.destination_release.binding,
      workspace_root: laterRoot, release_profile_id: "revision-release-1", release_profile_digest: sha("controlled revision release 1"),
      verification_profile_id: "revision-verifier-1", verification_profile_digest: laterCapabilities.profile_digest } } };
    const [goal] = await db.select().from(goals).where(eq(goals.id, f.base.goal_id));
    const [plan] = await db.select().from(plans).where(eq(plans.id, f.base.plan_id));
    const snapshot = ResearchDestinationPoolSnapshotV1Schema.parse({ version: 1, project_id: goal!.projectId, goal_id: goal!.id,
      plan_id: plan!.id, next_task_id: "handoff_design", base_research_task_id: f.base.source.task_id,
      actor_user_id: f.actor.actorUserId, consent_id: null, policy_version: f.actor.aiDataSharingPolicy!.version,
      goal_digest: researchRevisionGoalDigest(goal!), plan_digest: researchRevisionPlanDigest(plan!), max_retries: 1,
      source: { computer_id: f.source.nodeId, workspace_root: f.base.source.workspace_root, release: f.sourceRelease!,
        writer: role(sourceWriter), reviewer: role(sourceReviewer) },
      destination: { computer_id: f.destination.nodeId, writer_agent_id: destinationWriter.agentId, reviewer_agent_id: destinationReviewer.agentId },
      members: [{ slot_id: "revision_slot_0", index: 0, mapping, writer: role(destinationWriter), reviewer: role(destinationReviewer) },
        { slot_id: "revision_slot_1", index: 1, mapping: laterMapping,
          writer: role(await instance("revision_writer_1")), reviewer: role(await instance("revision_reviewer_1")) }] });
    const originalFeature = f.actor.supportsExecutionFeature, originalRelease = f.actor.getReleaseCapabilities;
    const originalVerifierSupport = f.actor.supportsVerificationProfile, originalVerifier = f.actor.getVerificationCapabilities, originalReleaseSupport = f.actor.supportsReleaseProfile;
    const laterVerifier = (node: string, profile: string, project: string, root: string) => node === f.destination.nodeId
      && profile === "revision-verifier-1" && project === goal!.projectId && root === laterRoot;
    f.actor.supportsVerificationProfile = (node, profile, project, root) => laterVerifier(node, profile, project, root) || originalVerifierSupport?.(node, profile, project, root) === true;
    f.actor.getVerificationCapabilities = (node, profile, project, root) => laterVerifier(node, profile, project, root) ? laterCapabilities : originalVerifier?.(node, profile, project, root);
    f.actor.getVerificationWorkspace = (node, profile, project, root) => f.actor.supportsVerificationProfile?.(node, profile, project, root) ? root : undefined;
    const destinationFeatures = ["imported-design-continuation.v1", "imported-design-review.v1", "imported-execution.v1",
      "imported-execution-review.v1", "imported-validation.v1", "product-release.acceptance.v1"];
    f.actor.supportsExecutionFeature = (node, feature) => feature === PRODUCT_RESEARCH_REVISION_FEATURE_V1 ? node === f.source.nodeId
      : ["run-verification.v1", "product-stage-verification.v1", "product-release.acceptance.v1", "measurement-plan.v2"].includes(feature) && [f.source.nodeId, f.destination.nodeId].includes(node)
      || node === f.destination.nodeId && destinationFeatures.includes(feature) || originalFeature?.(node, feature) === true;
    f.actor.supportsReleaseProfile = (node, profile, project, root, verifier) => node === f.destination.nodeId && profile === "revision-release-1"
      && laterVerifier(node, verifier, project, root) || originalReleaseSupport?.(node, profile, project, root, verifier) === true;
    f.actor.getReleaseCapabilities = (node, profile, project, root, verifier) => node === f.destination.nodeId
      && profile === laterMapping.destination_release.binding.release_profile_id && project === goal!.projectId && root === laterRoot
      && verifier === laterMapping.destination_release.binding.verification_profile_id ? laterMapping.destination_release : originalRelease?.(node, profile, project, root, verifier);
    f.actor.getProductSourceRouting = node => node === f.destination.nodeId ? { version: 1, source_exports: [], destination_mappings: [mapping, laterMapping] }
      : node === f.source.nodeId ? { version: 1, source_exports: [f.sourceRelease!], destination_mappings: [] } : undefined;
    f.actor.getPairedNodeSession = node => {
      const paired = [f.source, f.destination].find(value => value.nodeId === node);
      return paired ? { computerId: node, deviceId: paired.device.id, tokenLookup: parseDeviceToken(paired.node_token)!.lookup, sessionId: `revision-session-${node}` } : undefined;
    };
    const [sourceTask] = await db.select().from(tasks).where(eq(tasks.id, f.base.source.task_id));
    const [sourceRun] = await db.select().from(runs).where(eq(runs.id, f.base.source.run_id));
    const [destinationComputer] = await db.select().from(computers).where(eq(computers.id, f.destination.nodeId));
    const originalAutomation = await f.automation();
    await server.db.transaction(tx => persistResearchDestinationPool(f.actor, tx, { automation: originalAutomation, goal: goal!, plan: plan!, sourceTask: sourceTask!,
      sourceRun: sourceRun!, sourceReviewerRunId: f.base.source.reviewer_run_id, members: snapshot.members, destinationComputer: destinationComputer!, handoffId: f.base.transfer_id }));
    const [storedPool] = await db.select().from(revisionPools).where(eq(revisionPools.goalId, f.base.goal_id));
    expect(storedPool!.snapshot).toEqual(snapshot);
    const parent = await f.ensure(), binding = f.binding(), command = await binding.dispatch(parent.id);
    const result = reviewed(parent, f.researchBytes);
    if (result.outcome !== "reviewed") throw Error("Controlled reviewed result required");
    if (outcome === "changes_requested") result.verdict = { ...result.verdict, outcome,
      summary: "The source research needs a documented failure case", findings: [{ severity: "blocking", description: "Research omits recovery after a failed save" }] };
    await binding.receive({ kind: "product.source.review.result.v1", node_id: f.destination.nodeId, command_id: command.id,
      payload: outcome === "uncertain" ? { version: 1, review_id: parent.id, request_digest: parent.requestDigest,
        outcome: "uncertain", closed: false, execution_authorized: false, reason: "Controlled unclosed reviewer" } : result });
    const admit = async () => { const automation = await f.automation(); return server.db.transaction(tx => ensureGoalResearchRevision(f.actor, tx, automation, parent.id)); };
    return { ...f, parent, snapshot, poolId: storedPool!.id, admit };
  }
  it("retains handoff, imported review and research revision bytes through an injected object store", async () => {
    await server.close();
    const store = new MemoryArtifactStore();
    server = await buildTestServer({ artifactStore: store, workspaceRoot: "/workspace/product", authConfig: { enforceApiAuth: true },
      deviceAuth: testDeviceAuthConfig({ devNodeToken: "dev", devControlEscape: false }) });
    const f = await prepareRevision();
    expect(server.ctx.productSourceArtifactDir).toBeUndefined();
    expect(store.writes).toContain(f.base.source.capsule_digest);
    const before = store.reads.length;
    const revision = await f.admit();
    expect(revision.parentReviewId).toBe(f.parent.id);
    expect(store.reads.length).toBeGreaterThan(before);
    expect(store.reads.every(checksum => checksum === f.base.source.capsule_digest)).toBe(true);
  });

  it("creates one authorized H2 research successor without resetting original plan/history or spending twice", async () => {
    const f = await prepareRevision(), db = server.db.db;
    const [original] = await db.select().from(tasks).where(eq(tasks.id, f.base.source.task_id));
    const [plan] = await db.select().from(plans).where(eq(plans.id, f.base.plan_id));
    const beforeHandoff = await db.select().from(goalProductHandoffs), beforeReview = await db.select().from(goalImportedProductReviews);
    const revision = await f.admit(); expect((await f.admit()).id).toBe(revision.id);
    expect(await db.select().from(tasks).where(eq(tasks.id, original!.id))).toEqual([original]);
    expect(await db.select().from(plans).where(eq(plans.id, plan!.id))).toEqual([plan]);
    expect(await db.select().from(goalProductHandoffs)).toEqual(beforeHandoff); expect(await db.select().from(goalImportedProductReviews)).toEqual(beforeReview);
    expect((await db.select().from(goals).where(eq(goals.id, f.base.goal_id)))[0]!.retryCount).toBe(1);
    const [auxiliary] = await db.select().from(tasks).where(eq(tasks.id, revision.auxiliaryTaskId));
    expect(auxiliary).toMatchObject({ status: "ready", sourcePlanId: null, sourcePlanSpecRef: null,
      parentTaskId: original!.id, executionPolicyTaskId: original!.id, goalId: original!.goalId });
    const origin = await resolveResearchRevisionOrigin(f.actor, db, auxiliary!); expect(origin?.specRef).toBe("0");
    expect(await readCurrentResearchHandoff(f.actor, db, f.base.goal_id, f.base.plan_id, "handoff_design")).toMatchObject({ handoffId: null, revision: { id: revision.id } });
    const context = researchRevisionContext(ResearchRevisionIntentV1Schema.parse(revision.intent), revision.intentDigest, "actual-author-run");
    expect(context).toMatchObject({ author_run_id: "actual-author-run", baseline: { source_run_id: f.base.source.run_id, subject_digest: f.base.source.subject_digest } });
    expect(context).not.toHaveProperty("expected_subject_digest");
    await expect(db.update(researchRevisions).set({ attemptIndex: 2 }).where(eq(researchRevisions.id, revision.id))).rejects.toThrow();
    await expect(db.update(revisionPools).set({ currentRevisionId: null }).where(eq(revisionPools.id, f.poolId))).rejects.toThrow();
    await expect(db.update(revisionSlots).set({ status: "reserved", handoffId: null }).where(eq(revisionSlots.id, "revision_slot_0"))).rejects.toThrow();
    await expect(db.update(goalAutomations).set({ sourceHandoff: { version: 1, mode: "automatic" } }).where(eq(goalAutomations.goalId, f.base.goal_id))).rejects.toThrow();
  });
  it.each(["accepted", "uncertain"] as const)("does not create research repair from an %s H2", async outcome => {
    const f = await prepareRevision(outcome); await expect(f.admit()).rejects.toThrow("closed substantive H2 rejection");
    expect(await server.db.db.select().from(researchRevisions)).toEqual([]);
    expect((await server.db.db.select().from(goals).where(eq(goals.id, f.base.goal_id)))[0]!.retryCount).toBe(0);
  });
  it.each(["feature", "session", "budget"])("keeps source history closed when revision %s is unavailable", async missing => {
    const f = await prepareRevision();
    if (missing === "feature") { const supports = f.actor.supportsExecutionFeature; f.actor.supportsExecutionFeature = (node, feature) => feature !== PRODUCT_RESEARCH_REVISION_FEATURE_V1 && supports?.(node, feature) === true; }
    if (missing === "session") f.actor.getPairedNodeSession = () => undefined;
    if (missing === "budget") await server.db.db.update(goals).set({ retryCount: 1 }).where(eq(goals.id, f.base.goal_id));
    await expect(f.admit()).rejects.toThrow(); expect(await server.db.db.select().from(researchRevisions)).toEqual([]);
    expect((await server.db.db.select().from(tasks).where(eq(tasks.id, f.base.source.task_id)))[0]!.status).toBe("done");
    expect((await server.db.db.select().from(revisionSlots).where(eq(revisionSlots.id, "revision_slot_1")))[0]).toMatchObject({ status: "reserved", handoffId: null, revisionId: null });
  });
  it("cannot retrofit research revision authority onto a legacy goal", async () => {
    const f = await prepareImported(), parent = await f.ensure(), automation = await f.automation();
    await expect(server.db.transaction(tx => ensureGoalResearchRevision(f.actor, tx, automation, parent.id))).rejects.toThrow("original explicit configured-pool grant");
    await expect(server.db.db.update(goalAutomations).set({ sourceHandoff: { version: 1, mode: "automatic", research_revision: { version: 1, strategy: "configured_pool" } } })
      .where(eq(goalAutomations.goalId, f.base.goal_id))).rejects.toThrow();
    expect(await server.db.db.select().from(researchRevisions)).toEqual([]);
  });
  it("research revision reservations reject another goal, another handoff, overlapping scopes and ancestor restart", async () => {
    const f = await prepareRevision();
    await expect(server.db.transaction(tx => assertResearchHandoffDestinationOwner(f.actor, tx, f.intent))).resolves.toBeUndefined();
    for (const change of ["goal", "handoff", "child", "unused"]) {
      const intent = structuredClone(f.intent), base = intent.request.byte_request;
      if (change === "goal") base.goal_id = "other-goal";
      if (change === "handoff") base.transfer_id = "other-handoff";
      if (change === "child") base.destination.workspace_root += "/child";
      if (change === "unused") base.destination.workspace_root = f.snapshot.members[1]!.mapping.destination_release.binding.workspace_root;
      await expect(server.db.transaction(tx => assertResearchHandoffDestinationOwner(f.actor, tx, intent))).rejects.toThrow("retained research reservation");
    }
    await f.admit();
    await expect(server.db.transaction(tx => assertResearchHandoffDestinationOwner(f.actor, tx, f.intent))).rejects.toThrow("awaiting its exact accepted source");
    expect(await server.db.db.select().from(goalProductHandoffs)).toHaveLength(1);
  });
  it("research revision assignment rechecks the frozen writer after admission", async () => {
    const f = await prepareRevision(), revision = await f.admit(), db = server.db.db;
    const before = await db.select().from(runs), requirement = VerificationRequirementSchema.parse({
      ...f.review.source.run.verificationRequirement as object, request_id: "revision-author-verification" });
    await db.update(agentInstances).set({ runtime: "claude" }).where(eq(agentInstances.id, f.snapshot.source.writer.instance_id));
    await expect(assignTask(f.actor, revision.auxiliaryTaskId, { mode: "manual", agent_instance_id: f.snapshot.source.writer.instance_id }, undefined, requirement))
      .rejects.toThrow("original source contributor");
    expect(await db.select().from(runs)).toEqual(before);
    expect((await db.select().from(tasks).where(eq(tasks.id, revision.auxiliaryTaskId)))[0]!.status).toBe("ready");
  });
  it("research revision GoalRunner independently accepts a revised source, imports a fresh slot, and starts H3 exactly once", async () => {
    const f = await prepareRevision(); await prepareDispatcher(f);
    const errors: unknown[] = [], queued: string[] = [];
    f.actor.onRunQueued = async id => { queued.push(id); };
    const dispatcher = createGoalAutomationDispatcher(f.actor, async () => {}, error => { errors.push(error); });
    try {
      await dispatcher.pump();
      expect(errors).toEqual([]);
      const [revision] = await server.db.db.select().from(researchRevisions);
      expect(revision).toBeDefined(); expect(revision!.parentReviewId).toBe(f.parent.id);
      await dispatcher.pump();
      expect(errors).toEqual([]);
      const authorRuns = await server.db.db.select().from(runs).where(eq(runs.taskId, revision!.auxiliaryTaskId));
      expect(authorRuns).toHaveLength(1);
      const author = authorRuns[0]!;
      expect(author).toMatchObject({ status: "queued", computerId: f.source.nodeId, agentInstanceId: f.snapshot.source.writer.instance_id,
        workspaceRoot: f.base.source.workspace_root });
      expect(author.verificationRequirement).not.toHaveProperty("expected_subject_digest");
      const [context] = await server.db.db.select().from(contextPacks).where(eq(contextPacks.id, author.contextPackId!));
      expect(context!.payload).toMatchObject({ goal_context: { plan: { id: f.base.plan_id, spec_ref: "0" } },
        product_research_revision: { revision_id: revision!.id, author_run_id: author.id, baseline: { source_run_id: f.base.source.run_id } } });
      expect((context!.payload as { task: { description: string } }).task.description).toContain("Research omits recovery after a failed save");
      expect(queued).toContain(author.id);
      await dispatcher.pump();
      expect(await server.db.db.select().from(researchRevisions)).toHaveLength(1);
      expect(await server.db.db.select().from(runs).where(eq(runs.taskId, revision!.auxiliaryTaskId))).toHaveLength(1);
      expect((await server.db.db.select().from(tasks).where(eq(tasks.id, f.base.source.task_id)))[0]!.status).toBe("done");
      // Controlled owning-node evidence for a new subject, carried through the
      // actual wire ingest and independent-review services (no model process).
      const report = structuredClone(f.researchReport);
      report.findings[0]!.summary += "; recovery after a failed save has been added to the research";
      const researchBytes = Buffer.from(JSON.stringify(report)), researchPin = { path: ".artoo/product/research.json" as const, checksum: sha(researchBytes), size: researchBytes.length };
      const subject = sha("controlled revised research subject"), requirement = VerificationRequirementSchema.parse(author.verificationRequirement);
      const measurement = structuredClone(f.review.source.evidence.payload);
      measurement.request_id = requirement.request_id; measurement.subject_digest = subject; measurement.required_files = [researchPin];
      measurement.measurement_plan!.research = researchPin;
      const capsule = JSON.parse(f.bytes.toString("utf8")); capsule.source.subject_digest = subject;
      capsule.manifest.entries = capsule.manifest.entries.map((entry: { path: string }) => entry.path === researchPin.path ? { ...researchPin, kind: "file" } : entry);
      capsule.manifest_digest = sha(JSON.stringify(capsule.manifest)); capsule.files = [{ path: researchPin.path, base64: researchBytes.toString("base64") }];
      const bytes = Buffer.from(JSON.stringify(capsule)), capsuleDigest = sha(bytes);
      const provenance = { ...structuredClone(f.proof.research_provenance), research: researchPin };
      const proof = ProductSourceExportV2Schema.parse({ ...f.proof, byte_export: { ...f.proof.byte_export,
        export_id: hash({ run_id: author.id, request_id: requirement.request_id, capsule_digest: capsuleDigest }),
        run_id: author.id, task_id: author.taskId, verification_request_id: requirement.request_id,
        subject_digest: subject, context_digest: hash(context!.payload), verification_digest: hash(measurement),
        capsule_digest: capsuleDigest, manifest_digest: capsule.manifest_digest, capsule_bytes: bytes.length },
        research_provenance: provenance, research_provenance_digest: hash(provenance) });
      const wire = (run: typeof author, sequence: number, type: string, payload: unknown) => ingestWireRunEvent(f.actor,
        { kind: "run.event", node_id: run.computerId, run_id: run.id, sequence, event: { type, payload } });
      await wire(author, 0, "run.lifecycle", { phase: "started" });
      await wire(author, 1, "run.verification", measurement);
      await wire(author, 2, "run.product-source.export.v2", proof);
      await wire(author, 3, "run.lifecycle", { phase: "completed" });
      await dispatcher.pump(); expect(errors).toEqual([]);
      const [peer] = await server.db.db.select().from(autonomousReviews).where(eq(autonomousReviews.subjectRunId, author.id));
      expect(peer).toMatchObject({ status: "pending", reviewerInstanceId: f.snapshot.source.reviewer.instance_id });
      const assistants = createAssistantDispatcher(f.actor, error => { errors.push(error); });
      try { await assistants.pump(); } finally { await assistants.stop(); }
      const [peerRun] = await server.db.db.select().from(runs).where(eq(runs.taskId, peer!.reviewTaskId));
      expect(peerRun).toBeDefined(); expect(errors).toEqual([]);
      const peerRequirement = VerificationRequirementSchema.parse(peerRun!.verificationRequirement);
      await wire(peerRun!, 0, "run.lifecycle", { phase: "started" });
      await wire(peerRun!, 1, "run.verification", { ...measurement, request_id: peerRequirement.request_id });
      await wire(peerRun!, 2, "run.answer", { text: JSON.stringify({ version: 1, reviewed_run_id: author.id, verification_evidence_id: peer!.evidenceId,
        subject_digest: subject, outcome: "accepted", summary: "Controlled independent review accepted the revised research", findings: [] }) });
      await wire(peerRun!, 3, "run.lifecycle", { phase: "completed" });
      const peerSettlement = createAssistantDispatcher(f.actor, error => { errors.push(error); });
      try { await peerSettlement.pump(); } finally { await peerSettlement.stop(); }
      await dispatcher.pump(); expect(errors).toEqual([]);
      expect((await server.db.db.select().from(tasks).where(eq(tasks.id, author.taskId)))[0]!.status).toBe("done");
      f.actor.onProductSourceOperationQueued = async () => {};
      await dispatcher.pump(); expect(errors).toEqual([]);
      const handoffs = await server.db.db.select().from(goalProductHandoffs);
      expect(handoffs).toHaveLength(2);
      const successor = handoffs.find(value => value.id !== f.base.transfer_id)!;
      const successorIntent = ProductSourceHandoffIntentV1Schema.parse(successor.intent);
      expect(successorIntent.request.byte_request).toMatchObject({ source: { task_id: author.taskId, run_id: author.id, subject_digest: subject },
        destination: { workspace_root: f.snapshot.members[1]!.mapping.destination_release.binding.workspace_root } });
      expect(successorIntent.destination_start.context_pack.payload).not.toHaveProperty("product_research_revision");
      // The HTTP content route reads the same controlled current-node registry
      // as the orchestration service; it still authenticates the actual paired token.
      for (const key of ["supportsExecutionFeature", "supportsVerificationProfile", "supportsReleaseProfile", "getVerificationCapabilities",
        "getReleaseCapabilities", "getVerificationWorkspace", "getProductSourceRouting", "getPairedNodeSession"] as const)
        Object.assign(server.ctx, { [key]: f.actor[key] });
      const sourceOps = await f.ops(), uploadOp = sourceOps.find(value => value.handoffId === successor.id && value.kind === "upload")!,
        importOp = sourceOps.find(value => value.handoffId === successor.id && value.kind === "import_verify")!;
      const handoffBinding = (node: typeof f.source) => createGoalProductHandoffBinding(f.actor, {
        identity: { computerId: node.nodeId, deviceId: node.device.id, tokenLookup: parseDeviceToken(node.node_token)!.lookup },
        sessionId: f.actor.getPairedNodeSession!(node.nodeId)!.sessionId, isCurrent: () => true, artifactDir: directory, transport: { send: async () => {} },
      });
      const uploadBinding = handoffBinding(f.source), uploadCommand = await uploadBinding.dispatch(uploadOp.id),
        successorDigest = productSourceTransferRequestDigestV2(successorIntent.request, sha);
      const uploaded = await server.app.inject({ method: "PUT", url: `/api/v1/node/product-source-transfers-v2/${successor.id}/content`, payload: bytes,
        headers: { authorization: `Bearer ${f.source.node_token}`, "content-type": "application/octet-stream",
          "x-artoo-transfer-request-digest": successorDigest, "x-artoo-checksum": capsuleDigest } });
      expect(uploaded.statusCode, uploaded.body).toBe(200);
      await uploadBinding.receive({ kind: "product.source.operation.result.v1", node_id: f.source.nodeId, command_id: uploadCommand.id,
        payload: { version: 1, operation_id: uploadOp.id, payload_digest: uploadOp.payloadDigest, request_digest: successorDigest,
          outcome: "uploaded", closed: true, receipt: uploaded.json().transfer } });
      const importBinding = handoffBinding(f.destination), importCommand = await importBinding.dispatch(importOp.id);
      await importBinding.receive({ kind: "product.source.operation.result.v1", node_id: f.destination.nodeId, command_id: importCommand.id,
        payload: controlledDestinationResult(ProductSourceOperationV1Schema.parse(importOp.payload), researchBytes) });
      await importBinding.qualify(importOp.id);
      await dispatcher.pump(); expect(errors).toEqual([]);
      const [nextH2] = await server.db.db.select().from(goalImportedProductReviews).where(eq(goalImportedProductReviews.handoffId, successor.id));
      expect(nextH2).toMatchObject({ reviewerInstanceId: f.snapshot.members[1]!.reviewer.instance_id, sourceRunId: author.id });
      const reviewBinding = createGoalImportedProductReviewBinding(f.actor, {
        identity: { computerId: f.destination.nodeId, deviceId: f.destination.device.id, tokenLookup: parseDeviceToken(f.destination.node_token)!.lookup },
        sessionId: f.actor.getPairedNodeSession!(f.destination.nodeId)!.sessionId, isCurrent: () => true, artifactDir: directory, transport: { send: async () => {} },
      });
      const reviewCommand = await reviewBinding.dispatch(nextH2!.id);
      await reviewBinding.receive({ kind: "product.source.review.result.v1", node_id: f.destination.nodeId, command_id: reviewCommand.id,
        payload: reviewed(nextH2!, researchBytes) });
      const designQueued: string[] = [];
      f.actor.onImportedDesignContinuationQueued = async id => { designQueued.push(id); };
      await dispatcher.pump(); expect(errors).toEqual([]);
      const continuations = await server.db.db.select().from(goalImportedDesignContinuations);
      expect(continuations).toHaveLength(1);
      expect(continuations[0]).toMatchObject({ reviewId: nextH2!.id, writerInstanceId: f.snapshot.members[1]!.writer.instance_id,
        workspaceRoot: f.snapshot.members[1]!.mapping.destination_release.binding.workspace_root });
      expect(designQueued).toContain(continuations[0]!.id);
      await dispatcher.pump(); expect(errors).toEqual([]);
      expect(await server.db.db.select().from(goalImportedDesignContinuations)).toHaveLength(1);
      expect((await server.db.db.select().from(goals).where(eq(goals.id, f.base.goal_id)))[0]!.retryCount).toBe(1);
      expect((await server.db.db.select().from(goalImportedProductReviews).where(eq(goalImportedProductReviews.id, f.parent.id)))[0]!.result)
        .toMatchObject({ outcome: "reviewed", verdict: { outcome: "changes_requested" } });
    } finally { await dispatcher.stop(); }
  });
  async function ordinaryTask(id: string) {
    const now = server.ctx.clock.nowIso();
    await server.db.db.insert(tasks).values({ id, organizationId: server.ctx.organizationId, projectId: "proj_artoo", title: id,
      status: "ready", createdByType: "user", createdById: server.ctx.actorUserId, createdAt: now, updatedAt: now });
    return (instance: string) => assignTask({ ...server.ctx, onRunQueued: async () => {} }, id, { mode: "manual", agent_instance_id: instance });
  }
  async function otherInstance(computerId: string, id = "other_instance", workspaceRoot = "/unrelated/workspace") {
    const [source] = await server.db.db.select().from(agentInstances).where(eq(agentInstances.id, "instance_mock_coder"));
    await server.db.db.insert(agentInstances).values({ ...source!, id, computerId, runtime: "codex", status: "idle", workspaceRoot });
    return id;
  }
  async function prepareDispatcher(f: Pick<Awaited<ReturnType<typeof prepareHandoff>>, "base">) {
    const now = server.ctx.clock.nowIso();
    await server.db.db.insert(discussions).values({ id: "controlled_planning", organizationId: server.ctx.organizationId, goalId: f.base.goal_id,
      roomId: "measurement_room", threadRootId: "measurement_request", taskId: f.base.source.task_id, actorUserId: server.ctx.actorUserId,
      participants: [{ agent_instance_id: "instance_mock_coder", role: "Controlled planner" }, { agent_instance_id: "review_instance", role: "Controlled planning reviewer" }],
      rounds: 1, maxMinutes: 2, status: "ready", createdAt: now, updatedAt: now, deadlineAt: now });
    await server.db.db.update(goalAutomations).set({ discussionId: "controlled_planning" }).where(eq(goalAutomations.goalId, f.base.goal_id));
  }
  it.each([false, true])("blocks ordinary same-instance and overlapping workspace assignment during H2, uncertain=%s", async uncertain => {
    const f = await prepareImported(), row = await f.ensure(), binding = f.binding(), command = await binding.dispatch(row.id);
    if (uncertain) await binding.receive({ kind: "product.source.review.result.v1", node_id: f.destination.nodeId, command_id: command.id,
      payload: { version: 1, review_id: row.id, request_digest: row.requestDigest, outcome: "uncertain", closed: false,
        execution_authorized: false, reason: "Controlled reviewer closure remains unknown" } });
    const assign = await ordinaryTask("ordinary_same_reviewer");
    await expect(assign(row.reviewerInstanceId)).rejects.toThrow("no eligible");
    // Even spare instance capacity cannot authorize concurrent access to this exact imported workspace.
    await server.db.db.update(agentInstances).set({ config: { concurrency_limit: 3 } }).where(eq(agentInstances.id, row.reviewerInstanceId));
    await expect(assign(row.reviewerInstanceId)).rejects.toThrow("source operation");
    const neighbor = await otherInstance(f.destination.nodeId, "neighbor_instance", `${f.base.destination.workspace_root}/child`);
    await expect((await ordinaryTask("ordinary_overlap"))(neighbor)).rejects.toThrow("source operation");
    const independent = await otherInstance(f.other.nodeId);
    const started = await (await ordinaryTask("ordinary_unrelated"))(independent);
    expect(started.run.computer_id).toBe(f.other.nodeId);
    expect((await unsettledStandaloneExecutions(f.actor, server.db.db, { goalId: f.base.goal_id })).map(v => ({ kind: v.kind, id: v.id })))
      .toEqual([{ kind: "review", id: row.id }]);
    expect(await unsettledGoalExecutionCount(f.actor, server.db.db, f.base.goal_id)).toBe(1);
  });
  it.each([false, true])("counts a started H1 upload for reverse ordinary capacity and closure, uncertain=%s", async uncertain => {
    const f = await prepareHandoff(); await ensureGoalProductHandoff(f.actor, f.intent);
    const operation = (await f.ops()).find(v => v.kind === "upload")!, binding = f.binding(f.source.nodeId), command = await binding.dispatch(operation.id);
    if (uncertain) await binding.receive({ kind: "product.source.operation.result.v1", node_id: f.source.nodeId, command_id: command.id,
      payload: { version: 1, operation_id: operation.id, payload_digest: operation.payloadDigest, request_digest: f.digest,
        outcome: "uncertain", closed: false, reason: "Controlled upload closure remains unknown" } });
    const assign = await ordinaryTask("ordinary_same_source");
    await expect(assign(f.review.source.run.agentInstanceId)).rejects.toThrow("no eligible");
    await server.db.db.update(agentInstances).set({ config: { concurrency_limit: 3 } }).where(eq(agentInstances.id, f.review.source.run.agentInstanceId));
    await expect(assign(f.review.source.run.agentInstanceId)).rejects.toThrow("source operation");
    expect(await unsettledGoalExecutionCount(f.actor, server.db.db, f.base.goal_id)).toBe(1);
    const standalone = await unsettledStandaloneExecutions(f.actor, server.db.db, { goalId: f.base.goal_id });
    expect(standalone.map(v => ({ kind: v.kind, id: v.id }))).toEqual([{ kind: "handoff", id: operation.id }]);
  });
  it("includes H2 in the same goal budget even when the requested stage uses a different instance and computer", async () => {
    const f = await prepareImported(), row = await f.ensure(); await f.binding().dispatch(row.id);
    const independent = await otherInstance(f.other.nodeId), automation = await f.automation();
    const team = automation.team as { members: { stage: string; agent_instance_id: string }[] };
    await server.db.db.update(goalAutomations).set({ team: { ...team, members: team.members.map(v => v.stage === "design" ? { ...v, agent_instance_id: independent } : v) } }).where(eq(goalAutomations.goalId, f.base.goal_id));
    await server.db.db.update(goals).set({ budgets: { max_concurrent_runs: 1 } }).where(eq(goals.id, f.base.goal_id));
    await expect(assignTask(f.actor, "handoff_design", { mode: "manual", agent_instance_id: independent }, undefined,
      { version: 1, profile_id: "default", request_id: "ordinary_attempt" })).rejects.toThrow("concurrent run limit");
  });
  it("fences plan replacement and cancellation until the dedicated review closes", async () => {
    const f = await prepareImported(), row = await f.ensure(), binding = f.binding(), command = await binding.dispatch(row.id);
    await expect(cancelGoal(f.actor, f.base.goal_id)).rejects.toThrow("stop is still unconfirmed");
    expect(f.queued).toContainEqual({ id: row.id, control: "stop" });
    expect((await server.db.db.select().from(goals).where(eq(goals.id, f.base.goal_id)))[0]!.status).toBe("paused");
    const [oldPlan] = await server.db.db.select().from(plans).where(eq(plans.id, f.base.plan_id));
    await server.db.db.insert(plans).values({ ...oldPlan!, id: "replacement_plan", version: 2, status: "proposed", acceptedAt: null });
    await server.db.db.update(goalAutomations).set({ planId: "replacement_plan", executionMode: "single_agent" }).where(eq(goalAutomations.goalId, f.base.goal_id));
    await expect(acceptPlan(f.actor, "replacement_plan")).rejects.toThrow("all goal executions");
    await binding.receive({ kind: "product.source.review.result.v1", node_id: f.destination.nodeId, command_id: command.id,
      payload: { version: 1, review_id: row.id, request_digest: row.requestDigest, outcome: "failed", closed: true,
        execution_authorized: false, reason: "Controlled node confirmed all processes and tools closed" } });
    expect(await unsettledGoalExecutionCount(f.actor, server.db.db, f.base.goal_id)).toBe(0);
    expect((await cancelGoal(f.actor, f.base.goal_id))!.status).toBe("cancelled");
  });
  it("keeps task aggregation and product release fenced even when every plan task is marked done", async () => {
    const f = await prepareImported(), row = await f.ensure(), binding = f.binding(), command = await binding.dispatch(row.id);
    await server.db.db.update(tasks).set({ status: "done" }).where(eq(tasks.goalId, f.base.goal_id));
    await server.db.db.update(tasks).set({ status: "review" }).where(eq(tasks.id, f.base.source.task_id));
    await reviewTask(f.actor, f.base.source.task_id, { outcome: "accepted", comment: "Controlled re-acceptance tests the aggregate completion gate" });
    expect((await server.db.db.select().from(goals).where(eq(goals.id, f.base.goal_id)))[0]!.status).toBe("running");
    const automation = await f.automation();
    await expect(server.db.transaction(tx => ensureGoalProductRelease(f.actor, tx, { ...automation, releaseProfileId: "controlled-release" })))
      .rejects.toThrow("process exits");
    await binding.receive({ kind: "product.source.review.result.v1", node_id: f.destination.nodeId, command_id: command.id,
      payload: { version: 1, review_id: row.id, request_digest: row.requestDigest, outcome: "failed", closed: true,
        execution_authorized: false, reason: "Controlled complete closure releases the aggregate fence" } });
    await server.db.db.update(tasks).set({ status: "review" }).where(eq(tasks.id, f.base.source.task_id));
    await reviewTask(f.actor, f.base.source.task_id, { outcome: "accepted", comment: "Controlled re-acceptance after closure" });
    expect((await server.db.db.select().from(goals).where(eq(goals.id, f.base.goal_id)))[0]!.status).toBe("completed");
  });
  it("drives existing H1 in committed GoalRunner steps, then stops an unsettled import on pause", async () => {
    const f = await prepareHandoff(); await ensureGoalProductHandoff(f.actor, f.intent); await prepareDispatcher(f);
    const queued: { id: string; control: string; automationStatus: string }[] = [], errors: unknown[] = [];
    f.actor.onProductSourceOperationQueued = async (id, control) => {
      const [automation] = await server.db.db.select().from(goalAutomations).where(eq(goalAutomations.goalId, f.base.goal_id));
      queued.push({ id, control, automationStatus: automation!.status });
      if (control === "qualify") await f.binding(f.destination.nodeId).qualify(id);
      else await f.binding((await f.ops()).find(v => v.id === id)!.computerId).dispatch(id, control);
    };
    const dispatcher = createGoalAutomationDispatcher(f.actor, async () => {}, e => { errors.push(e); });
    await dispatcher.pump();
    const upload = (await f.ops()).find(v => v.kind === "upload")!;
    expect(queued).toEqual([{ id: upload.id, control: "start", automationStatus: "waiting" }]); expect(errors).toEqual([]);
    const response = await f.upload(), command = f.sent.find(v => "type" in v && v.type === "product.source.operation.v1")!;
    if (!("id" in command)) throw Error("Controlled H1 command required");
    await f.binding(f.source.nodeId).receive({ kind: "product.source.operation.result.v1", node_id: f.source.nodeId, command_id: command.id,
      payload: { version: 1, operation_id: upload.id, payload_digest: upload.payloadDigest, request_digest: f.digest, outcome: "uploaded", closed: true, receipt: response.json().transfer } });
    await dispatcher.pump();
    const imported = (await f.ops()).find(v => v.kind === "import_verify")!;
    expect(queued.at(-1)).toEqual({ id: imported.id, control: "start", automationStatus: "waiting" }); expect(errors).toEqual([]);
    await server.db.db.update(goals).set({ status: "paused" }).where(eq(goals.id, f.base.goal_id));
    await dispatcher.pump(); await dispatcher.stop();
    expect(queued.at(-1)).toEqual({ id: imported.id, control: "stop", automationStatus: "waiting" });
    expect(f.sent.at(-1)).toMatchObject({ type: "product.source.operation.stop.v1", payload: { operation_id: imported.id, request_digest: f.digest } });
    expect(errors).toEqual([]); expect((await server.db.db.select().from(goalProductHandoffs))[0]!.stopRequested).toBe(true);
    expect(await unsettledGoalExecutionCount(f.actor, server.db.db, f.base.goal_id)).toBe(1);
  });
  it("uses the actual paired NodeBinding path for queued H2 dispatch and serialized result receipt", async () => {
    const f = await prepareImported(), row = await f.ensure(), sent: ServerToNodeMessage[] = [];
    let current = true;
    const binding = attachNodeBinding(f.actor, { async send(frame) { sent.push(frame); }, subscribe() { return () => {}; }, async close() {} },
      f.destination.nodeId, [IMPORTED_PRODUCT_REVIEW_FEATURE_V1], () => current, [], [], [], undefined, "windows", {
        identity: { computerId: f.destination.nodeId, deviceId: f.destination.device.id, tokenLookup: parseDeviceToken(f.destination.node_token)!.lookup },
        sessionId: "actual-paired-binding", artifactDir: directory,
      });
    server.nodeRegistry.register(f.destination.nodeId, binding);
    try {
      await server.ctx.onImportedProductReviewQueued!(row.id, "start");
      const command = sent[0]!;
      if (!("id" in command)) throw Error("Expected H2 command");
      expect(command).toMatchObject({ type: "product.source.review.v1", payload: { review_id: row.id } });
      binding.receive({ kind: "product.source.review.ack.v1", node_id: f.destination.nodeId, command_id: command.id, status: "accepted",
        payload: { version: 1, review_id: row.id, request_digest: row.requestDigest } });
      await binding.drain(); expect((await server.db.db.select().from(goalImportedProductReviews))[0]!.result).toBeNull();
      binding.receive({ kind: "product.source.review.result.v1", node_id: f.destination.nodeId, command_id: command.id, payload: reviewed(row, f.researchBytes) });
      await binding.drain(); expect((await server.db.db.select().from(goalImportedProductReviews))[0]!.result).toMatchObject({ outcome: "reviewed", execution_authorized: false });
      current = false; await expect(binding.dispatchImportedProductReview!(row.id, "status")).rejects.toThrow("no longer current");
    } finally { binding.close(); }
  });
  it("queues the imported-review stop after a GoalRunner pause without minting an ordinary run", async () => {
    const f = await prepareImported(), row = await f.ensure(), beforeRuns = await server.db.db.select().from(runs);
    await f.binding().dispatch(row.id); await prepareDispatcher(f);
    await server.db.db.update(goals).set({ status: "paused" }).where(eq(goals.id, f.base.goal_id));
    const errors: unknown[] = [], dispatcher = createGoalAutomationDispatcher(f.actor, async () => {}, e => { errors.push(e); });
    await dispatcher.pump(); await dispatcher.stop();
    expect(errors).toEqual([]); expect(f.queued).toEqual([{ id: row.id, control: "stop" }]);
    expect((await server.db.db.select().from(goalImportedProductReviews))[0]!.stopRequested).toBe(true);
    expect(await server.db.db.select().from(runs)).toEqual(beforeRuns);
  });
  it("builds a distinct immutable imported review, keeps ACK separate, and never releases ordinary design write authority", async () => {
    const f = await prepareImported(), beforeRuns = await server.db.db.select().from(runs), beforeReviews = await server.db.db.select().from(autonomousReviews);
    const row = await f.ensure(); expect((await f.ensure()).id).toBe(row.id);
    const request = ImportedProductReviewRequestV1Schema.parse(row.request);
    expect(request.source_author).toEqual({ instance_id: f.review.source.run.agentInstanceId, agent_id: "agent_mock_coder" });
    expect(request.reviewer).toEqual({ instance_id: "imported_reviewer_instance", agent_id: "imported_reviewer_agent" });
    expect(request.review_start.context_pack.payload!.goal_context).toMatchObject({ goal_id: f.base.goal_id, plan: { id: f.base.plan_id } });
    expect(request.review_start.context_pack.payload!.policy).toMatchObject({ execution_mode: "discussion", filesystem_write_scope: [] });
    expect(request.review_start.policy_snapshot.filesystem_write_scope).toEqual([]);
    expect(request.review_start.context_pack.payload!.review_subject).toBeUndefined();
    if(request.result.outcome!=="verified")throw Error("Expected controlled transfer");
    const subject=request.review_start.context_pack.payload!.imported_review_subject!;
    expect(subject.measurement_mapping).toEqual(request.result.admission.mapping);
    expect(hash(subject.measurement_mapping)).toBe(subject.mapping_digest);
    expect(subject.measurement_mapping!.source_profile_digest).not.toBe(subject.measurement_mapping!.destination_profile_digest);
    expect(subject.measurement_mapping!.release).toBeDefined();
    expect(request.review_start.context_pack.payload!.task.description).toContain("keeps its original source-computer measurement plan");
    expect(request.review_start.context_pack.payload!.task.description).toContain("does not resolve a substantive defect or require an accepted verdict");
    expect(await server.db.db.select().from(runs)).toEqual(beforeRuns); expect(await server.db.db.select().from(autonomousReviews)).toEqual(beforeReviews);
    const binding = f.binding(), command = await binding.dispatch(row.id); expect(await binding.dispatch(row.id)).toEqual(command);
    await binding.acknowledge({ kind: "product.source.review.ack.v1", node_id: f.destination.nodeId, command_id: command.id, status: "accepted",
      payload: { version: 1, review_id: row.id, request_digest: row.requestDigest } });
    expect((await server.db.db.select().from(goalImportedProductReviews))[0]!.result).toBeNull();
    const result = reviewed(row, f.researchBytes);
    await expect(binding.receive({ kind: "product.source.review.result.v1", node_id: f.destination.nodeId, command_id: "unissued", payload: result })).rejects.toThrow("issued command");
    await binding.receive({ kind: "product.source.review.result.v1", node_id: f.destination.nodeId, command_id: command.id, payload: result });
    await binding.receive({ kind: "product.source.review.result.v1", node_id: f.destination.nodeId, command_id: command.id, payload: structuredClone(result) });
    expect(await binding.inspect(row.id)).toMatchObject({ state: "accepted_waiting_writer_authority", execution_authorized: false, design_write_authorized: false });
    const automation = await f.automation();
    expect(await server.db.transaction(tx => advanceGoalImportedProductReview(f.actor, tx, automation, "handoff_design"))).toMatchObject({ state: "accepted_waiting_writer_authority", design_write_authorized: false });
    expect((await server.db.db.select().from(tasks).where(eq(tasks.id, "handoff_design")))[0]!.status).toBe("ready");
    expect(await server.db.db.select().from(runs)).toEqual(beforeRuns);
    await expect(binding.dispatch(row.id)).rejects.toThrow("Settled");
  });
  it.each(["pause", "next-task", "allowed-runtime", "elapsed", "same-agent", "feature", "session", "expired-token", "goal-context", "plan-context"])("rechecks %s immediately before dispatch", async change => {
    const f = await prepareImported(), row = await f.ensure(), binding = f.binding();
    if (change === "pause") await server.db.db.update(goals).set({ status: "paused" }).where(eq(goals.id, f.base.goal_id));
    if (change === "next-task") await server.db.db.update(tasks).set({ status: "cancelled" }).where(eq(tasks.id, "handoff_design"));
    if (change === "allowed-runtime") await server.db.db.update(goals).set({ budgets: { allowed_runtimes: ["claude"] } }).where(eq(goals.id, f.base.goal_id));
    if (change === "elapsed") await server.db.db.update(goals).set({ budgets: { max_elapsed_ms: 1 }, runningSince: "2000-01-01T00:00:00Z" }).where(eq(goals.id, f.base.goal_id));
    if (change === "same-agent") await server.db.db.update(agentInstances).set({ agentId: row.sourceAgentId }).where(eq(agentInstances.id, row.reviewerInstanceId));
    if (change === "feature") { const support = f.actor.supportsExecutionFeature; f.actor.supportsExecutionFeature = (node, feature) => feature !== IMPORTED_PRODUCT_REVIEW_FEATURE_V1 && support?.(node, feature) === true; }
    if (change === "session") f.expireSession();
    if (change === "expired-token") await server.db.db.update(deviceTokens).set({ expiresAt: "2000-01-01T00:00:00Z" }).where(eq(deviceTokens.tokenLookup, parseDeviceToken(f.destination.node_token)!.lookup));
    if (change === "goal-context") await server.db.db.update(goals).set({ objective: "Changed actual goal objective" }).where(eq(goals.id, f.base.goal_id));
    if (change === "plan-context") await server.db.db.update(plans).set({ rationale: "Changed actual accepted plan" }).where(eq(plans.id, f.base.plan_id));
    await expect(binding.dispatch(row.id)).rejects.toThrow(); expect(f.sent).toEqual([]);
    expect((await server.db.db.select().from(goalImportedProductReviews))[0]!.request).toEqual(row.request);
  });
  it("requires the initiating user and a current independent reviewer before creating any review", async () => {
    const f = await prepareImported(), automation = await f.automation();
    await expect(server.db.transaction(tx => ensureGoalImportedProductReview({ ...f.actor, actorUserId: "different-user" }, tx, automation, f.base.transfer_id))).rejects.toThrow("original user's");
    await server.db.db.update(agentInstances).set({ agentId: "agent_mock_coder" }).where(eq(agentInstances.id, "imported_reviewer_instance"));
    // Rebinding to the original source agent also removes the only destination review-capable candidate.
    await expect(f.ensure()).rejects.toThrow("no eligible idle agent instance"); expect(await server.db.db.select().from(goalImportedProductReviews)).toEqual([]);
  });
  it("records stop-before-start only through its own durable cancellation command", async () => {
    const f = await prepareImported(), row = await f.ensure(), binding = f.binding();
    await expect(binding.dispatch(row.id, "stop")).rejects.toThrow("Persist review stop");
    await stopGoalImportedProductReviews(f.actor, f.base.goal_id); expect(f.queued).toEqual([{ id: row.id, control: "stop" }]);
    const command = await binding.dispatch(row.id, "stop");
    await binding.receive({ kind: "product.source.review.result.v1", node_id: f.destination.nodeId, command_id: command.id,
      payload: { version: 1, review_id: row.id, request_digest: row.requestDigest, outcome: "cancelled_before_start", closed: true, execution_authorized: false, reason: "Controlled node cancellation tombstone" } });
    const saved = (await server.db.db.select().from(goalImportedProductReviews))[0]!;
    expect(importedProductReviewView(saved)).toMatchObject({ state: "stopped_or_fenced", closed: true, design_write_authorized: false });
    await expect(binding.dispatch(row.id)).rejects.toThrow(); expect(f.sent.filter(frame => "type" in frame && frame.type === "product.source.review.v1")).toEqual([]);
  });
  it("keeps uncertain closure fenced and rereads it after a controlled admission interleaving", async () => {
    const f = await prepareImported(), row = await f.ensure(), original = semanticTransfers.admitProductSourceSemanticTransferInTransaction;
    let admissions = 0;
    vi.spyOn(semanticTransfers, "admitProductSourceSemanticTransferInTransaction").mockImplementation(async (...args) => {
      const value = await original(...args);
      // PGlite serializes its single connection. Inject via this transaction to exercise the final reread;
      // using the outer connection here would deadlock behind the very transaction awaiting this hook.
      if (++admissions === 2) await args[1].update(goalImportedProductReviews).set({ result: {
        version: 1, review_id: row.id, request_digest: row.requestDigest, outcome: "uncertain", closed: false, execution_authorized: false, reason: "Controlled result arrival while admission yields" },
      }).where(eq(goalImportedProductReviews.id, row.id));
      return value;
    });
    await expect(f.binding().dispatch(row.id)).rejects.toThrow("Settled"); expect(f.sent).toEqual([]);
    // The rejected transaction rolls back the injection. This checks the reread, not PostgreSQL contention.
    expect(await server.db.db.select().from(goalImportedProductReviewDeliveries)).toHaveLength(1);
  });
  it("rejects a substituted before/after verifier or accepted verdict without storing an authoritative result", async () => {
    const f = await prepareImported(), row = await f.ensure(), binding = f.binding(), command = await binding.dispatch(row.id), result = reviewed(row, f.researchBytes);
    if (result.outcome !== "reviewed") throw Error("Controlled result must be reviewed");
    const changed = structuredClone(result); changed.after.fresh.destination_run_id = changed.before.fresh.destination_run_id;
    await expect(binding.receive({ kind: "product.source.review.result.v1", node_id: f.destination.nodeId, command_id: command.id, payload: changed })).rejects.toThrow();
    expect((await server.db.db.select().from(goalImportedProductReviews))[0]!.result).toBeNull();
    const mismatched = structuredClone(result); mismatched.verdict.source_export_digest = sha("substituted");
    await expect(binding.receive({ kind: "product.source.review.result.v1", node_id: f.destination.nodeId, command_id: command.id, payload: mismatched })).rejects.toThrow();
    expect((await server.db.db.select().from(goalImportedProductReviews))[0]!.result).toBeNull();
  });
  it("rechecks token expiry after awaited capsule I/O and never treats the transport callback as credential authority", async () => {
    const f = await prepareImported(), row = await f.ensure(), binding = f.binding(), command = await binding.dispatch(row.id), read = blobs.readContentAddressedBlob;
    await server.db.db.update(deviceTokens).set({ expiresAt: "2099-01-01T00:00:00Z" }).where(eq(deviceTokens.tokenLookup, parseDeviceToken(f.destination.node_token)!.lookup));
    vi.spyOn(blobs, "readContentAddressedBlob").mockImplementation(async (...args) => { const bytes = await read(...args); vi.spyOn(f.actor.clock, "nowIso").mockReturnValue("2100-01-01T00:00:00Z"); return bytes; });
    await expect(binding.receive({ kind: "product.source.review.result.v1", node_id: f.destination.nodeId, command_id: command.id, payload: reviewed(row, f.researchBytes) })).rejects.toThrow("credential");
    expect((await server.db.db.select().from(goalImportedProductReviews))[0]!.result).toBeNull();
  });
  it("uses per-session deliveries and rejects an ACK or result projected into another session", async () => {
    const f = await prepareImported(), row = await f.ensure(), first = f.binding("first"), second = f.binding("second");
    const a = await first.dispatch(row.id), b = await second.dispatch(row.id); expect(a.id).not.toBe(b.id); expect(a.idempotency_key).toBe(b.idempotency_key);
    await expect(second.acknowledge({ kind: "product.source.review.ack.v1", node_id: f.destination.nodeId, command_id: a.id, status: "accepted",
      payload: { version: 1, review_id: row.id, request_digest: row.requestDigest } })).rejects.toThrow("matching delivery");
    await expect(second.receive({ kind: "product.source.review.result.v1", node_id: f.destination.nodeId, command_id: a.id, payload: reviewed(row, f.researchBytes) })).rejects.toThrow("issued command");
  });
  it("protects persisted identities and results in SQL and declares matching schema constraints", async () => {
    const f = await prepareImported(), row = await f.ensure();
    await expect(server.db.db.update(goalImportedProductReviews).set({ requestDigest: sha("different") }).where(eq(goalImportedProductReviews.id, row.id))).rejects.toThrow();
    await expect(server.db.db.delete(goalImportedProductReviews)).rejects.toThrow();
    const result = { version: 1, review_id: row.id, request_digest: row.requestDigest, outcome: "failed", closed: true, execution_authorized: false, reason: "Controlled closed failure" };
    await server.db.db.update(goalImportedProductReviews).set({ result }).where(eq(goalImportedProductReviews.id, row.id));
    await expect(server.db.db.update(goalImportedProductReviews).set({ result: null }).where(eq(goalImportedProductReviews.id, row.id))).rejects.toThrow();
    await expect(server.db.db.update(goalImportedProductReviews).set({ result: { ...result, execution_authorized: true } }).where(eq(goalImportedProductReviews.id, row.id))).rejects.toThrow();
    expect(getTableConfig(goalImportedProductReviews).checks.map(check => check.name).sort()).toEqual([
      "goal_imported_reviews_digest_chk", "goal_imported_reviews_distinct_agent_chk", "goal_imported_reviews_request_chk", "goal_imported_reviews_result_chk" ].sort());
    expect(getTableConfig(goalImportedProductReviews).uniqueConstraints).toHaveLength(3);
  });
});
