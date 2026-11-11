import { agentInstances, autonomousReviews, computers, contextPacks, runEventIngest, eventLog, goalAutomations, goals, memberSuspensions,
  messages, plans, productSourceTransfers, runs, tasks, users } from "@artoo/db";
import { canonicalProductSourceTransferValueV1, ProductSourceExportV1Schema, ProductSourceTransferRequestV1Schema, productSourceTransferRequestDigestV1 } from "@artoo/domain";
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testDeviceAuthConfig } from "./config/device-auth.js";
import { buildAiDataSharingPolicy } from "./config/ai-data-sharing.js";
import { aiDataSharingState, grantAiDataSharingConsent, revokeAiDataSharingConsent } from "./services/ai-data-sharing-service.js";
import { createPairing, revokeDevice } from "./services/device-service.js";
import { setMemberSuspension } from "./services/member-suspension-service.js";
import { admitProductSourceTransfer } from "./services/product-source-transfer-service.js";
import { prepareTransferReviewFixture } from "./test-fixtures/product-source-transfer-review.js";
import { measurementPlanEvidenceFixture } from "./test-fixtures/measurement-plan.js";
import { buildTestServer, type TestServer } from "./test-support.js";
import * as blobs from "./content-addressed-blob.js";
import { ingestRunEvent, ingestWireRunEvent } from "./services/run-service.js";
import { qualifyRunEventMessage } from "./services/run-event-receipt.js";
import { MemoryArtifactStore } from "./test-fixtures/memory-artifact-store.js";

