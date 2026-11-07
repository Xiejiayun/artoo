import { requireRunAiSharingAuthorization } from "./services/ai-data-sharing-service.js";
import { createGoalImportedProductReviewBinding } from "./services/imported-product-review-service.js";
import { createGoalProductHandoffBinding } from "./services/goal-product-handoff-service.js";
import { createImportedDesignContinuationBinding } from "./services/imported-design-continuation-service.js";
import { goalImportedDesignContinuations } from "@artoo/db";
import { ImportedDesignContinuationResultV1Schema, IMPORTED_DESIGN_CONTINUATION_FEATURE_V1 } from "@artoo/domain";
import { goalProductHandoffs, goalProductHandoffOperations } from "@artoo/db";
import type { AuthenticatedTransferNode } from "./services/product-source-transfer-service.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { agentInstances, assistantRunDispatches, assistantTurns, computers, contextPacks, goalAutomations, goals, productReleases, runs, tasks } from "@artoo/db";
import { assertDesignRevisionRunAdmission, assertNoActiveDesignRevision } from "./services/product-design-revision-guard.js";
import { ContextPackSchema, ID_PREFIXES, VerificationRequirementSchema, VerificationProfileAdvertisementsSchema,
  type VerificationProfileAdvertisement, ReleaseProfileAdvertisementsSchema, ProductReleaseRequestSchema,
  type ReleaseProfileAdvertisement, type VerificationCapabilities, type ReleaseCapabilitiesV1 } from "@artoo/domain";
import { NodeOwnedResultProfileDescriptorsV1Schema, type NodeOwnedResultProfileDescriptorV1 } from "@artoo/domain";
import type {
  NodeToServerMessage,
  NodeTransport,
  RunResumeCommand,
  RunStartCommand,
  RunStartOwnedResultCommand,
  RunStopCommand,
  Unsubscribe,
} from "@artoo/protocol";
import { and, eq } from "drizzle-orm";

import type { ServerContext } from "./context.js";
import { canDispatchAssistantRun } from "./services/assistant-service.js";
import { AppError } from "./errors.js";
import { validatePersistedAllocationStart } from "./persisted-allocation-start.js";
import { ingestProductReleaseReceipt, ingestProductReleaseHealthReport } from "./services/product-release-service.js";
import { verificationCapabilityBinding } from "./services/verification-capabilities.js";
import { canonicalAutomationWorkspace } from "./services/automation-workspace.js";
import { OWNED_RESULT_FEATURE, parseOwnedResultAssignment, assertOwnedResultStoredContext,
  assertOwnedResultDispatchInput } from "./services/owned-result-service.js";
import {
  cancelRun,
  failRunDaemonDisconnect,
  failRunStart,
  ingestWireRunEvent,
} from "./services/run-service.js";

const FALLBACK_WORKSPACE_ROOT = join(tmpdir(), "artoo-workspace");

export interface NodeBinding {
  /** Exact feature support from this current accepted hello; false once disposed. */
  supportsExecutionFeature(feature: string): boolean;
  /** Exact node-local profile routing, valid only for this active authenticated session. */
  supportsVerificationProfile(profileId: string, projectId: string, workspaceRoot: string): boolean;
  /** Unique current advertisement, preserving its exact spelling; Windows comparison is lexical only. */
  getVerificationWorkspace(profileId: string, projectId: string, workspaceRoot: string): string | undefined;
  getOwnedResultProfile?(resultProfileId: string, verifierTemplateId: string, projectId: string): NodeOwnedResultProfileDescriptorV1 | undefined;
  getVerificationCapabilities?(profileId: string, projectId: string, workspaceRoot: string): VerificationCapabilities | undefined;
  supportsReleaseProfile?(profileId: string, projectId: string, workspaceRoot: string, verificationProfileId: string): boolean;
  getReleaseCapabilities?(profileId: string, projectId: string, workspaceRoot: string, verificationProfileId: string): ReleaseCapabilitiesV1 | undefined;
  dispatchProductRelease?(releaseId: string): Promise<void>;
  dispatchProductReleaseCancel?(releaseId: string): Promise<void>;
  dispatchImportedProductReview?(reviewId: string, control: "start" | "stop" | "status"): Promise<void>;
  dispatchProductSourceOperation?(operationId: string, control: "start" | "stop" | "status" | "qualify"): Promise<void>;
  dispatchImportedDesignContinuation?(continuationId: string, control: "start" | "stop" | "status"): Promise<void>;
  /** Build + send run.start for a queued run over the node transport. */
  dispatchRunStart(runId: string): Promise<void>;
  /** Build + send run.resume for an already-active run (#115 P2-S3 reconnect). */
  dispatchRunResume(runId: string): Promise<void>;
  /** Resolves only after the node has confirmed that the process is stopped. */
  dispatchRunStop(runId: string): Promise<void>;
  /** Deliver frames buffered by the WebSocket authentication handshake. */
  receive(message: NodeToServerMessage): void;
  /** Resolves once all received run-events have been ingested (test sync point). */
  drain(): Promise<void>;
  close(): void;
}

/**
 * Server side of the node protocol. Owns a {@link NodeTransport}: dispatches
 * run.start / run.resume commands, and ingests Node->Server messages — run.event
 * through the qualified full-frame {@link ingestWireRunEvent} receiver,
 * rejected run.start command.ack through {@link failRunStart} recovery, and
 * rejected run.resume command.ack through the daemon_disconnect failure path.
 *
 * Incoming run-events are serialized (the in-process transport delivers them
 * synchronously and the node streams in sequence order) so run/task transitions
 * apply in order. A real artood swaps the in-process transport for a WebSocket;
 * this binding is unchanged.
 */
