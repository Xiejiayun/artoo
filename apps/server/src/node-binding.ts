import { createCleanValidationBinding } from "./services/clean-validation-service.js";
import { createCleanValidationReviewBinding } from "./services/clean-validation-review-service.js";
import { goalCleanValidations } from "@artoo/db";
import { IMPORTED_CLEAN_VALIDATION_FEATURE_V1, IMPORTED_CLEAN_VALIDATION_REVIEW_FEATURE_V1, PRODUCT_RELEASE_CLEAN_FEATURE_V1, ImportedCleanValidationResultV1Schema } from "@artoo/domain";
import { assertSourceLineageDispatch } from "./services/source-lineage-fence.js";
import { createImportedExecutionReviewBinding } from "./services/imported-execution-review-service.js";
import { createImportedValidationBinding } from "./services/imported-validation-service.js";
import { createImportedValidationReviewBinding } from "./services/imported-validation-review-service.js";
import { createSourceRecoveryBinding } from "./services/source-recovery-service.js";
import { SOURCE_CLEAN_RESTART_FEATURE_V1 } from "@artoo/domain";
import { createRecoveryValidationBinding } from "./services/recovery-validation-service.js";
import { createRecoveryValidationReviewBinding } from "./services/recovery-validation-review-service.js";
import { goalRecoveryValidations } from "@artoo/db";
import { PRODUCT_SOURCE_RECOVERY_FEATURE_V1, IMPORTED_RECOVERY_VALIDATION_FEATURE_V1, IMPORTED_RECOVERY_VALIDATION_REVIEW_FEATURE_V1,
  ImportedRecoveryValidationResultV1Schema } from "@artoo/domain";
import { inspectImportedValidationPublicationDispatch } from "./services/imported-validation-release-service.js";
import { inspectRecoveryValidationPublicationDispatch } from "./services/recovery-validation-release-service.js";
import { inspectCleanValidationPublicationDispatch } from "./services/clean-validation-release-service.js";
import { goalImportedValidations } from "@artoo/db";
import { IMPORTED_VALIDATION_FEATURE_V1, ImportedValidationResultV1Schema } from "@artoo/domain";
import { createImportedExecutionRepairBinding } from "./services/imported-execution-repair-service.js";
import { goalImportedExecutionRepairs } from "@artoo/db";
import { IMPORTED_EXECUTION_REVIEW_FEATURE_V1, ImportedExecutionRepairResultV1Schema } from "@artoo/domain";
import { requireRunAiSharingAuthorization } from "./services/ai-data-sharing-service.js";
import { createGoalImportedProductReviewBinding } from "./services/imported-product-review-service.js";
import { createGoalProductHandoffBinding } from "./services/goal-product-handoff-service.js";
import type { ArtifactStorageOptions } from "./content-addressed-blob.js";
import { createImportedDesignContinuationBinding } from "./services/imported-design-continuation-service.js";
import { createImportedDesignReviewBinding } from "./services/imported-design-review-service.js";
import { createImportedExecutionBinding } from "./services/imported-execution-service.js";
import { goalImportedExecutions } from "@artoo/db";
import { IMPORTED_EXECUTION_FEATURE_V1, ImportedExecutionResultV1Schema } from "@artoo/domain";
import { IMPORTED_DESIGN_REVIEW_FEATURE_V1 } from "@artoo/domain";
import { goalImportedDesignContinuations } from "@artoo/db";
import { ImportedDesignContinuationResultV1Schema, IMPORTED_DESIGN_CONTINUATION_FEATURE_V1 } from "@artoo/domain";
import { goalProductHandoffs, goalProductHandoffOperations } from "@artoo/db";
import type { AuthenticatedTransferNode } from "./services/product-source-transfer-service.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ProductSourceRoutingV1Schema, type ProductSourceRoutingV1 } from "@artoo/domain";
import { APPLICATION_PUBLICATION_FEATURE_V1, ApplicationPublicationProfileAdvertisementsV1Schema,
  type ApplicationPublicationProfileAdvertisementV1, type ApplicationPublicationCapabilitiesV1,
  type ApplicationPublicationVerificationAckV1 } from "@artoo/domain";
import { committedApplicationVerificationReceipt } from "./services/application-publication-receipt.js";
import { applicationPublications } from "@artoo/db";
import { ApplicationPublicationRequestV1Schema } from "@artoo/domain";
import { applicationPublicationDigest, assertApplicationPublicationDispatch, ingestApplicationPublicationReceipt,
  ingestApplicationPublicationObservation } from "./services/application-publication-service.js";

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

