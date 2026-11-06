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
import * as qualifiedReceipts from "./services/run-event-receipt.js";

const sha = (bytes: string | Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const hash = (value: unknown) => sha(canonicalProductSourceTransferValueV1(value));
describe("imported design continuation (controlled DB/protocol evidence, no native process)", () => {
  let server: TestServer, directory: string;
  const transports: ReturnType<typeof createWebSocketTransport>[] = [];
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "artoo-semantic-transfer-"));
    server = await buildTestServer({ artifactDir: directory, workspaceRoot: "/workspace/product", authConfig: { enforceApiAuth: true },
      deviceAuth: testDeviceAuthConfig({ devNodeToken: "dev", devControlEscape: false }) });
  });
  afterEach(async () => {
    await Promise.all(transports.splice(0).map(transport => transport.close()));
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
    measurementV2?: boolean; legacyResearch?: boolean } = {}) {
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

  async function prepareHandoff(){
    const f=await prepare({measurementV2:true}),now=server.ctx.clock.nowIso();
    await server.db.db.update(tasks).set({sourcePlanSpecRef:"0"}).where(eq(tasks.id,f.base.source.task_id));
    await server.db.db.update(plans).set({taskSpecs:[{development_stage:"research",title:"Research",acceptance_criteria:["Source research accepted"]},
      {development_stage:"design",title:"Design",acceptance_criteria:["Design the product"],dependencies:[{ref:"0",type:"blocks"}]}]}).where(eq(plans.id,f.base.plan_id));
    await server.db.db.insert(tasks).values({id:"handoff_design",organizationId:server.ctx.organizationId,projectId:f.base.project_id,goalId:f.base.goal_id,
      sourcePlanId:f.base.plan_id,sourcePlanSpecRef:"1",title:"Next design",status:"ready",acceptanceCriteria:["Design the product"],createdByType:"system",createdById:"goal_runner",createdAt:now,updatedAt:now});
    const context=structuredClone(f.review.source.context);context.task.id="handoff_verification_task";context.workspace.root=f.base.destination.workspace_root;
    context.policy.filesystem_write_scope=[f.base.destination.workspace_root];context.verification_capabilities={...f.base.destination.capabilities,profile_id:f.base.destination.profile_id};
    context.release_capabilities=f.destinationRelease;
    const [originalGoal] = await server.db.db.select().from(goals).where(eq(goals.id, f.base.goal_id));
    const [originalPlan] = await server.db.db.select().from(plans).where(eq(plans.id, f.base.plan_id));
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
        artifactDir:directory,transport:{send:async message=>{sent.push(message);}}});};
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
  async function prepareImported() {
    const f = await prepareHandoff(); await uploadHandoff(f);
    const imported = (await f.ops()).find(row => row.kind === "import_verify")!;
    const importBinding = f.binding(f.destination.nodeId), command = await importBinding.dispatch(imported.id);
    const measured = controlledDestinationResult(ProductSourceOperationV1Schema.parse(imported.payload), f.researchBytes);
    await importBinding.receive({ kind: "product.source.operation.result.v1", node_id: f.destination.nodeId, command_id: command.id, payload: measured });
    await importBinding.qualify(imported.id);
    const [sourceInstance] = await server.db.db.select().from(agentInstances).where(eq(agentInstances.id, f.review.source.run.agentInstanceId));
    const [sourceAgent] = await server.db.db.select().from(agents).where(eq(agents.id, sourceInstance!.agentId));
    await server.db.db.insert(agents).values({ ...sourceAgent!, id: "imported_reviewer_agent", kind: "reviewer", capabilities: ["code.read", "code.review"] });
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
      sessionId, isCurrent: () => current, artifactDir: directory, transport: { send: async frame => { sent.push(frame); } },
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

  async function prepareDesign() {
    const f = await prepareImported(), review = await f.ensure(), peer = f.binding(), command = await peer.dispatch(review.id);
    await peer.receive({ kind: "product.source.review.result.v1", node_id: f.destination.nodeId, command_id: command.id, payload: reviewed(review, f.researchBytes) });
    // H3 binds the materialized task to the exact accepted plan, rather than the H1 helper's display alias.
    await server.db.db.update(tasks).set({ title: "Design" }).where(eq(tasks.id, "handoff_design"));
    const [sourceAgent] = await server.db.db.select().from(agents).where(eq(agents.id, "agent_mock_coder"));
    const [sourceInstance] = await server.db.db.select().from(agentInstances).where(eq(agentInstances.id, "instance_mock_coder"));
    await server.db.db.insert(agents).values({ ...sourceAgent!, id: "design_writer_agent", capabilities: ["code.read", "code.modify", "code.review"] });
    await server.db.db.insert(agentInstances).values({ ...sourceInstance!, id: "design_writer_instance", agentId: "design_writer_agent",
      runtime: "codex", computerId: f.destination.nodeId, workspaceRoot: f.base.destination.workspace_root, status: "idle" });
    const a = await f.automation(), team = a.team as { members: { stage: string; agent_instance_id: string }[] };
    await server.db.db.update(goalAutomations).set({ team: { ...team, members: team.members.map(member => member.stage === "design"
      ? { ...member, agent_instance_id: "design_writer_instance" } : member) } }).where(eq(goalAutomations.goalId, f.base.goal_id));
    const support = f.actor.supportsExecutionFeature;
    f.actor.supportsExecutionFeature = (node, feature) => feature === IMPORTED_DESIGN_CONTINUATION_FEATURE_V1 ? node === f.destination.nodeId : support?.(node, feature) === true;
    f.actor.productSourceArtifactDir = directory;
    const sent: ServerToNodeMessage[] = [], queued: { id: string; control: string }[] = []; let current = true;
    f.actor.onImportedDesignContinuationQueued = async (id, control) => { queued.push({ id, control }); };
    const ensure = async () => { const automation = await f.automation(); return server.db.transaction(tx => ensureGoalImportedDesignContinuation(f.actor, tx, automation, review.id)); };
    const binding = (sessionId = "design-session") => createImportedDesignContinuationBinding(f.actor, {
      identity: { computerId: f.destination.nodeId, deviceId: f.destination.device.id, tokenLookup: parseDeviceToken(f.destination.node_token)!.lookup },
      sessionId, isCurrent: () => current, transport: { async send(frame) { sent.push(frame); } },
    });
    const failEvent = (runId: string) => ingestWireRunEvent(f.actor, { kind: "run.event", node_id: f.destination.nodeId, run_id: runId, sequence: 0,
      event: { type: "run.lifecycle", payload: { phase: "failed", reason: "Controlled precondition failure; no native execution" } } });
    return { ...f, review, ensureDesign: ensure, designBinding: binding, designSent: sent, designQueued: queued, failEvent, invalidateDesign: () => { current = false; } };
  }
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
    Object.assign(server.ctx, { supportsVerificationProfile: f.actor.supportsVerificationProfile,
      getVerificationCapabilities: f.actor.getVerificationCapabilities, supportsReleaseProfile: f.actor.supportsReleaseProfile,
      getReleaseCapabilities: f.actor.getReleaseCapabilities });
    server.ctx.supportsExecutionFeature = (node, feature) => feature === IMPORTED_DESIGN_CONTINUATION_FEATURE_V1
      ? server.nodeRegistry.get(node)?.supportsExecutionFeature(feature) === true : support?.(node, feature) === true;
    const address = server.app.server.listening ? server.app.server.address() : undefined;
    const port = address && typeof address === "object" ? address.port : new URL(await server.app.listen({ port: 0, host: "127.0.0.1" })).port;
    const frames: ServerToNodeMessage[] = []; let fatal = false;
    const transport = createWebSocketTransport({ url: `ws://127.0.0.1:${port}/api/v1/node?token=${options.dev ? "dev" : f.destination.node_token}`,
      acknowledgeRunEvents: true, onFatalDisconnect: () => { fatal = true; },
      hello: { kind: "node.hello", node_id: f.destination.nodeId, protocol_version: "2026-06-11", artood_version: "controlled-ws-fixture",
        machine: { hostname: "controlled-native-windows", os: "windows", arch: "x64" },
        execution_features: options.advertise === false ? [] : [IMPORTED_DESIGN_CONTINUATION_FEATURE_V1] } });
    transports.push(transport); transport.subscribe(frame => { frames.push(frame); }); await transport.ready;
    return { transport, frames, fatal: () => fatal };
  }
  it("reserves one real design run, preserves source input provenance and counts that exact run only once", async () => {
    const f = await prepareDesign(); await server.db.db.update(goals).set({ budgets: { max_concurrent_runs: 1 } }).where(eq(goals.id, f.base.goal_id));
    const before = await server.db.db.select().from(runs), row = await f.ensureDesign(); expect((await f.ensureDesign()).id).toBe(row.id);
    const request = ImportedDesignContinuationRequestV1Schema.parse(row.request), [run] = await server.db.db.select().from(runs).where(eq(runs.id, row.runId));
    expect((await server.db.db.select().from(runs)).length).toBe(before.length + 1);
    expect(run).toMatchObject({ taskId: "handoff_design", agentInstanceId: "design_writer_instance", computerId: f.destination.nodeId, status: "queued", requestedByUserId: f.actor.actorUserId });
    expect(request.run_start.context_pack.payload.product_development!.accepted_inputs!.files[0]).toMatchObject({ source_task_id: f.base.source.task_id, source_run_id: f.base.source.run_id, evidence_id: f.base.source.evidence_id });
    expect(request.run_start.context_pack.payload.product_development!.instructions).toContain(IMPORTED_DESIGN_CONTEXT_INSTRUCTION_V1);
    expect(request.run_start.context_pack.payload.transferred_product_input.initial_subject_digest).toBe(f.base.source.subject_digest);
    expect(request.run_start.verification!.expected_subject_digest).toBeUndefined();
    expect(await unsettledGoalExecutionCount(f.actor, server.db.db, f.base.goal_id)).toBe(1);
    const binding = f.designBinding(), command = await binding.dispatch(row.id); expect(await binding.dispatch(row.id)).toEqual(command);
    expect(f.designSent[0]).toMatchObject({ type: "product.source.design.v1", payload: { continuation_id: row.id } });
    await binding.acknowledge({ kind: "product.source.design.ack.v1", node_id: f.destination.nodeId, command_id: command.id, status: "accepted",
      payload: { version: 1, continuation_id: row.id, request_digest: row.requestDigest, run_id: row.runId } });
    expect((await server.db.db.select().from(goalImportedDesignContinuations))[0]!.result).toBeNull();
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
    expect((await server.db.db.select().from(runs).where(eq(runs.id, row.runId)))[0]!.status).toBe("cancelled");
    expect(await server.db.db.select().from(runEvidence).where(eq(runEvidence.runId, row.runId))).toEqual([]);
    expect(await unsettledGoalExecutionCount(f.actor, server.db.db, f.base.goal_id)).toBe(0);
    await expect(binding.dispatch(row.id)).rejects.toThrow();
  });
  it.each([false, true])("requires ordinary failure first and retains uncertainty after the real run becomes terminal, uncertain=%s", async uncertain => {
    const f = await prepareDesign(), row = await f.ensureDesign(), binding = f.designBinding(), command = await binding.dispatch(row.id);
    await f.failEvent(row.runId);
    const result = uncertain ? { version: 1 as const, continuation_id: row.id, request_digest: row.requestDigest, run_id: row.runId,
      outcome: "uncertain" as const, closed: false as const, reason: "Controlled closure remains unknown" } : { version: 1 as const, continuation_id: row.id,
      request_digest: row.requestDigest, run_id: row.runId, outcome: "failed" as const, closed: true as const, reason: "Controlled process closure confirmed after the failed event" };
    await binding.receive({ kind: "product.source.design.result.v1", node_id: f.destination.nodeId, command_id: command.id, payload: result });
    expect(await unsettledGoalExecutionCount(f.actor, server.db.db, f.base.goal_id)).toBe(uncertain ? 1 : 0);
    if (uncertain) {
      const neighbor = await otherInstance(f.destination.nodeId, "same_root_instance", f.base.destination.workspace_root);
      await expect((await ordinaryTask("same_root_task"))(neighbor)).rejects.toThrow("source operation");
      await expect(binding.receive({ kind: "product.source.design.result.v1", node_id: f.destination.nodeId, command_id: command.id,
        payload: { ...result, outcome: "failed", closed: true, reason: "Substituted closure" } })).rejects.toThrow("immutable");
    }
  });
  it.each(["pause", "plan", "task-spec", "writer-runtime", "writer-workspace", "profile", "expired-token", "session", "elapsed"])("rechecks %s before exposing a writer start", async change => {
    const f = await prepareDesign(), row = await f.ensureDesign(), binding = f.designBinding();
    if (change === "pause") await server.db.db.update(goals).set({ status: "paused" }).where(eq(goals.id, f.base.goal_id));
    if (change === "plan") await server.db.db.update(plans).set({ rationale: "Changed accepted plan" }).where(eq(plans.id, f.base.plan_id));
    if (change === "task-spec") await server.db.db.update(tasks).set({ acceptanceCriteria: ["Changed task criterion"] }).where(eq(tasks.id, row.taskId));
    if (change === "writer-runtime") await server.db.db.update(agentInstances).set({ runtime: "claude" }).where(eq(agentInstances.id, row.writerInstanceId));
    if (change === "writer-workspace") await server.db.db.update(agentInstances).set({ workspaceRoot: "/another/workspace" }).where(eq(agentInstances.id, row.writerInstanceId));
    if (change === "profile") f.actor.getVerificationCapabilities = () => undefined;
    if (change === "expired-token") await server.db.db.update(deviceTokens).set({ expiresAt: "2000-01-01T00:00:00Z" }).where(eq(deviceTokens.tokenLookup, parseDeviceToken(f.destination.node_token)!.lookup));
    if (change === "session") f.invalidateDesign();
    if (change === "elapsed") await server.db.db.update(goals).set({ runningSince: "2000-01-01T00:00:00Z", budgets: { max_elapsed_ms: 1 } }).where(eq(goals.id, f.base.goal_id));
    await expect(binding.dispatch(row.id)).rejects.toThrow(); expect(f.designSent).toEqual([]);
    expect((await server.db.db.select().from(goalImportedDesignContinuations))[0]!.request).toEqual(row.request);
  });
  it("permits only status or stop after an exposed start crosses a session and refuses ordinary starts", async () => {
    const f = await prepareDesign(), row = await f.ensureDesign(), first = f.designBinding("first"); await first.dispatch(row.id);
    const next = f.designBinding("second"); await expect(next.dispatch(row.id)).rejects.toThrow("new session");
    expect(await next.dispatch(row.id, "status")).toMatchObject({ type: "product.source.design.status.v1", payload: { run_id: row.runId } });
    const binding = attachNodeBinding(f.actor, { async send() {}, subscribe() { return () => {}; }, async close() {} }, f.destination.nodeId);
    try { await expect(binding.dispatchRunStart(row.runId)).rejects.toThrow("dedicated single-use"); } finally { binding.close(); }
    await server.db.db.update(tasks).set({ status: "ready" }).where(eq(tasks.id, row.taskId));
    await expect(assignTask(f.actor, row.taskId, { mode: "manual", agent_instance_id: row.writerInstanceId })).rejects.toThrow("dedicated single-use");
  });
  it("queues only dedicated H3 through GoalRunner after commit and protects its one-use SQL identity", async () => {
    const f = await prepareDesign(); await prepareDispatcher(f);
    const errors: unknown[] = [], ordinary: string[] = [];
    f.actor.onRunQueued = async id => { ordinary.push(id); };
    const dispatcher = createGoalAutomationDispatcher(f.actor, async () => {}, error => { errors.push(error); });
    await dispatcher.pump(); await dispatcher.stop();
    expect(errors).toEqual([]); expect(ordinary).toEqual([]);
    const [row] = await server.db.db.select().from(goalImportedDesignContinuations);
    expect(row).toBeDefined(); expect(f.designQueued).toEqual([{ id: row!.id, control: "start" }]);
    await expect(server.db.db.update(goalImportedDesignContinuations).set({ requestDigest: sha("changed") })).rejects.toThrow();
    await expect(server.db.db.delete(goalImportedDesignContinuations)).rejects.toThrow();
    expect(getTableConfig(goalImportedDesignContinuations).uniqueConstraints).toHaveLength(3);
  });
  it("does not turn a closed design result into acceptance, another ordinary writer, or goal completion", async () => {
    const f = await prepareDesign(), row = await f.ensureDesign(), binding = f.designBinding(), command = await binding.dispatch(row.id);
    await f.failEvent(row.runId);
    // Dedicated finished means the execution has closed. The persisted ordinary failure
    // remains authoritative, and this result supplies no node-owned verification.
    await binding.receive({ kind: "product.source.design.result.v1", node_id: f.destination.nodeId, command_id: command.id,
      payload: { version: 1, continuation_id: row.id, request_digest: row.requestDigest, run_id: row.runId, outcome: "finished", closed: true } });
    const before = await server.db.db.select({ id: runs.id }).from(runs), errors: unknown[] = [], ordinary: string[] = [];
    f.actor.onRunQueued = async id => { ordinary.push(id); };
    await prepareDispatcher(f);
    const dispatcher = createGoalAutomationDispatcher(f.actor, async () => {}, error => { errors.push(error); });
    await dispatcher.pump(); await dispatcher.stop();
    expect(errors).toEqual([]); expect(ordinary).toEqual([]); expect(f.designQueued).toEqual([]);
    expect(await server.db.db.select({ id: runs.id }).from(runs)).toEqual(before);
    expect(await f.automation()).toMatchObject({ status: "waiting", lastError: "Imported design requires reconciliation before continuation: finished" });
    expect((await server.db.db.select().from(goals).where(eq(goals.id, f.base.goal_id)))[0]!.status).toBe("running");
    expect((await server.db.db.select().from(tasks).where(eq(tasks.id, row.taskId)))[0]!.status).not.toBe("done");
    expect(await server.db.db.select().from(runEvidence).where(eq(runEvidence.runId, row.runId))).toEqual([]);
  });
  it("admits ordinary paired Windows H3 only after schema readiness and resolves stop only after its committed event and dedicated closed result", async () => {
    const f = await prepareDesign(), row = await f.ensureDesign(), realCheck = qualifiedReceipts.requireQualifiedReceiptSchema;
    let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(qualifiedReceipts, "requireQualifiedReceiptSchema").mockImplementationOnce(async ctx => { await pending; await realCheck(ctx); });
    const peer = await openOrdinaryDesignSocket(f);
    try {
      await eventually(() => !!server.nodeRegistry.get(f.destination.nodeId), "ordinary paired registration");
      const binding = server.nodeRegistry.get(f.destination.nodeId)!;
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
      await eventually(async () => (await server.db.db.select().from(goalImportedDesignDeliveries).where(eq(goalImportedDesignDeliveries.id, stop.id)))[0]?.ack != null, "dedicated ACK committed");
      expect(stopResolved).toBe(false);
      const frame = { kind: "run.event" as const, node_id: f.destination.nodeId, run_id: row.runId, sequence: 0,
        event: { type: "run.lifecycle" as const, payload: { phase: "failed" as const, reason: "Controlled WS closure; no native process" } } };
      // Real ordinary transport resolves this send only after the server sends its
      // accepted full-frame receipt following the committed terminal transaction.
      await peer.transport.send(frame);
      expect((await server.db.db.select().from(runEventIngest).where(eq(runEventIngest.runId, row.runId)))[0]?.bodyIdentity).toBe(qualifyRunEventMessage(frame).bodyIdentity);
      expect(stopResolved).toBe(false);
      await peer.transport.send({ kind: "product.source.design.result.v1", node_id: f.destination.nodeId, command_id: stop.id,
        payload: { ...stop.payload, outcome: "failed", closed: true, reason: "Controlled ordinary terminal event and process closure" } });
      await stopped;
      expect((await server.db.db.select().from(goalImportedDesignContinuations).where(eq(goalImportedDesignContinuations.id, row.id)))[0]!.result).toMatchObject({ outcome: "failed", closed: true });
      expect(peer.frames.some(frame => frame.type === "node.session.ready")).toBe(false);
    } finally { release(); }
  });
  it.each(["resolved", "rejected"])("cannot revive or unregister an ordinary H3 binding when schema readiness is %s after replacement and rechecks an expired paired token", async late => {
    const f = await prepareDesign(), row = await f.ensureDesign(), realCheck = qualifiedReceipts.requireQualifiedReceiptSchema;
    let release!: () => void, reject!: (error: Error) => void; const pending = new Promise<void>((resolve, no) => { release = resolve; reject = no; });
    vi.spyOn(qualifiedReceipts, "requireQualifiedReceiptSchema").mockImplementationOnce(async ctx => { await pending; await realCheck(ctx); });
    const previous = await openOrdinaryDesignSocket(f);
    try {
      await eventually(() => !!server.nodeRegistry.get(f.destination.nodeId), "first ordinary binding");
      const first = server.nodeRegistry.get(f.destination.nodeId)!;
      const next = await openOrdinaryDesignSocket(f);
      await eventually(() => server.nodeRegistry.get(f.destination.nodeId) !== first && server.nodeRegistry.get(f.destination.nodeId)?.supportsExecutionFeature(IMPORTED_DESIGN_CONTINUATION_FEATURE_V1) === true, "replacement qualified binding");
      if (late === "rejected") { reject(Error("Controlled late schema rejection")); await eventually(previous.fatal, "old rejected schema closes old socket"); }
      else { release(); await realCheck(server.ctx); }
      expect(first.supportsExecutionFeature(IMPORTED_DESIGN_CONTINUATION_FEATURE_V1)).toBe(false);
      await expect(first.dispatchImportedDesignContinuation!(row.id, "start")).rejects.toThrow("no longer current");
      expect(next.transport.connected).toBe(true); expect(next.fatal()).toBe(false);
      expect(server.nodeRegistry.get(f.destination.nodeId)!.supportsExecutionFeature(IMPORTED_DESIGN_CONTINUATION_FEATURE_V1)).toBe(true);
      await server.db.db.update(deviceTokens).set({ expiresAt: "2000-01-01T00:00:00Z" }).where(eq(deviceTokens.tokenLookup, parseDeviceToken(f.destination.node_token)!.lookup));
      await expect(server.nodeRegistry.get(f.destination.nodeId)!.dispatchImportedDesignContinuation!(row.id, "status")).rejects.toThrow("credential is no longer current");
      expect(next.frames.some(frame => frame.type.startsWith("product.source.design"))).toBe(false);
    } finally { release(); }
  });
  it("fails closed for unavailable ordinary H3 receipt schema without changing the immutable writer", async () => {
    const f = await prepareDesign(), row = await f.ensureDesign();
    vi.spyOn(qualifiedReceipts, "requireQualifiedReceiptSchema").mockRejectedValueOnce(Error("Controlled missing receipt schema"));
    const peer = await openOrdinaryDesignSocket(f);
    await eventually(() => peer.fatal() && !server.nodeRegistry.get(f.destination.nodeId), "H3 schema rejection closes socket");
    expect(peer.frames.some(frame => frame.type.startsWith("product.source.design"))).toBe(false);
    expect((await server.db.db.select().from(goalImportedDesignContinuations).where(eq(goalImportedDesignContinuations.id, row.id)))[0]!.result).toBeNull();
  });
  it("gives neither dev nodes H3 authority nor ordinary non-H3 nodes a new schema handshake", async () => {
    const f = await prepareDesign(), row = await f.ensureDesign(), probe = vi.spyOn(qualifiedReceipts, "requireQualifiedReceiptSchema");
    const ordinary = await openOrdinaryDesignSocket(f, { advertise: false });
    await eventually(() => !!server.nodeRegistry.get(f.destination.nodeId), "ordinary non-H3 registration");
    expect(probe).not.toHaveBeenCalled(); expect(ordinary.fatal()).toBe(false);
    const previous = server.nodeRegistry.get(f.destination.nodeId)!;
    await openOrdinaryDesignSocket(f, { dev: true });
    await eventually(() => !!server.nodeRegistry.get(f.destination.nodeId) && server.nodeRegistry.get(f.destination.nodeId) !== previous, "dev registration");
    const dev = server.nodeRegistry.get(f.destination.nodeId)!;
    expect(probe).not.toHaveBeenCalled(); expect(dev.supportsExecutionFeature(IMPORTED_DESIGN_CONTINUATION_FEATURE_V1)).toBe(false);
    await expect(dev.dispatchImportedDesignContinuation!(row.id, "start")).rejects.toThrow("paired receipt session");
  });
});