export function attachNodeBinding(
  ctx: ServerContext,
  transport: NodeTransport,
  computerId: string,
  executionFeatures: readonly string[] = [],
  isCurrentBinding: () => boolean = () => true,
  verificationProfiles: readonly VerificationProfileAdvertisement[] = [],
  releaseProfiles: readonly ReleaseProfileAdvertisement[] = [],
  ownedResultProfiles: readonly NodeOwnedResultProfileDescriptorV1[] = [],
  managedResultReady: () => boolean = () => false,
  nodeOs?: string,
  importedReviewOptions?: { identity: AuthenticatedTransferNode; sessionId: string; artifactDir: string; qualifiedRunEventReceiptsReady?: () => boolean },
): NodeBinding {
  // Copy the accepted hello snapshot so later caller mutation cannot change it.
  const executionFeatureSet = new Set(executionFeatures);
  const profileSnapshot = Object.freeze(VerificationProfileAdvertisementsSchema.parse(verificationProfiles)
    .map((profile) => Object.freeze(profile)));
  const releaseSnapshot = Object.freeze(ReleaseProfileAdvertisementsSchema.parse(releaseProfiles).map((profile) => Object.freeze(profile)));
  const ownedResultSnapshot = NodeOwnedResultProfileDescriptorsV1Schema.parse(ownedResultProfiles);
  if (ownedResultSnapshot.some(profile => profile.node_id !== computerId)) throw AppError.permissionDenied("Owned result descriptors belong to another node");
  const pendingCommandRun = new Map<string, string>(); // command_id -> run_id (run.start)
  const pendingResumeRun = new Map<string, { runId: string; timer: ReturnType<typeof setTimeout> }>();
  const pendingStops = new Map<string, { runId: string; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const pendingReleaseStops = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const stoppingRuns = new Map<string, Promise<void>>();
  const pendingDesignStops = new Map<string, { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  // Coalesces only this binding's concurrent calls, never durable node ownership.
  const startingRuns = new Map<string, Promise<void>>();
  // Only this live binding can rely on its node's in-memory start deduplication.
  // A new connection/server must treat an exposed durable intent as uncertain.
  const exposedAssistantRuns = new Set<string>();
  let closed = false;
  const importedReviews = importedReviewOptions && createGoalImportedProductReviewBinding(ctx, {
    ...importedReviewOptions, transport, isCurrent: () => !closed && isCurrentBinding(),
  });
  const importedDesigns = importedReviewOptions && createImportedDesignContinuationBinding(ctx, {
    identity: importedReviewOptions.identity, sessionId: importedReviewOptions.sessionId, transport,
    // Ordinary native Windows nodes commit the same qualified event receipts,
    // without acquiring managed-workspace/session authority.
    isCurrent: () => !closed && isCurrentBinding() && importedReviewOptions.qualifiedRunEventReceiptsReady?.() === true,
  });
  async function importedDesignForRun(runId: string) {
    const [row] = await ctx.db.db.select().from(goalImportedDesignContinuations).where(and(eq(goalImportedDesignContinuations.runId, runId), eq(goalImportedDesignContinuations.organizationId, ctx.organizationId)));
    if (row && row.computerId !== computerId) throw AppError.permissionDenied("Imported design run belongs to another node");
    return row;
  }
  async function stopImportedDesign(row: typeof goalImportedDesignContinuations.$inferSelect): Promise<void> {
    if (!importedDesigns) throw AppError.permissionDenied("Imported design stop requires its paired receipt session");
    if (ImportedDesignContinuationResultV1Schema.safeParse(row.result).data?.closed === true) return;
    const prior = pendingDesignStops.get(row.id); if (prior) return prior.promise;
    let resolve!: () => void, reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    void promise.catch(() => {});
    const timer = setTimeout(() => reject(AppError.conflict("Imported design process closure is still unconfirmed")), 15000);
    pendingDesignStops.set(row.id, { promise, resolve, reject, timer });
    try { await importedDesigns.requestStop(row.id); await importedDesigns.dispatch(row.id, "stop"); await promise; }
    catch (error) { reject(error instanceof Error ? error : new Error(String(error))); throw error; }
    finally { clearTimeout(timer); pendingDesignStops.delete(row.id); }
  }
  async function sourceOperationBinding(operationId: string) {
    if (!importedReviewOptions) throw AppError.permissionDenied("Source operations require a current paired node session and configured artifact store");
    const [record] = await ctx.db.db.select({ actorUserId: goalProductHandoffs.actorUserId }).from(goalProductHandoffOperations)
      .innerJoin(goalProductHandoffs, eq(goalProductHandoffs.id, goalProductHandoffOperations.handoffId))
      .where(and(eq(goalProductHandoffOperations.id, operationId), eq(goalProductHandoffs.organizationId, ctx.organizationId)));
    if (!record) throw AppError.notFound("Source operation not found");
    return createGoalProductHandoffBinding({ ...ctx, actorUserId: record.actorUserId, automationActor: { type: "system", id: "goal_runner" } }, {
      ...importedReviewOptions, transport, isCurrent: () => !closed && isCurrentBinding(),
    });
  }
  async function ownsRun(runId: string): Promise<boolean> {
    const run = (await ctx.db.db.select({ computerId: runs.computerId }).from(runs)
      .where(and(eq(runs.id, runId), eq(runs.organizationId, ctx.organizationId))))[0];
    return run?.computerId === computerId;
  }
  let tail: Promise<void> = Promise.resolve();
  const enqueue = (work: () => Promise<unknown>): void => {
    tail = tail.then(work, work).then(
      () => undefined,
      () => undefined,
    );
  };

  const receive = (message: NodeToServerMessage): void => {
    // The credential-bound identity is authoritative for every inbound frame.
    if (closed || message.node_id !== computerId) return;
    if (message.kind === "product.source.design.ack.v1" || message.kind === "product.source.design.result.v1") {
      if (!importedDesigns || !isCurrentBinding() || importedReviewOptions?.qualifiedRunEventReceiptsReady?.() !== true) return;
      const frame = structuredClone(message);
      enqueue(async () => {
        if (closed || !isCurrentBinding() || importedReviewOptions?.qualifiedRunEventReceiptsReady?.() !== true) return;
        if (frame.kind === "product.source.design.ack.v1") await importedDesigns.acknowledge(frame);
        else {
          await importedDesigns.receive(frame);
          const pending = pendingDesignStops.get(frame.payload.continuation_id);
          if (pending) frame.payload.closed ? pending.resolve() : pending.reject(AppError.conflict("Imported design closure remains uncertain"));
        }
      });
      return;
    }
    if (message.kind === "product.source.operation.ack.v1" || message.kind === "product.source.operation.result.v1") {
      if (!importedReviewOptions || !isCurrentBinding()) return;
      const frame = structuredClone(message);
      enqueue(async () => {
        if (closed || !isCurrentBinding()) return;
        const source = await sourceOperationBinding(frame.payload.operation_id);
        if (frame.kind === "product.source.operation.ack.v1") await source.acknowledge(frame); else await source.receive(frame);
      });
      return;
    }
    if (message.kind === "product.source.review.ack.v1" || message.kind === "product.source.review.result.v1") {
      if (!importedReviews || !isCurrentBinding()) return;
      const frame = structuredClone(message);
      enqueue(async () => {
        if (closed || !isCurrentBinding()) return;
        if (frame.kind === "product.source.review.ack.v1") await importedReviews.acknowledge(frame);
        else await importedReviews.receive(frame);
      });
      return;
    }
    if (message.kind === "product.release.receipt") {
      if (!isCurrentBinding()) return;
      const payload = structuredClone(message.payload);
      enqueue(async () => { if (!closed && isCurrentBinding()) await ingestProductReleaseReceipt(ctx, computerId, payload, () => !closed && isCurrentBinding()); });
    } else if (message.kind === "product.release.health") {
      const payload = structuredClone(message.payload);
      enqueue(async () => {
        let status: "accepted" | "rejected" = "accepted", reason: string | undefined;
        try {
          if (!binding.supportsExecutionFeature("product-release.health.v1")) throw AppError.permissionDenied("Current node session does not support product health reports");
          const [run] = await ctx.db.db.select({ root: runs.workspaceRoot }).from(runs).where(and(eq(runs.id, payload.request.run_id),
            eq(runs.organizationId, ctx.organizationId), eq(runs.computerId, computerId)));
          if (!run?.root) throw AppError.permissionDenied("Health report has no owned publication workspace");
          const authorized = () => binding.supportsExecutionFeature("product-release.health.v1")
            && binding.supportsReleaseProfile?.(payload.request.release_profile_id, payload.request.project_id, run.root!, payload.request.verification_profile_id) === true;
          if (!authorized()) throw AppError.permissionDenied("Current node session does not advertise this publication workspace");
          await ingestProductReleaseHealthReport(ctx, computerId, payload, authorized);
        } catch (error) {
          status = "rejected"; reason = error instanceof Error ? error.message.slice(0, 2000) : "Product health report could not be accepted";
        }
        if (closed) return;
        await transport.send({ kind: "command", id: `health-receipt:${payload.event_id}`,
          idempotency_key: `health-receipt:${payload.event_id}`, type: "product.release.health.ack",
          payload: { event_id: payload.event_id, release_id: payload.request.release_id, sequence: payload.sequence, status,
            ...(reason ? { message: reason } : {}) } });
      });
    } else if (message.kind === "run.event") {
      // Snapshot serialized-wire semantics before queued work can observe caller mutation.
      let frame: typeof message;
      try { frame = JSON.parse(JSON.stringify(message)) as typeof message; } catch { return; }
      enqueue(async () => {
        if (!(await ownsRun(frame.run_id))) return;
        let status: "accepted" | "rejected" = "accepted";
        try {
          const result = await ingestWireRunEvent(ctx, frame, profile => {
            const current = binding.getOwnedResultProfile?.(profile.result_profile.id, profile.verifier_template.id, profile.project_id);
            return !!current && isDeepStrictEqual(current, profile);
          });
          if (result === null) return;
          if (!result.receiptBodyIdentity) throw new Error("run event did not obtain a qualified receipt");
        } catch { status = "rejected"; }
        if (closed || !isCurrentBinding()) return;
        await transport.send({
          kind: "command", id: `receipt:${frame.run_id}:${frame.sequence}`,
          idempotency_key: `receipt:${frame.run_id}:${frame.sequence}`, type: "run.event.ack",
          payload: { run_id: frame.run_id, sequence: frame.sequence, status,
            ...(status === "rejected" ? { message: "run event could not be accepted" } : {}),
          },
        });
      });
    } else if (message.kind === "command.ack" && pendingReleaseStops.has(message.command_id)) {
      const pending = pendingReleaseStops.get(message.command_id)!;
      pendingReleaseStops.delete(message.command_id); clearTimeout(pending.timer);
      enqueue(async () => { if (message.status === "accepted") pending.resolve(); else pending.reject(AppError.conflict(message.message)); });
    } else if (message.kind === "command.ack" && pendingStops.has(message.command_id)) {
      const pending = pendingStops.get(message.command_id)!;
      pendingStops.delete(message.command_id);
      clearTimeout(pending.timer);
      enqueue(async () => {
        if (!(await ownsRun(pending.runId))) pending.reject(AppError.permissionDenied("run is not owned by this node"));
        else if (message.status === "rejected") pending.reject(AppError.conflict(`node could not stop run: ${message.message}`));
        else pending.resolve();
      });
    } else if (message.kind === "command.ack" && message.status === "rejected") {
      const startRunId = pendingCommandRun.get(message.command_id);
      if (startRunId !== undefined) {
        pendingCommandRun.delete(message.command_id);
        enqueue(async () => {
          if (await ownsRun(startRunId)) await failRunStart(ctx, startRunId, message.error_code, message.message);
        });
        return;
      }
      // #115 P2-S3b: a rejected run.resume (node no longer has the process) maps to
      // the same auditable daemon_disconnect failure path — idempotent, and only
      // for a starting/running run on this connected computer.
      const resume = pendingResumeRun.get(message.command_id);
      if (resume !== undefined) {
        pendingResumeRun.delete(message.command_id);
        clearTimeout(resume.timer);
        // Only explicit process_exited proves absence. Permission/policy errors
        // and malformed/unsupported requests cannot release write leases.
        enqueue(() => failRunDaemonDisconnect(ctx, resume.runId, computerId, message.error_code === "process_exited"));
      }
    } else if (message.kind === "command.ack") {
      // Accepted: no server-side transition (resume just continues the live run).
      pendingCommandRun.delete(message.command_id);
      const resume = pendingResumeRun.get(message.command_id);
      if (resume !== undefined) {
        clearTimeout(resume.timer);
        // A process may have survived beyond grace expiry. Its run has already
        // failed, so stop that exact process and wait for confirmation before
        // allowing another execution. Do not resurrect the failed run.
        void reconcileSurvivingProcess(resume.runId).catch(() => {});
      }
      pendingResumeRun.delete(message.command_id);
    }
  };
  const unsubscribe: Unsubscribe = transport.subscribe(receive);

  async function reconcileSurvivingProcess(runId: string): Promise<void> {
    const run = (await ctx.db.db.select({ status: runs.status, failureReason: runs.failureReason }).from(runs)
      .where(and(eq(runs.id, runId), eq(runs.organizationId, ctx.organizationId), eq(runs.computerId, computerId))))[0];
    if (closed || run?.status !== "failed" || run.failureReason !== "daemon_disconnect") return;
    await binding.dispatchRunStop(runId);
    await failRunDaemonDisconnect(ctx, runId, computerId, true);
  }

  function assertCurrentStartBinding(runId: string): void {
    if (closed || !isCurrentBinding()) {
      throw AppError.conflict("Run start blocked because the node binding is no longer current",
        { run_id: runId, dispatch: "blocked", reason: closed ? "binding_closed" : "binding_replaced" });
    }
  }

  function assertAllocationFeature(runId: string): void {
    if (!binding.supportsExecutionFeature("workspace-allocation.per-run-v1")) {
      throw AppError.conflict("Run start blocked because the current node lacks allocation support",
        { run_id: runId, dispatch: "blocked", reason: "unsupported_execution_feature" });
    }
  }

  async function requireAuthorizedRun(runId: string, run: typeof runs.$inferSelect): Promise<void> {
    try { await requireRunAiSharingAuthorization(ctx, run); }
    catch (error) {
      if (!(error instanceof AppError) || !["ai_consent_required", "ai_sharing_unconfigured"].includes(error.code)) throw error;
      // A previous delivery may have reached the node even when the stored run
      // still says queued. Confirm exact stop before changing status or leases.
      let stopped = false;
      try {
        if (run.status === "failed" && run.failureReason === "daemon_disconnect") {
          await binding.dispatchRunStop(runId);
          await failRunDaemonDisconnect(ctx, runId, computerId, true);
        } else {
          await cancelRun({ ...ctx, actorUserId: run.requestedByUserId ?? ctx.actorUserId }, runId,
            () => binding.dispatchRunStop(runId));
        }
        stopped = true;
      } catch { /* Keep existing run/lease state when stop cannot be confirmed. */ }
      throw new AppError(error.code, error.message, error.httpStatus,
        { ...error.details, run_id: runId, stop_confirmed: stopped });
    }
  }

  async function sendRunStart(runId: string): Promise<void> {
    assertCurrentStartBinding(runId);
    if (await importedDesignForRun(runId)) throw AppError.permissionDenied("Imported design requires its dedicated single-use start command");
    const [run] = await ctx.db.db.select().from(runs).where(and(
      eq(runs.id, runId), eq(runs.organizationId, ctx.organizationId),
    ));
    assertCurrentStartBinding(runId);
    if (!run || run.computerId !== computerId) throw AppError.permissionDenied("run is not owned by this node");
    if (run.status !== "queued") return;
    const ownedAssignment = parseOwnedResultAssignment(run);
    const assertOwnedProfile = () => {
      if (!ownedAssignment) return;
      const expected = ownedAssignment.request.requirement.profile;
      const current = binding.getOwnedResultProfile?.(expected.result_profile.id, expected.verifier_template.id, expected.project_id);
      if (!current || !isDeepStrictEqual(current, expected)) throw AppError.conflict("Current managed node session differs from the original owned result profile");
    };
    if (ownedAssignment) {
      assertOwnedProfile();
      await assertOwnedResultStoredContext(ctx, ctx.db.db, run, ownedAssignment);
      await assertOwnedResultDispatchInput(ctx, ctx.db.db, run, ownedAssignment);
      assertCurrentStartBinding(runId); assertOwnedProfile();
    }

    // Only an explicit null record selects legacy behavior.
    const allocated = run.workspaceAllocation !== null;
    if (allocated) assertAllocationFeature(runId);
    const persistedContextPack = run.contextPackId === null ? undefined
      : (await ctx.db.db.select().from(contextPacks).where(and(
        eq(contextPacks.id, run.contextPackId), eq(contextPacks.organizationId, ctx.organizationId),
      )))[0];
    const verification = run.verificationRequirement === null ? undefined : VerificationRequirementSchema.parse(run.verificationRequirement);
    if (verification && (!binding.supportsExecutionFeature("run-verification.v1") || run.workspaceBranch !== null || run.workspaceAllocation !== null)) {
      throw AppError.conflict("Trusted verification requires a supported node and an ordinary workspace");
    }
    assertCurrentStartBinding(runId);
    let workspaceRoot: string;
    let workspaceBranch = run.workspaceBranch;
    let allocation: RunStartCommand["payload"]["workspace_allocation"];
    let context: RunStartCommand["payload"]["context_pack"];

    if (allocated) {
      const [[computer], [task]] = await Promise.all([
        ctx.db.db.select({ os: computers.os }).from(computers).where(and(
          eq(computers.id, computerId), eq(computers.organizationId, ctx.organizationId),
        )),
        ctx.db.db.select({ projectId: tasks.projectId }).from(tasks).where(and(
          eq(tasks.id, run.taskId), eq(tasks.organizationId, ctx.organizationId),
        )),
      ]);
      assertCurrentStartBinding(runId);
      const validated = validatePersistedAllocationStart(run, persistedContextPack,
        { computerOs: computer?.os, projectId: task?.projectId });
      workspaceRoot = validated.root;
      workspaceBranch = validated.branch;
      allocation = validated.allocation;
      context = validated.context;
    } else {
      const instance = run.workspaceRoot === null
        ? (await ctx.db.db.select({ workspaceRoot: agentInstances.workspaceRoot }).from(agentInstances)
          .where(eq(agentInstances.id, run.agentInstanceId)))[0]
        : undefined;
      assertCurrentStartBinding(runId);
      workspaceRoot = run.workspaceRoot ?? instance?.workspaceRoot ?? FALLBACK_WORKSPACE_ROOT;
      const contextPackId = run.contextPackId ?? ctx.idGen.generate(ID_PREFIXES.contextPack);
      const parsed = persistedContextPack === undefined ? undefined : ContextPackSchema.safeParse(persistedContextPack.payload);
      context = parsed?.success === true
        ? { id: contextPackId, payload: parsed.data }
        : { id: contextPackId, uri: "artoo://contextpack/" + contextPackId };
    }

    if (verification) {
      const task = (await ctx.db.db.select({ projectId: tasks.projectId }).from(tasks).where(and(
        eq(tasks.id, run.taskId), eq(tasks.organizationId, ctx.organizationId),
      )))[0];
      if (!task || !context.payload || context.payload.project.id !== task.projectId
        || context.payload.task.id !== run.taskId || context.payload.workspace.root !== workspaceRoot
        || !binding.supportsVerificationProfile(verification.profile_id, task.projectId, workspaceRoot)) {
        throw AppError.conflict("The current node does not advertise this project's verification profile and workspace",
          { run_id: runId, dispatch: "blocked", reason: "verification_profile_mismatch" });
      }
    }

    // A changed terminal/ownership state observed during the reads must not send.
    const [latest] = await ctx.db.db.select({ status: runs.status, computerId: runs.computerId }).from(runs).where(and(
      eq(runs.id, runId), eq(runs.organizationId, ctx.organizationId),
    ));
    assertCurrentStartBinding(runId);
    if (!latest || latest.computerId !== computerId) throw AppError.permissionDenied("run is not owned by this node");
    if (latest.status !== "queued") return;
    if (allocated) assertAllocationFeature(runId);

    const commandId = ctx.idGen.generate("cmd");
    const command: RunStartCommand | RunStartOwnedResultCommand = ownedAssignment ? {
      kind: "command", id: commandId, idempotency_key: runId + ":start", type: "run.start.owned-result.v1",
      payload: structuredClone(ownedAssignment.request),
    } : {
      kind: "command", id: commandId, idempotency_key: runId + ":start", type: "run.start",
      payload: {
        run_id: runId, task_id: run.taskId, agent_instance_id: run.agentInstanceId, runtime: run.runtimeId,
        workspace: { root: workspaceRoot, ...(workspaceBranch !== null ? { branch: workspaceBranch } : {}) },
        ...(allocation !== undefined ? { workspace_allocation: allocation } : {}),
        ...(run.workspaceRoot !== null && workspaceBranch !== null ? { workspace_retention_reporting: "typed-v1" } : {}),
        context_pack: context,
        ...(verification ? { verification } : {}),
        // The base is metadata, never a wider write grant.
        policy_snapshot: { filesystem_write_scope: [workspaceRoot], requires_approval: ["git.push", "external.post"] },
        artifact_rules: { paths: ["artifacts/**", "*.patch"] },
      },
    };
    assertCurrentStartBinding(runId);
    if (allocated) assertAllocationFeature(runId);
    await requireAuthorizedRun(runId, run);
    if (!await canDispatchAssistantRun(ctx, run, { context: context.payload, recheckPlanningCapabilities: false })) return;
    assertCurrentStartBinding(runId);
    const [assistantTurn] = await ctx.db.db.select({ id: assistantTurns.id }).from(assistantTurns)
      .where(and(eq(assistantTurns.runId, run.id), eq(assistantTurns.organizationId, ctx.organizationId))).limit(1);
    let claimedExposureAt: string | undefined;
    if (assistantTurn && !exposedAssistantRuns.has(run.id)) {
      // Commit possible exposure before touching the transport. A crash here
      // may conservatively require reconciliation; it must never authorize a
      // second process after a node restart lost its ordinary in-memory IDs.
      const exposedAt = ctx.clock.nowIso();
      const [claimed] = await ctx.db.db.update(assistantRunDispatches).set({ state: "exposed", exposedAt })
        .where(and(eq(assistantRunDispatches.runId, run.id), eq(assistantRunDispatches.organizationId, ctx.organizationId),
          eq(assistantRunDispatches.turnId, assistantTurn.id), eq(assistantRunDispatches.version, 1), eq(assistantRunDispatches.state, "prepared")))
        .returning({ id: assistantRunDispatches.runId });
      if (!claimed) { await binding.dispatchRunResume(run.id); return; }
      claimedExposureAt = exposedAt;
    }
    let sendInvoked = false, knownBlocked = false;
    try {
      let recheckPlanning: (() => void) | undefined;
      if (!await canDispatchAssistantRun(ctx, run, { context: context.payload, recheckPlanningCapabilities: false,
        onPlanningRecheckReady: recheck => { recheckPlanning = recheck; } })) { knownBlocked = true; return; }
      await assertDesignRevisionRunAdmission(ctx, ctx.db.db, run, { live: true });
      assertCurrentStartBinding(runId);
      recheckPlanning?.();
      // The last awaited authorization/database fence is above. Use one current
      // snapshot immediately before the send, never one sampled before those reads.
      if (verification && !binding.supportsVerificationProfile(verification.profile_id, context.payload!.project.id, workspaceRoot)) {
        throw AppError.conflict("Verification profile is no longer available on the current node session",
          { run_id: runId, dispatch: "blocked", reason: "verification_profile_mismatch" });
      }
      if (verification) {
        const current = binding.getVerificationCapabilities!(verification.profile_id, context.payload!.project.id, workspaceRoot);
        if (current?.measurement_plan_policy && !binding.supportsExecutionFeature(`measurement-plan.v${current.measurement_plan_policy.version}`)) {
          throw AppError.conflict("The current node cannot enforce the configured measurement plan",
            { run_id: runId, dispatch: "blocked", reason: "unsupported_measurement_plan_verification" });
        }
        const expected = verification.capability_binding, supplied = context.payload!.verification_capabilities;
        if ((current || expected || supplied) && (!current || !expected || !supplied
          || !isDeepStrictEqual(expected, verificationCapabilityBinding(current))
          || !isDeepStrictEqual(supplied, { ...current, profile_id: verification.profile_id }))) {
          throw AppError.conflict("The current verification capabilities do not match this run's bound context",
            { run_id: runId, dispatch: "blocked", reason: "verification_capability_mismatch" });
        }
        const releaseExpected = verification.release_capability_binding, releaseSupplied = context.payload!.release_capabilities;
        if (releaseExpected || releaseSupplied) {
          const releaseCurrent = binding.getReleaseCapabilities?.((releaseExpected ?? releaseSupplied!.binding).release_profile_id,
            context.payload!.project.id, workspaceRoot, verification.profile_id);
          if (!releaseExpected || !releaseSupplied || !releaseCurrent
            || !isDeepStrictEqual(releaseCurrent.binding, releaseExpected) || !isDeepStrictEqual(releaseCurrent, releaseSupplied)) {
            throw AppError.conflict("The current release capabilities do not match this run's fixed publication scope",
              { run_id: runId, dispatch: "blocked", reason: "release_capability_mismatch" });
          }
        }
      }
      if ((context.payload?.product_development?.stage || context.payload?.review_subject?.development_stage)
        && !binding.supportsExecutionFeature("product-stage-verification.v1")) {
        throw AppError.conflict("The current node cannot enforce accepted product stage inputs",
          { run_id: runId, dispatch: "blocked", reason: "unsupported_product_stage_verification" });
      }
      if (assistantTurn) exposedAssistantRuns.add(run.id);
      assertOwnedProfile();
      pendingCommandRun.set(commandId, runId);
      // After send is invoked, disconnect/error may still mean delivery occurred.
      // Do not fail the run or release leases from this dispatch path.
      sendInvoked = true;
      await transport.send(command);
    } catch (error) {
      // Only a known admission rejection before send proves this invocation did
      // not expose a process. Unknown errors retain the conservative fence.
      knownBlocked = error instanceof AppError && error.httpStatus < 500;
      throw error;
    } finally {
      if (knownBlocked && !sendInvoked && claimedExposureAt !== undefined && assistantTurn) {
        await ctx.db.db.update(assistantRunDispatches).set({ state: "prepared", exposedAt: null })
          .where(and(eq(assistantRunDispatches.runId, run.id), eq(assistantRunDispatches.organizationId, ctx.organizationId),
            eq(assistantRunDispatches.turnId, assistantTurn.id), eq(assistantRunDispatches.version, 1),
            eq(assistantRunDispatches.state, "exposed"), eq(assistantRunDispatches.exposedAt, claimedExposureAt)));
      }
    }
  }

  const binding: NodeBinding = {
    receive,
    supportsExecutionFeature(feature): boolean {
      if (feature === IMPORTED_DESIGN_CONTINUATION_FEATURE_V1 && (!importedDesigns || importedReviewOptions?.qualifiedRunEventReceiptsReady?.() !== true)) return false;
      return !closed && isCurrentBinding() && executionFeatureSet.has(feature);
    },
    getOwnedResultProfile(resultProfileId, verifierTemplateId, projectId) {
      if (!managedResultReady() || !binding.supportsExecutionFeature(OWNED_RESULT_FEATURE)
        || !binding.supportsExecutionFeature("workspace-allocation.per-run-v1")) return undefined;
      const profile = ownedResultSnapshot.find(value => value.node_id === computerId && value.project_id === projectId
        && value.result_profile.id === resultProfileId && value.verifier_template.id === verifierTemplateId);
      return profile ? structuredClone(profile) : undefined;
    },
    supportsVerificationProfile(profileId, projectId, workspaceRoot): boolean {
      const exact = binding.supportsExecutionFeature("run-verification.v1") && profileSnapshot.some((profile) =>
        profile.profile_id === profileId && profile.project_id === projectId && profile.workspace_root === workspaceRoot);
      // Recheck uniqueness at existing dispatch/capability gates as well as selection.
      return exact && (nodeOs !== "win32" && nodeOs !== "windows"
        || binding.getVerificationWorkspace(profileId, projectId, workspaceRoot) === workspaceRoot);
    },
    getVerificationWorkspace(profileId, projectId, workspaceRoot) {
      if (!binding.supportsExecutionFeature("run-verification.v1")) return undefined;
      if (nodeOs !== "win32" && nodeOs !== "windows") {
        return profileSnapshot.find(profile => profile.profile_id === profileId && profile.project_id === projectId
          && profile.workspace_root === workspaceRoot)?.workspace_root;
      }
      // This only routes to the node's declared root. Native qualification must
      // reject unsupported case-sensitive/reparse aliases; node physical checks remain exact.
      let key: string;
      try { key = canonicalAutomationWorkspace(workspaceRoot, nodeOs); } catch { return undefined; }
      const matches = profileSnapshot.filter(profile => {
        try { return canonicalAutomationWorkspace(profile.workspace_root, nodeOs) === key; } catch { return false; }
      });
      // Even a different profile/project colliding with this key is ambiguous.
      if (matches.length !== 1) return undefined;
      const profile = matches[0]!;
      return profile.profile_id === profileId && profile.project_id === projectId ? profile.workspace_root : undefined;
    },
    getVerificationCapabilities(profileId, projectId, workspaceRoot) {
      if (!binding.supportsExecutionFeature("verification-capabilities.v1")
        || !binding.supportsVerificationProfile(profileId, projectId, workspaceRoot)) return undefined;
      const capabilities = profileSnapshot.find((profile) => profile.profile_id === profileId
        && profile.project_id === projectId && profile.workspace_root === workspaceRoot)?.capabilities;
      // The nested accepted-hello snapshot remains private, including after a caller mutates its copy.
      return capabilities ? structuredClone(capabilities) : undefined;
    },
    supportsReleaseProfile(profileId, projectId, workspaceRoot, verificationProfileId): boolean {
      return binding.supportsExecutionFeature("product-release.static.v1")
        && binding.supportsVerificationProfile(verificationProfileId, projectId, workspaceRoot)
        && releaseSnapshot.some((profile) => profile.profile_id === profileId && profile.project_id === projectId
          && profile.workspace_root === workspaceRoot && profile.verification_profile_id === verificationProfileId);
    },
    getReleaseCapabilities(profileId, projectId, workspaceRoot, verificationProfileId) {
      if (!binding.supportsExecutionFeature("product-release.acceptance.v1")
        || !binding.supportsReleaseProfile?.(profileId, projectId, workspaceRoot, verificationProfileId)) return undefined;
      const capabilities = releaseSnapshot.find((profile) => profile.profile_id === profileId && profile.project_id === projectId
        && profile.workspace_root === workspaceRoot && profile.verification_profile_id === verificationProfileId)?.capabilities;
      return capabilities ? structuredClone(capabilities) : undefined;
    },
    async dispatchImportedProductReview(reviewId, control): Promise<void> {
      if (!importedReviews) throw AppError.permissionDenied("Imported review requires a current paired node session and configured artifact store");
      await importedReviews.dispatch(reviewId, control);
    },
    async dispatchProductSourceOperation(operationId, control): Promise<void> {
      const source = await sourceOperationBinding(operationId);
      if (control === "qualify") await source.qualify(operationId); else await source.dispatch(operationId, control);
    },
    async dispatchImportedDesignContinuation(continuationId, control): Promise<void> {
      if (!importedDesigns) throw AppError.permissionDenied("Imported design requires its paired receipt session");
      await importedDesigns.dispatch(continuationId, control);
    },
    async dispatchProductRelease(releaseId): Promise<void> {
      assertCurrentStartBinding(releaseId);
      const [row] = await ctx.db.db.select({ release: productReleases, goal: goals, automation: goalAutomations })
        .from(productReleases).innerJoin(goals, eq(goals.id, productReleases.goalId)).innerJoin(goalAutomations, eq(goalAutomations.goalId, goals.id))
        .where(and(eq(productReleases.id, releaseId), eq(productReleases.organizationId, ctx.organizationId)));
      if (!row || row.release.computerId !== computerId) throw AppError.permissionDenied("release is not owned by this node");
      if (row.release.status !== "queued" || row.goal.status !== "running" || !["executing", "waiting"].includes(row.automation.status)) return;
      const request = ProductReleaseRequestSchema.parse(row.release.request);
      if (!binding.supportsReleaseProfile?.(request.release_profile_id, row.release.projectId, row.automation.workspaceRoot!, request.verification_profile_id)) {
        throw AppError.conflict("Current node does not advertise the bound release profile");
      }
      if (request.acceptance_binding) {
        const current = binding.getReleaseCapabilities?.(request.release_profile_id, row.release.projectId,
          row.automation.workspaceRoot!, request.verification_profile_id);
        if (!current || !isDeepStrictEqual(current.binding, request.acceptance_binding.release_binding)) {
          throw AppError.conflict("Current node publication acceptance contract differs from the immutable request");
        }
      }
      await assertNoActiveDesignRevision(ctx, ctx.db.db, row.goal.id);
      const [sourceRun] = await ctx.db.db.select().from(runs).where(and(eq(runs.id, row.release.runId), eq(runs.organizationId, ctx.organizationId)));
      if (!sourceRun) throw AppError.conflict("Publication source execution is missing");
      await assertDesignRevisionRunAdmission(ctx, ctx.db.db, sourceRun, { acceptance: true });
      assertCurrentStartBinding(releaseId);
      await transport.send({ kind: "command", id: `release:${releaseId}`, idempotency_key: `release:${releaseId}`,
        type: "product.release", payload: request });
    },
    async dispatchProductReleaseCancel(releaseId): Promise<void> {
      assertCurrentStartBinding(releaseId);
      const [row] = await ctx.db.db.select().from(productReleases).where(and(eq(productReleases.id, releaseId), eq(productReleases.organizationId, ctx.organizationId)));
      if (!row || row.computerId !== computerId) throw AppError.permissionDenied("release is not owned by this node");
      if (row.status !== "queued") return;
      const request = ProductReleaseRequestSchema.parse(row.request);
      const commandId = ctx.idGen.generate("release_stop");
      const pending = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { pendingReleaseStops.delete(commandId); reject(AppError.conflict("Publication stop remains unconfirmed")); }, 15000);
        pendingReleaseStops.set(commandId, { resolve, reject, timer });
      });
      void pending.catch(() => {});
      try {
        assertCurrentStartBinding(releaseId);
        await transport.send({ kind: "command", id: commandId, idempotency_key: `release:${releaseId}:cancel`, type: "product.release.cancel", payload: request });
        await pending;
      } finally {
        const entry = pendingReleaseStops.get(commandId); if (entry) clearTimeout(entry.timer);
        pendingReleaseStops.delete(commandId);
      }
    },
    async dispatchRunStart(runId: string): Promise<void> {
      assertCurrentStartBinding(runId);
      const existing = startingRuns.get(runId);
      if (existing) return existing;
      const operation = sendRunStart(runId).finally(() => { startingRuns.delete(runId); });
      startingRuns.set(runId, operation);
      return operation;
    },

    // #115 P2-S3: ask a reconnected node to continue an already-active run after a
    // brief disconnect grace window. Only the run id is sent; accepted means no
    // server transition, rejected means the node lost the process and the server
    // fails the run through the daemon_disconnect path.
    async dispatchRunResume(runId: string): Promise<void> {
      if (closed) return;
      const importedDesign = await importedDesignForRun(runId);
      if (importedDesign) { await binding.dispatchImportedDesignContinuation!(importedDesign.id, "status"); return; }
      const [run] = await ctx.db.db.select().from(runs).where(and(eq(runs.id, runId), eq(runs.organizationId, ctx.organizationId)));
      if (!run || run.computerId !== computerId) throw AppError.permissionDenied("run is not owned by this node");
      if (run.status === "queued") {
        const [prepared] = await ctx.db.db.select({ id: assistantRunDispatches.runId }).from(assistantRunDispatches)
          .innerJoin(assistantTurns, and(eq(assistantTurns.id, assistantRunDispatches.turnId), eq(assistantTurns.runId, run.id)))
          .where(and(eq(assistantRunDispatches.runId, run.id), eq(assistantRunDispatches.organizationId, ctx.organizationId),
            eq(assistantRunDispatches.version, 1), eq(assistantRunDispatches.state, "prepared"))).limit(1);
        // Only a durable, never-exposed intent can become a start on a new
        // connection. Legacy/possibly-sent starts keep the process-exit fence.
        if (prepared) { await binding.dispatchRunStart(runId); return; }
      }
      if ([...pendingResumeRun.values()].some((pending) => pending.runId === runId)) return;
      await requireAuthorizedRun(runId, run);
      await assertDesignRevisionRunAdmission(ctx, ctx.db.db, run, { live: true });
      assertCurrentStartBinding(runId);
      const commandId = ctx.idGen.generate("cmd");
      const timer = setTimeout(() => {
        if (closed || !pendingResumeRun.delete(commandId)) return;
        enqueue(async () => {
          await failRunDaemonDisconnect(ctx, runId, computerId);
          // Run the stop outside the ingestion queue: its ACK is itself queued.
          void reconcileSurvivingProcess(runId).catch(() => {});
        });
      }, 15_000);
      pendingResumeRun.set(commandId, { runId, timer });
      const command: RunResumeCommand = {
        kind: "command",
        id: commandId,
        idempotency_key: `${runId}:resume`,
        type: "run.resume",
        payload: { run_id: runId },
      };
      try { await transport.send(command); }
      catch (error) {
        clearTimeout(timer);
        pendingResumeRun.delete(commandId);
        await failRunDaemonDisconnect(ctx, runId, computerId);
        throw error;
      }
    },

    async dispatchRunStop(runId: string): Promise<void> {
      if (closed) throw AppError.conflict("node disconnected before process stop was confirmed");
      if (!(await ownsRun(runId))) throw AppError.permissionDenied("run is not owned by this node");
      const importedDesign = await importedDesignForRun(runId);
      if (importedDesign) return stopImportedDesign(importedDesign);
      const existing = stoppingRuns.get(runId);
      if (existing) return existing;
      const commandId = ctx.idGen.generate("cmd");
      const pending = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingStops.delete(commandId);
          reject(AppError.conflict("node did not confirm process stop; the run and write leases remain active"));
        }, 15_000);
        pendingStops.set(commandId, { runId, resolve, reject, timer });
      });
      void pending.catch(() => {}); // disconnect may reject during transport.send
      stoppingRuns.set(runId, pending);
      const command: RunStopCommand = {
        kind: "command", id: commandId, idempotency_key: `${runId}:stop`,
        type: "run.stop", payload: { run_id: runId, reason: "user_cancelled" },
      };
      try {
        try { await transport.send(command); }
        catch (error) { pendingStops.get(commandId)?.reject(error instanceof Error ? error : new Error(String(error))); }
        await pending;
      } finally {
        const entry = pendingStops.get(commandId);
        if (entry) clearTimeout(entry.timer);
        pendingStops.delete(commandId);
        stoppingRuns.delete(runId);
      }
    },

    async drain(): Promise<void> {
      // Settle the current chain, then re-check in case ingestion enqueued more.
      let previous: Promise<void>;
      do {
        previous = tail;
        await previous;
      } while (previous !== tail);
    },

    close(): void {
      closed = true;
      unsubscribe();
      for (const pending of pendingResumeRun.values()) clearTimeout(pending.timer);
      pendingResumeRun.clear();
      for (const pending of pendingStops.values()) {
        clearTimeout(pending.timer);
        pending.reject(AppError.conflict("node disconnected before process stop was confirmed"));
      }
      pendingStops.clear();
      for (const pending of pendingDesignStops.values()) { clearTimeout(pending.timer); pending.reject(AppError.conflict("Node disconnected before imported design closure")); }
      pendingDesignStops.clear();
      for (const pending of pendingReleaseStops.values()) { clearTimeout(pending.timer); pending.reject(AppError.conflict("Node disconnected before publication stop was confirmed")); }
      pendingReleaseStops.clear();
    },
  };
  return binding;
}