const sha = (bytes: string | Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
describe("paired-node product source byte transport (controlled receipts, no execution authority)", () => {
  let server: TestServer, directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "artoo-transfer-"));
    server = await buildTestServer({ artifactDir: directory, workspaceRoot: "/workspace/product", authConfig: { enforceApiAuth: true },
      deviceAuth: testDeviceAuthConfig({ devNodeToken: "dev", devControlEscape: false }) });
  });
  afterEach(async () => { vi.restoreAllMocks(); await server?.close(); await rm(directory, { recursive: true, force: true }); });

  async function paired(name: string, actorUserId = server.ctx.actorUserId) {
    const code = await createPairing({ ...server.ctx, actorUserId }, { pepper: server.ctx.deviceAuth.pairingPepper, ttlMs: 60000 }, { createdByUserId: actorUserId });
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
  async function prepare(pairingUserId = server.ctx.actorUserId, largeCapsule = false, completionReason?: string | null) {
    const source = await paired("source", pairingUserId), destination = await paired("destination", pairingUserId), other = await paired("other", pairingUserId);
    await server.db.db.update(agentInstances).set({ computerId: source.nodeId }).where(eq(agentInstances.id, "instance_mock_coder"));
    const f = measurementPlanEvidenceFixture(), review = await prepareTransferReviewFixture(server, f);
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
    server.ctx.supportsExecutionFeature = (nodeId, feature) => [source.nodeId, destination.nodeId].includes(nodeId) && feature === "product-source-transfer.v1";
    server.ctx.supportsVerificationProfile = (nodeId, profile, project, workspace) => nodeId === destination.nodeId && profile === "default"
      && project === "proj_artoo" && workspace === "/destination/product";
    server.ctx.getVerificationCapabilities = () => structuredClone(f.capabilities);
    const manifest = { entries: [{ path: ".artoo/product", kind: "directory" }, { path: "product", kind: "directory" }] };
    const capsule = { version: 1, kind: "artoo.product-source.v1", source: { project_id: "proj_artoo", profile_id: "default",
      profile_digest: f.payload.profile_digest, subject_digest: f.payload.subject_digest }, manifest, manifest_digest: sha(JSON.stringify(manifest)), files: [] };
    if (largeCapsule) {
      const content = Buffer.alloc(8 * 1024 * 1024, 97);
      (capsule.manifest.entries as unknown[]).push({ path: "product/large.bin", kind: "file", checksum: sha(content), size: content.length });
      (capsule.files as unknown[]).push({ path: "product/large.bin", base64: content.toString("base64") });
      capsule.manifest_digest = sha(JSON.stringify(capsule.manifest));
    }
    // Controlled server protocol fixture only; the native runtime suite establishes actual process provenance.
    const bytes = Buffer.from(JSON.stringify(capsule));
    const request = ProductSourceTransferRequestV1Schema.parse({ version: 1, kind: "product-source-transfer.v1", transfer_id: "transfer_fixture",
      organization_id: server.ctx.organizationId, project_id: "proj_artoo", goal_id: "measurement_goal", plan_id: "transfer_plan",
      authorization: { actor_user_id: server.ctx.actorUserId, consent_id: null, policy_version: server.ctx.aiDataSharingPolicy!.version },
      source: { node_id: source.nodeId, task_id: review.source.run.taskId, run_id: review.source.run.id, evidence_id: review.source.evidence.id,
        verification_request_id: f.payload.request_id, profile_id: "default", profile_digest: f.payload.profile_digest, workspace_root: "/workspace/product",
        subject_digest: f.payload.subject_digest, review_id: "measurement_review", reviewer_run_id: review.peer.run.id, reviewer_evidence_id: review.peer.evidence.id,
        capsule_digest: sha(bytes), manifest_digest: capsule.manifest_digest, capsule_bytes: bytes.length },
      destination: { node_id: destination.nodeId, profile_id: "default", workspace_root: "/destination/product",
        capabilities: f.capabilities, capability_digest: sha(canonicalProductSourceTransferValueV1(f.capabilities)) } });
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
    const hash = (value: unknown) => sha(canonicalProductSourceTransferValueV1(value));
    const proof = ProductSourceExportV1Schema.parse({ version: 1, export_id: hash({ run_id: request.source.run_id,
      request_id: request.source.verification_request_id, capsule_digest: request.source.capsule_digest }),
      node_id: source.nodeId, run_id: request.source.run_id, task_id: request.source.task_id, project_id: request.project_id,
      goal_id: request.goal_id, plan_id: request.plan_id, verification_request_id: f.payload.request_id, profile_id: "default",
      profile_digest: f.payload.profile_digest, subject_digest: f.payload.subject_digest, context_digest: hash(review.source.context),
      verification_digest: hash(review.source.evidence.payload), capsule_digest: request.source.capsule_digest,
      manifest_digest: request.source.manifest_digest, capsule_bytes: bytes.length,
      author_closure: "windows-job-and-tools-closed.v1", execution_authorized: false });
    const exportFrame = { kind: "run.event", node_id: source.nodeId, run_id: review.source.run.id, sequence: 2,
      event: { type: "run.product-source.export.v1", payload: proof } };
    await ingestWireRunEvent(server.ctx, exportFrame);
    const terminalFrame = { kind: "run.event", node_id: source.nodeId, run_id: review.source.run.id, sequence: 3,
      event: { type: "run.lifecycle", payload: { phase: "completed", ...(completionReason === undefined ? {} : { reason: completionReason }) } } };
    await ingestWireRunEvent(server.ctx, terminalFrame);
    await server.db.db.update(tasks).set({ status: "done" }).where(eq(tasks.id, review.source.run.taskId));
    const actor = { ...server.ctx, automationActor: { type: "system" as const, id: "goal_runner" as const } };
    const digest = productSourceTransferRequestDigestV1(request, sha);
    const url = `/api/v1/node/product-source-transfers/${request.transfer_id}/content`;
    const headers = (token: string, override: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`,
      "x-artoo-transfer-request-digest": digest, "x-artoo-checksum": sha(bytes), ...override });
    const upload = (token = source.node_token, payload = bytes, extra: Record<string, string> = {}) => server.app.inject({ method: "PUT", url,
      headers: headers(token, { "content-type": "application/octet-stream", ...extra }), payload });
    const download = (token = destination.node_token) => server.app.inject({ method: "GET", url, headers: headers(token) });
    return { source, destination, other, review, request, actor, digest, bytes, upload, download, headers, url, proof, exportFrame, terminalFrame };
  }

  it("retains and transports source capsules through an injected object store without a directory", async () => {
    await server.close();
    const store = new MemoryArtifactStore();
    server = await buildTestServer({ artifactStore: store, workspaceRoot: "/workspace/product", authConfig: { enforceApiAuth: true },
      deviceAuth: testDeviceAuthConfig({ devNodeToken: "dev", devControlEscape: false }) });
    const f = await prepare();
    await admitProductSourceTransfer(f.actor, f.request);
    expect((await f.upload()).statusCode).toBe(200);
    const downloaded = await f.download();
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.rawPayload).toEqual(f.bytes);
    expect(store.writes).toContain(f.request.source.capsule_digest);
    expect(store.reads).toContain(f.request.source.capsule_digest);
    expect((await f.download(f.other.node_token)).statusCode).toBe(403);
    vi.spyOn(store, "read").mockRejectedValue(new Error("Object store unavailable"));
    expect((await f.download()).statusCode).toBe(500);
  });

  it("persists full admission, replays identical requests and transports exact bytes only to the selected node", async () => {
    const f = await prepare(), accepted = await admitProductSourceTransfer(f.actor, f.request);
    expect(accepted).toMatchObject({ status: "awaiting_upload", execution_authorized: false, request_digest: f.digest });
    expect(await admitProductSourceTransfer(f.actor, JSON.parse(JSON.stringify(f.request)))).toEqual(accepted);
    expect((await f.download()).statusCode).toBe(409);
    expect((await f.upload()).json()).toMatchObject({ transfer: { status: "available", execution_authorized: false } });
    expect((await f.upload()).statusCode).toBe(200);
    const downloaded = await f.download();
    expect(downloaded.statusCode).toBe(200); expect(downloaded.rawPayload).toEqual(f.bytes);
    expect(downloaded.headers["x-artoo-checksum"]).toBe(f.request.source.capsule_digest);
    expect((await server.db.db.select().from(productSourceTransfers))).toHaveLength(1);
    expect((await server.db.db.select().from(runs))).toHaveLength(2); // No destination task/run is authorized or created.
    const changed = structuredClone(f.request); changed.source.capsule_digest = sha("replacement");
    await expect(admitProductSourceTransfer(f.actor, changed)).rejects.toThrow("export");
    await expect(server.db.db.update(productSourceTransfers).set({ requestDigest: sha("replacement") })).rejects.toThrow();
    await expect(server.db.db.update(productSourceTransfers).set({ status: "awaiting_upload", availableAt: null, uploadedByDeviceId: null })).rejects.toThrow();
    await expect(server.db.db.delete(productSourceTransfers)).rejects.toThrow();
  });

  it.each([undefined, null])("admits the original completed wire frame with reason %s without normalizing replay", async reason => {
    const f = await prepare(undefined, false, reason);
    const receipt = and(eq(runEventIngest.runId, f.review.source.run.id), eq(runEventIngest.sequence, f.terminalFrame.sequence));
    const [before] = await server.db.db.select({ bodyIdentity: runEventIngest.bodyIdentity }).from(runEventIngest).where(receipt);
    expect(before?.bodyIdentity).toBe(qualifyRunEventMessage(f.terminalFrame).bodyIdentity);
    await expect(ingestWireRunEvent(server.ctx, f.terminalFrame)).resolves.toMatchObject({ deduped: true });
    const changed = { ...f.terminalFrame, event: { type: "run.lifecycle",
      payload: reason === null ? { phase: "completed" } : { phase: "completed", reason: null } } };
    expect(qualifyRunEventMessage(changed).bodyIdentity).not.toBe(qualifyRunEventMessage(f.terminalFrame).bodyIdentity);
    await expect(ingestWireRunEvent(server.ctx, changed)).rejects.toThrow("body mismatch");
    await expect(admitProductSourceTransfer(f.actor, f.request)).resolves.toMatchObject({ status: "awaiting_upload" });
    const [after] = await server.db.db.select({ bodyIdentity: runEventIngest.bodyIdentity }).from(runEventIngest).where(receipt);
    expect(after).toEqual(before);
  });

  it.each(["", "unexpected success detail"])("does not qualify a completed wire frame with reason %j", async reason => {
    const f = await prepare(undefined, false, reason);
    await expect(admitProductSourceTransfer(f.actor, f.request)).rejects.toThrow("export");
    expect(await server.db.db.select().from(productSourceTransfers)).toHaveLength(0);
  });

  it.each(["failed", "cancelled", "sequence", "node", "missing-receipt"])(
    "rejects a completed domain event with a mismatched %s receipt", async kind => {
      const reason = null, f = await prepare(undefined, false, reason);
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
      await expect(admitProductSourceTransfer(f.actor, f.request)).rejects.toThrow("export");
      expect(await server.db.db.select().from(productSourceTransfers)).toHaveLength(0);
    });

  it("requires the qualified owning-node export and original frame replay", async () => {
    const f = await prepare();
    await expect(ingestWireRunEvent(server.ctx, f.exportFrame)).resolves.toMatchObject({ deduped: true });
    await expect(ingestRunEvent(server.ctx, { nodeId: f.source.nodeId, runId: f.request.source.run_id, sequence: 2,
      event: { kind: "product_source_export", proof: f.proof } })).rejects.toThrow("qualified node");
    await expect(ingestWireRunEvent(server.ctx, { ...f.exportFrame, node_id: f.other.nodeId })).rejects.toThrow("owned by this node");
    await expect(ingestWireRunEvent(server.ctx, { ...f.exportFrame, event: { ...f.exportFrame.event,
      payload: { ...f.proof, capsule_digest: sha("replacement") } } })).rejects.toThrow("body mismatch");
    await server.db.db.update(runEventIngest).set({ bodyIdentity: null }).where(eq(runEventIngest.eventId, f.review.source.evidence.eventId));
    await expect(admitProductSourceTransfer(f.actor, f.request)).rejects.toThrow("export");
  });

  it("does not infer an export from verification, capsule metadata or unqualified completion", async () => {
    const f = await prepare();
    const [exportEvent] = await server.db.db.select().from(eventLog).where(eq(eventLog.type, "run.product-source.export.v1"));
    await server.db.db.update(runEventIngest).set({ bodyIdentity: null }).where(eq(runEventIngest.eventId, exportEvent!.id));
    await expect(admitProductSourceTransfer(f.actor, f.request)).rejects.toThrow("export");
    await server.db.db.update(runEventIngest).set({ bodyIdentity: qualifyRunEventMessage(f.exportFrame).bodyIdentity })
      .where(eq(runEventIngest.eventId, exportEvent!.id));
    const [terminal] = await server.db.db.select().from(eventLog).where(eq(eventLog.type, "run.completed"));
    await server.db.db.update(runEventIngest).set({ bodyIdentity: null }).where(eq(runEventIngest.eventId, terminal!.id));
    await expect(admitProductSourceTransfer(f.actor, f.request)).rejects.toThrow("export");
  });

  it("rejects control, missing, dev and wrong-node credentials even when the general dev escape exists", async () => {
    const f = await prepare(); await admitProductSourceTransfer(f.actor, f.request);
    for (const token of [f.source.control_token, "", "dev", f.destination.node_token, f.other.node_token]) expect((await f.upload(token)).statusCode).toBe(403);
    expect((await f.upload()).statusCode).toBe(200);
    for (const token of [f.destination.control_token, "", "dev", f.source.node_token, f.other.node_token]) expect((await f.download(token)).statusCode).toBe(403);
    expect((await server.app.inject({ method: "POST", url: f.url, headers: f.headers(f.source.node_token) })).statusCode).toBe(401);
    expect((await server.app.inject({ method: "GET", url: `${f.url}/extra`, headers: f.headers(f.destination.node_token) })).statusCode).toBe(401);
  });

  it("rejects absent internal attribution, foreign organization, wrong source/review/evidence/profile and request digest", async () => {
    const f = await prepare();
    await expect(admitProductSourceTransfer(server.ctx, f.request)).rejects.toThrow("Only the goal runner");
    for (const key of ["run_id", "task_id", "evidence_id", "verification_request_id", "review_id", "reviewer_run_id", "reviewer_evidence_id", "profile_id"] as const) {
      const request = structuredClone(f.request); request.source[key] = "wrong";
      await expect(admitProductSourceTransfer(f.actor, request)).rejects.toThrow();
    }
    await expect(admitProductSourceTransfer(f.actor, { ...f.request, organization_id: "foreign" })).rejects.toThrow("organization");
    const changed = structuredClone(f.request); changed.destination.capability_digest = sha("different");
    await expect(admitProductSourceTransfer(f.actor, changed)).rejects.toThrow("capability digest");
    await admitProductSourceTransfer(f.actor, f.request);
    expect((await f.upload(f.source.node_token, f.bytes, { "x-artoo-transfer-request-digest": sha("other") })).statusCode).toBe(409);
  });

  it.each(["paused", "cancelled", "plan", "automation", "policy", "member", "capabilities", "profile", "feature", "offline", "latest", "review", "evidence", "source_pair", "destination_pair"])(
    "rechecks %s after availability and never treats a stored accepted flag as authority", async kind => {
      const f = await prepare(); await admitProductSourceTransfer(f.actor, f.request); expect((await f.upload()).statusCode).toBe(200);
      const db = server.db.db;
      if (kind === "paused" || kind === "cancelled") await db.update(goals).set({ status: kind }).where(eq(goals.id, f.request.goal_id));
      if (kind === "plan") await db.update(goals).set({ currentPlanId: "replacement" }).where(eq(goals.id, f.request.goal_id));
      if (kind === "automation") await db.update(goalAutomations).set({ status: "cancelled" }).where(eq(goalAutomations.goalId, f.request.goal_id));
      if (kind === "policy") server.ctx.aiDataSharingPolicy = null;
      if (kind === "member") await db.insert(memberSuspensions).values({ userId: server.ctx.actorUserId, organizationId: server.ctx.organizationId,
        suspendedByUserId: server.ctx.actorUserId, reason: "withdraw authorization", suspendedAt: server.ctx.clock.nowIso() });
      if (kind === "capabilities") server.ctx.getVerificationCapabilities = () => undefined;
      if (kind === "profile") server.ctx.supportsVerificationProfile = () => false;
      if (kind === "feature") server.ctx.supportsExecutionFeature = () => false;
      if (kind === "offline") await db.update(computers).set({ status: "offline" }).where(eq(computers.id, f.destination.nodeId));
      if (kind === "latest") await db.insert(runs).values({ ...f.review.source.run, id: "zz_replacement", createdAt: "2026-06-14T00:00:00Z" });
      if (kind === "review") await db.update(messages).set({ body: JSON.stringify({ ...f.review.verdict, outcome: "changes_requested" }) }).where(eq(messages.id, "measurement_response"));
      if (kind === "evidence") await db.update(eventLog).set({ actorId: "wrong-node" }).where(eq(eventLog.id, f.review.source.evidence.eventId));
      if (kind === "source_pair") await revokeDevice(server.ctx, f.source.device.id);
      if (kind === "destination_pair") await revokeDevice(server.ctx, f.destination.device.id);
      const response = await f.download(); expect(response.statusCode).toBeGreaterThanOrEqual(400); expect(response.rawPayload).not.toEqual(f.bytes);
      expect((await f.upload()).statusCode).toBeGreaterThanOrEqual(400);
    });

  it("rechecks authorization after asynchronous upload before marking content available", async () => {
    const f = await prepare(); await admitProductSourceTransfer(f.actor, f.request);
    const write = blobs.writeContentAddressedBlob;
    vi.spyOn(blobs, "writeContentAddressedBlob").mockImplementation(async (path, bytes) => {
      await write(path, bytes); await server.db.db.update(goals).set({ status: "paused" }).where(eq(goals.id, f.request.goal_id));
    });
    expect((await f.upload()).statusCode).toBe(409);
    expect((await server.db.db.select().from(productSourceTransfers))[0]).toMatchObject({ status: "awaiting_upload", availableAt: null });
    expect(await readFile(join(directory, f.request.source.capsule_digest.slice(7)))).toEqual(f.bytes); // Retained unreferenced blob, not a false receipt.
  });

  it("rechecks node revocation after asynchronous download and rejects corrupt/missing storage", async () => {
    const f = await prepare(); await admitProductSourceTransfer(f.actor, f.request); expect((await f.upload()).statusCode).toBe(200);
    const path = join(directory, f.request.source.capsule_digest.slice(7));
    await writeFile(path, Buffer.alloc(f.bytes.length, 1)); expect((await f.download()).statusCode).toBe(409);
    await rm(path); expect((await f.download()).statusCode).toBe(409);
    await writeFile(path, f.bytes);
    const read = blobs.readContentAddressedBlob;
    vi.spyOn(blobs, "readContentAddressedBlob").mockImplementation(async (...args) => { const result = await read(...args); await revokeDevice(server.ctx, f.destination.device.id); return result; });
    expect((await f.download()).statusCode).toBe(403);
  });

  it("rejects changed bytes, checksum/header substitution and oversized bodies without availability", async () => {
    const f = await prepare(); await admitProductSourceTransfer(f.actor, f.request);
    expect((await f.upload(f.source.node_token, Buffer.from("{}"))).statusCode).toBe(400);
    expect((await f.upload(f.source.node_token, f.bytes, { "x-artoo-checksum": sha("wrong") })).statusCode).toBe(400);
    expect((await f.upload(f.source.node_token, Buffer.alloc(12 * 1024 * 1024 + 1))).statusCode).toBe(413);
    const changed = structuredClone(f.request); changed.transfer_id = "wrong_manifest"; changed.source.manifest_digest = sha("wrong");
    await expect(admitProductSourceTransfer(f.actor, changed)).rejects.toThrow("export");
    expect((await server.db.db.select().from(productSourceTransfers)).every(row => row.status === "awaiting_upload")).toBe(true);
  });

  it("keeps the ordinary artifact route's authorization and 10 MiB limit after shared blob extraction", async () => {
    const f = await prepare();
    await server.db.db.update(runs).set({ status: "running" }).where(eq(runs.id, f.request.source.run_id));
    const url = `/api/v1/node/runs/${f.request.source.run_id}/artifacts?type=patch&path=changes.patch`;
    const payload = Buffer.from("ordinary artifact"), headers = { authorization: `Bearer ${f.source.node_token}`,
      "content-type": "application/octet-stream", "x-artoo-checksum": sha(payload) };
    expect((await server.app.inject({ method: "PUT", url, headers: { ...headers, authorization: `Bearer ${f.source.control_token}` }, payload })).statusCode).toBe(403);
    expect((await server.app.inject({ method: "PUT", url, headers, payload: Buffer.alloc(10 * 1024 * 1024 + 1) })).statusCode).toBe(413);
    const uploaded = await server.app.inject({ method: "PUT", url, headers, payload });
    expect(uploaded.statusCode).toBe(201);
    const download = await server.app.inject({ method: "GET", url: uploaded.json().artifact.uri, headers: { authorization: `Bearer ${f.source.control_token}` } });
    expect(download.statusCode).toBe(200); expect(download.rawPayload).toEqual(payload);
    expect((await server.app.inject({ method: "GET", url: uploaded.json().artifact.uri, headers: { authorization: `Bearer ${f.source.node_token}` } })).statusCode).toBe(401);
    expect(await server.db.db.select().from(productSourceTransfers)).toEqual([]);
  });

  it("accepts a bounded capsule between 10 and 12 MiB through the separate parser", async () => {
    const f = await prepare(server.ctx.actorUserId, true), bytes = f.bytes, request = f.request;
    expect(bytes.length).toBeGreaterThan(10 * 1024 * 1024); expect(bytes.length).toBeLessThan(12 * 1024 * 1024);
    const receipt = await admitProductSourceTransfer(f.actor, request);
    const response = await server.app.inject({ method: "PUT", url: f.url, payload: bytes,
      headers: f.headers(f.source.node_token, { "content-type": "application/octet-stream", "x-artoo-checksum": sha(bytes),
        "x-artoo-transfer-request-digest": receipt.request_digest }) });
    expect(response.statusCode).toBe(200); expect(response.json()).toMatchObject({ transfer: { execution_authorized: false } });
  });

  it("does not revive a transfer when its original consent is revoked and replaced", async () => {
    const f = await prepare();
    const policy = buildAiDataSharingPolicy({ mode: "external", providers: [{ id: "fixture", name: "Controlled fixture", privacy_url: "https://example.com/privacy" }] });
    server.ctx.aiDataSharingPolicy = policy; f.actor.aiDataSharingPolicy = policy;
    await grantAiDataSharingConsent(server.ctx, policy.version);
    const original = (await aiDataSharingState(server.ctx)).consent!;
    f.request.authorization.consent_id = original.id; f.request.authorization.policy_version = policy.version;
    await server.db.db.update(goalAutomations).set({ consentId: original.id, policyVersion: policy.version }).where(eq(goalAutomations.goalId, f.request.goal_id));
    const admitted = await admitProductSourceTransfer(f.actor, f.request);
    const headers = { "content-type": "application/octet-stream", "x-artoo-transfer-request-digest": admitted.request_digest };
    expect((await f.upload(f.source.node_token, f.bytes, headers)).statusCode).toBe(200);
    await revokeAiDataSharingConsent(server.ctx); await grantAiDataSharingConsent(server.ctx, policy.version);
    expect((await aiDataSharingState(server.ctx)).consent!.id).not.toBe(original.id);
    const response = await server.app.inject({ method: "GET", url: f.url,
      headers: f.headers(f.destination.node_token, { "x-artoo-transfer-request-digest": admitted.request_digest }) });
    expect(response.statusCode).toBe(428); expect(response.rawPayload).not.toEqual(f.bytes);
    await expect(admitProductSourceTransfer(f.actor, f.request)).rejects.toThrow("AI data sharing");
  });

  it("keeps node enroller authorization distinct from the original goal user", async () => {
    await server.db.db.insert(users).values({ id: "device_admin", organizationId: server.ctx.organizationId, email: "device-admin@example.com",
      displayName: "Different device administrator", role: "admin", createdAt: server.ctx.clock.nowIso() });
    const f = await prepare("device_admin");
    expect(f.request.authorization.actor_user_id).toBe("user_owner");
    await admitProductSourceTransfer(f.actor, f.request); expect((await f.upload()).statusCode).toBe(200);
    const suspended = await setMemberSuspension(server.ctx, "device_admin", true, "Revoke this separate device owner's access");
    expect(suspended.revoked_device_ids).toContain(f.source.device.id);
    expect((await f.download()).statusCode).toBe(403);
    await expect(admitProductSourceTransfer(f.actor, f.request)).rejects.toThrow("no longer paired");
  });
});
