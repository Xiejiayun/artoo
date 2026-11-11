import {goalProductHandoffs,goalProductHandoffOperations,goalProductHandoffDeliveries,deviceTokens} from "@artoo/db";
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
import { and, eq, sql } from "drizzle-orm";
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

const sha = (bytes: string | Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const hash = (value: unknown) => sha(canonicalProductSourceTransferValueV1(value));
describe("paired-node semantic source transport (controlled protocol receipts only)", () => {
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
    measurementV2?: boolean; legacyResearch?: boolean; completionReason?: string | null } = {}) {
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
      event: { type: "run.lifecycle", payload: { phase: "completed", ...(options.completionReason === undefined ? {} : { reason: options.completionReason }) } } };
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

  it("uses the injected object store for semantic capsules without a local directory", async () => {
    await server.close();
    const store = new MemoryArtifactStore();
    server = await buildTestServer({ artifactStore: store, workspaceRoot: "/workspace/product", authConfig: { enforceApiAuth: true },
      deviceAuth: testDeviceAuthConfig({ devNodeToken: "dev", devControlEscape: false }) });
    const f = await prepare();
    await admitProductSourceSemanticTransfer(f.actor, f.request);
    expect((await f.upload()).statusCode).toBe(200);
    const downloaded = await f.download();
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.rawPayload).toEqual(f.bytes);
    expect(store.writes).toContain(f.base.source.capsule_digest);
    expect(store.reads).toContain(f.base.source.capsule_digest);
    vi.spyOn(store, "read").mockRejectedValue(new Error("Object store unavailable"));
    expect((await f.download()).statusCode).toBe(500);
  });

  it("persists both immutable requests, replays and returns full v2 and export digests without creating execution", async () => {
    const f = await prepare(), accepted = await admitProductSourceSemanticTransfer(f.actor, f.request);
    expect(accepted).toMatchObject({ status: "awaiting_upload", execution_authorized: false, request_digest: f.digest });
    expect(await admitProductSourceSemanticTransfer(f.actor, structuredClone(f.request))).toEqual(accepted);
    expect((await f.download()).statusCode).toBe(409);
    expect((await f.upload()).json()).toMatchObject({ transfer: { status: "available", request_digest: f.digest, execution_authorized: false } });
    expect((await f.upload()).statusCode).toBe(200);
    const downloaded = await f.download();
    expect(downloaded.statusCode).toBe(200); expect(downloaded.rawPayload).toEqual(f.bytes);
    expect(downloaded.headers["x-artoo-transfer-request-digest"]).toBe(f.digest);
    expect(downloaded.headers["x-artoo-source-export-digest"]).toBe(f.request.source_export_digest);
    expect(downloaded.headers["x-artoo-checksum"]).toBe(f.base.source.capsule_digest);
    expect(await server.db.db.select().from(productSourceTransfers)).toMatchObject([{ request: f.base, requestDigest: productSourceTransferRequestDigestV1(f.base, sha) }]);
    expect(await server.db.db.select().from(productSourceSemanticTransfers)).toMatchObject([{ request: f.request, requestDigest: f.digest }]);
    expect(await server.db.db.select().from(runs)).toHaveLength(2);
    await expect(server.db.db.update(productSourceSemanticTransfers).set({ sourceExportDigest: sha("substitute") })).rejects.toThrow();
    await expect(server.db.db.delete(productSourceSemanticTransfers)).rejects.toThrow();
    await expect(server.db.db.update(productSourceTransfers).set({ request: f.request })).rejects.toThrow();
  });

  it.each([undefined, null])("admits the original completed wire frame with reason %s without normalizing replay", async reason => {
    const f = await prepare({ measurementV2: true, completionReason: reason });
    const receipt = and(eq(runEventIngest.runId, f.review.source.run.id), eq(runEventIngest.sequence, f.terminalFrame.sequence));
    const [before] = await server.db.db.select({ bodyIdentity: runEventIngest.bodyIdentity }).from(runEventIngest).where(receipt);
    expect(before?.bodyIdentity).toBe(qualifyRunEventMessage(f.terminalFrame).bodyIdentity);
    await expect(ingestWireRunEvent(server.ctx, f.terminalFrame)).resolves.toMatchObject({ deduped: true });
    const changed = { ...f.terminalFrame, event: { type: "run.lifecycle",
      payload: reason === null ? { phase: "completed" } : { phase: "completed", reason: null } } };
    expect(qualifyRunEventMessage(changed).bodyIdentity).not.toBe(qualifyRunEventMessage(f.terminalFrame).bodyIdentity);
    await expect(ingestWireRunEvent(server.ctx, changed)).rejects.toThrow("body mismatch");
    await expect(admitProductSourceSemanticTransfer(f.actor, f.request)).resolves.toMatchObject({ status: "awaiting_upload" });
    const [after] = await server.db.db.select({ bodyIdentity: runEventIngest.bodyIdentity }).from(runEventIngest).where(receipt);
    expect(after).toEqual(before);
  });

  it("admits null-reason completion with the legacy measurement policy", async () => {
    const f = await prepare({ completionReason: null });
    expect(f.request.source_export.measurement_v2).toBeUndefined();
    await expect(admitProductSourceSemanticTransfer(f.actor, f.request)).resolves.toMatchObject({ status: "awaiting_upload" });
  });

  it.each(["", "unexpected success detail"])("does not qualify a completed wire frame with reason %j", async reason => {
    const f = await prepare({ measurementV2: true, completionReason: reason });
    await expect(admitProductSourceSemanticTransfer(f.actor, f.request)).rejects.toThrow("export");
    expect(await server.db.db.select().from(productSourceSemanticTransfers)).toHaveLength(0);
  });

  it.each(["failed", "cancelled", "sequence", "node", "missing-receipt"])(
    "rejects a completed domain event with a mismatched %s receipt", async kind => {
      const reason = null, f = await prepare({ measurementV2: true, completionReason: reason });
      const receipt = and(eq(runEventIngest.runId, f.review.source.run.id), eq(runEventIngest.sequence, f.terminalFrame.sequence));
      if (kind === "failed" || kind === "cancelled") {
        const changed = { ...f.terminalFrame, event: { type: "run.lifecycle", payload: { phase: kind, reason: null } } };
        await server.db.db.update(runEventIngest).set({ bodyIdentity: qualifyRunEventMessage(changed).bodyIdentity }).where(receipt);
      } else if (kind === "sequence") {
        await server.db.db.update(runEventIngest).set({ sequence: f.terminalFrame.sequence + 1 }).where(receipt);
      } else if (kind === "node") {
        await server.db.db.update(runEventIngest).set({ nodeId: f.other.nodeId }).where(receipt);
      } else {
        await server.db.db.delete(runEventIngest).where(receipt);
      }
      await expect(admitProductSourceSemanticTransfer(f.actor, f.request)).rejects.toThrow("export");
      expect(await server.db.db.select().from(productSourceSemanticTransfers)).toHaveLength(0);
    });

  it("requires owning-node qualified v2 ingest, exact predecessor and unchanged original replay", async () => {
    const f = await prepare();
    await expect(ingestWireRunEvent(server.ctx, f.exportFrame)).resolves.toMatchObject({ deduped: true });
    await expect(ingestRunEvent(server.ctx, { nodeId: f.source.nodeId, runId: f.base.source.run_id, sequence: 2,
      event: { kind: "product_source_semantic_export", proof: f.proof } })).rejects.toThrow("qualified node");
    await expect(ingestWireRunEvent(server.ctx, { ...f.exportFrame, node_id: f.other.nodeId })).rejects.toThrow("owned by this node");
    await expect(ingestWireRunEvent(server.ctx, { ...f.exportFrame, event: { ...f.exportFrame.event,
      payload: { ...f.proof, research_provenance_digest: sha("changed") } } })).rejects.toThrow("body mismatch");
    await server.db.db.update(runEventIngest).set({ bodyIdentity: null }).where(eq(runEventIngest.eventId, f.review.source.evidence.eventId));
    await expect(admitProductSourceSemanticTransfer(f.actor, f.request)).rejects.toThrow("export");
  });

  it("preserves an earlier local receipt's original run/task within the same goal and workspace", async () => {
    const f = await prepare({ originalReceiptRun: true });
    expect(f.proof.research_provenance.sources[0]!.origin).toMatchObject({ run_id: "original_retrieval_run", task_id: "original_retrieval_task" });
    await admitProductSourceSemanticTransfer(f.actor, f.request);
    expect((await f.upload()).statusCode).toBe(200);
    const download = await f.download(); expect(download.statusCode).toBe(200); expect(download.rawPayload).toEqual(f.bytes);
    const [stored] = await server.db.db.select().from(productSourceSemanticTransfers);
    expect(stored?.request).toEqual(f.request);
  });

  it.each(["source-capabilities", "research-pin", "origin", "provenance-digest"])("rejects changed %s at the export ingest boundary", async kind => {
    const f = await prepare({ skipExport: true }), proof = structuredClone(f.proof);
    if (kind === "source-capabilities") proof.source_capabilities.checks[0]!.config_digest = sha("changed");
    if (kind === "research-pin") proof.research_provenance.research.checksum = sha("changed");
    if (kind === "origin") proof.research_provenance.sources[0]!.origin.workspace_root = "/different/workspace";
    proof.research_provenance_digest = kind === "provenance-digest" ? sha("changed") : hash(proof.research_provenance);
    await expect(ingestWireRunEvent(server.ctx, { ...f.exportFrame, event: { ...f.exportFrame.event, payload: proof } })).rejects.toThrow("export");
    expect(await server.db.db.select().from(eventLog).where(eq(eventLog.type, "run.product-source.export.v2"))).toHaveLength(0);
  });

  it.each(["export", "completion"])("rejects a missing qualified %s frame", async kind => {
    const f = await prepare();
    const [event] = await server.db.db.select().from(eventLog).where(eq(eventLog.type, kind === "export" ? "run.product-source.export.v2" : "run.completed"));
    await server.db.db.update(runEventIngest).set({ bodyIdentity: null }).where(eq(runEventIngest.eventId, event!.id));
    await expect(admitProductSourceSemanticTransfer(f.actor, f.request)).rejects.toThrow("export");
  });

  it("rejects incomplete or unknown command mappings and altered provenance/export digests", async () => {
    const f = await prepare();
    const unknown = structuredClone(f.request); unknown.command_pairs[0]!.destination_command_id = "unknown";
    await expect(admitProductSourceSemanticTransfer(f.actor, unknown)).rejects.toThrow("export");
    const incomplete = structuredClone(f.request);
    incomplete.byte_request.destination.capabilities.checks.push({ ...incomplete.byte_request.destination.capabilities.checks[0]!, command_id: "extra" });
    incomplete.byte_request.destination.capability_digest = hash(incomplete.byte_request.destination.capabilities);
    f.actor.getVerificationCapabilities = () => incomplete.byte_request.destination.capabilities;
    await expect(admitProductSourceSemanticTransfer(f.actor, incomplete)).rejects.toThrow("export");
    f.actor.getVerificationCapabilities = server.ctx.getVerificationCapabilities;
    for (const field of ["source_export_digest", "research_provenance_digest"] as const) {
      const request = structuredClone(f.request);
      if (field === "source_export_digest") request.source_export_digest = sha("changed");
      else { request.source_export.research_provenance_digest = sha("changed"); request.source_export_digest = productSourceExportDigestV2(request.source_export, sha); }
      await expect(admitProductSourceSemanticTransfer(f.actor, request)).rejects.toThrow("digest");
    }
    expect(await server.db.db.select().from(productSourceTransfers)).toHaveLength(0);
  });

  it("rejects v1 downgrade and v1-only exports on v2 routes", async () => {
    const f = await prepare(); await admitProductSourceSemanticTransfer(f.actor, f.request);
    await expect(admitProductSourceTransfer(f.actor, f.base)).rejects.toThrow("export");
    const old = await server.app.inject({ method: "PUT", url: f.url.replace("transfers-v2", "transfers"), payload: f.bytes,
      headers: f.headers(f.source.node_token, { "content-type": "application/octet-stream", "x-artoo-transfer-request-digest": productSourceTransferRequestDigestV1(f.base, sha) }) });
    expect(old.statusCode).toBe(409);
    const [event] = await server.db.db.select().from(eventLog).where(eq(eventLog.type, "run.product-source.export.v2"));
    await server.db.db.update(eventLog).set({ type: "run.product-source.export.v1", payload: f.proof.byte_export }).where(eq(eventLog.id, event!.id));
    expect((await f.upload()).statusCode).toBe(409);
  });

  it("requires only paired assigned node credentials and full envelope digest", async () => {
    const f = await prepare(); await expect(admitProductSourceSemanticTransfer(server.ctx, f.request)).rejects.toThrow("Only the goal runner");
    await admitProductSourceSemanticTransfer(f.actor, f.request);
    for (const token of [f.source.control_token, "", "dev", f.destination.node_token, f.other.node_token]) expect((await f.upload(token)).statusCode).toBe(403);
    expect((await f.upload(f.source.node_token, f.bytes, { "x-artoo-transfer-request-digest": productSourceTransferRequestDigestV1(f.base, sha) })).statusCode).toBe(409);
    expect((await f.upload()).statusCode).toBe(200);
    for (const token of [f.destination.control_token, "", "dev", f.source.node_token, f.other.node_token]) expect((await f.download(token)).statusCode).toBe(403);
    expect((await server.app.inject({ method: "POST", url: f.url, headers: f.headers(f.source.node_token) })).statusCode).toBe(401);
    expect((await server.app.inject({ method: "GET", url: `${f.url}/extra`, headers: f.headers(f.source.node_token) })).statusCode).toBe(401);
  });

  it.each(["metadata", "omitted", "duplicate"] as const)("rejects %s research despite an exactly bound capsule hash", async malformed => {
    const f = await prepare({ malformed }); await admitProductSourceSemanticTransfer(f.actor, f.request);
    expect((await f.upload()).statusCode).toBe(400);
    expect(await server.db.db.select().from(productSourceTransfers)).toMatchObject([{ status: "awaiting_upload", availableAt: null }]);
  });

  it.each(["plan", "review", "capabilities", "v1-only-feature", "pairing"])("requalifies current %s after availability", async kind => {
    const f = await prepare(); await admitProductSourceSemanticTransfer(f.actor, f.request); expect((await f.upload()).statusCode).toBe(200);
    if (kind === "plan") await server.db.db.update(goals).set({ currentPlanId: "replacement" }).where(eq(goals.id, f.base.goal_id));
    if (kind === "review") await server.db.db.update(messages).set({ body: JSON.stringify({ ...f.review.verdict, outcome: "changes_requested" }) }).where(eq(messages.id, "measurement_response"));
    if (kind === "capabilities") server.ctx.getVerificationCapabilities = () => undefined;
    if (kind === "v1-only-feature") server.ctx.supportsExecutionFeature = (_node, feature) => feature === "product-source-transfer.v1";
    if (kind === "pairing") await revokeDevice(server.ctx, f.source.device.id);
    expect((await f.download()).statusCode).toBeGreaterThanOrEqual(400); expect((await f.upload()).statusCode).toBeGreaterThanOrEqual(400);
  });

  it("rechecks authorization after blob write before availability and credentials after blob read", async () => {
    const f = await prepare(); await admitProductSourceSemanticTransfer(f.actor, f.request);
    const write = blobs.writeContentAddressedBlob;
    const spy = vi.spyOn(blobs, "writeContentAddressedBlob").mockImplementation(async (path, bytes) => {
      await write(path, bytes); await server.db.db.update(goals).set({ status: "paused" }).where(eq(goals.id, f.base.goal_id));
    });
    expect((await f.upload()).statusCode).toBe(409);
    expect(await server.db.db.select().from(productSourceTransfers)).toMatchObject([{ status: "awaiting_upload" }]);
    spy.mockRestore(); await server.db.db.update(goals).set({ status: "running" }).where(eq(goals.id, f.base.goal_id));
    expect((await f.upload()).statusCode).toBe(200);
    const read = blobs.readContentAddressedBlob;
    vi.spyOn(blobs, "readContentAddressedBlob").mockImplementation(async (...args) => { const bytes = await read(...args); await revokeDevice(server.ctx, f.destination.device.id); return bytes; });
    expect((await f.download()).statusCode).toBe(403);
  });

  it("rejects changed bytes, checksum and oversized upload before availability", async () => {
    const f = await prepare(); await admitProductSourceSemanticTransfer(f.actor, f.request);
    expect((await f.upload(f.source.node_token, Buffer.from("{}"))).statusCode).toBe(400);
    expect((await f.upload(f.source.node_token, f.bytes, { "x-artoo-checksum": sha("changed") })).statusCode).toBe(400);
    expect((await f.upload(f.source.node_token, Buffer.alloc(12 * 1024 * 1024 + 1))).statusCode).toBe(413);
  });

  it("preserves paired policy-v2 release JSON and original v3 research bytes without authorizing execution or publication", async () => {
    const f = await prepare({ measurementV2: true, originalReceiptRun: true });
    const sourceReader = vi.fn(f.actor.getReleaseCapabilities!); f.actor.getReleaseCapabilities = sourceReader;
    const accepted = await admitProductSourceSemanticTransfer(f.actor, f.request);
    expect(accepted).toMatchObject({ status: "awaiting_upload", request_digest: f.digest, execution_authorized: false });
    expect(await admitProductSourceSemanticTransfer(f.actor, structuredClone(f.request))).toEqual(accepted);
    expect(f.sourceRelease!.binding.workspace_root).not.toBe(f.destinationRelease!.binding.workspace_root);
    expect(f.sourceRelease!.binding.verification_profile_id).not.toBe(f.destinationRelease!.binding.verification_profile_id);
    expect(sourceReader).toHaveBeenCalledWith(f.source.nodeId, "site", "proj_artoo", "/workspace/product", "default");
    expect(sourceReader).toHaveBeenCalledWith(f.destination.nodeId, "destination-site", "proj_artoo", "/destination/product", "destination-verify");
    expect(f.review.source.evidence.payload).toMatchObject({ checks: [{ observation: { version: 3, scope: "final", stage: "research", cases: [] } }],
      measurement_plan: { version: 2, scope: "final", release_criterion_count: 1, pending_release: [{ release_binding: f.sourceRelease!.binding }] } });
    expect(f.proof.research_provenance.sources[0]!.origin).toMatchObject({ run_id: "original_retrieval_run", task_id: "original_retrieval_task" });
    expect((await f.upload()).statusCode).toBe(200);
    const download = await f.download(); expect(download.statusCode).toBe(200); expect(download.rawPayload).toEqual(f.bytes);
    const capsule = JSON.parse(download.rawPayload.toString("utf8")) as { files: { path: string; base64: string }[] };
    expect(Buffer.from(capsule.files[0]!.base64, "base64")).toEqual(f.researchBytes);
    expect(f.researchReport.requirements[0]!.acceptance_criteria[0]).toBe("  Saved entry is visible  ");
    expect(download.headers["x-artoo-transfer-request-digest"]).toBe(f.digest);
    expect(download.headers["x-artoo-source-export-digest"]).toBe(f.request.source_export_digest);
    expect(f.digest).not.toBe(productSourceTransferRequestDigestV1(f.base, sha));
    const [stored] = await server.db.db.select().from(productSourceSemanticTransfers);
    expect(stored?.request).toEqual(f.request); expect(stored?.requestDigest).toBe(f.digest);
    expect(await server.db.db.select().from(runs)).toHaveLength(2);
    const changed = structuredClone(f.request); changed.measurement_v2!.destination_release.binding.release_profile_digest = sha("replacement release");
    await expect(server.db.db.update(productSourceSemanticTransfers).set({ request: changed })).rejects.toThrow();
    expect((await server.db.db.select().from(productSourceSemanticTransfers))[0]?.request).toEqual(f.request);
  });

  it.each(["source", "destination"] as const)("rejects a missing %s policy-v2 extension at admission", async side => {
    const f = await prepare({ measurementV2: true }), request = structuredClone(f.request);
    if (side === "source") delete request.source_export.measurement_v2; else delete request.measurement_v2;
    await expect(admitProductSourceSemanticTransfer(f.actor, request)).rejects.toThrow("Invalid semantic");
    expect(await server.db.db.select().from(productSourceTransfers)).toHaveLength(0);
  });

  it.each(["profile", "digest", "contract", "workspace"] as const)("rejects substituted source release %s at owning-node export ingest", async field => {
    const f = await prepare({ measurementV2: true, skipExport: true }), proof = structuredClone(f.proof), release = proof.measurement_v2!.source_release;
    if (field === "profile") release.binding.release_profile_id = "unmeasured-site";
    if (field === "digest") release.binding.release_profile_digest = sha("unmeasured source release");
    if (field === "contract") { release.contract.health_checks[0]!.path = "/other"; release.binding.contract_digest = hash(release.contract); }
    if (field === "workspace") release.binding.workspace_root = "/foreign/workspace";
    await expect(ingestWireRunEvent(server.ctx, { ...f.exportFrame, event: { ...f.exportFrame.event, payload: proof } }))
      .rejects.toThrow(field === "workspace" ? "Source release configuration differs" : "export");
    expect(await server.db.db.select().from(eventLog).where(eq(eventLog.type, "run.product-source.export.v2"))).toHaveLength(0);
  });

  it.each(["persisted-context", "persisted-requirement", "final-summary", "missing-summary"] as const)("rejects policy-v2 export after its %s changes", async field => {
    const f = await prepare({ measurementV2: true, skipExport: true });
    if (field === "persisted-context") {
      const context = structuredClone(f.review.source.context); context.release_capabilities!.binding.release_profile_digest = sha("changed context");
      await server.db.db.update(contextPacks).set({ payload: context }).where(eq(contextPacks.id, f.review.source.run.contextPackId!));
    } else if (field === "persisted-requirement") {
      const [run] = await server.db.db.select().from(runs).where(eq(runs.id, f.review.source.run.id));
      const requirement = structuredClone(run!.verificationRequirement) as { release_capability_binding?: unknown };
      delete requirement.release_capability_binding;
      await server.db.db.update(runs).set({ verificationRequirement: requirement }).where(eq(runs.id, f.review.source.run.id));
    } else {
      const payload = structuredClone(f.review.source.evidence.payload);
      if (field === "missing-summary") delete payload.measurement_plan;
      else {
        if (payload.measurement_plan?.version !== 2) throw new Error("Expected controlled summary 2");
        payload.measurement_plan.pending_release[0]!.release_binding.release_profile_digest = sha("changed final evidence");
      }
      await server.db.db.update(runEvidence).set({ payload }).where(eq(runEvidence.id, f.review.source.evidence.id));
      await server.db.db.update(eventLog).set({ payload }).where(eq(eventLog.id, f.review.source.evidence.eventId));
    }
    await expect(ingestWireRunEvent(server.ctx, f.exportFrame)).rejects.toThrow("export");
    expect(await server.db.db.select().from(eventLog).where(eq(eventLog.type, "run.product-source.export.v2"))).toHaveLength(0);
  });

  it.each((["source", "destination"] as const).flatMap(side =>
    (["new-feature", "base-feature", "verifier-scope", "verifier-contract", "release-scope", "release-missing", "release-contract", "offline"] as const)
      .map(change => ({ side, change }))))("requires the current $side session's $change", async ({ side, change }) => {
    const f = await prepare({ measurementV2: true }), selected = f[side].nodeId;
    if (change === "new-feature" || change === "base-feature") {
      const original = f.actor.supportsExecutionFeature;
      f.actor.supportsExecutionFeature = (node, feature) => !(node === selected && feature ===
        (change === "new-feature" ? PRODUCT_SOURCE_TRANSFER_MEASUREMENT_V2_FEATURE_V1 : "product-source-transfer.v2")) && original?.(node, feature) === true;
    }
    if (change === "verifier-scope") {
      const original = f.actor.supportsVerificationProfile;
      f.actor.supportsVerificationProfile = (node, ...scope) => node !== selected && original?.(node, ...scope) === true;
    }
    if (change === "verifier-contract") {
      const original = f.actor.getVerificationCapabilities;
      f.actor.getVerificationCapabilities = (node, ...scope) => {
        const value = original?.(node, ...scope);
        if (node === selected && value) value.checks[0]!.contract.viewports[0]!.height += 1;
        return value;
      };
    }
    if (change === "release-scope") {
      const original = f.actor.supportsReleaseProfile;
      f.actor.supportsReleaseProfile = (node, ...scope) => node !== selected && original?.(node, ...scope) === true;
    }
    if (change === "release-missing" || change === "release-contract") {
      const original = f.actor.getReleaseCapabilities;
      f.actor.getReleaseCapabilities = (node, ...scope) => {
        const value = original?.(node, ...scope);
        if (node === selected && change === "release-missing") return undefined;
        if (node === selected && value) value.contract.health_checks[0]!.path = "/changed-current-contract";
        return value;
      };
    }
    if (change === "offline") await server.db.db.update(computers).set({ status: "offline" }).where(eq(computers.id, selected));
    await expect(admitProductSourceSemanticTransfer(f.actor, f.request)).rejects.toThrow();
    expect(await server.db.db.select().from(productSourceTransfers)).toHaveLength(0);
  });

  it("rechecks a replaced session after awaited source qualification before creating a transfer", async () => {
    const f = await prepare({ measurementV2: true }), qualify = semanticExports.requireProductSourceSemanticExportForTransfer;
    vi.spyOn(semanticExports, "requireProductSourceSemanticExportForTransfer").mockImplementation(async (...args) => {
      const eventId = await qualify(...args), original = f.actor.supportsExecutionFeature;
      f.actor.supportsExecutionFeature = (node, feature) => !(node === f.source.nodeId && feature === PRODUCT_SOURCE_TRANSFER_MEASUREMENT_V2_FEATURE_V1)
        && original?.(node, feature) === true;
      return eventId;
    });
    await expect(admitProductSourceSemanticTransfer(f.actor, f.request)).rejects.toThrow("current feature");
    expect(await server.db.db.select().from(productSourceSemanticTransfers)).toHaveLength(0);
    expect(await server.db.db.select().from(productSourceTransfers)).toHaveLength(0);
  });

  it.each(["source", "destination"] as const)("rechecks the complete %s release after blob write and read", async side => {
    const f = await prepare({ measurementV2: true }), selected = f[side].nodeId;
    await admitProductSourceSemanticTransfer(f.actor, f.request);
    const originalReader = server.ctx.getReleaseCapabilities!, write = blobs.writeContentAddressedBlob;
    const replaceReader = () => { server.ctx.getReleaseCapabilities = (node, ...scope) => {
      const value = originalReader(node, ...scope);
      if (node === selected && value) value.binding.release_profile_digest = sha("changed during blob I/O");
      return value;
    }; };
    const writeSpy = vi.spyOn(blobs, "writeContentAddressedBlob").mockImplementation(async (...args) => { await write(...args); replaceReader(); });
    expect((await f.upload()).statusCode).toBe(409);
    expect(await server.db.db.select().from(productSourceTransfers)).toMatchObject([{ status: "awaiting_upload", availableAt: null }]);
    writeSpy.mockRestore(); server.ctx.getReleaseCapabilities = originalReader;
    expect((await f.upload()).statusCode).toBe(200);
    const read = blobs.readContentAddressedBlob;
    vi.spyOn(blobs, "readContentAddressedBlob").mockImplementation(async (...args) => { const bytes = await read(...args); replaceReader(); return bytes; });
    const response = await f.download(); expect(response.statusCode).toBe(409); expect(response.rawPayload).not.toEqual(f.bytes);
  });

  it("conflicts on the same ID when only the complete destination release digest changes", async () => {
    const f = await prepare({ measurementV2: true }); await admitProductSourceSemanticTransfer(f.actor, f.request);
    const changed = structuredClone(f.request), original = f.actor.getReleaseCapabilities;
    changed.measurement_v2!.destination_release.binding.release_profile_digest = sha("a new configured release version");
    expect(productSourceTransferRequestDigestV1(changed.byte_request, sha)).toBe(productSourceTransferRequestDigestV1(f.base, sha));
    expect(productSourceTransferRequestDigestV2(changed, sha)).not.toBe(f.digest);
    f.actor.getReleaseCapabilities = (node, ...scope) => node === f.destination.nodeId
      ? structuredClone(changed.measurement_v2!.destination_release) : original?.(node, ...scope);
    await expect(admitProductSourceSemanticTransfer(f.actor, changed)).rejects.toThrow("another immutable");
    const [stored] = await server.db.db.select().from(productSourceSemanticTransfers);
    expect(stored?.request).toEqual(f.request); expect(stored?.requestDigest).toBe(f.digest);
  });

  it("rejects legacy research on the paired v2 route even when capsule, report pin and metadata match", async () => {
    const f = await prepare({ measurementV2: true, legacyResearch: true });
    await admitProductSourceSemanticTransfer(f.actor, f.request);
    expect((await f.upload()).statusCode).toBe(400);
    expect(await server.db.db.select().from(productSourceTransfers)).toMatchObject([{ status: "awaiting_upload", availableAt: null }]);
  });

  it("keeps accepted independent source review mandatory for policy-v2 download", async () => {
    const f = await prepare({ measurementV2: true }); await admitProductSourceSemanticTransfer(f.actor, f.request);
    expect((await f.upload()).statusCode).toBe(200);
    await server.db.db.update(messages).set({ body: JSON.stringify({ ...f.review.verdict, outcome: "changes_requested" }) }).where(eq(messages.id, "measurement_response"));
    expect((await f.download()).statusCode).toBe(409);
  });

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
  it("durably owns the immutable intent and original user without assigning the next stage",async()=>{
    const f=await prepareHandoff(),first=await ensureGoalProductHandoff(f.actor,f.intent);
    expect(await ensureGoalProductHandoff(f.actor,structuredClone(f.intent))).toEqual(first);expect((await f.ops())).toHaveLength(2);
    const [row]=await server.db.db.select().from(goalProductHandoffs);expect(row).toMatchObject({actorUserId:f.base.authorization.actor_user_id,consentId:null,policyVersion:f.base.authorization.policy_version});
    expect(first).toMatchObject({qualified_receipt:false,execution_authorized:false,automatic_review_authorized:false});
    expect((await server.db.db.select().from(tasks).where(eq(tasks.id,"handoff_design")))[0]!.status).toBe("ready");
    const changed=structuredClone(f.intent);changed.destination_start.verification!.request_id="different";
    await expect(ensureGoalProductHandoff(f.actor,changed)).rejects.toThrow("immutable");
    await expect(ensureGoalProductHandoff({...f.actor,actorUserId:"another-user"},f.intent)).rejects.toThrow("original user's");
  });
  it("rolls back byte and semantic admission when its next-stage intent fails",async()=>{
    const f=await prepareHandoff();f.intent.next_task_id="missing-next";
    await expect(ensureGoalProductHandoff(f.actor,f.intent)).rejects.toThrow("dependent design");
    expect(await server.db.db.select().from(productSourceTransfers)).toHaveLength(0);expect(await server.db.db.select().from(productSourceSemanticTransfers)).toHaveLength(0);
    expect(await server.db.db.select().from(goalProductHandoffs)).toHaveLength(0);
  });
  it("does not dispatch on pause, changed plan or stale session; preserves the fixed operation on replay",async()=>{
    const f=await prepareHandoff();await ensureGoalProductHandoff(f.actor,f.intent);const operation=(await f.ops())[0]!;
    await server.db.db.update(goals).set({status:"paused"}).where(eq(goals.id,f.base.goal_id));await expect(f.binding(operation.computerId).dispatch(operation.id)).rejects.toThrow("current running goal");
    expect(f.sent).toHaveLength(0);await server.db.db.update(goals).set({status:"running"}).where(eq(goals.id,f.base.goal_id));
    await server.db.db.update(goals).set({currentPlanId:null}).where(eq(goals.id,f.base.goal_id));await expect(f.binding(operation.computerId).dispatch(operation.id)).rejects.toThrow("current running goal");
    await server.db.db.update(goals).set({currentPlanId:f.base.plan_id}).where(eq(goals.id,f.base.goal_id));
    const first=await f.binding(operation.computerId).dispatch(operation.id),second=await f.binding(operation.computerId).dispatch(operation.id);expect(second).toEqual(first);
    f.invalidate();await expect(f.binding(operation.computerId).dispatch(operation.id)).rejects.toThrow("session");
  });
  it("never substitutes an ACK for a qualified receipt and rejects wrong delivery/node bindings",async()=>{
    const f=await prepareHandoff();await ensureGoalProductHandoff(f.actor,f.intent);const operation=(await f.ops()).find(v=>v.kind==="upload")!,binding=f.binding(f.source.nodeId),command=await binding.dispatch(operation.id);
    const ack={kind:"product.source.operation.ack.v1" as const,node_id:f.source.nodeId,command_id:command.id,status:"accepted" as const,payload:{version:1 as const,operation_id:operation.id,payload_digest:operation.payloadDigest}};
    await binding.acknowledge(ack);await binding.acknowledge(ack);expect((await f.ops()).find(v=>v.id===operation.id)!.result).toBeNull();
    const destination=(await f.ops()).find(v=>v.kind==="import_verify")!;await expect(f.binding(f.destination.nodeId).dispatch(destination.id)).rejects.toThrow("upload result");
    await expect(binding.acknowledge({...ack,command_id:"never-issued"})).rejects.toThrow("issued delivery");
    await expect(f.binding(f.destination.nodeId).acknowledge({...ack,node_id:f.destination.nodeId})).rejects.toThrow("another node");
  });
  for(const withdrawn of ["revoked","expired"] as const)it(`rejects ${withdrawn} original node credentials even while the transport callback stays current`,async()=>{
    const f=await prepareHandoff();await ensureGoalProductHandoff(f.actor,f.intent);const operation=(await f.ops()).find(v=>v.kind==="upload")!,binding=f.binding(f.source.nodeId),command=await binding.dispatch(operation.id);
    const response=await f.upload();expect(response.statusCode).toBe(200);
    if(withdrawn==="revoked")await revokeDevice(server.ctx,f.source.device.id);
    else await server.db.db.update(deviceTokens).set({expiresAt:"2000-01-01T00:00:00Z"}).where(eq(deviceTokens.tokenLookup,parseDeviceToken(f.source.node_token)!.lookup));
    await expect(binding.receive({kind:"product.source.operation.result.v1",node_id:f.source.nodeId,command_id:command.id,payload:{version:1,operation_id:operation.id,
      payload_digest:operation.payloadDigest,request_digest:f.digest,outcome:"uploaded",closed:true,receipt:response.json().transfer}})).rejects.toThrow("credential");
    await expect(binding.acknowledge({kind:"product.source.operation.ack.v1",node_id:f.source.nodeId,command_id:command.id,status:"accepted",
      payload:{version:1,operation_id:operation.id,payload_digest:operation.payloadDigest}})).rejects.toThrow("credential");
    expect((await f.ops()).find(v=>v.id===operation.id)!.result).toBeNull();expect(f.sent).toHaveLength(1);
  });
  it("rechecks elapsed/retry budgets and next-task state before dispatch",async()=>{
    const f=await prepareHandoff();await ensureGoalProductHandoff(f.actor,f.intent);const operation=(await f.ops()).find(v=>v.kind==="upload")!,binding=f.binding(f.source.nodeId);
    await server.db.db.update(goals).set({budgets:{max_elapsed_ms:1},runningSince:"2000-01-01T00:00:00Z"}).where(eq(goals.id,f.base.goal_id));
    await expect(binding.dispatch(operation.id)).rejects.toThrow("elapsed time budget");
    await server.db.db.update(goals).set({budgets:{max_retries:0},retryCount:1,runningSince:null}).where(eq(goals.id,f.base.goal_id));
    await expect(binding.dispatch(operation.id)).rejects.toThrow("retry budget");
    await server.db.db.update(goals).set({budgets:{},retryCount:0}).where(eq(goals.id,f.base.goal_id));
    await server.db.db.update(tasks).set({status:"cancelled"}).where(eq(tasks.id,"handoff_design"));await expect(binding.dispatch(operation.id)).rejects.toThrow("ready dependent design");
    expect(f.sent).toHaveLength(0);
  });
  it("keeps uncertain closure active and prevents another handoff under a one-operation budget",async()=>{
    const f=await prepareHandoff();await ensureGoalProductHandoff(f.actor,f.intent);const operation=(await f.ops()).find(v=>v.kind==="upload")!,binding=f.binding(f.source.nodeId),command=await binding.dispatch(operation.id);
    await binding.receive({kind:"product.source.operation.result.v1",node_id:f.source.nodeId,command_id:command.id,payload:{version:1,operation_id:operation.id,
      payload_digest:operation.payloadDigest,request_digest:f.digest,outcome:"uncertain",closed:false,reason:"Controlled unknown native closure"}});
    await server.db.db.update(goals).set({budgets:{max_concurrent_runs:1}}).where(eq(goals.id,f.base.goal_id));
    await expect(binding.dispatch(operation.id)).rejects.toThrow("Unconfirmed operation closure");
    const [next]=await server.db.db.select().from(tasks).where(eq(tasks.id,"handoff_design"));
    const [plan]=await server.db.db.select().from(plans).where(eq(plans.id,f.base.plan_id));const specs=plan!.taskSpecs as unknown[];
    await server.db.db.update(plans).set({taskSpecs:[...specs,specs[1]]}).where(eq(plans.id,f.base.plan_id));
    await server.db.db.insert(tasks).values({...next!,id:"second_design",sourcePlanSpecRef:"2"});
    const second=structuredClone(f.intent);second.next_task_id="second_design";second.request.byte_request.transfer_id="second_handoff";
    await expect(ensureGoalProductHandoff(f.actor,second)).rejects.toThrow("unconfirmed closure");
    expect(await server.db.db.select().from(goalProductHandoffs)).toHaveLength(1);expect((await f.ops()).find(v=>v.id===operation.id)!.result).toMatchObject({closed:false});
  });
  for(const phase of [1,2] as const)it(`rechecks a newly visible uncertain result inside dispatch fence ${phase} (controlled DB interleaving)`,async()=>{
    const f=await prepareHandoff();await ensureGoalProductHandoff(f.actor,f.intent);
    const operation=(await f.ops()).find(v=>v.kind==="upload")!,binding=f.binding(f.source.nodeId);
    await binding.dispatch(operation.id);let admissions=0,observed=false;
    const original=semanticTransfers.admitProductSourceSemanticTransferInTransaction;
    vi.spyOn(semanticTransfers,"admitProductSourceSemanticTransferInTransaction").mockImplementation(async(...args)=>{
      if(++admissions===phase){
        // PGlite serializes transactions. Write the actual row at the selected load -> goal-fence
        // boundary to model a visible competing receive result; this is not multi-connection locking evidence.
        const tx=args[1];await tx.update(goalProductHandoffOperations).set({result:{version:1,operation_id:operation.id,
          payload_digest:operation.payloadDigest,request_digest:f.digest,outcome:"uncertain",closed:false,reason:"Controlled load/fence interleaving"}})
          .where(eq(goalProductHandoffOperations.id,operation.id));
        const [visible]=await tx.select().from(goalProductHandoffOperations).where(eq(goalProductHandoffOperations.id,operation.id));
        expect(visible!.result).toMatchObject({closed:false});observed=true;
      }
      return original(...args);
    });
    await expect(binding.dispatch(operation.id)).rejects.toThrow("Unconfirmed operation closure");
    expect(observed).toBe(true);expect(admissions).toBe(phase);
    expect(f.sent.filter(message=>message.type==="product.source.operation.v1")).toHaveLength(1);
    // The injected write rolls back with the rejected dispatch transaction; ordinary receive persistence has its own test.
    expect((await f.ops()).find(v=>v.id===operation.id)!.result).toBeNull();
  });
  it("records exact destination evidence during pause but qualifies only on resume and stops before target review",async()=>{
    const f=await prepareHandoff();await uploadHandoff(f);const operation=(await f.ops()).find(v=>v.kind==="import_verify")!,binding=f.binding(f.destination.nodeId),command=await binding.dispatch(operation.id);
    const result=controlledDestinationResult(ProductSourceOperationV1Schema.parse(operation.payload),f.researchBytes);
    await server.db.db.update(goals).set({status:"paused"}).where(eq(goals.id,f.base.goal_id));
    await binding.receive({kind:"product.source.operation.result.v1",node_id:f.destination.nodeId,command_id:command.id,payload:result});
    await expect(binding.qualify(operation.id)).rejects.toThrow("current running goal");
    await server.db.db.update(goals).set({status:"running"}).where(eq(goals.id,f.base.goal_id));
    await server.db.db.update(tasks).set({status:"cancelled"}).where(eq(tasks.id,"handoff_design"));await expect(binding.qualify(operation.id)).rejects.toThrow("ready dependent design");
    await server.db.db.update(tasks).set({status:"ready"}).where(eq(tasks.id,"handoff_design"));
    expect(await binding.qualify(operation.id)).toMatchObject({state:"qualified_receipt_waiting_target_review",execution_authorized:false,automatic_review_authorized:false});
    expect((await server.db.db.select().from(tasks).where(eq(tasks.id,"handoff_design")))[0]!.status).toBe("ready");
    await requestGoalProductHandoffStop(f.actor,f.base.transfer_id);await expect(binding.qualify(operation.id)).rejects.toThrow("stop is retained");
    expect((await binding.dispatch(operation.id,"stop")).type).toBe("product.source.operation.stop.v1");
  });
  it("rejects a stale session after async blob I/O and leaves no destination result",async()=>{
    const f=await prepareHandoff();await uploadHandoff(f);const operation=(await f.ops()).find(v=>v.kind==="import_verify")!,binding=f.binding(f.destination.nodeId),command=await binding.dispatch(operation.id);
    const result=controlledDestinationResult(ProductSourceOperationV1Schema.parse(operation.payload),f.researchBytes),original=blobs.readContentAddressedBlob;
    vi.spyOn(blobs,"readContentAddressedBlob").mockImplementationOnce(async(...args)=>{const bytes=await original(...args);f.invalidate();return bytes;});
    await expect(binding.receive({kind:"product.source.operation.result.v1",node_id:f.destination.nodeId,command_id:command.id,payload:result})).rejects.toThrow("session");
    expect((await f.ops()).find(v=>v.id===operation.id)!.result).toBeNull();
  });
  it("retains a bound closed verifier failure as evidence without qualifying it",async()=>{
    const f=await prepareHandoff();await uploadHandoff(f);const operation=(await f.ops()).find(v=>v.kind==="import_verify")!,binding=f.binding(f.destination.nodeId),command=await binding.dispatch(operation.id);
    const result=controlledDestinationResult(ProductSourceOperationV1Schema.parse(operation.payload),f.researchBytes);if(result.outcome!=="verified")throw Error("Controlled verifier result missing");
    result.fresh.verification.outcome="failed";result.fresh.verification.reason="Controlled closed verification failure";
    delete result.fresh.verification.measurement_plan;
    for(const check of result.fresh.verification.checks){delete check.observation;check.exit_code=1;}
    await binding.receive({kind:"product.source.operation.result.v1",node_id:f.destination.nodeId,command_id:command.id,payload:result});
    await expect(binding.qualify(operation.id)).rejects.toThrow("Fresh destination receipt");expect((await f.ops()).find(v=>v.id===operation.id)!.result).toEqual(result);
    expect((await server.db.db.select().from(goalProductHandoffs))[0]!.qualifiedReceipt).toBe(false);
  });
  it("rechecks credential expiration after blob I/O while the same transport remains current",async()=>{
    const f=await prepareHandoff();await uploadHandoff(f);const operation=(await f.ops()).find(v=>v.kind==="import_verify")!,binding=f.binding(f.destination.nodeId),command=await binding.dispatch(operation.id);
    const result=controlledDestinationResult(ProductSourceOperationV1Schema.parse(operation.payload),f.researchBytes),original=blobs.readContentAddressedBlob;
    const now=Date.parse(f.actor.clock.nowIso());await server.db.db.update(deviceTokens).set({expiresAt:new Date(now+60000).toISOString()})
      .where(eq(deviceTokens.tokenLookup,parseDeviceToken(f.destination.node_token)!.lookup));
    vi.spyOn(blobs,"readContentAddressedBlob").mockImplementationOnce(async(...args)=>{const bytes=await original(...args);vi.spyOn(f.actor.clock,"nowIso").mockReturnValue(new Date(now+60001).toISOString());return bytes;});
    await expect(binding.receive({kind:"product.source.operation.result.v1",node_id:f.destination.nodeId,command_id:command.id,payload:result})).rejects.toThrow("credential");
    expect((await f.ops()).find(v=>v.id===operation.id)!.result).toBeNull();
  });
  it("enforces immutable database identities and results independently of the service",async()=>{
    const f=await prepareHandoff(),{operation,binding,command,result}=await uploadHandoff(f);
    await binding.receive({kind:"product.source.operation.result.v1",node_id:f.source.nodeId,command_id:command.id,payload:structuredClone(result)});
    await expect(server.db.db.update(goalProductHandoffs).set({policyVersion:"changed"}).where(eq(goalProductHandoffs.id,f.base.transfer_id))).rejects.toThrow();
    await expect(server.db.db.update(goalProductHandoffOperations).set({computerId:f.destination.nodeId}).where(eq(goalProductHandoffOperations.id,operation.id))).rejects.toThrow();
    await expect(server.db.db.update(goalProductHandoffOperations).set({result:{...result,reason:"changed"}}).where(eq(goalProductHandoffOperations.id,operation.id))).rejects.toThrow();
  });
  it("keeps migrated CHECK/UNIQUE constraints aligned with the declared Drizzle tables",async()=>{
    for(const table of [goalProductHandoffs,goalProductHandoffOperations,goalProductHandoffDeliveries]){
      const declared=getTableConfig(table),expected=[...declared.checks.map(check=>check.name),...declared.uniqueConstraints.map(constraint=>constraint.getName())].sort();
      const actual=(await server.db.db.execute(sql`SELECT conname FROM pg_constraint WHERE conrelid=to_regclass(${declared.name}) AND contype IN ('c','u') ORDER BY conname`)).rows;
      expect(actual.map((row:{conname:string})=>String(row.conname)).sort()).toEqual(expected);
    }
  });
});