import type { ImportedSourceReceiptFamily, ServerContext } from "./context.js";
import { canDispatchAssistantRun } from "./services/assistant-service.js";
import { AppError } from "./errors.js";
import { validatePersistedAllocationStart } from "./persisted-allocation-start.js";
import { ingestProductReleaseReceipt, ingestProductReleaseHealthReport } from "./services/product-release-service.js";
import { assertProductReleaseRetryDispatch } from "./services/product-release-retry-service.js";
import { verificationCapabilityBinding } from "./services/verification-capabilities.js";
import { APPLICATION_VERIFICATION_FEATURE_V1 } from "@artoo/domain";
import { applicationRequirement } from "./services/application-verification.js";
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
  /** Close the underlying socket when its computer is explicitly removed. */
  disconnect?(): void;
  /** Current session's folder suggestions, never a substitute for node authorization. */
  workspaceRoots?: { readonly version: 1; readonly paths: readonly string[] };
  getProductSourceRouting?(): ProductSourceRoutingV1 | undefined;
  announceSourceRecoverySession?(): Promise<void>;
  announceApplicationPublicationSession?(): Promise<void>;
  getApplicationPublicationCapabilities?(profileId: string, projectId: string): ApplicationPublicationCapabilitiesV1 | undefined;
  dispatchApplicationPublication?(publicationId: string, control: "start" | "stop" | "status"): Promise<void>;
  dispatchSourceRecovery?(recoveryId: string, control: "start" | "stop" | "status"): Promise<void>;
  dispatchRecoveryValidation?(validationId: string, control: "start" | "stop" | "status"): Promise<void>;
  dispatchCleanValidation?(validationId: string, control: "start" | "stop" | "status"): Promise<void>;
  dispatchRecoveryValidationReview?(reviewId: string, control: "start" | "stop" | "status"): Promise<void>;
  dispatchCleanValidationReview?(reviewId: string, control: "start" | "stop" | "status"): Promise<void>;
  getPairedNodeSession?(): NonNullable<ReturnType<NonNullable<ServerContext["getPairedNodeSession"]>>> | undefined;
  redeliverCommittedSourceReceipt?(family: ImportedSourceReceiptFamily, id: string): Promise<void>;
  dispatchImportedDesignReview?(reviewId: string, control: "start" | "stop" | "status"): Promise<void>;
  dispatchImportedExecution?(executionId: string, control: "start" | "stop" | "status"): Promise<void>;
  dispatchImportedExecutionReview?(reviewId: string, control: "start" | "stop" | "status"): Promise<void>;
  dispatchImportedExecutionRepair?(repairId: string, control: "start" | "stop" | "status"): Promise<void>;
  dispatchImportedValidation?(validationId: string, control: "start" | "stop" | "status"): Promise<void>;
  dispatchImportedValidationReview?(reviewId: string, control: "start" | "stop" | "status"): Promise<void>;
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
  importedReviewOptions?: ArtifactStorageOptions & { identity: AuthenticatedTransferNode; sessionId: string; qualifiedRunEventReceiptsReady?: () => boolean },
  productSourceRouting?: ProductSourceRoutingV1,
  applicationPublicationProfiles: readonly ApplicationPublicationProfileAdvertisementV1[] = [],
): NodeBinding {
  // Copy the accepted hello snapshot so later caller mutation cannot change it.
  const executionFeatureSet = new Set(executionFeatures);
  const pairedSession = importedReviewOptions ? Object.freeze({ ...importedReviewOptions.identity, sessionId: importedReviewOptions.sessionId }) : undefined;
  const publicationProfiles = ApplicationPublicationProfileAdvertisementsV1Schema.parse(applicationPublicationProfiles);
  const routingSnapshot = productSourceRouting === undefined ? undefined : ProductSourceRoutingV1Schema.parse(productSourceRouting);
  const profileSnapshot = Object.freeze(VerificationProfileAdvertisementsSchema.parse(verificationProfiles)
    .map((profile) => Object.freeze(profile)));
  const releaseSnapshot = Object.freeze(ReleaseProfileAdvertisementsSchema.parse(releaseProfiles).map((profile) => Object.freeze(profile)));
  const ownedResultSnapshot = NodeOwnedResultProfileDescriptorsV1Schema.parse(ownedResultProfiles);
  if (ownedResultSnapshot.some(profile => profile.node_id !== computerId)) throw AppError.permissionDenied("Owned result descriptors belong to another node");
  const pendingCommandRun = new Map<string, string>(); // command_id -> run_id (run.start)
  // One exposed request per pending normal source start, scoped to this binding.
  // Periodic re-delivery must not allocate another node-side reply identity.
  const pendingSourceStarts = new Map<string, RunStartCommand>();
  // Stop/rejection can arrive before durable state leaves queued. Retain the
  // original snapshot as a retired entry until that advancement is observed.
  const retiredSourceStarts = new Set<string>();
  function retireSourceStart(runId: string, commandId?: string): void {
    const command = pendingSourceStarts.get(runId);
    if (!command || commandId !== undefined && command.id !== commandId) return;
    retiredSourceStarts.add(runId);
    if (pendingCommandRun.get(command.id) === runId) pendingCommandRun.delete(command.id);
  }
  function forgetSourceStart(runId: string, commandId?: string): void {
    const command = pendingSourceStarts.get(runId);
    if (!command || commandId !== undefined && command.id !== commandId) return;
    pendingSourceStarts.delete(runId);
    retiredSourceStarts.delete(runId);
    if (pendingCommandRun.get(command.id) === runId) pendingCommandRun.delete(command.id);
  }
  const pendingResumeRun = new Map<string, { runId: string; timer: ReturnType<typeof setTimeout> }>();
  const pendingStops = new Map<string, { runId: string; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const pendingReleaseStops = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const pendingApplicationStops = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const stoppingRuns = new Map<string, Promise<void>>();
  const pendingDesignStops = new Map<string, { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const pendingExecutionStops = new Map<string, { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const pendingRepairStops = new Map<string, { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const pendingValidationStops = new Map<string, { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const pendingRecoveryValidationStops = new Map<string, { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const pendingCleanValidationStops = new Map<string, { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  // Coalesces only this binding's concurrent calls, never durable node ownership.
  const startingRuns = new Map<string, Promise<void>>();
  // Only this live binding can rely on its node's in-memory start deduplication.
  // A new connection/server must treat an exposed durable intent as uncertain.
  const exposedAssistantRuns = new Set<string>();
  let closed = false;
  const sourceRecovery = importedReviewOptions && createSourceRecoveryBinding(ctx, {
    identity: importedReviewOptions.identity, sessionId: importedReviewOptions.sessionId, transport,
    isCurrent: () => !closed && isCurrentBinding() && importedReviewOptions.qualifiedRunEventReceiptsReady?.() === true,
  });
  const recoveryValidations = importedReviewOptions && createRecoveryValidationBinding(ctx, {
    identity: importedReviewOptions.identity, sessionId: importedReviewOptions.sessionId, transport,
    isCurrent: () => !closed && isCurrentBinding() && importedReviewOptions.qualifiedRunEventReceiptsReady?.() === true,
  });
  const recoveryValidationReviews = importedReviewOptions && createRecoveryValidationReviewBinding(ctx, {
    identity: importedReviewOptions.identity, sessionId: importedReviewOptions.sessionId, transport,
    isCurrent: () => !closed && isCurrentBinding() && importedReviewOptions.qualifiedRunEventReceiptsReady?.() === true,
  });
  const cleanValidations = importedReviewOptions && createCleanValidationBinding(ctx, {
    identity: importedReviewOptions.identity, sessionId: importedReviewOptions.sessionId, transport,
    isCurrent: () => !closed && isCurrentBinding() && importedReviewOptions.qualifiedRunEventReceiptsReady?.() === true,
  });
  const cleanValidationReviews = importedReviewOptions && createCleanValidationReviewBinding(ctx, {
    identity: importedReviewOptions.identity, sessionId: importedReviewOptions.sessionId, transport,
    isCurrent: () => !closed && isCurrentBinding() && importedReviewOptions.qualifiedRunEventReceiptsReady?.() === true,
  });
  const importedReviews = importedReviewOptions && createGoalImportedProductReviewBinding(ctx, {
    ...importedReviewOptions, transport, isCurrent: () => !closed && isCurrentBinding(),
  });
  const importedDesigns = importedReviewOptions && createImportedDesignContinuationBinding(ctx, {
    identity: importedReviewOptions.identity, sessionId: importedReviewOptions.sessionId, transport,
    // Ordinary native Windows nodes commit the same qualified event receipts,
    // without acquiring managed-workspace/session authority.
    isCurrent: () => !closed && isCurrentBinding() && importedReviewOptions.qualifiedRunEventReceiptsReady?.() === true,
  });
  const importedDesignReviews = importedReviewOptions && createImportedDesignReviewBinding(ctx, {
    identity: importedReviewOptions.identity, sessionId: importedReviewOptions.sessionId, transport,
    isCurrent: () => !closed && isCurrentBinding() && importedReviewOptions.qualifiedRunEventReceiptsReady?.() === true,
  });
  const importedExecutions = importedReviewOptions && createImportedExecutionBinding(ctx, {
    identity: importedReviewOptions.identity, sessionId: importedReviewOptions.sessionId, transport,
    isCurrent: () => !closed && isCurrentBinding() && importedReviewOptions.qualifiedRunEventReceiptsReady?.() === true,
  });
  const implementationReviews = importedReviewOptions && createImportedExecutionReviewBinding(ctx, {
    identity: importedReviewOptions.identity, sessionId: importedReviewOptions.sessionId, transport,
    isCurrent: () => !closed && isCurrentBinding() && importedReviewOptions.qualifiedRunEventReceiptsReady?.() === true,
  });
  const implementationRepairs = importedReviewOptions && createImportedExecutionRepairBinding(ctx, {
    identity: importedReviewOptions.identity, sessionId: importedReviewOptions.sessionId, transport,
    isCurrent: () => !closed && isCurrentBinding() && importedReviewOptions.qualifiedRunEventReceiptsReady?.() === true,
  });
  const validations = importedReviewOptions && createImportedValidationBinding(ctx, {
    identity: importedReviewOptions.identity, sessionId: importedReviewOptions.sessionId, transport,
    isCurrent: () => !closed && isCurrentBinding() && importedReviewOptions.qualifiedRunEventReceiptsReady?.() === true,
  });
  const validationReviews = importedReviewOptions && createImportedValidationReviewBinding(ctx, {
    identity: importedReviewOptions.identity, sessionId: importedReviewOptions.sessionId, transport,
    isCurrent: () => !closed && isCurrentBinding() && importedReviewOptions.qualifiedRunEventReceiptsReady?.() === true,
  });
  async function recoveryValidationForRun(runId: string) {
    const [row] = await ctx.db.db.select().from(goalRecoveryValidations).where(and(eq(goalRecoveryValidations.runId, runId), eq(goalRecoveryValidations.organizationId, ctx.organizationId)));
    if (row && row.computerId !== computerId) throw AppError.permissionDenied("H9 validation run belongs to another node");
    return row;
  }
  async function stopRecoveryValidation(row: typeof goalRecoveryValidations.$inferSelect): Promise<void> {
    if (!recoveryValidations) throw AppError.permissionDenied("H9 stop requires its paired receipt session");
    if (ImportedRecoveryValidationResultV1Schema.safeParse(row.result).data?.closed === true) return;
    const prior = pendingRecoveryValidationStops.get(row.id); if (prior) return prior.promise;
    let resolve!: () => void, reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); void promise.catch(() => {});
    const timer = setTimeout(() => reject(AppError.conflict("H9 validation process closure is still unconfirmed")), 15000);
    pendingRecoveryValidationStops.set(row.id, { promise, resolve, reject, timer });
    try { await recoveryValidations.requestStop(row.id); await recoveryValidations.dispatch(row.id, "stop"); await promise; }
    catch (error) { reject(error instanceof Error ? error : new Error(String(error))); throw error; }
    finally { clearTimeout(timer); pendingRecoveryValidationStops.delete(row.id); }
  }
  async function cleanValidationForRun(runId: string) {
    const [row] = await ctx.db.db.select().from(goalCleanValidations).where(and(eq(goalCleanValidations.runId, runId), eq(goalCleanValidations.organizationId, ctx.organizationId)));
    if (row && row.computerId !== computerId) throw AppError.permissionDenied("clean-restart validation run belongs to another node");
    return row;
  }
  async function stopCleanValidation(row: typeof goalCleanValidations.$inferSelect): Promise<void> {
    if (!cleanValidations) throw AppError.permissionDenied("clean-restart stop requires its paired receipt session");
    if (ImportedCleanValidationResultV1Schema.safeParse(row.result).data?.closed === true) return;
    const prior = pendingCleanValidationStops.get(row.id); if (prior) return prior.promise;
    let resolve!: () => void, reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); void promise.catch(() => {});
    const timer = setTimeout(() => reject(AppError.conflict("clean-restart validation process closure is still unconfirmed")), 15000);
    pendingCleanValidationStops.set(row.id, { promise, resolve, reject, timer });
    try { await cleanValidations.requestStop(row.id); await cleanValidations.dispatch(row.id, "stop"); await promise; }
    catch (error) { reject(error instanceof Error ? error : new Error(String(error))); throw error; }
    finally { clearTimeout(timer); pendingCleanValidationStops.delete(row.id); }
  }
  async function importedValidationForRun(runId: string) {
    const [row] = await ctx.db.db.select().from(goalImportedValidations).where(and(eq(goalImportedValidations.runId, runId), eq(goalImportedValidations.organizationId, ctx.organizationId)));
    if (row && row.computerId !== computerId) throw AppError.permissionDenied("H7 validation run belongs to another node");
    return row;
  }
  async function stopImportedValidation(row: typeof goalImportedValidations.$inferSelect): Promise<void> {
    if (!validations) throw AppError.permissionDenied("H7 stop requires its paired receipt session");
    if (ImportedValidationResultV1Schema.safeParse(row.result).data?.closed === true) return;
    const prior = pendingValidationStops.get(row.id); if (prior) return prior.promise;
    let resolve!: () => void, reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); void promise.catch(() => {});
    const timer = setTimeout(() => reject(AppError.conflict("H7 validation process closure is still unconfirmed")), 15000);
    pendingValidationStops.set(row.id, { promise, resolve, reject, timer });
    try { await validations.requestStop(row.id); await validations.dispatch(row.id, "stop"); await promise; }
    catch (error) { reject(error instanceof Error ? error : new Error(String(error))); throw error; }
    finally { clearTimeout(timer); pendingValidationStops.delete(row.id); }
  }
  async function importedExecutionForRun(runId: string) {
    const [row] = await ctx.db.db.select().from(goalImportedExecutions).where(and(eq(goalImportedExecutions.runId, runId), eq(goalImportedExecutions.organizationId, ctx.organizationId)));
    if (row && row.computerId !== computerId) throw AppError.permissionDenied("H5 run belongs to another node");
    return row;
  }
  async function stopImportedExecution(row: typeof goalImportedExecutions.$inferSelect): Promise<void> {
    if (!importedExecutions) throw AppError.permissionDenied("H5 stop requires its paired receipt session");
    if (ImportedExecutionResultV1Schema.safeParse(row.result).data?.closed === true) return;
    const prior = pendingExecutionStops.get(row.id); if (prior) return prior.promise;
    let resolve!: () => void, reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); void promise.catch(() => {});
    const timer = setTimeout(() => reject(AppError.conflict("H5 process closure is still unconfirmed")), 15000);
    pendingExecutionStops.set(row.id, { promise, resolve, reject, timer });
    try { await importedExecutions.requestStop(row.id); await importedExecutions.dispatch(row.id, "stop"); await promise; }
    catch (error) { reject(error instanceof Error ? error : new Error(String(error))); throw error; }
    finally { clearTimeout(timer); pendingExecutionStops.delete(row.id); }
  }
  async function importedExecutionRepairForRun(runId: string) {
    const [row] = await ctx.db.db.select().from(goalImportedExecutionRepairs).where(and(eq(goalImportedExecutionRepairs.runId, runId), eq(goalImportedExecutionRepairs.organizationId, ctx.organizationId)));
    if (row && row.computerId !== computerId) throw AppError.permissionDenied("H6 repair run belongs to another node");
    return row;
  }
  async function stopImportedExecutionRepair(row: typeof goalImportedExecutionRepairs.$inferSelect): Promise<void> {
    if (!implementationRepairs) throw AppError.permissionDenied("H6 repair stop requires its paired receipt session");
    if (ImportedExecutionRepairResultV1Schema.safeParse(row.result).data?.closed === true) return;
    const prior = pendingRepairStops.get(row.id); if (prior) return prior.promise;
    let resolve!: () => void, reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); void promise.catch(() => {});
    const timer = setTimeout(() => reject(AppError.conflict("H6 repair process closure is still unconfirmed")), 15000);
    pendingRepairStops.set(row.id, { promise, resolve, reject, timer });
    try { await implementationRepairs.requestStop(row.id); await implementationRepairs.dispatch(row.id, "stop"); await promise; }
    catch (error) { reject(error instanceof Error ? error : new Error(String(error))); throw error; }
    finally { clearTimeout(timer); pendingRepairStops.delete(row.id); }
  }
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
    if (message.kind === "product.source.lifecycle.register.v1" || message.kind === "product.source.clean-restart.checkpoint.v1") {
      if (!ctx.sourceLifecycle || !importedReviewOptions || !executionFeatureSet.has(SOURCE_CLEAN_RESTART_FEATURE_V1)
        || !isCurrentBinding() || importedReviewOptions.qualifiedRunEventReceiptsReady?.() !== true) return;
      const frame = structuredClone(message), lifecycle = ctx.sourceLifecycle, original = importedReviewOptions;
      enqueue(async () => {
        const current = () => !closed && isCurrentBinding() && original.qualifiedRunEventReceiptsReady?.() === true;
        if (!current()) return;
        const register = frame.kind === "product.source.lifecycle.register.v1";
        const correlation = register ? frame.payload.registration.registration_id : frame.payload.generation_id;
        try {
          if (frame.kind === "product.source.lifecycle.register.v1") {
            const payload = await lifecycle.registerDaemon(original.identity, original.sessionId, frame.payload);
            if (!current()) throw AppError.conflict("Original clean lifecycle daemon changed before its registration reply");
            await transport.send({ kind: "command", id: correlation, idempotency_key: `clean-registered:${correlation}:${payload.registration_digest}`,
              type: "product.source.lifecycle.registered.v1", payload });
          } else {
            const payload = await lifecycle.checkpoint(original.identity, original.sessionId, frame.payload);
            if (!current()) throw AppError.conflict("Original clean lifecycle daemon changed before its checkpoint reply");
            await transport.send({ kind: "command", id: correlation, idempotency_key: `clean-checkpoint:${correlation}:${payload.checkpoint_digest}`,
              type: "product.source.clean-restart.checkpointed.v1", payload });
          }
        } catch (error) {
          if (current()) await transport.send({ kind: "command", id: correlation, idempotency_key: `clean-rejected:${correlation}`,
            type: "product.source.lifecycle.rejected.v1", payload: { version: 1, control: register ? "register" : "checkpoint", correlation_id: correlation,
              reason: error instanceof AppError ? error.message.slice(0, 500) : "Clean lifecycle admission could not be confirmed" } });
        }
      }); return;
    }
    if (message.kind === "product.source.recovery.register.v1" || message.kind === "product.source.recovery.available.v1"
      || message.kind === "product.source.recovery.ack.v1" || message.kind === "product.source.recovery.result.v1") {
      if (!sourceRecovery || !executionFeatureSet.has(PRODUCT_SOURCE_RECOVERY_FEATURE_V1) || !isCurrentBinding() || importedReviewOptions?.qualifiedRunEventReceiptsReady?.() !== true) return;
      const frame = structuredClone(message);
      enqueue(async () => {
        if (closed || !isCurrentBinding() || importedReviewOptions?.qualifiedRunEventReceiptsReady?.() !== true) return;
        if (frame.kind === "product.source.recovery.register.v1") await sourceRecovery.register(frame);
        else if (frame.kind === "product.source.recovery.available.v1") await sourceRecovery.available(frame);
        else if (frame.kind === "product.source.recovery.ack.v1") await sourceRecovery.acknowledge(frame);
        else await sourceRecovery.receive(frame);
      }); return;
    }
    if (message.kind === "product.source.recovery-validation.ack.v1" || message.kind === "product.source.recovery-validation.result.v1") {
      if (!recoveryValidations || !executionFeatureSet.has(IMPORTED_RECOVERY_VALIDATION_FEATURE_V1) || !isCurrentBinding() || importedReviewOptions?.qualifiedRunEventReceiptsReady?.() !== true) return;
      const frame = structuredClone(message);
      enqueue(async () => {
        if (closed || !isCurrentBinding() || importedReviewOptions?.qualifiedRunEventReceiptsReady?.() !== true) return;
        if (frame.kind === "product.source.recovery-validation.ack.v1") await recoveryValidations.acknowledge(frame);
        else { await recoveryValidations.receive(frame); const pending = pendingRecoveryValidationStops.get(frame.payload.validation_id);
          if (pending) frame.payload.closed ? pending.resolve() : pending.reject(AppError.conflict("Recovery validation closure remains uncertain")); }
      }); return;
    }
    if (message.kind === "product.source.recovery-validation-review.ack.v1" || message.kind === "product.source.recovery-validation-review.result.v1") {
      if (!recoveryValidationReviews || !executionFeatureSet.has(IMPORTED_RECOVERY_VALIDATION_REVIEW_FEATURE_V1) || !isCurrentBinding() || importedReviewOptions?.qualifiedRunEventReceiptsReady?.() !== true) return;
      const frame = structuredClone(message);
      enqueue(async () => {
        if (closed || !isCurrentBinding() || importedReviewOptions?.qualifiedRunEventReceiptsReady?.() !== true) return;
        if (frame.kind === "product.source.recovery-validation-review.ack.v1") await recoveryValidationReviews.acknowledge(frame); else await recoveryValidationReviews.receive(frame);
      }); return;
    }
    if (message.kind === "product.source.clean-validation.ack.v1" || message.kind === "product.source.clean-validation.result.v1") {
      if (!cleanValidations || !executionFeatureSet.has(IMPORTED_CLEAN_VALIDATION_FEATURE_V1) || !isCurrentBinding() || importedReviewOptions?.qualifiedRunEventReceiptsReady?.() !== true) return;
      const frame = structuredClone(message);
      enqueue(async () => {
        if (closed || !isCurrentBinding() || importedReviewOptions?.qualifiedRunEventReceiptsReady?.() !== true) return;
        if (frame.kind === "product.source.clean-validation.ack.v1") await cleanValidations.acknowledge(frame);
        else { await cleanValidations.receive(frame); const pending = pendingCleanValidationStops.get(frame.payload.validation_id);
          if (pending) frame.payload.closed ? pending.resolve() : pending.reject(AppError.conflict("Recovery validation closure remains uncertain")); }
      }); return;
    }
    if (message.kind === "product.source.clean-validation-review.ack.v1" || message.kind === "product.source.clean-validation-review.result.v1") {
      if (!cleanValidationReviews || !executionFeatureSet.has(IMPORTED_CLEAN_VALIDATION_REVIEW_FEATURE_V1) || !isCurrentBinding() || importedReviewOptions?.qualifiedRunEventReceiptsReady?.() !== true) return;
      const frame = structuredClone(message);
      enqueue(async () => {
        if (closed || !isCurrentBinding() || importedReviewOptions?.qualifiedRunEventReceiptsReady?.() !== true) return;
        if (frame.kind === "product.source.clean-validation-review.ack.v1") await cleanValidationReviews.acknowledge(frame); else await cleanValidationReviews.receive(frame);
      }); return;
    }
    if (message.kind === "product.source.validation.ack.v1" || message.kind === "product.source.validation.result.v1") {
      if (!validations || !executionFeatureSet.has(IMPORTED_VALIDATION_FEATURE_V1) || !isCurrentBinding() || importedReviewOptions?.qualifiedRunEventReceiptsReady?.() !== true) return;
      const frame = structuredClone(message);
      enqueue(async () => {
        if (closed || !isCurrentBinding() || importedReviewOptions?.qualifiedRunEventReceiptsReady?.() !== true) return;
        if (frame.kind === "product.source.validation.ack.v1") await validations.acknowledge(frame);
        else { await validations.receive(frame); const pending = pendingValidationStops.get(frame.payload.validation_id);
          if (pending) frame.payload.closed ? pending.resolve() : pending.reject(AppError.conflict("H7 validation closure remains uncertain")); }
      });
      return;
    }
    if (message.kind === "product.source.validation-review.ack.v1" || message.kind === "product.source.validation-review.result.v1") {
      if (!validationReviews || !executionFeatureSet.has(IMPORTED_VALIDATION_FEATURE_V1) || !isCurrentBinding() || importedReviewOptions?.qualifiedRunEventReceiptsReady?.() !== true) return;
      const frame = structuredClone(message);
      enqueue(async () => {
        if (closed || !isCurrentBinding() || importedReviewOptions?.qualifiedRunEventReceiptsReady?.() !== true) return;
        if (frame.kind === "product.source.validation-review.ack.v1") await validationReviews.acknowledge(frame); else await validationReviews.receive(frame);
      });
      return;
    }
    if (message.kind === "product.source.execution-repair.ack.v1" || message.kind === "product.source.execution-repair.result.v1") {
      if (!implementationRepairs || !executionFeatureSet.has(IMPORTED_EXECUTION_REVIEW_FEATURE_V1) || !isCurrentBinding() || importedReviewOptions?.qualifiedRunEventReceiptsReady?.() !== true) return;
      const frame = structuredClone(message);
      enqueue(async () => {
        if (closed || !isCurrentBinding() || importedReviewOptions?.qualifiedRunEventReceiptsReady?.() !== true) return;
        if (frame.kind === "product.source.execution-repair.ack.v1") await implementationRepairs.acknowledge(frame);
        else { await implementationRepairs.receive(frame); const pending = pendingRepairStops.get(frame.payload.repair_id);
          if (pending) frame.payload.closed ? pending.resolve() : pending.reject(AppError.conflict("H6 repair closure remains uncertain")); }
      });
      return;
    }
    if (message.kind === "product.source.execution.ack.v1" || message.kind === "product.source.execution.result.v1") {
      if (!importedExecutions || !executionFeatureSet.has(IMPORTED_EXECUTION_FEATURE_V1) || !isCurrentBinding() || importedReviewOptions?.qualifiedRunEventReceiptsReady?.() !== true) return;
      const frame = structuredClone(message);
      enqueue(async () => {
        if (closed || !isCurrentBinding() || importedReviewOptions?.qualifiedRunEventReceiptsReady?.() !== true) return;
        if (frame.kind === "product.source.execution.ack.v1") await importedExecutions.acknowledge(frame);
        else { await importedExecutions.receive(frame); const pending = pendingExecutionStops.get(frame.payload.execution_id);
          if (pending) frame.payload.closed ? pending.resolve() : pending.reject(AppError.conflict("H5 closure remains uncertain")); }
      });
      return;
    }
    if (message.kind === "product.source.execution-review.ack.v1" || message.kind === "product.source.execution-review.result.v1") {
      if (!implementationReviews || !executionFeatureSet.has(IMPORTED_EXECUTION_REVIEW_FEATURE_V1) || !isCurrentBinding() || importedReviewOptions?.qualifiedRunEventReceiptsReady?.() !== true) return;
      const frame = structuredClone(message);
      enqueue(async () => {
        if (closed || !isCurrentBinding() || importedReviewOptions?.qualifiedRunEventReceiptsReady?.() !== true) return;
        if (frame.kind === "product.source.execution-review.ack.v1") await implementationReviews.acknowledge(frame); else await implementationReviews.receive(frame);
      });
      return;
    }
    if (message.kind === "product.source.design-review.ack.v1" || message.kind === "product.source.design-review.result.v1") {
      if (!importedDesignReviews || !executionFeatureSet.has(IMPORTED_DESIGN_REVIEW_FEATURE_V1) || !isCurrentBinding() || importedReviewOptions?.qualifiedRunEventReceiptsReady?.() !== true) return;
      const frame = structuredClone(message);
      enqueue(async () => {
        if (closed || !isCurrentBinding() || importedReviewOptions?.qualifiedRunEventReceiptsReady?.() !== true) return;
        if (frame.kind === "product.source.design-review.ack.v1") await importedDesignReviews.acknowledge(frame); else await importedDesignReviews.receive(frame);
      });
      return;
    }
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
      enqueue(async () => { if (!closed && isCurrentBinding()) await ingestProductReleaseReceipt(ctx, computerId, payload, () => !closed && isCurrentBinding(), pairedSession); });
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
    } else if (message.kind === "application.publication.receipt" || message.kind === "application.publication.observation") {
      if (!pairedSession || message.node_id !== computerId || !isCurrentBinding()) return;
      const frame = structuredClone(message);
      enqueue(async () => {
        const current = () => !closed && isCurrentBinding() && pairedSession.sessionId === frame.payload.request.publisher_session_id;
        let status: "accepted" | "rejected" = "accepted", failure: string | undefined;
        try {
          if (frame.kind === "application.publication.receipt") await ingestApplicationPublicationReceipt(ctx, computerId, frame.payload, current);
          else await ingestApplicationPublicationObservation(ctx, computerId, frame.payload, current);
        } catch (error) { status = "rejected"; failure = error instanceof Error ? error.message.slice(0, 2000) : "Application publication evidence rejected"; }
        if (!current()) return;
        const base = { version: 1 as const, publication_id: frame.payload.request.publication_id,
          publisher_session_id: frame.payload.request.publisher_session_id, request_digest: frame.payload.request_digest,
          status, ...(failure ? { message: failure } : {}) };
        if (frame.kind === "application.publication.receipt") await transport.send({ kind: "command", id: `application-receipt:${base.publication_id}`,
          idempotency_key: `application-receipt:${base.publication_id}`, type: "application.publication.receipt.ack",
          payload: { ...base, receipt_digest: applicationPublicationDigest(frame.payload) } });
        else await transport.send({ kind: "command", id: `application-observation:${frame.payload.event_id}`,
          idempotency_key: `application-observation:${frame.payload.event_id}`, type: "application.publication.observation.ack",
          payload: { ...base, event_id: frame.payload.event_id, sequence: frame.payload.sequence, observation_digest: applicationPublicationDigest(frame.payload) } });
      });
    } else if (message.kind === "run.event") {
      // Snapshot serialized-wire semantics before queued work can observe caller mutation.
      let frame: typeof message;
      try { frame = JSON.parse(JSON.stringify(message)) as typeof message; } catch { return; }
      enqueue(async () => {
        if (!(await ownsRun(frame.run_id))) return;
        let status: "accepted" | "rejected" = "accepted";
        let applicationVerification: ApplicationPublicationVerificationAckV1 | undefined;
        try {
          const result = await ingestWireRunEvent(ctx, frame, profile => {
            const current = binding.getOwnedResultProfile?.(profile.result_profile.id, profile.verifier_template.id, profile.project_id);
            return !!current && isDeepStrictEqual(current, profile);
          });
          if (result === null) return;
          if (!result.receiptBodyIdentity) throw new Error("run event did not obtain a qualified receipt");
          if (frame.event.type === "run.verification" && frame.event.payload.application?.publication) {
            if (!pairedSession || !binding.supportsExecutionFeature(APPLICATION_PUBLICATION_FEATURE_V1)
              || importedReviewOptions?.qualifiedRunEventReceiptsReady?.() !== true)
              throw AppError.conflict("Application verification receipt requires the current paired publication session");
            applicationVerification = await committedApplicationVerificationReceipt(ctx, frame, pairedSession,
              () => !closed && isCurrentBinding() && importedReviewOptions?.qualifiedRunEventReceiptsReady?.() === true);
          }
          if (frame.event.type === "run.lifecycle" && ["started", "completed", "failed", "cancelled"].includes(frame.event.payload.phase)) {
            forgetSourceStart(frame.run_id);
          }
        } catch { status = "rejected"; }
        if (closed || !isCurrentBinding()) return;
        await transport.send({
          kind: "command", id: `receipt:${frame.run_id}:${frame.sequence}`,
          idempotency_key: `receipt:${frame.run_id}:${frame.sequence}`, type: "run.event.ack",
          payload: { run_id: frame.run_id, sequence: frame.sequence, status,
            ...(status === "accepted" && applicationVerification ? { application_verification: applicationVerification } : {}),
            ...(status === "rejected" ? { message: "run event could not be accepted" } : {}),
          },
        });
      });
    } else if (message.kind === "command.ack" && pendingApplicationStops.has(message.command_id)) {
      const pending = pendingApplicationStops.get(message.command_id)!;
      pendingApplicationStops.delete(message.command_id); clearTimeout(pending.timer);
      enqueue(async () => { if (message.status === "accepted") pending.resolve(); else pending.reject(AppError.conflict(message.message)); });
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
        else { retireSourceStart(pending.runId); pending.resolve(); }
      });
    } else if (message.kind === "command.ack" && message.status === "rejected") {
      const startRunId = pendingCommandRun.get(message.command_id);
      if (startRunId !== undefined) {
        pendingCommandRun.delete(message.command_id);
        retireSourceStart(startRunId, message.command_id);
        enqueue(async () => {
          if (await ownsRun(startRunId)) {
            await failRunStart(ctx, startRunId, message.error_code, message.message);
            forgetSourceStart(startRunId, message.command_id);
          }
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
      // An ACK can arrive before the first lifecycle event commits. Keep the
      // complete source-start identity until the run actually leaves queued.
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
    // Capture before the first read: Stop/rejection/lifecycle handling may retire
    // this entry during any awaited admission check, not only the transaction.
    const previousSourceStart = pendingSourceStarts.get(runId);
    if (await importedExecutionForRun(runId)) throw AppError.permissionDenied("H5 requires its dedicated single-use execution command");
    if (await importedExecutionRepairForRun(runId)) throw AppError.permissionDenied("Repair requires its dedicated single-use authorization command");
    if (await recoveryValidationForRun(runId)) throw AppError.permissionDenied("Recovery validation requires its dedicated current-epoch command");
    if (await cleanValidationForRun(runId)) throw AppError.permissionDenied("Recovery validation requires its dedicated current-epoch command");
    if (await importedValidationForRun(runId)) throw AppError.permissionDenied("H7 requires its dedicated single-use validation command");
    if (await importedDesignForRun(runId)) throw AppError.permissionDenied("Imported design requires its dedicated single-use start command");
    const [run] = await ctx.db.db.select().from(runs).where(and(
      eq(runs.id, runId), eq(runs.organizationId, ctx.organizationId),
    ));
    assertCurrentStartBinding(runId);
    if (!run || run.computerId !== computerId) throw AppError.permissionDenied("run is not owned by this node");
    if (run.status !== "queued") { forgetSourceStart(runId); return; }
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
    if (latest.status !== "queued") { forgetSourceStart(runId); return; }
    if (allocated) assertAllocationFeature(runId);

    // The node's source replay gate receives every ordinary run.start before
    // planning/verification admission, including starts it will reject. Retain
    // their stable complete request, without granting new execution authority.
    // Fresh fallback ContextPack IDs, clean mode and owned/allocated paths stay unchanged.
    const sourceStartScope = () => !ownedAssignment && !allocated
      && run.contextPackId !== null && persistedContextPack !== undefined && context.payload !== undefined
      && !executionFeatureSet.has(SOURCE_CLEAN_RESTART_FEATURE_V1)
      && binding.supportsExecutionFeature(PRODUCT_SOURCE_RECOVERY_FEATURE_V1);
    const retainSourceStart = sourceStartScope();
    if (previousSourceStart && !retainSourceStart) throw AppError.conflict("Pending source startup no longer has its original dispatch scope");
    const commandId = previousSourceStart?.id ?? ctx.idGen.generate("cmd");
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
    if (previousSourceStart && !isDeepStrictEqual(previousSourceStart, command)) {
      throw AppError.conflict("Pending source startup complete request changed; original execution identity is retained");
    }
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
      await ctx.db.transaction(async tx => {
        await assertDesignRevisionRunAdmission(ctx, tx, run, { live: true });
        // Keep the computer fence through the real send. prepareStop takes this
        // same lock before freezing the complete native executor operation set.
        await assertSourceLineageDispatch(ctx, tx, computerId, workspaceRoot);
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
          if (verification.application || context.payload!.app_delivery || context.payload!.app_publication || verification.application_publication) {
            const intent = context.payload!.application_publication;
            if (!verification.application || !!context.payload!.app_delivery === !!context.payload!.app_publication || !current?.application || allocated || workspaceBranch !== null
              || !binding.supportsExecutionFeature(APPLICATION_VERIFICATION_FEATURE_V1)
              || !isDeepStrictEqual(verification.application, applicationRequirement(current.application, context.payload!.review_subject?.verification?.application))) {
              throw AppError.conflict("The current node cannot enforce this application's exact configured development requirement",
                { run_id: runId, dispatch: "blocked", reason: "unsupported_application_verification" });
            }
            if (context.payload!.app_publication) {
              const configured = intent && binding.getApplicationPublicationCapabilities?.(intent.authorization.grant.publication_profile_id, context.payload!.project.id);
              if (!intent || !verification.application_publication || !pairedSession || intent.publisher_session_id !== pairedSession.sessionId
                || intent.agent_instance_id !== run.agentInstanceId || !configured || !isDeepStrictEqual(configured, intent.capabilities)
                || !isDeepStrictEqual(intent.authorization.grant, context.payload!.app_publication)
                || !isDeepStrictEqual(verification.application_publication, { version: 1, authorization_event_id: intent.authorization.event_id,
                  publication_profile_id: configured.binding.publication_profile_id, publication_profile_digest: configured.binding.publication_profile_digest,
                  publication_contract_digest: configured.binding.publication_contract_digest, publisher_session_id: pairedSession.sessionId }))
                throw AppError.conflict("Application publication run lost its original paired grant and configured capability");
            } else if (intent || verification.application_publication) throw AppError.conflict("Development-only run cannot obtain publication authority");
          }
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
        // A fresh invocation must also respect Stop/rejection while the durable
        // transition is still pending. This marker never authorizes a restart.
        if (retiredSourceStarts.has(runId)) return;
        let delivery = command;
        if (retainSourceStart || previousSourceStart) {
          const current = pendingSourceStarts.get(runId);
          // A lifecycle or confirmed Stop may retire the pending start while
          // this re-delivery awaits the fences above. Never resurrect it.
          if (previousSourceStart && current !== previousSourceStart) return;
          if (!sourceStartScope() || command.type !== "run.start") throw AppError.conflict("Pending source startup no longer has its original dispatch scope");
          if (current && !isDeepStrictEqual(current, command)) throw AppError.conflict("Pending source startup complete request changed; original execution identity is retained");
          if (!current) {
            const snapshot = structuredClone(command);
            const freeze = (value: object): void => {
              for (const child of Object.values(value)) if (child !== null && typeof child === "object") freeze(child);
              Object.freeze(value);
            };
            freeze(snapshot);
            pendingSourceStarts.set(runId, snapshot);
          }
          delivery = pendingSourceStarts.get(runId)!;
        }
        pendingCommandRun.set(commandId, runId);
        // After send is invoked, disconnect/error may still mean delivery occurred.
        // Do not fail the run or release leases from this dispatch path.
        sendInvoked = true;
        await transport.send(delivery);
      });
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
      if (feature === APPLICATION_PUBLICATION_FEATURE_V1 && (!pairedSession
        || importedReviewOptions?.qualifiedRunEventReceiptsReady?.() !== true || !publicationProfiles.length
        || !["windows", "win32"].includes(nodeOs ?? ""))) return false;
      if ([IMPORTED_CLEAN_VALIDATION_FEATURE_V1, IMPORTED_CLEAN_VALIDATION_REVIEW_FEATURE_V1, PRODUCT_RELEASE_CLEAN_FEATURE_V1].includes(feature)
        && (!ctx.sourceLifecycle || !cleanValidations || !cleanValidationReviews || importedReviewOptions?.qualifiedRunEventReceiptsReady?.() !== true)) return false;
      if (feature === SOURCE_CLEAN_RESTART_FEATURE_V1 && (!ctx.sourceLifecycle || !sourceRecovery
        || importedReviewOptions?.qualifiedRunEventReceiptsReady?.() !== true)) return false;
      if ([PRODUCT_SOURCE_RECOVERY_FEATURE_V1, IMPORTED_RECOVERY_VALIDATION_FEATURE_V1, IMPORTED_RECOVERY_VALIDATION_REVIEW_FEATURE_V1].includes(feature)
        && (!sourceRecovery || importedReviewOptions?.qualifiedRunEventReceiptsReady?.() !== true)) return false;
      if ((feature === IMPORTED_DESIGN_CONTINUATION_FEATURE_V1 || feature === IMPORTED_DESIGN_REVIEW_FEATURE_V1 || feature === IMPORTED_EXECUTION_FEATURE_V1 || feature === IMPORTED_EXECUTION_REVIEW_FEATURE_V1 || feature === IMPORTED_VALIDATION_FEATURE_V1) && (!importedDesigns || importedReviewOptions?.qualifiedRunEventReceiptsReady?.() !== true)) return false;
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
    getPairedNodeSession() {
      if (closed || !isCurrentBinding() || !pairedSession) return undefined;
      return { ...pairedSession };
    },
    getApplicationPublicationCapabilities(profileId, projectId) {
      if (closed || !isCurrentBinding() || !pairedSession || importedReviewOptions?.qualifiedRunEventReceiptsReady?.() !== true
        || !binding.supportsExecutionFeature(APPLICATION_PUBLICATION_FEATURE_V1)) return undefined;
      const profile = publicationProfiles.find(item => item.profile_id === profileId && item.project_id === projectId && item.computer_id === computerId);
      if (!profile) return undefined;
      const verifier = profileSnapshot.find(item => item.profile_id === profile.verification_profile_id && item.project_id === projectId);
      const capabilities = verifier?.capabilities, profileBinding = profile.capabilities.binding;
      if (!capabilities?.application || capabilities.profile_digest !== profileBinding.verification_profile_digest
        || capabilities.application.config_digest !== profileBinding.application_config_digest
        || capabilities.application.contract_digest !== profileBinding.application_contract_digest) return undefined;
      return structuredClone(profile.capabilities);
    },
    async announceApplicationPublicationSession() {
      if (closed || !isCurrentBinding() || !pairedSession || importedReviewOptions?.qualifiedRunEventReceiptsReady?.() !== true
        || !executionFeatureSet.has(APPLICATION_PUBLICATION_FEATURE_V1) || !publicationProfiles.some(profile =>
          binding.getApplicationPublicationCapabilities?.(profile.profile_id, profile.project_id))) return;
      await transport.send({ kind: "command", id: `application-session:${pairedSession.sessionId}`,
        idempotency_key: `application-session:${pairedSession.sessionId}`, type: "application.publication.session.v1",
        payload: { version: 1, node_id: computerId, session_id: pairedSession.sessionId } });
      if (closed || !isCurrentBinding()) throw AppError.conflict("Application publication session announcement lost its original binding");
    },
    async dispatchApplicationPublication(publicationId, control) {
      if (closed || !isCurrentBinding() || !pairedSession) throw AppError.conflict("Original application publication node is unavailable");
      const [row] = await ctx.db.db.select().from(applicationPublications).where(and(eq(applicationPublications.id, publicationId),
        eq(applicationPublications.organizationId, ctx.organizationId), eq(applicationPublications.computerId, computerId)));
      if (!row) throw AppError.notFound("Application publication not found on this node");
      const request = control === "start" ? await assertApplicationPublicationDispatch(ctx, row) : ApplicationPublicationRequestV1Schema.parse(row.request);
      if (closed || !isCurrentBinding() || pairedSession.sessionId !== request.publisher_session_id)
        throw AppError.conflict("Application publication cannot adopt another paired connection");
      const id = `application-${control}:${row.id}`;
      if (control !== "stop") {
        await transport.send({ kind: "command", id, idempotency_key: id,
          type: control === "start" ? "application.publication.start" : "application.publication.status", payload: request });
        return;
      }
      if (pendingApplicationStops.has(id)) throw AppError.conflict("Original application stop is still pending");
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { pendingApplicationStops.delete(id); reject(AppError.conflict("Original application stop confirmation timed out")); },
          Math.min(60_000, request.capabilities.contract.limits.normal_drain_reserve_ms + 5_000));
        pendingApplicationStops.set(id, { resolve, reject, timer });
        void transport.send({ kind: "command", id, idempotency_key: id, type: "application.publication.stop",
          payload: { version: 1, request, reason: "user-stop" } }).catch(error => {
            clearTimeout(timer); pendingApplicationStops.delete(id); reject(error);
          });
      });
    },
    async redeliverCommittedSourceReceipt(family, id): Promise<void> {
      const owner = {
        design: { feature: IMPORTED_DESIGN_CONTINUATION_FEATURE_V1, binding: importedDesigns },
        "design-review": { feature: IMPORTED_DESIGN_REVIEW_FEATURE_V1, binding: importedDesignReviews },
        execution: { feature: IMPORTED_EXECUTION_FEATURE_V1, binding: importedExecutions },
        "execution-review": { feature: IMPORTED_EXECUTION_REVIEW_FEATURE_V1, binding: implementationReviews },
        "execution-repair": { feature: IMPORTED_EXECUTION_REVIEW_FEATURE_V1, binding: implementationRepairs },
        validation: { feature: IMPORTED_VALIDATION_FEATURE_V1, binding: validations },
        "validation-review": { feature: IMPORTED_VALIDATION_FEATURE_V1, binding: validationReviews },
      }[family];
      if (!owner?.binding || !binding.supportsExecutionFeature(owner.feature)
        || importedReviewOptions?.qualifiedRunEventReceiptsReady?.() !== true || !binding.getPairedNodeSession?.())
        throw AppError.permissionDenied("Source receipt recovery requires its original current feature and qualified receipt session");
      // Return the actual transaction lifetime; the inbound queue intentionally
      // observes errors without returning its tail and cannot own maintenance.
      await owner.binding.redeliverCommittedReceipt(id);
    },
    getProductSourceRouting() {
      if (!routingSnapshot || !binding.getPairedNodeSession?.() || importedReviewOptions?.qualifiedRunEventReceiptsReady?.() !== true
        || !["product-source-transfer.v2", "product-source-transfer.measurement-v2.v1", "product-source-operations.v1"]
          .every(feature => binding.supportsExecutionFeature(feature))) return undefined;
      const currentRelease = (release: ReleaseCapabilitiesV1) => {
        const scope = release.binding;
        return isDeepStrictEqual(binding.getReleaseCapabilities?.(scope.release_profile_id, scope.project_id, scope.workspace_root,
          scope.verification_profile_id), release);
      };
      if (routingSnapshot.source_exports.some(release => !currentRelease(release))
        || routingSnapshot.destination_mappings.some(mapping => !currentRelease(mapping.destination_release))) return undefined;
      // A caller can inspect a defensive snapshot; it cannot change the accepted hello.
      return structuredClone(routingSnapshot);
    },
    async dispatchImportedExecution(executionId, control): Promise<void> {
      if (!importedExecutions || !binding.supportsExecutionFeature(IMPORTED_EXECUTION_FEATURE_V1)) throw AppError.permissionDenied("H5 requires its current paired receipt session and execution feature");
      await importedExecutions.dispatch(executionId, control);
    },
    async dispatchImportedValidation(validationId, control): Promise<void> {
      if (!validations || !binding.supportsExecutionFeature(IMPORTED_VALIDATION_FEATURE_V1)) throw AppError.permissionDenied("H7 validation requires its current paired receipt session and feature");
      await validations.dispatch(validationId, control);
    },
    async announceSourceRecoverySession(): Promise<void> {
      if (!pairedSession || !sourceRecovery || !binding.supportsExecutionFeature(PRODUCT_SOURCE_RECOVERY_FEATURE_V1)
        || importedReviewOptions?.qualifiedRunEventReceiptsReady?.() !== true) return;
      await transport.send({ kind: "command", id: `recovery-session:${pairedSession.sessionId}`, idempotency_key: `recovery-session:${pairedSession.sessionId}`,
        type: "product.source.recovery.session.v1", payload: { version: 1, node_id: computerId, session_id: pairedSession.sessionId } });
      if (closed || !isCurrentBinding()) throw AppError.conflict("Recovery session announcement lost its current node binding");
    },
    async dispatchSourceRecovery(recoveryId, control): Promise<void> {
      if (!sourceRecovery || !binding.supportsExecutionFeature(PRODUCT_SOURCE_RECOVERY_FEATURE_V1)) throw AppError.permissionDenied("Recovery requires the current native recovery feature");
      await sourceRecovery.dispatch(recoveryId, control);
    },
    async dispatchRecoveryValidation(validationId, control): Promise<void> {
      if (!recoveryValidations || !binding.supportsExecutionFeature(IMPORTED_RECOVERY_VALIDATION_FEATURE_V1)) throw AppError.permissionDenied("Recovery validation requires its current native author feature");
      await recoveryValidations.dispatch(validationId, control);
    },
    async dispatchRecoveryValidationReview(reviewId, control): Promise<void> {
      if (!recoveryValidationReviews || !binding.supportsExecutionFeature(IMPORTED_RECOVERY_VALIDATION_REVIEW_FEATURE_V1)) throw AppError.permissionDenied("Recovery review requires its current native reviewer feature");
      await recoveryValidationReviews.dispatch(reviewId, control);
    },
    async dispatchCleanValidation(validationId, control): Promise<void> {
      if (!cleanValidations || !binding.supportsExecutionFeature(IMPORTED_CLEAN_VALIDATION_FEATURE_V1)) throw AppError.permissionDenied("Recovery validation requires its current native author feature");
      await cleanValidations.dispatch(validationId, control);
    },
    async dispatchCleanValidationReview(reviewId, control): Promise<void> {
      if (!cleanValidationReviews || !binding.supportsExecutionFeature(IMPORTED_CLEAN_VALIDATION_REVIEW_FEATURE_V1)) throw AppError.permissionDenied("Recovery review requires its current native reviewer feature");
      await cleanValidationReviews.dispatch(reviewId, control);
    },
    async dispatchImportedValidationReview(reviewId, control): Promise<void> {
      if (!validationReviews || !binding.supportsExecutionFeature(IMPORTED_VALIDATION_FEATURE_V1)) throw AppError.permissionDenied("H7 final-product review requires its current paired receipt session and feature");
      await validationReviews.dispatch(reviewId, control);
    },
    async dispatchImportedExecutionReview(reviewId, control): Promise<void> {
      if (!implementationReviews || !binding.supportsExecutionFeature(IMPORTED_EXECUTION_REVIEW_FEATURE_V1)) throw AppError.permissionDenied("H6 review requires its current paired receipt session and execution feature");
      await implementationReviews.dispatch(reviewId, control);
    },
    async dispatchImportedExecutionRepair(repairId, control): Promise<void> {
      if (!implementationRepairs || !binding.supportsExecutionFeature(IMPORTED_EXECUTION_REVIEW_FEATURE_V1)) throw AppError.permissionDenied("H6 repair requires its current paired receipt session and execution feature");
      await implementationRepairs.dispatch(repairId, control);
    },
    async dispatchImportedDesignReview(reviewId, control): Promise<void> {
      if (!importedDesignReviews || !binding.supportsExecutionFeature(IMPORTED_DESIGN_REVIEW_FEATURE_V1)) throw AppError.permissionDenied("H4 requires its current paired receipt session and execution feature");
      await importedDesignReviews.dispatch(reviewId, control);
    },
    async dispatchImportedDesignContinuation(continuationId, control): Promise<void> {
      if (!importedDesigns) throw AppError.permissionDenied("Imported design requires its paired receipt session");
      await importedDesigns.dispatch(continuationId, control);
    },
    async dispatchProductRelease(releaseId): Promise<void> {
      assertCurrentStartBinding(releaseId);
      await ctx.db.transaction(async tx => {
      const [header] = await tx.select({ goalId: productReleases.goalId }).from(productReleases).where(and(eq(productReleases.id, releaseId), eq(productReleases.organizationId, ctx.organizationId)));
      if (header) await tx.select().from(goals).where(and(eq(goals.id, header.goalId), eq(goals.organizationId, ctx.organizationId))).for("update");
      const [row] = await tx.select({ release: productReleases, goal: goals, automation: goalAutomations })
        .from(productReleases).innerJoin(goals, eq(goals.id, productReleases.goalId)).innerJoin(goalAutomations, eq(goalAutomations.goalId, goals.id))
        .where(and(eq(productReleases.id, releaseId), eq(productReleases.organizationId, ctx.organizationId))).for("update");
      if (!row || row.release.computerId !== computerId) throw AppError.permissionDenied("release is not owned by this node");
      if (row.release.status !== "queued" || row.goal.status !== "running" || !["executing", "waiting"].includes(row.automation.status)) return;
      const request = ProductReleaseRequestSchema.parse(row.release.request);
      await assertProductReleaseRetryDispatch(ctx, tx, row.release, pairedSession);
      if (request.imported_clean && !binding.supportsExecutionFeature(PRODUCT_RELEASE_CLEAN_FEATURE_V1))
        throw AppError.conflict("Current native executor does not advertise clean publication authority");
      const clean = await inspectCleanValidationPublicationDispatch(ctx, tx, row.release);
      const imported = clean ?? await inspectRecoveryValidationPublicationDispatch(ctx, tx, row.release)
        ?? await inspectImportedValidationPublicationDispatch(ctx, tx, row.release);
      const workspaceRoot = imported?.run.workspaceRoot ?? row.automation.workspaceRoot;
      if (!workspaceRoot || !binding.supportsReleaseProfile?.(request.release_profile_id, row.release.projectId, workspaceRoot, request.verification_profile_id)) {
        throw AppError.conflict("Current node does not advertise the bound release profile");
      }
      if (request.acceptance_binding) {
        const current = binding.getReleaseCapabilities?.(request.release_profile_id, row.release.projectId,
          workspaceRoot, request.verification_profile_id);
        if (!current || !isDeepStrictEqual(current.binding, request.acceptance_binding.release_binding)
          || imported && !isDeepStrictEqual(current, imported.capabilities)) {
          throw AppError.conflict("Current node publication acceptance contract differs from the immutable request");
        }
      }
      await assertNoActiveDesignRevision(ctx, tx, row.goal.id);
      const [sourceRun] = await tx.select().from(runs).where(and(eq(runs.id, row.release.runId), eq(runs.organizationId, ctx.organizationId)));
      if (!sourceRun) throw AppError.conflict("Publication source execution is missing");
      if (!imported) await assertDesignRevisionRunAdmission(ctx, tx, sourceRun, { acceptance: true });
      // The clean resolver holds its exact generation gate through this send;
      // every other release retains the ordinary lineage fence.
      if (!clean) await assertSourceLineageDispatch(ctx, tx, computerId, workspaceRoot);
      assertCurrentStartBinding(releaseId);
      await transport.send({ kind: "command", id: `release:${releaseId}`, idempotency_key: `release:${releaseId}`,
        type: "product.release", payload: request });
      assertCurrentStartBinding(releaseId);
      });
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
      const importedExecution = await importedExecutionForRun(runId);
      if (importedExecution) { await binding.dispatchImportedExecution!(importedExecution.id, "status"); return; }
      const importedRepair = await importedExecutionRepairForRun(runId);
      if (importedRepair) { await binding.dispatchImportedExecutionRepair!(importedRepair.id, "status"); return; }
      const recoveredValidation = await recoveryValidationForRun(runId);
      if (recoveredValidation) { await binding.dispatchRecoveryValidation!(recoveredValidation.id, "status"); return; }
      const cleanedValidation = await cleanValidationForRun(runId);
      if (cleanedValidation) { await binding.dispatchCleanValidation!(cleanedValidation.id, "status"); return; }
      const importedValidation = await importedValidationForRun(runId);
      if (importedValidation) { await binding.dispatchImportedValidation!(importedValidation.id, "status"); return; }
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
      const importedExecution = await importedExecutionForRun(runId);
      if (importedExecution) return stopImportedExecution(importedExecution);
      const importedRepair = await importedExecutionRepairForRun(runId);
      if (importedRepair) return stopImportedExecutionRepair(importedRepair);
      const recoveredValidation = await recoveryValidationForRun(runId);
      if (recoveredValidation) return stopRecoveryValidation(recoveredValidation);
      const cleanedValidation = await cleanValidationForRun(runId);
      if (cleanedValidation) return stopCleanValidation(cleanedValidation);
      const importedValidation = await importedValidationForRun(runId);
      if (importedValidation) return stopImportedValidation(importedValidation);
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
      for (const runId of pendingSourceStarts.keys()) forgetSourceStart(runId);
      for (const pending of pendingResumeRun.values()) clearTimeout(pending.timer);
      pendingResumeRun.clear();
      for (const pending of pendingStops.values()) {
        clearTimeout(pending.timer);
        pending.reject(AppError.conflict("node disconnected before process stop was confirmed"));
      }
      pendingStops.clear();
      for (const pending of pendingDesignStops.values()) { clearTimeout(pending.timer); pending.reject(AppError.conflict("Node disconnected before imported design closure")); }
      pendingDesignStops.clear();
      for (const pending of pendingExecutionStops.values()) { clearTimeout(pending.timer); pending.reject(AppError.conflict("Node disconnected before H5 closure")); }
      pendingExecutionStops.clear();
      for (const pending of pendingRepairStops.values()) { clearTimeout(pending.timer); pending.reject(AppError.conflict("Node disconnected before repair closure")); }
      pendingRepairStops.clear();
      for (const pending of pendingValidationStops.values()) { clearTimeout(pending.timer); pending.reject(AppError.conflict("Node disconnected before validation closure")); }
      pendingValidationStops.clear();
      for (const pending of pendingRecoveryValidationStops.values()) { clearTimeout(pending.timer); pending.reject(AppError.conflict("Node disconnected before recovery validation closure")); }
      for (const pending of pendingCleanValidationStops.values()) { clearTimeout(pending.timer); pending.reject(AppError.conflict("Node disconnected before recovery validation closure")); }
      pendingRecoveryValidationStops.clear();
      pendingCleanValidationStops.clear();
      for (const pending of pendingReleaseStops.values()) { clearTimeout(pending.timer); pending.reject(AppError.conflict("Node disconnected before publication stop was confirmed")); }
      pendingReleaseStops.clear();
      for (const pending of pendingApplicationStops.values()) { clearTimeout(pending.timer); pending.reject(AppError.conflict("Node disconnected before original application stop was confirmed")); }
      pendingApplicationStops.clear();
    },
  };
  return binding;
}
