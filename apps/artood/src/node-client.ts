import { observeWindowsStopStage, recordWindowsStopDiagnostic } from "./windows-stop-diagnostics.js";
import { createHash, randomUUID } from "node:crypto";
import { ManagedDelivery, boundedOperation, abortableOperation, DeliveryCancelled,
  type ManagedJournalOptions, type ManagedSession } from "./managed/managed-delivery.js";
import type { FreshLaunchPermit, JournalRun, TerminalSettlement } from "./managed/journal-types.js";
import { PRODUCT_SOURCE_TRANSFER_FEATURE_V1, PRODUCT_SOURCE_TRANSFER_FEATURE_V2, PRODUCT_SOURCE_TRANSFER_MEASUREMENT_V2_FEATURE_V1,
  PRODUCT_SOURCE_OPERATIONS_FEATURE_V1, IMPORTED_PRODUCT_REVIEW_FEATURE_V1, IMPORTED_DESIGN_CONTINUATION_FEATURE_V1,
  IMPORTED_DESIGN_REVIEW_FEATURE_V1, IMPORTED_EXECUTION_FEATURE_V1, IMPORTED_EXECUTION_REVIEW_FEATURE_V1, IMPORTED_VALIDATION_FEATURE_V1,
  SOURCE_CLEAN_RESTART_FEATURE_V1, IMPORTED_CLEAN_VALIDATION_FEATURE_V1, IMPORTED_CLEAN_VALIDATION_REVIEW_FEATURE_V1, PRODUCT_RELEASE_CLEAN_FEATURE_V1,
  PRODUCT_RESEARCH_REVISION_FEATURE_V1 } from "@artoo/domain";
import { readProductSourceRuntimeCapabilities } from "./product-source-runtime.js";
import { claimProductResearchRevisionRun, closeProductResearchRevisionRun } from "./product-source-runtime.js";
import { readProductResearchRevision } from "./product-research-revision.js";
import type {
  AgentInstanceHandle,
  NodeSideTransport,
  NodeToServerMessage,
  NodeErrorCode,
  RunEventMessage,
  RunStartCommand,
  RunStartOwnedResultCommand,
  RunStopCommand,
  RunResumeCommand,
  RuntimeAdapter,
  ServerToNodeMessage,
  Unsubscribe
} from "@artoo/protocol";
import { adapterRunEventBodySchema, assertWorkspaceScope, runStartCommandSchema } from "@artoo/protocol";
import { RunStartPayloadSchema, RunWorkspaceRetainedPayloadSchema,
  type OwnedResultRunAdmissionV1, type RunStartPayload, type WorkspaceRetentionOutcome, type ProductReleaseHealthReport } from "@artoo/domain";
import { snapshotOwnedResultRunAdmission } from "./owned-result-admission.js";
import { prepareOwnedResultRun, materializeOwnedResultRun, finalizeOwnedResultRun, readOwnedResultProfileDescriptors, selectOwnedResultProfile,
  type PreparedOwnedResultProfiles, type PreparedOwnedResultRun, type OwnedResultFinalizationV1 } from "./owned-worktree-verification.js";
import { worktreeResultFailureIsUncertain } from "./owned/worktree-results.js";

import type { AdapterRegistry } from "./adapter-registry.js";
import { allocationStartBinding, assertMatchingAllocationReplay, type AllocationStartBinding, type AllocationReplayIdentity } from "./node-allocation-identity.js";
import {
  assertRealWorkspaceScope, createOwnedRunAdmission, getOwnedStartupReceipt, getOwnedStopReceipt,
  getOwnedRunStatusReceipt, isOwnedRunAdapter, bindWindowsVerifiedExecution, assertWindowsVerifiedExecutionClosed, supportsWorkspaceReadOnlyTools,
  bindWindowsPlanningExecution, assertWindowsPlanningExecutionClosed, assertWindowsPlanningStartupClosed,
  type OwnedRunAdmission, type OwnedRunRuntimeAdapter, type WindowsVerifiedExecutionAdmission, type WindowsPlanningExecutionAdmission,
} from "./process-adapter.js";
import { snapshotGitOptions, type GitReadOptions } from "./owned/git-operations.js";
import { OwnedGitError } from "./owned/owned-git.js";
import { readWindowsNativeFailure } from "./owned/windows-process-diagnostic.js";
import { prepareVerificationProfiles, selectVerificationProfile, readVerificationCapabilities, readWindowsVerificationBackend, assertVerificationWorkspaceBoundary, runVerification, runVerificationPreview, VerificationCleanupError,
  type VerificationProfile, type PreparedVerificationProfile } from "./verification.js";
import { createProductReleaseExecutor, prepareReleaseProfiles, type ReleaseProfile } from "./product-release.js";
import { bindWorkspaceToolVerifier, bindWorkspaceToolEvidenceReader, bindWorkspaceToolCapabilities, bindWorkspaceToolReleaseCapabilities } from "./workspace-tools.js";
import { bindWorkspaceReadOnlyTools, isAutonomousPlanningContext } from "./workspace-readonly.js";
import { createSourceStartReplay, type SourceStartOutcome, type SourceStartScope } from "./source-start-replay.js";
import { createSourceCommandInflight, isOrdinarySourceResultReceipt } from "./source-command-inflight.js";
import { createSourceCommandDiagnostics, recordSourceCommandPhase, type SourceCommandDiagnostic } from "./source-command-diagnostics.js";
import { createProductSourceOperationClient } from "./product-source-operations.js";
import { createImportedProductReviewClient } from "./imported-product-review.js";
import { createImportedDesignContinuationClient } from "./imported-design-continuation.js";
import { createImportedDesignReviewClient } from "./imported-design-review.js";
import { createImportedExecutionClient } from "./imported-execution.js";
import { createImportedExecutionReviewClient } from "./imported-execution-review.js";
import { createImportedValidationClient } from "./imported-validation.js";
import { createProductSourceRecoveryClient } from "./source-recovery-client.js";
import { assertCleanDaemonControllerConfiguration, type PreparedCleanDaemonConfiguration } from "./windows-clean-local-configuration.js";
import { createImportedRecoveryValidationClient } from "./imported-recovery-validation.js";
import { createImportedCleanValidationClient } from "./imported-clean-validation.js";
import { prepareWindowsCleanValidationRuntime, readPreparedCleanValidationRelease, claimCleanValidationRelease,
  releaseCleanValidationClaim, withWindowsCleanReleaseOperation, type PreparedWindowsCleanValidationRuntime,
  type PreparedCleanValidationRelease } from "./windows-clean-validation-runtime.js";
import { readWindowsRecoverySourceRuntime, withWindowsSourceRecoveryOperation, readPreparedRecoveryValidationRelease,
  claimRecoveryValidationRelease, type PreparedWindowsSourceRecoveryConfiguration,
  type PreparedWindowsSourceRecoveryRuntime, type PreparedRecoveryValidationRelease } from "./windows-source-recovery.js";
import { canonicalProductSourceTransferValueV1, importedValidationRequestDigestV1, importedValidationReviewRequestDigestV1,
  type RecoveryOperationRefV1 } from "@artoo/domain";
import type { createProductSourceSemanticClient } from "./product-source-semantic-client.js";
import type { ReleaseCapabilityReader } from "./release-capability-authority.js";
import { readBrowserEvidence, type BrowserEvidenceGrant } from "./browser-evidence.js";
import { provisionRunNamespace } from "./owned/workspace-namespace.js";
import { prepareOwnedWorktree, reserveOwnedWorktree, materializeOwnedWorktree,
  type MaterializedWorktree, type OwnedReservation } from "./owned/worktree-reservation.js";
import type { ArtifactUploader } from "./artifact-upload.js";
import { assertProductSourceRuntimeConfiguration, assertProductSourceWorkspaceBoundary, claimProductSourceRun,
  claimImportedValidationRelease, readPreparedImportedValidationRelease,
  releaseProductSourceRun, captureProductSourceExport, captureProductSourceExportV2, productSourceSemanticExportEnabled, productSourceMeasurementV2ExportEnabled,
  type PreparedProductSourceRuntime } from "./product-source-runtime.js";
import {
  createGitCliExecutor,
  materializeWorkspace,
  planWorkspace,
  type GitExecutor,
  type WorkspaceConfig,
  type WorkspacePlan,
} from "./workspace-binding.js";

/**
 * `artood` node-protocol client (mock-loop core of task #6).
 *
 * Drives a {@link RuntimeAdapter} in response to Server->Node commands over a
 * {@link NodeSideTransport}, proving the node-side protocol loop:
 *
 *   run.start -> command.ack(accepted) -> adapter.start
 *             -> stream RunEvents as run.event with a per-run monotonic sequence
 *   run.stop  -> command.ack(accepted) -> adapter.stop (the run streams to a
 *               cancelled lifecycle and ends)
 *   run.resume -> command.ack(accepted) only when this client still tracks the
 *                live handle; otherwise command.ack(rejected/process_exited).
 *
 * Legacy starts retain the transport/adapter seam. Explicit per-run starts use
 * genuine local workspace handles and authenticated owned-process evidence;
 * that same-process path does not advertise a public execution feature or
 * reconstruct restart ownership. No production branch depends on test helpers.
 */
export interface NodeClientOptions {
  nodeId: string;
  transport: NodeSideTransport;
  /** Single-runtime mode: handles any run.start.runtime. Provide this OR registry. */
  adapter?: RuntimeAdapter;
  /** Multi-runtime mode: resolves the adapter by run.start.runtime; unknown -> runtime_missing. */
  registry?: AdapterRegistry;
  /** Node-side workspace materialization config (git worktree mode). Default: no worktree support. */
  workspace?: WorkspaceConfig;
  /** Legacy materialization executor only; explicit per-run mode never calls it. */
  git?: GitExecutor;
  /** Trusted local asynchronous physical-mode settings; never read from wire payloads. */
  ownedGit?: Omit<GitReadOptions, "signal">;
  uploadArtifact?: ArtifactUploader;
  /** Trusted local managed delivery. It never falls back to transport replay. */
  managedJournal?: ManagedJournalOptions;
  /** Administrator-owned ordinary-workspace verifiers; never read from task content. */
  verificationProfiles?: readonly VerificationProfile[];
  releaseProfiles?: readonly ReleaseProfile[];
  /** Genuine locally prepared registry; requires an explicitly upgraded managed journal. */
  ownedResultProfiles?: PreparedOwnedResultProfiles;
  /** Explicit local Windows source transport slice; no wire/config object can mint this authority. */
  productSourceRuntime?: PreparedProductSourceRuntime;
  /** Original protected configuration, activated only after the dedicated guardian handshake. */
  productSourceRecovery?: { configuration: PreparedWindowsSourceRecoveryConfiguration; features: readonly string[];
    cleanLifecycle?: PreparedCleanDaemonConfiguration;
    isCurrent(): boolean; activate(runtime: PreparedWindowsSourceRecoveryRuntime): PreparedProductSourceRuntime;
    /** Authenticated connection identity only; no source audit or execution authority. */
    replaySession?(): object | undefined;
    onFailure?(error: Error): void; onReady?(): void };
  /** Node-runner-owned authenticated connection identity; reconnect cannot revive publication retry authority. */
  releaseRetrySession?: () => object | undefined;
  /** Explicit local transport preparation. Absence preserves ordinary/manual behavior and import fencing. */
  productSourceOperations?: {client:ReturnType<typeof createProductSourceSemanticClient>;isCurrent:()=>boolean;importedReview?:boolean;importedDesign?:boolean;importedDesignReview?:boolean;importedExecution?:boolean;importedExecutionReview?:boolean;importedValidation?:boolean};
  /** Local bounded observation only; never supplied by a command or used as execution evidence. */
  sourceCommandDiagnostic?: (value: SourceCommandDiagnostic) => unknown;
}

export interface NodeClient {
  /** Controller-derived discovery; wire metadata cannot enable any of these features. */
  productSourceFeatures?(): readonly string[];
  start(): void;
  /** Confirms configured publication listeners are available; startup errors are not hidden. */
  ready(): Promise<void>;
  /** Replays node-owned latest health observations after a new transport connection. */
  replayReleaseHealth(): Promise<void>;
  stop(cancelRunning?: boolean): Promise<void>;
  invalidateManagedStartupSession(session: ManagedSession | undefined, cause: Error): void;
  failManagedConnection(cause: Error): Promise<void>;
  requestManagedRunStop(runId: string): Promise<void>;
}

type PhysicalStartupOutcome = Readonly<
  | { kind: "started" }
  | { kind: "rejected" | "cancelled" | "uncertain"; code: NodeErrorCode; message: string }
>;
interface PhysicalExecution {
  readonly adapter: OwnedRunRuntimeAdapter;
  readonly handle: AgentInstanceHandle;
  readonly admission: OwnedRunAdmission;
  readonly stopOwnedRun: OwnedRunRuntimeAdapter["stopOwnedRun"];
  readonly inspectOwnedRun: OwnedRunRuntimeAdapter["inspectOwnedRun"];
  readonly streamEvents: RuntimeAdapter["streamEvents"];
  /** The real stream/receipt task is still owned, even after its writer closes. */
  deliveryPending: boolean;
  stopPending?: Promise<void>;
}
interface PhysicalStartRecord {
  readonly identity: AllocationReplayIdentity;
  /** Retained after compaction so a legacy duplicate cannot downgrade this mode. */
  readonly ownedResultDigest?: string;
  ownedResult?: { request: OwnedResultRunAdmissionV1; selection: ReturnType<typeof selectOwnedResultProfile>;
    prepared?: PreparedOwnedResultRun; worktree?: MaterializedWorktree; finalizing?: Promise<OwnedResultFinalizationV1>; unsafe?: boolean };
  readonly ready: Promise<PhysicalStartupOutcome>;
  resolveReady?: (outcome: PhysicalStartupOutcome) => void;
  outcome?: PhysicalStartupOutcome;
  controller?: AbortController;
  startupSession?: ManagedSession;
  execution?: PhysicalExecution;
  /** Set only after authenticated closure of this exclusively claimed attempt. */
  confirmedClosed: boolean;
  closureReceipt?: unknown;
  userStopRequested?: boolean;
  managed?: { permit: FreshLaunchPermit; delivery: ManagedDelivery; settled: boolean; deliveryPending: boolean; run?: JournalRun;
    observedTerminal?: TerminalSettlement["terminal"]; failure?: string };
  readonly recovery: { runId: string; taskId: string; root: string; branch: string; phase: string };
}
/** A legacy journal admission is an identity fence, never physical authority. */
interface MixedLegacyStartRecord {
  readonly key: string;
  readonly ready: Promise<PhysicalStartupOutcome>;
  resolveReady?: (outcome: PhysicalStartupOutcome) => void;
  outcome?: PhysicalStartupOutcome;
  controller?: AbortController;
  startupSession?: ManagedSession;
  admitted: boolean;
  adapterInvoked: boolean;
  stopPending?: Promise<void>;
  stopCompleted?: boolean;
  stopFailure?: string;
}
interface RunDelivery {
  readonly commandId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly workspaceRoot: string;
}

export function createNodeClient(options: NodeClientOptions): NodeClient {
  const { nodeId, transport } = options;
  if (options.productSourceRecovery && (options.productSourceRuntime || options.managedJournal || options.ownedResultProfiles)) {
    throw Error("Recovery startup requires its separate ordinary guardian lifecycle");
  }
  if (!options.adapter && !options.registry) {
    throw new Error("createNodeClient requires either an adapter or a registry");
  }
  // run.start.runtime is the only adapter-selection key on the node side — no
  // scheduling or fallback here. Single-adapter mode handles every runtime.
  const resolveAdapter = (runtime: string): RuntimeAdapter | undefined =>
    options.registry ? options.registry.resolve(runtime) : options.adapter;
  const workspaceConfig: WorkspaceConfig = options.workspace ?? {};
  if (options.ownedResultProfiles) {
    readOwnedResultProfileDescriptors(options.ownedResultProfiles, nodeId);
    if (options.managedJournal?.journal.ownedResultFinalizationVersion !== 1
      || !options.managedJournal.journal.admitOwnedResultStart || !options.managedJournal.journal.settleOwnedResultProcess
      || options.managedJournal.mixed?.allowNewAllocations === false || transport.acknowledgesRunEvents !== true) {
      throw new Error("Owned result profiles require fresh managed allocations, committed receipts and an explicitly upgraded journal");
    }
  }
  const git: GitExecutor = options.git ?? createGitCliExecutor();
  const verificationProfiles = prepareVerificationProfiles(options.verificationProfiles, workspaceConfig.allowedRoots);
  let sourceRuntime = options.productSourceRuntime;
  let recoveryRuntime: PreparedWindowsSourceRecoveryRuntime | undefined;
  let recoveredValidations: ReturnType<typeof createImportedRecoveryValidationClient> | undefined;
  let cleanValidations: ReturnType<typeof createImportedCleanValidationClient> | undefined;
  let cleanRuntime: PreparedWindowsCleanValidationRuntime | undefined;
  let sourceOperations: ReturnType<typeof createProductSourceOperationClient> | undefined;
  let importedReviews: ReturnType<typeof createImportedProductReviewClient> | undefined;
  let importedDesigns: ReturnType<typeof createImportedDesignContinuationClient> | undefined;
  let importedDesignReviews: ReturnType<typeof createImportedDesignReviewClient> | undefined;
  let importedExecutions: ReturnType<typeof createImportedExecutionClient> | undefined;
  let importedExecutionReviews: ReturnType<typeof createImportedExecutionReviewClient> | undefined;
  let importedValidations: ReturnType<typeof createImportedValidationClient> | undefined;
  function initializeSource() {
  if (sourceRuntime) {
    if (process.platform !== "win32" || options.managedJournal || options.ownedResultProfiles) {
      throw new Error("Product source runtime supports only ordinary Windows verified execution");
    }
    assertProductSourceRuntimeConfiguration(sourceRuntime, nodeId, workspaceConfig.allowedRoots, verificationProfiles);
  }
  if(options.productSourceOperations&&(!sourceRuntime||typeof options.productSourceOperations.isCurrent!=="function"))throw new Error("Source operations require an original local runtime and current authenticated session");
  sourceOperations=options.productSourceOperations?createProductSourceOperationClient({nodeId,transport,runtime:sourceRuntime!,
    client:options.productSourceOperations.client,isCurrent:options.productSourceOperations.isCurrent}):undefined;
  importedReviews=sourceOperations&&options.productSourceOperations?.importedReview?createImportedProductReviewClient({nodeId,transport,
    runtime:sourceRuntime!,sourceOperations,resolveAdapter,isCurrent:options.productSourceOperations.isCurrent}):undefined;
  if (options.productSourceOperations?.importedDesign && !importedReviews) throw new Error("Imported design requires the original local imported-review controller");
  importedDesigns = importedReviews && options.productSourceOperations?.importedDesign ? createImportedDesignContinuationClient({ nodeId, transport,
    runtime: sourceRuntime!, reviews: importedReviews, resolveAdapter, isCurrent: options.productSourceOperations.isCurrent,
    uploadArtifact: options.uploadArtifact }) : undefined;
  if (options.productSourceOperations?.importedDesignReview && !importedDesigns) throw new Error("H4 requires the original local H3 design controller");
  importedDesignReviews = importedDesigns && options.productSourceOperations?.importedDesignReview ? createImportedDesignReviewClient({ nodeId, transport,
    runtime: sourceRuntime!, designs: importedDesigns, resolveAdapter, isCurrent: options.productSourceOperations.isCurrent }) : undefined;
  if (options.productSourceOperations?.importedExecution && !importedDesignReviews) throw new Error("H5 requires the original local H4 controller");
  importedExecutions = importedDesignReviews && options.productSourceOperations?.importedExecution ? createImportedExecutionClient({ nodeId, transport,
    runtime: sourceRuntime!, reviews: importedDesignReviews, resolveAdapter, isCurrent: options.productSourceOperations.isCurrent,
    uploadArtifact: options.uploadArtifact }) : undefined;
  if (options.productSourceOperations?.importedExecutionReview && !importedExecutions) throw new Error("H6 requires the original local H5 controller");
  importedExecutionReviews = importedExecutions && options.productSourceOperations?.importedExecutionReview ? createImportedExecutionReviewClient({
    nodeId, transport, runtime: sourceRuntime!, executions: importedExecutions, resolveAdapter,
    isCurrent: options.productSourceOperations.isCurrent, uploadArtifact: options.uploadArtifact }) : undefined;
  if (options.productSourceOperations?.importedValidation && !importedExecutionReviews) throw Error("H7 requires the original local H6 controller");
  importedValidations = importedExecutionReviews && options.productSourceOperations?.importedValidation ? createImportedValidationClient({ nodeId, transport,
    runtime: sourceRuntime!, implementations: importedExecutionReviews, resolveAdapter,
    isCurrent: options.productSourceOperations.isCurrent, uploadArtifact: options.uploadArtifact }) : undefined;
  }
  if (sourceRuntime) initializeSource();
  else if (options.productSourceOperations && !options.productSourceRecovery) throw Error("Source operations require an original prepared runtime");
  const releaseProfiles = prepareReleaseProfiles(options.releaseProfiles, verificationProfiles);
  if (releaseProfiles.length && options.managedJournal) throw new Error("Product publication does not support managed journal nodes");
  const pendingHealth = new Map<string, ProductReleaseHealthReport>();
  let healthSending: Promise<void> | undefined, healthStopped = false;
  let healthRetry: ReturnType<typeof setTimeout> | undefined;
  function retryHealth(): void {
    if (healthStopped || healthRetry || !pendingHealth.size) return;
    healthRetry = setTimeout(() => { healthRetry = undefined; void flushHealth().catch(() => {}); }, 10_000);
    healthRetry.unref();
  }
  function flushHealth(): Promise<void> {
    if (healthSending) return healthSending;
    if (healthStopped) return Promise.resolve();
    const operation = (async () => {
      const failed = new Set<string>(); let deliveryError: unknown;
      while (pendingHealth.size && !healthStopped) {
        const next = [...pendingHealth.entries()].find(([id]) => !failed.has(id));
        if (!next) break;
        const [id, report] = next;
        try {
          // The server serializes these frames. Replay immutable publication
          // evidence first, including the restored version, before its health.
          const receipts = new Map(releaseExecutor.getPublicationReceipts().map((receipt) => [receipt.request.release_id, receipt]));
          for (const releaseId of new Set([id, ...(report.active_release_id ? [report.active_release_id] : [])])) {
            const receipt = receipts.get(releaseId);
            if (!receipt || receipt.outcome !== "published") throw new Error("Health replay has no matching published receipt");
            await transport.send({ kind: "product.release.receipt", node_id: nodeId, payload: receipt });
          }
          await transport.send({ kind: "product.release.health", node_id: nodeId, payload: report });
          const newer = pendingHealth.get(id);
          pendingHealth.delete(id);
          if (newer && newer !== report) pendingHealth.set(id, newer); // Give other releases a turn before the next observation.
        } catch (error) {
          // A rejected historical report must not prevent other profiles from
          // reporting an outage. Retry each failed identity once per round.
          failed.add(id); deliveryError = error;
        }
      }
      if (failed.size) throw deliveryError;
    })();
    healthSending = operation;
    void operation.then(() => { if (healthSending === operation) healthSending = undefined; }, () => {
      if (healthSending === operation) healthSending = undefined;
      retryHealth();
    });
    return operation;
  }
  function enqueueHealth(report: ProductReleaseHealthReport): void {
    if (healthStopped) return;
    const current = pendingHealth.get(report.request.release_id);
    if (!current || current.sequence < report.sequence) pendingHealth.set(report.request.release_id, report);
    // The durable journal is the retry authority. A disconnected transport must
    // not block health checks or grow a queue for every periodic observation.
    void flushHealth().catch(() => {});
  }
  const releaseExecutor = createProductReleaseExecutor(releaseProfiles, { onHealthReport: enqueueHealth, retrySession: options.releaseRetrySession,
    onError: (error) => { process.stderr.write(`Product publication monitoring failed: ${errorMessage(error).slice(0, 2000)}\n`); } });
  let releaseReady: Promise<void> | undefined;
  const sourceRecovery: ReturnType<typeof createProductSourceRecoveryClient> | undefined = options.productSourceRecovery ? createProductSourceRecoveryClient({
    nodeId, transport, configuration: options.productSourceRecovery.configuration, isCurrent: options.productSourceRecovery.isCurrent,
    cleanLifecycle: options.productSourceRecovery.cleanLifecycle,
    suspend() {
      sourceOperations?.invalidate(); importedReviews?.invalidate(); importedDesigns?.invalidate(); importedDesignReviews?.invalidate();
      importedExecutions?.invalidate(); importedExecutionReviews?.invalidate(); importedValidations?.invalidate();
      recoveredValidations?.invalidate(); cleanValidations?.invalidate(); releaseExecutor.requestStop();
    },
    onFailure(error) { options.productSourceRecovery!.onFailure?.(error); },
    activate(runtime, workspace, cleanCheckpoint) {
      withWindowsSourceRecoveryOperation(runtime, { operationId: "source-activation",
        bindingDigest: "sha256:" + createHash("sha256").update(nodeId).digest("hex"), serverOperation: null }, () => {
      if (workspace) releaseExecutor.fenceRecoveredWorkspace(runtime);
      sourceRuntime = options.productSourceRecovery!.activate(runtime); recoveryRuntime = runtime;
      if (sourceRuntime !== readWindowsRecoverySourceRuntime(runtime)) throw Error("Recovery activation changed its original source runtime");
      if (!workspace && !cleanCheckpoint) initializeSource();
      else if (cleanCheckpoint) {
        cleanRuntime = prepareWindowsCleanValidationRuntime(runtime, cleanCheckpoint);
        releaseExecutor.fenceCleanWorkspace(cleanRuntime);
        cleanValidations = createImportedCleanValidationClient({ nodeId, transport, runtime: cleanRuntime,
          clean: { readAccepted: request => sourceRecovery!.readCleanAccepted(request.restart),
            assertAccepted(request, original) {
              if (sourceRecovery!.readCleanAccepted(request.restart) !== original) throw Error("Clean validation checkpoint owner changed");
            } }, resolveAdapter, isCurrent: options.productSourceRecovery!.isCurrent, uploadArtifact: options.uploadArtifact });
      }
      else if (workspace) recoveredValidations = createImportedRecoveryValidationClient({ nodeId, transport, runtime, recovery: sourceRecovery!,
        resolveAdapter, isCurrent: options.productSourceRecovery!.isCurrent, uploadArtifact: options.uploadArtifact });
      // A recovered checkpoint is unverified. It cannot restart persisted publication
      // listeners or monitor journals before the fresh author and review authorize release.
      if (!workspace && !cleanCheckpoint) {
        releaseReady ??= withWindowsSourceRecoveryOperation(runtime, { operationId: "publisher-start",
          bindingDigest: "sha256:" + createHash("sha256").update(nodeId).digest("hex"), serverOperation: null }, () => releaseExecutor.start());
        track(releaseReady);
      }
      });
      // Registration alone is not execution readiness: source controllers and
      // any fresh publication listeners must finish initialization in this session.
      if (options.productSourceRecovery!.onReady) void Promise.resolve(releaseReady).then(() => {
        if (recoveryRuntime !== runtime || !sourceRecovery?.isActive() || !options.productSourceRecovery!.isCurrent()) {
          throw Error("Source activation lost its current registered session before readiness");
        }
        options.productSourceRecovery!.onReady?.();
      }).catch(error => options.productSourceRecovery!.onFailure?.(error instanceof Error ? error : Error("Source activation failed")));
    },
  }) : undefined;
  const releasingWorkspaces = new Map<string, number>();
  const verificationRuns = new Map<string, { profile: PreparedVerificationProfile; requestId: string;
    runStart: RunStartPayload;
    adapterInvoked?: boolean; workspaceProcessInvoked?: boolean;
    context: RunStartPayload["context_pack"]["payload"]; expectedSubjectDigest?: string;
    readReleaseCapabilities?: ReleaseCapabilityReader;
    windowsAdmission?: WindowsVerifiedExecutionAdmission;
    controller: AbortController; pending?: Promise<unknown>; unsafe?: boolean }>();
  const runs = new Map<string, { handle: AgentInstanceHandle; adapter: RuntimeAdapter }>();
  const planningToolRuns = new Map<string, { controller: AbortController; profile?: PreparedVerificationProfile;
    windowsAdmission?: WindowsPlanningExecutionAdmission; adapterInvoked?: boolean; adapterStarted?: boolean; unsafe?: boolean }>();
  const starting = new Map<string, Promise<void>>();
  const finished = new Set<string>();
  // Includes legacy (undefined) bindings, distinguishing an actual launch from
  // a cancellation tombstone that must never acquire an identity or a writer.
  const launchBindings = new Map<string, AllocationReplayIdentity | undefined>();
  const physicalStarts = new Map<string, PhysicalStartRecord>();
  const mixedLegacyStarts = new Map<string, MixedLegacyStartRecord>();
  const mixedStopIntents = new Set<string>();
  const closedDeliveries = new Map<string, ManagedDelivery>();
  const inflight = new Set<Promise<void>>();
  let unsubscribe: Unsubscribe | undefined;
  const sourceStartReplay = createSourceStartReplay();
  const sourceCommandInflight = createSourceCommandInflight();
  const sourceCommandDiagnostics = createSourceCommandDiagnostics(options.sourceCommandDiagnostic ?? (() => {}));
  const pendingSourceReplaySends = new Map<string, symbol>();
  // Clean lifecycle's ordinary-state reader performs its own audit. Keep that
  // existing path until it has a separate local-fact replay capability.
  const sourceReplayEnabled = !!options.productSourceRecovery?.replaySession && !options.productSourceRecovery.cleanLifecycle;
  function sourceReplayScope(): SourceStartScope | undefined {
    const session = options.productSourceRecovery?.replaySession?.();
    return session && recoveryRuntime && !healthStopped && sourceRecovery?.isActive() && sourceRecovery.allowsOrdinary()
      ? { runtime: recoveryRuntime, session } : undefined;
  }

  async function sendControl(message: NodeToServerMessage): Promise<void> {
    const operation = transport.send(message);
    if (options.managedJournal) await boundedOperation(operation, 10000);
    else await operation;
  }
  async function ackAccepted(commandId: string): Promise<void> {
    const observed = sourceStartReplay.observeAck(commandId, { status: "accepted" });
    try { await sendControl({
      kind: "command.ack",
      node_id: nodeId,
      command_id: commandId,
      status: "accepted",
      message: null
    }); sourceStartReplay.finishAck(observed, true); }
    catch (error) { sourceStartReplay.finishAck(observed, false); throw error; }
  }

  async function ackRejected(commandId: string, errorCode: NodeErrorCode, message: string): Promise<void> {
    const observed = sourceStartReplay.observeAck(commandId, { status: "rejected", error_code: errorCode, message });
    const retained = observed?.outcome;
    try { await sendControl({
      kind: "command.ack",
      node_id: nodeId,
      command_id: commandId,
      status: "rejected",
      error_code: errorCode,
      message: retained?.status === "rejected" ? retained.message : message
    }); sourceStartReplay.finishAck(observed, true); }
    catch (error) { sourceStartReplay.finishAck(observed, false); throw error; }
  }

  function track(task: Promise<void>): void {
    inflight.add(task);
    void task.catch(() => {}).finally(() => { inflight.delete(task); });
  }

  function settlePhysical(record: PhysicalStartRecord, outcome: PhysicalStartupOutcome): void {
    if (record.outcome) return;
    record.outcome = Object.freeze(outcome);
    record.resolveReady!(record.outcome);
    record.resolveReady = undefined;
    // Owned results keep the original cancellation signal through capture,
    // verification and journal settlement. Startup readiness does not end
    // that lifetime; compactPhysical releases it after closed delivery.
    if (!record.ownedResult) record.controller = undefined;
  }

  function settleMixedLegacy(record: MixedLegacyStartRecord, outcome: PhysicalStartupOutcome): void {
    if (record.outcome) return;
    record.outcome = Object.freeze(outcome);
    record.resolveReady!(record.outcome);
    record.resolveReady = undefined;
    record.controller = undefined;
    record.startupSession = undefined;
  }

  function assertMixedLegacyStartup(runId: string, record: MixedLegacyStartRecord): void {
    record.controller?.signal.throwIfAborted();
    if (mixedStopIntents.has(runId)) throw new DeliveryCancelled("Run was stopped before ordinary startup");
    options.managedJournal!.channel.assertCurrentSession(record.startupSession);
  }

  async function stopLegacyRun(runId: string, run: { handle: AgentInstanceHandle; adapter: RuntimeAdapter }): Promise<void> {
    const verification = verificationRuns.get(runId);
    if (verification) {
      verification.controller.abort();
      try {
        await run.adapter.stop(run.handle, "user_cancelled");
        if (verification.windowsAdmission) assertWindowsVerifiedExecutionClosed(verification.windowsAdmission, run.handle);
      } catch (error) {
        if (verification.windowsAdmission) { verification.unsafe = true; throw new VerificationCleanupError("Windows verified stop remains unconfirmed"); }
        throw error;
      }
      await verification.pending;
      if (verification.unsafe) throw new VerificationCleanupError("Verifier closure remains unconfirmed");
      return;
    }
    const planning = planningToolRuns.get(runId);
    if (planning?.windowsAdmission) {
      planning.controller.abort();
      try {
        await run.adapter.stop(run.handle, "user_cancelled");
        assertWindowsPlanningExecutionClosed(planning.windowsAdmission, run.handle);
      } catch (error) {
        planning.unsafe = true;
        throw new VerificationCleanupError("Windows planning stop remains unconfirmed", { cause: error });
      }
      if (planning.unsafe) throw new VerificationCleanupError("Windows planning closure remains unconfirmed");
      return;
    }
    const record = mixedLegacyStarts.get(runId);
    if (!record) return run.adapter.stop(run.handle, "user_cancelled");
    if (record.stopCompleted) return;
    if (record.stopPending) return record.stopPending;
    const operation = Promise.resolve().then(() => run.adapter.stop(run.handle, "user_cancelled"));
    record.stopPending = operation;
    try {
      await operation; record.stopCompleted = true; record.stopFailure = undefined;
      const current = runs.get(runId);
      // A failed/pending Stop can outlive its stream. Release only the exact
      // handle retained for that finished stream, after its retry succeeds.
      if (finished.has(runId) && current && current.handle === run.handle && current.adapter === run.adapter) runs.delete(runId);
    }
    catch (error) { record.stopFailure = errorMessage(error); throw error; }
    finally { if (record.stopPending === operation) record.stopPending = undefined; }
  }

  function compactPhysical(record: PhysicalStartRecord): void {
    if (record.ownedResult?.unsafe) return;
    if (record.managed && (!record.managed.settled || record.managed.deliveryPending)) return;
    if (record.confirmedClosed && !record.execution?.deliveryPending) {
      record.execution = undefined;
      record.closureReceipt = undefined;
      record.controller = undefined;
      record.ownedResult = undefined;
      // Keep identity and the original startup outcome. No ContextPack, worktree
      // inventory, error chain, child/queue or resolved-handle promise is retained.
    }
  }

  async function acknowledgePhysicalStart(commandId: string, outcome: PhysicalStartupOutcome): Promise<void> {
    if (outcome.kind === "started") await ackAccepted(commandId);
    else await ackRejected(commandId, outcome.code, outcome.message);
  }

  async function drainManagedRecord(record: PhysicalStartRecord): Promise<void> {
    const managed = record.managed!;
    managed.deliveryPending = true;
    if (record.execution) record.execution.deliveryPending = true;
    try {
      await managed.delivery.drainClosed();
      managed.deliveryPending = false;
      if (record.execution) record.execution.deliveryPending = false;
    } finally { compactPhysical(record); }
  }

  async function stopPhysical(record: PhysicalStartRecord): Promise<void> {
    if (record.confirmedClosed && (record.closureReceipt || record.managed?.settled || !record.managed)) return;
    const execution = record.execution;
    if (!execution) throw new Error("Owned startup has no authenticated writer-absence proof; recovery state is retained");
    if (execution.stopPending) return execution.stopPending;
    const operation = (async () => {
      const value = await execution.stopOwnedRun(execution.handle, execution.admission, "user_cancelled");
      const receipt = getOwnedStopReceipt(value, execution.admission, execution.handle);
      if (receipt?.kind !== "confirmed_closed") throw new Error("Owned process/guardian cleanup is uncertain; recovery state is retained");
      record.closureReceipt = value;
      record.confirmedClosed = true;
      compactPhysical(record);
    })();
    execution.stopPending = operation;
    try { await operation; }
    finally { if (execution.stopPending === operation) execution.stopPending = undefined; }
  }

  async function joinOwnedResultFinalization(record: PhysicalStartRecord): Promise<void> {
    const result = record.ownedResult;
    if (result?.finalizing) {
      try { await result.finalizing; }
      catch (error) { if (worktreeResultFailureIsUncertain(error)) result.unsafe = true; }
    }
    if (result?.unsafe) throw new Error("Owned result verifier or persistence remains uncertain; result authority is retained");
  }

  async function executePhysicalStart(command: Pick<RunStartCommand, "id" | "idempotency_key">, binding: AllocationStartBinding,
    record: PhysicalStartRecord, controller: AbortController): Promise<void> {
    const payload = binding.payload;
    let materialized: MaterializedWorktree | undefined;
    let reservation: OwnedReservation | undefined;
    let admission: OwnedRunAdmission | undefined;
    let adapterInvoked = false;
    let physicalWorkEntered = false;
    let rejectionCode: NodeErrorCode = "process_start_failed";
    try {
      // Local authority is detached before any asynchronous work. Neither the
      // wire allocation base nor the legacy injected executor grants Git access.
      const baseRepo = workspaceConfig.worktreeBaseRepo;
      const allowedRoots = Object.freeze([...(workspaceConfig.allowedRoots ?? [])]);
      const gitOptions = snapshotGitOptions({ ...options.ownedGit, signal: controller.signal });
      const adapter = resolveAdapter(payload.runtime);
      if (!adapter) {
        rejectionCode = "runtime_missing";
        throw new Error(`no adapter for runtime '${payload.runtime}'`);
      }
      if (!isOwnedRunAdapter(adapter)) throw new Error("selected runtime lacks the complete authenticated owned-run startup/stop/status seam");
      // Capture the verified producer functions synchronously; later property
      // replacement cannot provide a fake stream or a different physical start.
      const startOwnedRun = adapter.startOwnedRun.bind(adapter);
      const stopOwnedRun = adapter.stopOwnedRun.bind(adapter);
      const inspectOwnedRun = adapter.inspectOwnedRun.bind(adapter);
      const streamEvents = adapter.streamEvents.bind(adapter);
      if (typeof baseRepo !== "string" || !baseRepo || allowedRoots.length === 0) {
        throw new Error("per-run allocation requires a local source repository and a nonempty local allowlist");
      }
      if (options.managedJournal) {
        const journal = options.managedJournal.journal;
        options.managedJournal.channel.assertCurrentSession(record.startupSession);
        controller.signal.throwIfAborted();
        const ownedResult = record.ownedResult;
        if (ownedResult) {
          ownedResult.prepared = await prepareOwnedResultRun(ownedResult.selection.store, ownedResult.selection.template, ownedResult.request);
          options.managedJournal.channel.assertCurrentSession(record.startupSession); controller.signal.throwIfAborted();
        }
        const admissionRequest = { expectedNamespace: journal.namespace, runId: payload.run_id, idempotencyKey: command.idempotency_key };
        const admitted = ownedResult ? await journal.admitOwnedResultStart!({ ...admissionRequest, admission: ownedResult.prepared! })
          : await journal.admitStart({ ...admissionRequest, payload });
        if (admitted.kind !== "fresh") throw new Error(`Durable managed start is ${admitted.kind}; no new execution authority`);
        options.managedJournal.mixed?.bindRun(payload.run_id, "managed");
        record.managed = { permit: admitted.permit, settled: false, deliveryPending: true,
          delivery: new ManagedDelivery(journal, admitted.permit, nodeId, payload.run_id, options.managedJournal.channel) };
        await journal.advance(admitted.permit, "preparing");
      } else admission = createOwnedRunAdmission({ launchKey: binding.key, runId: payload.run_id, taskId: payload.task_id,
        agentInstanceId: payload.agent_instance_id, runtime: payload.runtime,
        workspaceRoot: payload.workspace.root, workspaceBranch: payload.workspace.branch! });
      const input = Object.freeze({ root: payload.workspace.root, basePath: payload.workspace_allocation!.base_path,
        agentInstanceId: payload.agent_instance_id, runId: payload.run_id, sourceRepo: baseRepo, allowedRoots });
      controller.signal.throwIfAborted();
      physicalWorkEntered = true;
      if (record.ownedResult) {
        record.recovery.phase = "materializing_result_input";
        materialized = await materializeOwnedResultRun(record.ownedResult.prepared!, controller.signal);
        record.ownedResult.worktree = materialized;
      } else {
      record.recovery.phase = "namespace";
      await provisionRunNamespace(input, gitOptions);
      record.recovery.phase = "preparing";
      const prepared = await prepareOwnedWorktree({ ...input, branch: payload.workspace.branch! }, gitOptions);
      record.recovery.phase = "reserving";
      reservation = await reserveOwnedWorktree(prepared);
      record.recovery.phase = "materializing";
      materialized = await materializeOwnedWorktree(reservation);
      }
      record.recovery.phase = "adapter_startup";
      adapterInvoked = true;
      let handle: AgentInstanceHandle;
      if (record.managed) {
        const journal = options.managedJournal!.journal;
        options.managedJournal!.channel.assertCurrentSession(record.startupSession);
        controller.signal.throwIfAborted();
        await journal.advance(record.managed.permit, "launch_intent");
        const started = await journal.startOwnedProcess(record.managed.permit, adapter, materialized, controller.signal);
        handle = started.handle; admission = started.admission;
        // Retain genuine authority before recordStarted can fail or observe a
        // writer that already exited naturally during the awaited bridge.
        record.execution = { adapter, handle, admission, stopOwnedRun, inspectOwnedRun, streamEvents, deliveryPending: true };
        await journal.recordStarted(record.managed.permit, adapter, handle);
        controller.signal.throwIfAborted();
        options.managedJournal!.channel.assertCurrentSession(record.startupSession);
      } else handle = await startOwnedRun({ runId: payload.run_id, taskId: payload.task_id,
        agentInstanceId: payload.agent_instance_id, runtime: payload.runtime,
        workspaceRoot: payload.workspace.root, runStart: payload }, materialized, admission!, controller.signal);
      record.execution ??= { adapter, handle, admission: admission!, stopOwnedRun, inspectOwnedRun, streamEvents, deliveryPending: true };
      record.recovery.phase = "streaming";
      // Startup readiness is a historical fact, independently settled from ACK,
      // stream and authoritative receipt delivery. Later failures cannot rewrite it.
      settlePhysical(record, { kind: "started" });
      const plan: WorkspacePlan = { kind: "worktree", root: payload.workspace.root,
        branch: payload.workspace.branch!, baseRepo };
      const delivery: RunDelivery = { commandId: command.id, runId: payload.run_id,
        taskId: payload.task_id, workspaceRoot: payload.workspace.root };
      track(streamStartedRun(delivery, adapter, handle, plan, true, record));
      // No full command/ContextPack or genuine worktree handle enters the
      // permanently remembered startup outcome or delivery task's input.
      return;
    } catch (error) {
      if (record.managed) {
        const managed = record.managed;
        managed.failure ??= errorMessage(error).slice(0, 500);
        if (record.execution) {
          try { await managed.delivery.abort(new Error(managed.failure)); } catch { /* Storage unknown cannot skip the actual physical stop. */ }
          try { await stopPhysical(record); } catch { /* Preserve genuine uncertainty and execution state. */ }
          if (record.confirmedClosed && record.closureReceipt) {
            try {
              const closed = await options.managedJournal!.journal.settleOwnedProcess(managed.permit, record.execution.handle, record.closureReceipt,
                { terminal: { type: "run.lifecycle", payload: { phase: "failed", reason: managed.failure } }, retentionOutcome: "incomplete_delivery" });
              managed.run = closed; managed.settled = true; managed.delivery.useClosed(closed);
            } catch { /* Genuine stop can be known while durable settlement/delivery remains unknown. */ }
          }
          record.execution.deliveryPending = true;
        } else if (materialized) {
          try {
            const closed = await options.managedJournal!.journal.settleOwnedStartupFailure(managed.permit, materialized, error);
            managed.run = closed; managed.settled = true; record.confirmedClosed = true;
            managed.delivery.useClosed(closed);
          } catch { /* not_spawned or storage uncertainty never fabricates a physical settlement. */ }
        }
        settlePhysical(record, { kind: record.confirmedClosed ? "rejected" : "uncertain", code: rejectionCode, message: managed.failure });
        if (managed.settled) track(drainManagedRecord(record));
        if (!record.execution && !managed.settled) record.managed = undefined;
        compactPhysical(record); await acknowledgePhysicalStart(command.id, record.outcome!); return;
      }
      const receipt = adapterInvoked && materialized && admission
        ? getOwnedStartupReceipt(error, admission, materialized) : undefined;
      // This genuine handle came only from this attempt's fresh exclusive claim.
      // A not_spawned receipt alone would not authorize a foreign/occupied root.
      const adapterClosed = materialized !== undefined
        && (receipt?.kind === "not_spawned" || receipt?.kind === "confirmed_closed");
      const cancelledGitClosed = !adapterInvoked && reservation !== undefined
        && controller.signal.aborted && confirmedOwnedGitCleanup(error);
      record.confirmedClosed = adapterClosed || cancelledGitClosed;
      const kind = record.confirmedClosed
        ? (controller.signal.aborted || receipt?.cancellationRequested ? "cancelled" : "rejected")
        : physicalWorkEntered ? "uncertain" : "rejected";
      const message = `${errorMessage(error)}\nOwned attempt retained: ${JSON.stringify(record.recovery)}`;
      settlePhysical(record, { kind, code: rejectionCode, message });
      compactPhysical(record);
      await acknowledgePhysicalStart(command.id, record.outcome!);
    } finally {
      // Even an unexpected local proof/classification exception must release
      // matching duplicates and stop/resume waiters without claiming success.
      if (!record.outcome) {
        record.confirmedClosed = false;
        settlePhysical(record, { kind: "uncertain", code: "process_start_failed",
          message: `Owned startup could not establish its outcome; retained ${JSON.stringify(record.recovery)}` });
      }
    }
  }

  function beginPhysicalStart(command: Pick<RunStartCommand, "id" | "idempotency_key">, binding: AllocationStartBinding,
    ownedResult?: { request: OwnedResultRunAdmissionV1; digest: string; selection: ReturnType<typeof selectOwnedResultProfile> }): Promise<void> {
    let resolveReady!: (outcome: PhysicalStartupOutcome) => void;
    const controller = new AbortController();
    const record: PhysicalStartRecord = { identity: Object.freeze({ key: binding.key }),
      ...(ownedResult ? { ownedResultDigest: ownedResult.digest, ownedResult: { request: ownedResult.request, selection: ownedResult.selection } } : {}),
      ready: new Promise<PhysicalStartupOutcome>((resolve) => { resolveReady = resolve; }),
      controller, confirmedClosed: false, startupSession: options.managedJournal?.channel.assertCurrentSession(),
      recovery: { runId: binding.payload.run_id, taskId: binding.payload.task_id,
        root: binding.payload.workspace.root, branch: binding.payload.workspace.branch!, phase: "admitted" } };
    record.resolveReady = resolveReady;
    // Install the strict identity and separately settled outcome before I/O.
    physicalStarts.set(binding.payload.run_id, record);
    launchBindings.set(binding.payload.run_id, record.identity);
    return executePhysicalStart(command, binding, record, controller);
  }

  function beginMixedLegacyStart(command: RunStartCommand, snapshot: { key: string; payload: RunStartPayload }): Promise<void> {
    const managed = options.managedJournal!, runId = snapshot.payload.run_id;
    let resolveReady!: (outcome: PhysicalStartupOutcome) => void;
    const record: MixedLegacyStartRecord = { key: snapshot.key, admitted: false, adapterInvoked: false,
      ready: new Promise<PhysicalStartupOutcome>((resolve) => { resolveReady = resolve; }),
      controller: new AbortController(), startupSession: managed.channel.assertCurrentSession() };
    record.resolveReady = resolveReady;
    // Reserve this process's attempt before journal I/O. Matching duplicates
    // join its outcome; neither a pending row nor an ACK grants another start.
    mixedLegacyStarts.set(runId, record);
    launchBindings.set(runId, undefined);
    starting.set(runId, record.ready.then(() => {}));
    return (async () => {
      try {
        assertMixedLegacyStartup(runId, record);
        const admitted = await managed.journal.admitStart({ expectedNamespace: managed.journal.namespace,
          runId, idempotencyKey: command.idempotency_key, payload: snapshot.payload });
        if (admitted.kind !== "fresh") throw new Error(`Durable ordinary start is ${admitted.kind}; no new execution authority`);
        if (admitted.run.namespace !== managed.journal.namespace || admitted.run.runId !== runId
          || admitted.run.mode !== "legacy" || admitted.run.launchKey !== snapshot.key) {
          throw new Error("Ordinary admission identity differs from the immutable start");
        }
        record.admitted = true;
        assertMixedLegacyStartup(runId, record);
        managed.mixed!.bindRun(runId, "legacy");
        // This permit is intentionally not used for a producer, event or physical
        // settlement. The retained legacy row grants no restart ownership.
        await executeStart({ ...command, payload: admitted.payload }, () => { starting.delete(runId); }, record);
      } catch (error) {
        if (record.outcome) throw error;
        const outcome: PhysicalStartupOutcome = { kind: record.adapterInvoked ? "uncertain"
          : record.controller?.signal.aborted || mixedStopIntents.has(runId) ? "cancelled" : "rejected",
          code: "process_start_failed", message: errorMessage(error) };
        settleMixedLegacy(record, outcome);
        await acknowledgePhysicalStart(command.id, outcome);
      } finally {
        if (!record.outcome) settleMixedLegacy(record, { kind: "uncertain", code: "process_start_failed",
          message: "Ordinary startup did not establish an outcome; its durable identity is retained" });
        starting.delete(runId);
      }
    })();
  }

  async function onRunStartOwnedResult(command: RunStartOwnedResultCommand): Promise<void> {
    try {
      // Detach the entire versioned admission before any await or duplicate ACK.
      const snapshot = snapshotOwnedResultRunAdmission(command.payload), payload = snapshot.request.run_start, runId = payload.run_id;
      if (payload.context_pack.payload?.product_research_revision) throw new Error("Research revision requires its original source-node execution path");
      if(payload.context_pack.payload?.imported_recovery_validation || payload.context_pack.payload?.imported_recovery_validation_review_subject || payload.context_pack.payload?.imported_validation || payload.context_pack.payload?.imported_validation_review_subject || payload.context_pack.payload?.imported_review_subject || payload.context_pack.payload?.transferred_product_input || payload.context_pack.payload?.imported_design_review_subject || payload.context_pack.payload?.imported_execution || payload.context_pack.payload?.imported_execution_review_subject || payload.context_pack.payload?.imported_execution_repair)throw new Error("Imported research does not support ordinary owned-result execution");
      if (sourceRuntime) {
        assertProductSourceWorkspaceBoundary(sourceRuntime, payload.workspace.root);
        throw new Error("Product source runtime does not admit owned-result execution");
      }
      const managed = options.managedJournal, registry = options.ownedResultProfiles;
      if (!managed || !registry || managed.journal.ownedResultFinalizationVersion !== 1
        || !managed.journal.admitOwnedResultStart || !managed.journal.settleOwnedResultProcess
        || managed.mixed?.allowNewAllocations === false || transport.acknowledgesRunEvents !== true
        || command.idempotency_key !== `${runId}:start`) throw new Error("Owned result command requires configured managed result execution and a stable start key");
      managed.channel.assertCurrentSession();
      const selection = selectOwnedResultProfile(registry, nodeId, snapshot.request.requirement.profile);
      releaseExecutor.assertWorkspaceBoundary(payload);
      if (releasingWorkspaces.has(payload.workspace.root)) throw new Error("Workspace has a product publication in progress");
      const adapter = resolveAdapter(payload.runtime);
      assertVerificationWorkspaceBoundary(payload, verificationProfiles, adapter !== undefined && isOwnedRunAdapter(adapter));
      const previous = physicalStarts.get(runId);
      if (previous) {
        if (previous.ownedResultDigest !== snapshot.digest) throw new Error("Owned result mode or complete admission changed");
        assertMatchingAllocationReplay(previous.identity, snapshot.launch);
        await acknowledgePhysicalStart(command.id, await previous.ready); return;
      }
      if (mixedLegacyStarts.has(runId) || launchBindings.has(runId) || starting.has(runId) || runs.has(runId)
        || finished.has(runId) || mixedStopIntents.has(runId)) throw new Error("Existing run identity or Stop fence denies a new owned result launch");
      // beginPhysicalStart installs the immutable mode/digest fence synchronously.
      return beginPhysicalStart(command, snapshot.launch, { request: snapshot.request, digest: snapshot.digest, selection });
    } catch (error) { await ackRejected(command.id, "process_start_failed", errorMessage(error)); }
  }

  async function onRunStart(command: RunStartCommand): Promise<void> {
    let binding: AllocationStartBinding | undefined;
    let legacy: { key: string; payload: RunStartPayload } | undefined;
    let verifiedSnapshot: { key: string; payload: RunStartPayload } | undefined;
    let verificationProfile: PreparedVerificationProfile | undefined;
    let planningProfile: PreparedVerificationProfile | undefined;
    let readOnlyPlanning = false;
    let readReleaseCapabilities: ReleaseCapabilityReader | undefined;
    try {
      runStartCommandSchema.parse(command); // Also guard typed/in-memory transports before duplicate ACKs.
      if(command.payload.context_pack.payload?.imported_recovery_validation || command.payload.context_pack.payload?.imported_recovery_validation_review_subject || command.payload.context_pack.payload?.imported_validation || command.payload.context_pack.payload?.imported_validation_review_subject || command.payload.context_pack.payload?.imported_review_subject || command.payload.context_pack.payload?.transferred_product_input || command.payload.context_pack.payload?.imported_design_review_subject || command.payload.context_pack.payload?.imported_execution || command.payload.context_pack.payload?.imported_execution_review_subject || command.payload.context_pack.payload?.imported_execution_repair)throw new Error("Imported research requires its dedicated local operation controller");
      if (sourceRuntime) assertProductSourceWorkspaceBoundary(sourceRuntime, command.payload.workspace.root);
      const configuredAdapter = resolveAdapter(command.payload.runtime);
      releaseExecutor.assertWorkspaceBoundary(command.payload);
      if (releasingWorkspaces.has(command.payload.workspace.root)) throw new Error("Workspace has a product publication in progress");
      assertVerificationWorkspaceBoundary(command.payload, verificationProfiles, configuredAdapter !== undefined && isOwnedRunAdapter(configuredAdapter));
      if (command.payload.verification || (configuredAdapter && supportsWorkspaceReadOnlyTools(configuredAdapter)
        && isAutonomousPlanningContext(command.payload))) {
        verifiedSnapshot = snapshotMixedLegacyStart(command.payload);
      }
      const admitted = verifiedSnapshot?.payload ?? command.payload;
      if (admitted.verification?.release_capability_binding || admitted.context_pack.payload?.release_capabilities) {
        if (!admitted.verification?.release_capability_binding || !admitted.context_pack.payload?.release_capabilities) {
          throw new Error("Release capability requires both exact request and context bindings");
        }
        readReleaseCapabilities = releaseExecutor.getCapabilityReader(admitted.verification.release_capability_binding.release_profile_id);
      }
      verificationProfile = selectVerificationProfile(admitted, verificationProfiles, options.managedJournal !== undefined, readReleaseCapabilities, nodeId);
      if (readProductResearchRevision(admitted.context_pack.payload) && (!sourceRuntime || !verificationProfile)) {
        throw new Error("Research revision requires its original locally prepared source runtime");
      }
      readOnlyPlanning = !options.managedJournal && configuredAdapter !== undefined
        && supportsWorkspaceReadOnlyTools(configuredAdapter) && isAutonomousPlanningContext(admitted);
      if (sourceRuntime && !verificationProfile) {
        if (!readOnlyPlanning) throw new Error("Product source runtime requires original Windows verified execution");
        // The future-worker snapshot describes capability only. Native ownership
        // comes from exactly one protected profile for this node's actual workspace.
        const candidates = verificationProfiles.filter(profile => profile.workspace_root === admitted.workspace.root
          && profile.project_id === admitted.context_pack.payload?.project.id);
        if (candidates.length !== 1) throw new Error("Native planning requires exactly one local workspace profile");
        planningProfile = candidates[0]!;
        if (process.platform !== "win32" || !readWindowsVerificationBackend(planningProfile)) {
          throw new Error("Native planning requires an original local Windows backend");
        }
      }
      binding = allocationStartBinding(command.payload, process.platform, transport.acknowledgesRunEvents);
      if (options.managedJournal) {
        options.managedJournal.channel.assertCurrentSession();
        if (options.managedJournal.mixed && command.idempotency_key !== `${command.payload.run_id}:start`) {
          throw new Error("Mixed execution requires the stable run start idempotency key");
        }
        if (!binding) {
          if (!options.managedJournal.mixed) throw new Error("Managed execution requires an explicit per-run allocation");
          legacy = snapshotMixedLegacyStart(command.payload);
        }
      }
    } catch (error) {
      await ackRejected(command.id, "process_start_failed", errorMessage(error));
      return;
    }
    // Per-run launches use the detached frozen snapshot, including after awaits.
    const launchCommand = binding || legacy || verifiedSnapshot ? { ...command, payload: (binding ?? legacy ?? verifiedSnapshot)!.payload } : command;
    const replayIdentity = binding || verifiedSnapshot ? Object.freeze({ key: (binding ?? verifiedSnapshot)!.key }) : undefined;
    const runId = launchCommand.payload.run_id;
    if (planningToolRuns.get(runId)?.unsafe) {
      await ackRejected(command.id, "process_start_failed", "Windows planning closure remains unconfirmed"); return;
    }
    const ordinary = mixedLegacyStarts.get(runId);
    if (ordinary) {
      if (!legacy || legacy.key !== ordinary.key) {
        await ackRejected(command.id, "process_start_failed", "run.start ordinary launch binding or execution mode changed"); return;
      }
      await acknowledgePhysicalStart(command.id, await ordinary.ready); return;
    }
    if (binding && options.managedJournal && finished.has(runId) && !launchBindings.has(runId)) {
      await ackRejected(command.id, "process_start_failed", "Durable stop-before-start fence denies a new managed launch"); return;
    }
    const physical = physicalStarts.get(runId);
    if (physical) {
      if (physical.ownedResultDigest) { await ackRejected(command.id, "process_start_failed", "Owned result admission cannot be replayed as legacy run.start"); return; }
      try { assertMatchingAllocationReplay(physical.identity, binding); }
      catch (error) { await ackRejected(command.id, "process_start_failed", errorMessage(error)); return; }
      await acknowledgePhysicalStart(command.id, await physical.ready);
      return;
    }
    if (options.managedJournal?.mixed && mixedStopIntents.has(runId)) {
      await ackRejected(command.id, "process_start_failed", "Run-wide Stop intent denies a new launch"); return;
    }
    if (legacy) return beginMixedLegacyStart(launchCommand, legacy);
    if (starting.has(runId) || runs.has(runId) || finished.has(runId)) {
      try {
        if (launchBindings.has(runId)) assertMatchingAllocationReplay(launchBindings.get(runId), replayIdentity);
      } catch (error) {
        await ackRejected(command.id, "process_start_failed", errorMessage(error));
        return;
      }
      const planning = planningToolRuns.get(runId);
      if (planning?.profile && starting.has(runId)) {
        // An identical replay joins the original native startup. Its pending
        // broker/admission is not evidence that an execution handle was returned.
        await starting.get(runId);
        if (planning.unsafe || !planning.adapterStarted) {
          await ackRejected(command.id, "process_start_failed", planning.unsafe
            ? "Windows planning closure remains unconfirmed" : "Original native planning startup did not acquire a run handle");
          return;
        }
      }
      if (binding && starting.has(runId)) {
        await starting.get(runId);
        // A pending attempt is not an accepted launch if startup later rejects.
        if (!launchBindings.has(runId)) {
          await ackRejected(command.id, "process_start_failed", "original per-run startup did not acquire a run handle");
          return;
        }
      }
      await ackAccepted(command.id); // Retries never spawn another writer.
      return;
    }
    if (binding) {
      if (options.managedJournal?.mixed?.allowNewAllocations === false) {
        await ackRejected(command.id, "process_start_failed", "New per-run allocations are disabled on this worker"); return;
      }
      return beginPhysicalStart(launchCommand, binding);
    }
    if (verificationProfile) {
      if ([...verificationRuns.values()].some((run) => run.profile.workspace_root === verificationProfile.workspace_root)) {
        await ackRejected(command.id, "process_start_failed", "Verification workspace already has an active execution"); return;
      }
      if (sourceRuntime) {
        try {
          if (readProductResearchRevision(launchCommand.payload.context_pack.payload)) claimProductResearchRevisionRun(sourceRuntime, launchCommand.payload, verificationProfile);
          else claimProductSourceRun(sourceRuntime, runId, launchCommand.payload.workspace.root);
        }
        catch (error) { await ackRejected(command.id, "process_start_failed", errorMessage(error)); return; }
      }
      verificationRuns.set(runId, { profile: verificationProfile, runStart: launchCommand.payload, requestId: launchCommand.payload.verification!.request_id,
        expectedSubjectDigest: launchCommand.payload.verification!.expected_subject_digest,
        context: launchCommand.payload.context_pack.payload, readReleaseCapabilities, controller: new AbortController() });
    }
    if (readOnlyPlanning) planningToolRuns.set(runId, { controller: new AbortController(), ...(planningProfile ? { profile: planningProfile } : {}) });
    let ready!: () => void;
    launchBindings.set(runId, replayIdentity);
    starting.set(runId, new Promise<void>((resolve) => { ready = resolve; }));
    try {
      await executeStart(launchCommand, () => { starting.delete(runId); ready(); });
    } finally {
      planningToolRuns.get(runId)?.controller.abort();
      if (!planningToolRuns.get(runId)?.unsafe) planningToolRuns.delete(runId);
      starting.delete(runId);
      if (!runs.has(runId) && !finished.has(runId) && !planningToolRuns.get(runId)?.unsafe) launchBindings.delete(runId);
      if (sourceRuntime && !runs.has(runId) && !finished.has(runId)) {
        const verification = verificationRuns.get(runId);
        if (verification && !verification.adapterInvoked && !verification.workspaceProcessInvoked && !verification.unsafe) {
          if (readProductResearchRevision(verification.context)) closeProductResearchRevisionRun(sourceRuntime, verification.runStart, verification.profile);
          releaseProductSourceRun(sourceRuntime, runId);
        } else if (verification) verification.unsafe = true; // An invoked producer without a closed handle retains its source claim.
      }
      if (!runs.has(runId) && !verificationRuns.get(runId)?.unsafe) verificationRuns.delete(runId);
      ready();
    }
  }

  async function executeStart(command: RunStartCommand, ready: () => void, mixed?: MixedLegacyStartRecord): Promise<void> {
    const payload = command.payload;
    const rejectStart = async (code: NodeErrorCode, message: string): Promise<void> => {
      if (mixed) settleMixedLegacy(mixed, { kind: mixed.adapterInvoked ? "uncertain"
        : mixed.controller?.signal.aborted || mixedStopIntents.has(payload.run_id) ? "cancelled" : "rejected", code, message });
      await ackRejected(command.id, code, message);
    };
    const adapter = resolveAdapter(payload.runtime);
    if (!adapter) {
      await rejectStart("runtime_missing", `no adapter for runtime '${payload.runtime}'`);
      return;
    }

    // Prepare the workspace before the adapter starts. A branch-backed run
    // materializes a git worktree at workspace.root; a missing base repo or a
    // failed materialization rejects run.start without ever starting the adapter.
    const planResult = planWorkspace(payload.workspace, workspaceConfig);
    if (!planResult.ok) {
      await rejectStart(planResult.code, planResult.reason);
      return;
    }
    const plan = planResult.plan;
    // Validate an advertised raw branch even if legacy planning trims it empty.
    const typedRetention = payload.workspace.branch != null && payload.workspace_retention_reporting === "typed-v1";
    try {
      if (mixed) assertMixedLegacyStartup(payload.run_id, mixed);
      if (typedRetention) {
        if (transport.acknowledgesRunEvents !== true) {
          throw new Error("typed workspace retention requires committed run-event receipts");
        }
        // Reject unsupported identity before materialization or a writer starts.
        RunWorkspaceRetainedPayloadSchema.parse({ version: 1, workspace_root: plan.root,
          workspace_branch: payload.workspace.branch, outcome: "unconfirmed" });
      }
      assertWorkspaceScope(plan.root, payload.policy_snapshot.filesystem_write_scope);
      if (workspaceConfig.allowedRoots) {
        assertRealWorkspaceScope(plan.root, workspaceConfig.allowedRoots);
        if (plan.kind === "worktree") assertRealWorkspaceScope(plan.baseRepo, workspaceConfig.allowedRoots);
      }
      const sourceVerification = verificationRuns.get(payload.run_id);
      if (sourceVerification && plan.kind === "worktree") sourceVerification.workspaceProcessInvoked = true;
      await materializeWorkspace(plan, git);
    } catch (err) {
      await rejectStart("process_start_failed", errorMessage(err));
      return;
    }

    let handle: AgentInstanceHandle;
    try {
      if (mixed) { assertMixedLegacyStartup(payload.run_id, mixed); mixed.adapterInvoked = true; }
      const config = {
        runId: payload.run_id,
        taskId: payload.task_id,
        agentInstanceId: payload.agent_instance_id,
        runtime: payload.runtime,
        workspaceRoot: payload.workspace.root,
        runStart: payload
      };
      const verification = verificationRuns.get(payload.run_id);
      if (verification?.profile.capabilities) {
        bindWorkspaceToolCapabilities(config, () => {
          verification.controller.signal.throwIfAborted();
          return readVerificationCapabilities(verification.profile)!;
        });
      }
      if (verification?.readReleaseCapabilities) {
        bindWorkspaceToolReleaseCapabilities(config, () => {
          verification.controller.signal.throwIfAborted();
          return verification.readReleaseCapabilities!();
        });
      }
      const evidenceGrants = new Map<string, BrowserEvidenceGrant>();
      const grantEvidence = (receipt: Pick<import("@artoo/domain").RunVerificationPayload, "request_id" | "profile_id" | "profile_digest"> & {
        checks: Pick<import("@artoo/domain").RunVerificationPayload["checks"][number], "id" | "observation">[] },
        subjectDigest: string, scope: "preview" | "final") => {
        if (!verification || receipt.profile_id !== verification.profile.id || receipt.profile_digest !== verification.profile.digest) throw new Error("Browser evidence profile differs from this run");
        for (const check of receipt.checks) {
          const observation = check.observation;
          if (!observation?.evidence_bundle) continue;
          const evidenceRoot = verification.profile.commands.find((command) => command.id === check.id)?.observation?.evidence_root;
          if (!evidenceRoot || observation.scope !== scope) throw new Error("Browser evidence is not authorized by this run's protected profile");
          const grant: BrowserEvidenceGrant = { evidenceRoot, requestId: receipt.request_id, profileId: receipt.profile_id,
            profileDigest: receipt.profile_digest, subjectDigest, checkId: check.id, scope, ...observation.evidence_bundle };
          // Validate the local sealed provenance before admitting any server-supplied reference.
          readBrowserEvidence(grant, grant.bundle_id);
          evidenceGrants.set(grant.bundle_id, grant);
          if (observation.version !== 1) {
            for (const item of observation.cases) {
              evidenceGrants.set(item.trace_ref, grant);
              for (const capture of item.captures) evidenceGrants.set(capture.screenshot_ref, grant);
            }
          } else {
            for (const item of observation.cases) if (item.screenshot_ref) evidenceGrants.set(item.screenshot_ref, grant);
          }
        }
      };
      const review = payload.context_pack.payload?.review_subject;
      if (verification && review?.verification) {
        if (verification.expectedSubjectDigest !== review.subject_digest) throw new Error("Review browser evidence differs from the admitted source");
        grantEvidence(review.verification, review.subject_digest, "final");
      }
      if (verification && (evidenceGrants.size || (!review && verification.profile.commands.some((command) => command.observation?.evidence_root)))) {
        bindWorkspaceToolEvidenceReader(config, async (reference, readOptions) => {
          verification.controller.signal.throwIfAborted();
          const grant = evidenceGrants.get(reference);
          if (!grant) throw new Error("Evidence reference is not granted to this session");
          return readBrowserEvidence(grant, reference, readOptions);
        });
      }
      if (verification && payload.context_pack.payload?.product_development
        && payload.context_pack.payload.policy.execution_mode !== "discussion") {
        let attempts = 0;
        bindWorkspaceToolVerifier(config, async (toolSignal) => {
          verification.controller.signal.throwIfAborted(); toolSignal.throwIfAborted();
          if (verification.unsafe) throw new VerificationCleanupError("Verifier closure remains unconfirmed");
          if (verification.pending) throw new Error("A verifier is already running");
          if (++attempts > 12) throw new Error("In-task verification attempt budget exhausted");
          // Preview diagnostics must never consume the final evidence ID or
          // create a release attestation. Final verification still runs after exit.
          const pending = runVerificationPreview(verification.profile, `preview_${randomUUID().replaceAll("-", "")}`,
            AbortSignal.any([verification.controller.signal, toolSignal]), verification.context, verification.expectedSubjectDigest, verification.readReleaseCapabilities);
          verification.pending = pending;
          try {
            const result = await pending;
            if (result.verification.outcome === "passed" && result.verification.subject_digest) grantEvidence(result.verification, result.verification.subject_digest, "preview");
            return result;
          }
          catch (error) { if (error instanceof VerificationCleanupError) verification.unsafe = true; throw error; }
          finally { if (!verification.unsafe && verification.pending === pending) verification.pending = undefined; }
        });
      }
      if (supportsWorkspaceReadOnlyTools(adapter) && payload.context_pack.payload?.policy.execution_mode === "discussion") {
        const context = payload.context_pack.payload;
        const planning = planningToolRuns.get(payload.run_id);
        if (verification && review) {
          if (!verification.expectedSubjectDigest) throw new Error("Read-only review requires its admitted source digest");
          bindWorkspaceReadOnlyTools(config, { projectId: context.project.id, workspaceRoot: plan.root,
            source: { profile: verification.profile, subjectDigest: verification.expectedSubjectDigest }, assertCurrent: () => {
              verification.controller.signal.throwIfAborted();
              if (verificationRuns.get(payload.run_id) !== verification || verification.unsafe || finished.has(payload.run_id)) {
                throw new Error("Read-only review is no longer current");
              }
            } });
        } else if (planning) {
          bindWorkspaceReadOnlyTools(config, { projectId: context.project.id, workspaceRoot: plan.root, assertCurrent: () => {
            planning.controller.signal.throwIfAborted();
            if (planningToolRuns.get(payload.run_id) !== planning || planning.unsafe || finished.has(payload.run_id)) {
              throw new Error("Read-only planning is no longer current");
            }
          } });
        }
      }
      if (verification && process.platform === "win32") {
        Object.freeze(config);
        verification.windowsAdmission = bindWindowsVerifiedExecution(adapter, config, verification.profile, verification.controller.signal, () => {
          if (verificationRuns.get(payload.run_id) !== verification || verification.unsafe) throw new Error("Windows verified run is no longer current");
        });
      }
      const planning = planningToolRuns.get(payload.run_id);
      if (planning?.profile) {
        Object.freeze(config);
        planning.windowsAdmission = bindWindowsPlanningExecution(adapter, config, planning.profile, planning.controller.signal, () => {
          if (planningToolRuns.get(payload.run_id) !== planning || planning.unsafe) throw new Error("Windows planning run is no longer current");
        });
        planning.adapterInvoked = true;
      }
      if (verification) verification.adapterInvoked = true;
      handle = await adapter.start(config);
    } catch (err) {
      const planning = planningToolRuns.get(payload.run_id);
      if (planning?.adapterInvoked && planning.windowsAdmission) {
        try { assertWindowsPlanningStartupClosed(planning.windowsAdmission); }
        catch { planning.unsafe = true; }
      }
      if (err instanceof VerificationCleanupError) {
        const verification = verificationRuns.get(payload.run_id);
        if (verification) verification.unsafe = true;
      }
      // start() can reject after a child already wrote files (for example, a
      // process guardian failed to launch). Preserve the materialized worktree
      // even when the adapter never returned a handle to this client.
      const recovery = plan.kind === "worktree" ? `\nWorktree retained for recovery: ${JSON.stringify({
        run_id: payload.run_id, task_id: payload.task_id, workspace_root: plan.root,
        workspace_branch: plan.branch, outcome: "process_start_failed",
      })}` : "";
      await rejectStart("process_start_failed", `${errorMessage(err)}${recovery}`);
      return;
    }
    runs.set(payload.run_id, { handle, adapter });
    const planning = planningToolRuns.get(payload.run_id);
    if (planning?.profile) planning.adapterStarted = true;
    if (mixed) settleMixedLegacy(mixed, { kind: "started" });
    ready();
    await streamStartedRun({ commandId: command.id, runId: payload.run_id, taskId: payload.task_id,
      workspaceRoot: payload.workspace.root }, adapter, handle, plan, typedRetention);
  }

  async function streamManagedRun(delivery: RunDelivery, handle: AgentInstanceHandle, physical: PhysicalStartRecord): Promise<void> {
    const managed = physical.managed!, journal = options.managedJournal!.journal;
    let delivered = false, ownedResultSettlementAttempted = false;
    const persist = async (settlement: TerminalSettlement): Promise<void> => {
      await stopPhysical(physical);
      if (!physical.confirmedClosed || !physical.closureReceipt) throw new Error("Managed settlement lacks the retained genuine closure object");
      let run: JournalRun;
      const result = physical.ownedResult;
      if (result && settlement.terminal.payload.phase === "completed") {
        if (!result.prepared || !result.worktree || !physical.execution || !physical.controller) throw new Error("Owned result execution lost its original finalization authority");
        physical.recovery.phase = "finalizing_result";
        result.finalizing ??= finalizeOwnedResultRun(result.prepared, { worktree: result.worktree,
          admission: physical.execution.admission, handle, closure: physical.closureReceipt, signal: physical.controller.signal });
        let bundle: OwnedResultFinalizationV1;
        try { bundle = await result.finalizing; }
        catch (error) { if (worktreeResultFailureIsUncertain(error)) result.unsafe = true; throw error; }
        // After this call a missing reply may mean the atomic commit succeeded.
        // Never replace that outcome with a new failed settlement.
        ownedResultSettlementAttempted = true;
        run = await journal.settleOwnedResultProcess!(managed.permit, handle, physical.closureReceipt, bundle);
      } else run = await journal.settleOwnedProcess(managed.permit, handle, physical.closureReceipt, settlement);
      managed.run = run; managed.settled = true; managed.delivery.useClosed(run);
      // Receipt is retained until the preceding real journal commit succeeds.
      physical.closureReceipt = undefined;
      await drainManagedRecord(physical); delivered = true;
    };
    try {
      await abortableOperation(boundedOperation(ackAccepted(delivery.commandId), 10000), managed.delivery.signal);
      const iterator = physical.execution!.streamEvents(handle)[Symbol.asyncIterator]();
      for (;;) {
        // A separate cancellation signal wakes even a silent producer. Do not
        // await iterator.return() before stopping the genuine writer: return
        // itself can wait behind the same blocked next(). Actual owned stop is
        // the cleanup authority, and the losing next Promise stays observed.
        const yielded = await abortableOperation(iterator.next(), managed.delivery.signal);
        managed.delivery.signal.throwIfAborted();
        if (yielded.done) break;
        const raw = adapterRunEventBodySchema.parse(yielded.value);
        if (raw.type === "run.lifecycle" && ["completed", "failed", "cancelled"].includes(raw.payload.phase)) {
          // Only a terminal actually observed before our failure-stop is prior
          // runtime history. A cancellation emitted by that stop is not read
          // back and cannot turn a delivery failure into user cancellation.
          managed.observedTerminal = raw as TerminalSettlement["terminal"];
          const current = await journal.lookupRun({ expectedNamespace: journal.namespace, runId: delivery.runId });
          if (raw.payload.phase === "completed" && current?.liveAbort) throw new Error(current.liveAbort.message);
          await persist({ terminal: managed.observedTerminal, retentionOutcome: raw.payload.phase as "completed" | "failed" | "cancelled" });
          return;
        }
        const event = raw.type === "artifact.created" && options.uploadArtifact
          ? await boundedOperation(options.uploadArtifact(delivery.runId, delivery.workspaceRoot, raw), 30000) : raw;
        await managed.delivery.sendLive(event);
      }
      throw new Error("Managed stream ended without a terminal outcome");
    } catch (error) {
      if (managed.settled) throw error; // Closed correction/receipt state remains durable; never settle again.
      if (physical.ownedResult?.unsafe || ownedResultSettlementAttempted) {
        physical.recovery.phase = physical.ownedResult?.unsafe ? "result_finalization_uncertain" : "result_settlement_unknown";
        throw error;
      }
      const prior = managed.observedTerminal;
      let storedAbort: JournalRun["liveAbort"] = null;
      try { storedAbort = (await journal.lookupRun({ expectedNamespace: journal.namespace, runId: delivery.runId }))?.liveAbort ?? null; }
      catch { /* Storage unavailable; still stop the genuine writer below. */ }
      const priorNonSuccess = prior && (prior.payload.phase === "failed" || prior.payload.phase === "cancelled") ? prior : undefined;
      const userCancelled = physical.userStopRequested === true && !storedAbort && !managed.failure;
      managed.failure ??= (storedAbort?.message ?? errorMessage(error)).slice(0, 500);
      try {
        if (userCancelled) await journal.latchLiveDeliveryAbort(managed.permit, { code: "user_cancelled", message: "User stop requested" });
        else await managed.delivery.abort(error);
      } catch { /* Persistence failure cannot skip physical stop or invent closure. */ }
      const terminal: TerminalSettlement["terminal"] = priorNonSuccess ?? { type: "run.lifecycle", payload: userCancelled
        ? { phase: "cancelled", reason: "user_cancelled" } : { phase: "failed", reason: managed.failure } };
      await persist({ terminal, retentionOutcome: terminal.payload.phase === "cancelled" ? "cancelled"
        : priorNonSuccess ? "failed" : "incomplete_delivery" });
    } finally {
      if (physical.execution) physical.execution.deliveryPending = !delivered;
      physical.recovery.phase = managed.settled ? "closed" : physical.ownedResult?.unsafe ? "result_finalization_uncertain"
        : ownedResultSettlementAttempted ? "result_settlement_unknown" : physical.confirmedClosed ? "physical_closed_journal_unknown" : "cleanup_uncertain";
      compactPhysical(physical);
    }
  }

  async function streamStartedRun(delivery: RunDelivery, adapter: RuntimeAdapter, handle: AgentInstanceHandle,
    plan: WorkspacePlan, typedRetention: boolean, physical?: PhysicalStartRecord): Promise<void> {
    if (physical?.managed) return streamManagedRun(delivery, handle, physical);
    let ownedStopAttempted = false;
    let sequence = 0;
    let retentionReported: WorkspaceRetentionOutcome | undefined;
    const reportRetainedWorkspace = async (outcome: WorkspaceRetentionOutcome): Promise<void> => {
      if (plan.kind !== "worktree") return;
      // Only completed delivery can need one subsequent correction. A timed-out
      // report may already have committed, so its correction uses a new sequence.
      if (retentionReported && !(retentionReported === "completed" && outcome === "incomplete_delivery")) return;
      retentionReported = outcome;
      if (typedRetention) {
        try {
          await transport.send({ kind: "run.event", node_id: nodeId, run_id: delivery.runId, sequence: sequence++,
            event: { type: "run.workspace.retained", payload: { version: 1, workspace_root: plan.root,
              workspace_branch: plan.branch, outcome } },
          });
        } catch (error) {
          // Success requires committed typed evidence; other outcomes preserve
          // the actual failure/cancellation even if metadata delivery fails.
          if (outcome === "completed") throw error;
        }
      }
      // Keep the legacy diagnostic readable, without treating runtime text as
      // retention authority. In typed mode this diagnostic is only best-effort.
      try {
        const diagnostic = transport.send({ kind: "run.event", node_id: nodeId, run_id: delivery.runId, sequence: sequence++,
          event: { type: "run.output", payload: { stream: "stderr", text: `Worktree retained for recovery: ${JSON.stringify({
            run_id: delivery.runId, task_id: delivery.taskId, workspace_root: plan.root,
            workspace_branch: plan.branch, outcome,
          })}` } },
        }, typedRetention ? { delivery: "best-effort" } : undefined);
        // Typed metadata already supplies the durable authority. Never wait on
        // the optional diagnostic, including transports that ignore the option.
        if (typedRetention) void diagnostic.catch(() => {});
        else await diagnostic;
      } catch (error) {
        if (!typedRetention && outcome === "completed") { retentionReported = undefined; throw error; }
      }
    };
    try {
      await ackAccepted(delivery.commandId);
      const stream = physical ? physical.execution!.streamEvents(handle) : adapter.streamEvents(handle);
      for await (const yielded of stream) {
        // Custom adapters and child output have no authority to report retention.
        const rawEvent = adapterRunEventBodySchema.parse(yielded);
        if (rawEvent.type === "run.lifecycle" && (rawEvent.payload.phase === "completed" || rawEvent.payload.phase === "failed" || rawEvent.payload.phase === "cancelled")) {
          const verification = verificationRuns.get(delivery.runId);
          if (verification?.windowsAdmission) assertWindowsVerifiedExecutionClosed(verification.windowsAdmission, handle);
          const planning = planningToolRuns.get(delivery.runId);
          if (planning?.windowsAdmission) assertWindowsPlanningExecutionClosed(planning.windowsAdmission, handle);
          if (verification && rawEvent.payload.phase === "completed") {
            // The coding producer no longer owns completion. Close it before
            // hashing or starting the independent administrator verifier.
            await adapter.stop(handle, "user_cancelled");
            if (verification.windowsAdmission) assertWindowsVerifiedExecutionClosed(verification.windowsAdmission, handle);
            const pending = runVerification(verification.profile, verification.requestId, verification.controller.signal, verification.context, verification.expectedSubjectDigest,
              verification.readReleaseCapabilities);
            verification.pending = pending;
            let evidence;
            try { evidence = await pending; }
            catch (error) {
              if (error instanceof VerificationCleanupError) verification.unsafe = true;
              throw error;
            }
            releaseExecutor.recordVerification(delivery.runId, verification.profile.project_id, verification.profile.workspace_root, evidence,
              verification.readReleaseCapabilities ? { context: verification.context!, readCapabilities: verification.readReleaseCapabilities } : undefined);
            await transport.send({ kind: "run.event", node_id: nodeId, run_id: delivery.runId, sequence: sequence++,
              event: { type: "run.verification", payload: evidence } });
            if (sourceRuntime && evidence.outcome === "passed" && verification.context?.product_development
              && verification.context.policy.execution_mode !== "discussion" && !verification.controller.signal.aborted) {
              try {
                if (!verification.windowsAdmission) throw new Error("Source export requires original native Windows author closure");
                const input = { runStart: verification.runStart, profile: verification.profile, evidence, admission: verification.windowsAdmission, handle };
                // First-hop v2 requires the explicit local prepared release
                // association. Other stages/policies retain the ordinary byte route.
                const semanticResearch = verification.context.product_development.stage === "research"
                  && (verification.profile.capabilities?.measurement_plan_policy?.version === 1
                    && productSourceSemanticExportEnabled(sourceRuntime)
                    || verification.profile.capabilities?.measurement_plan_policy?.version === 2
                    && productSourceMeasurementV2ExportEnabled(sourceRuntime, verification.profile));
                const event = semanticResearch
                  ? { type: "run.product-source.export.v2" as const, payload: captureProductSourceExportV2(sourceRuntime, input) }
                  : { type: "run.product-source.export.v1" as const, payload: captureProductSourceExport(sourceRuntime, input) };
                await transport.send({ kind: "run.event", node_id: nodeId, run_id: delivery.runId, sequence: sequence++, event });
              } catch (error) {
                // Storage or delivery uncertainty retains this workspace even after process closure.
                verification.unsafe = true;
                throw new VerificationCleanupError(`Product source export remains unconfirmed: ${errorMessage(error)}`);
              }
            }
            // Failed checks remain reviewable. An explicit stop still cancels
            // the run and never starts another verification command.
            if (verification.controller.signal.aborted) rawEvent.payload = { phase: "cancelled", reason: "user_cancelled" };
          }
          if (physical) {
            ownedStopAttempted = true;
            await stopPhysical(physical);
          }
          await reportRetainedWorkspace(rawEvent.payload.phase as "completed" | "failed" | "cancelled");
        }
        const event = rawEvent.type === "artifact.created" && options.uploadArtifact
          ? await options.uploadArtifact(delivery.runId, delivery.workspaceRoot, rawEvent) : rawEvent;
        const message: RunEventMessage = {
          kind: "run.event",
          node_id: nodeId,
          run_id: delivery.runId,
          sequence: sequence,
          event
        };
        sequence += 1;
        await transport.send(message);
        if (verificationRuns.has(delivery.runId) && rawEvent.type === "run.lifecycle"
          && ["completed", "failed", "cancelled"].includes(rawEvent.payload.phase)) break;
      }
    } catch (error) {
      if (error instanceof VerificationCleanupError) {
        const verification = verificationRuns.get(delivery.runId);
        if (verification) verification.unsafe = true;
        throw error;
      }
      // Preserve the worktree when a deliverable could not be safely transferred.
      // A delivery error can occur while the process is still writing. Confirm
      // process stop before reporting failure and allowing lease release.
      if (physical) {
        if (!ownedStopAttempted) { ownedStopAttempted = true; await stopPhysical(physical); }
        else if (!physical.confirmedClosed) throw error;
      }
      else await stopLegacyRun(delivery.runId, { handle, adapter });
      await reportRetainedWorkspace("incomplete_delivery");
      await transport.send({
        kind: "run.event", node_id: nodeId, run_id: delivery.runId, sequence: sequence++,
        event: { type: "run.lifecycle", payload: { phase: "failed", reason: errorMessage(error) } },
      }).catch(() => {});
    } finally {
      if (!physical && !verificationRuns.get(delivery.runId)?.unsafe && !planningToolRuns.get(delivery.runId)?.unsafe) {
        if (sourceRuntime) {
          const verification = verificationRuns.get(delivery.runId);
          if (verification) {
            if (!verification.windowsAdmission) throw new VerificationCleanupError("Product source run lost native closure authority");
            assertWindowsVerifiedExecutionClosed(verification.windowsAdmission, handle);
            if (readProductResearchRevision(verification.context)) closeProductResearchRevisionRun(sourceRuntime, verification.runStart,
              verification.profile, { admission: verification.windowsAdmission, handle });
            releaseProductSourceRun(sourceRuntime, delivery.runId);
          } else {
            const planning = planningToolRuns.get(delivery.runId);
            if (!planning?.windowsAdmission) throw new VerificationCleanupError("Product source run lost native closure authority");
            try { assertWindowsPlanningExecutionClosed(planning.windowsAdmission, handle); }
            catch (error) { planning.unsafe = true; throw error; }
          }
        }
        finished.add(delivery.runId);
        const ordinary = mixedLegacyStarts.get(delivery.runId);
        // Stream completion does not erase a mixed run's remaining Stop
        // authority while persistence or an adapter Stop is still pending.
        const awaitingRequestedStop = ordinary && mixedStopIntents.has(delivery.runId) && !ordinary.stopCompleted;
        if (!awaitingRequestedStop && !ordinary?.stopFailure && !ordinary?.stopPending) runs.delete(delivery.runId);
        verificationRuns.delete(delivery.runId);
        // Artifacts do not certify that all modified/new/ignored bytes are saved.
        await reportRetainedWorkspace("unconfirmed");
      } else if (physical) {
        try {
          // Stream completion alone does not prove guardian/group closure.
          if (!physical.confirmedClosed && !ownedStopAttempted) await stopPhysical(physical);
        } finally {
          try { await reportRetainedWorkspace("unconfirmed"); }
          finally {
            if (physical.execution) physical.execution.deliveryPending = false;
            physical.recovery.phase = physical.confirmedClosed ? "closed" : "cleanup_uncertain";
            compactPhysical(physical);
          }
        }
      }
    }
  }

  async function requestManagedRunStop(runId: string): Promise<void> {
    const physical = physicalStarts.get(runId);
    if (!options.managedJournal || !physical?.managed) throw new Error("Local Stop requires this Node's owned managed run");
    const managed = physical.managed;
    physical.controller?.abort();
    if (!managed.failure && !managed.settled) physical.userStopRequested = true;
    managed.delivery.cancelUnexposed(new DeliveryCancelled("User stop requested"));
    try { await options.managedJournal.journal.requestStop({ expectedNamespace: options.managedJournal.journal.namespace, runId }); }
    catch (error) {
      await physical.ready;
      try { await stopPhysical(physical); } catch { /* Preserve unknown closure while surfacing the original storage error. */ }
      try { await joinOwnedResultFinalization(physical); } catch { /* Retained finalizer uncertainty remains observable on the next Stop. */ }
      throw error;
    }
    await physical.ready;
    try { await stopPhysical(physical); } finally { await joinOwnedResultFinalization(physical); }
  }

  async function onRunStop(command: RunStopCommand): Promise<void> {
    const runId = command.payload.run_id;
    verificationRuns.get(runId)?.controller.abort();
    planningToolRuns.get(runId)?.controller.abort();
    if (options.managedJournal?.mixed) mixedStopIntents.add(runId);
    const ordinary = mixedLegacyStarts.get(runId);
    if (ordinary) {
      ordinary.controller?.abort(new DeliveryCancelled("User stop requested before ordinary startup"));
      let storageFailure: unknown;
      let storageFailed = false;
      let stopped: JournalRun | undefined;
      try {
        const journal = options.managedJournal!.journal;
        stopped = await journal.requestStop({ expectedNamespace: journal.namespace, runId, expectedKey: ordinary.key });
      } catch (error) { storageFailed = true; storageFailure = error; }
      // Even failed persistence cannot revoke the captured legacy stop handle.
      await ordinary.ready;
      try {
        const run = runs.get(runId);
        if (run) await stopLegacyRun(runId, run);
        else if (!ordinary.admitted && stopped?.receipt?.kind !== "run_fenced_unbound" && stopped?.receipt?.kind !== "not_started_fenced") {
          throw new Error("Durable ordinary ownership is unknown; stop is not confirmed");
        }
        else if (ordinary.stopFailure) throw new Error(ordinary.stopFailure);
        else if (ordinary.adapterInvoked && ordinary.outcome?.kind !== "started" && !ordinary.stopCompleted) {
          throw new Error("Ordinary startup invoked its adapter without a returned handle; stop remains uncertain");
        }
        if (storageFailed) throw storageFailure;
        await ackAccepted(command.id);
      } catch (error) { await ackRejected(command.id, "process_start_failed", errorMessage(error)); }
      return;
    }
    const physical = physicalStarts.get(command.payload.run_id);
    if (physical?.managed) {
      try { await requestManagedRunStop(command.payload.run_id); await ackAccepted(command.id); }
      catch (error) { await ackRejected(command.id, "process_start_failed", errorMessage(error)); }
      return;
    }
    physical?.controller?.abort(); // Stop startup promptly, before any journal await.
    if (options.managedJournal && !runs.has(command.payload.run_id) && !starting.has(command.payload.run_id)
      && !(launchBindings.has(command.payload.run_id) && launchBindings.get(command.payload.run_id) === undefined)) {
      if (physical && !physical.managed?.failure) physical.userStopRequested = true;
      physical?.managed?.delivery.cancelUnexposed(new DeliveryCancelled("User stop requested"));
      const journal = options.managedJournal.journal;
      try {
        const stopped = await journal.requestStop({ expectedNamespace: journal.namespace, runId: command.payload.run_id });
        if (!physical?.execution && (stopped.receipt?.kind === "run_fenced_unbound" || stopped.receipt?.kind === "not_started_fenced")) {
          finished.add(command.payload.run_id); await ackAccepted(command.id); return;
        }
      }
      catch (error) {
        // A database failure does not revoke the actual captured stop authority.
        if (physical) { physical.controller?.abort(); await physical.ready; try { await stopPhysical(physical); } catch { /* reported uncertain below */ } }
        await ackRejected(command.id, "process_start_failed", errorMessage(error)); return;
      }
      if (!physical) {
        const durable = await journal.lookupRun({ expectedNamespace: journal.namespace, runId: command.payload.run_id });
        if (durable?.receipt?.kind === "run_fenced_unbound" || durable?.receipt?.kind === "not_started_fenced") { await ackAccepted(command.id); return; }
        await ackRejected(command.id, "process_start_failed", "Durable live ownership is unknown; stop is not confirmed"); return;
      }
    }
    if (physical) {
      // Signal the actual shared startup controller before waiting for readiness.
      physical.controller?.abort();
      await physical.ready;
      try { await stopPhysical(physical); await ackAccepted(command.id); }
      catch (error) { await ackRejected(command.id, "process_start_failed", errorMessage(error)); }
      return;
    }
    await starting.get(command.payload.run_id);
    const run = runs.get(command.payload.run_id);
    if (!run && verificationRuns.get(runId)?.unsafe) {
      await ackRejected(command.id, "process_start_failed", "Verifier closure remains unconfirmed after startup failure"); return;
    }
    if (!run && planningToolRuns.get(runId)?.unsafe) {
      await ackRejected(command.id, "process_start_failed", "Windows planning closure remains unconfirmed after startup failure"); return;
    }
    if (!run && !finished.has(command.payload.run_id)) {
      // A cancellation can race ahead of run.start. Record the tombstone before
      // acknowledging absence, so a later start for this run cannot spawn.
      finished.add(command.payload.run_id);
      await ackAccepted(command.id);
      return;
    }
    try {
      if (run) await stopLegacyRun(runId, run);
      await ackAccepted(command.id);
    } catch (error) {
      await ackRejected(command.id, "process_exited", errorMessage(error));
    }
  }

  // #115 P2-S3b: resume an already-active run after a reconnect. This handler is
  // deliberately narrow: it does not implement WebSocket reconnect or outbound
  // event buffering, and it NEVER rebuilds or starts a process. It only reports
  // whether the run's handle is still live in this client. Alive → ack accepted
  // (the existing streamEvents loop keeps flowing). Lost → ack rejected
  // (process_exited), and the server maps that to the daemon_disconnect path.
  async function onRunResume(command: RunResumeCommand): Promise<void> {
    if (planningToolRuns.get(command.payload.run_id)?.unsafe) {
      await ackRejected(command.id, "process_start_failed", "Windows planning closure remains unconfirmed"); return;
    }
    if (verificationRuns.get(command.payload.run_id)?.unsafe && !runs.has(command.payload.run_id)) {
      await ackRejected(command.id, "process_start_failed", "Verifier closure remains unconfirmed after startup failure"); return;
    }
    const ordinary = mixedLegacyStarts.get(command.payload.run_id);
    if (ordinary) {
      const outcome = await ordinary.ready;
      // A rejected journal admission does not make the durable owner's process
      // absent. Let the checked recovery path below inspect that original row.
      if (ordinary.admitted) {
        if (ordinary.stopFailure || outcome.kind === "uncertain") {
          await ackRejected(command.id, "process_start_failed", ordinary.stopFailure
            ?? (outcome.kind === "uncertain" ? outcome.message : "Ordinary stop remains uncertain"));
        } else if (outcome.kind === "started" && runs.has(command.payload.run_id)) {
          await ackAccepted(command.id);
        } else {
          await ackRejected(command.id, "process_exited", "Ordinary run has no active handle in this client");
        }
        return;
      }
    }
    const physical = physicalStarts.get(command.payload.run_id);
    if (physical) {
      await physical.ready;
      if (physical.managed?.settled && physical.managed.run) {
        const run = physical.managed.run, journal = options.managedJournal!.journal;
        try {
          const state = await journal.inspectClosedRunDelivery({ expectedNamespace: journal.namespace, runId: run.runId,
            launchKey: run.launchKey!, physicalReceiptId: run.receipt!.id });
          if (state.state === "delivered") {
            physical.managed.deliveryPending = false;
            if (physical.execution) physical.execution.deliveryPending = false;
            compactPhysical(physical); await ackRejected(command.id, "process_exited", "owned execution and durable delivery are closed"); return;
          }
          if (state.state === "blocked") { await ackRejected(command.id, "process_start_failed", "Durable delivery remains blocked"); return; }
          track(drainManagedRecord(physical));
          await ackAccepted(command.id); return; // Durable delivery-only resume needs no live handle.
        } catch (error) { await ackRejected(command.id, "process_start_failed", errorMessage(error)); return; }
      }
      const execution = physical.execution;
      if (!execution) {
        await ackRejected(command.id, physical.confirmedClosed ? "process_exited" : "process_start_failed",
          physical.confirmedClosed ? "owned execution and delivery are closed"
            : "owned startup has no authenticated current status; recovery state is retained");
        return;
      }
      try {
        if (physical.managed) await options.managedJournal!.journal.lookupRun({ expectedNamespace: options.managedJournal!.journal.namespace, runId: command.payload.run_id });
        const value = await execution.inspectOwnedRun(execution.handle, execution.admission);
        const receipt = getOwnedRunStatusReceipt(value, execution.admission, execution.handle);
        if (receipt?.kind === "confirmed_closed") { physical.confirmedClosed = true; physical.closureReceipt = value; }
        if ((receipt?.kind === "running" || receipt?.kind === "confirmed_closed") && execution.deliveryPending) {
          // This ACK means this client still owns a resumable execution/delivery.
          // A closed child can have real terminal events awaiting committed receipts.
          await ackAccepted(command.id);
        } else if (receipt?.kind === "confirmed_closed") {
          compactPhysical(physical);
          await ackRejected(command.id, "process_exited", "owned execution and delivery are closed");
        } else {
          await ackRejected(command.id, "process_start_failed", "owned execution status or delivery is uncertain; no absence is claimed");
        }
      } catch (error) {
        await ackRejected(command.id, "process_start_failed", errorMessage(error));
      }
      return;
    }
    if (options.managedJournal) {
      const journal = options.managedJournal.journal;
      const durable = await journal.lookupRun({ expectedNamespace: journal.namespace, runId: command.payload.run_id });
      if (durable && !runs.has(command.payload.run_id)) {
        if (durable.mode === "per-run" && durable.phase === "closed" && durable.receipt?.kind === "process_exit_confirmed" && durable.launchKey) {
          const state = await journal.inspectClosedRunDelivery({ expectedNamespace: journal.namespace, runId: durable.runId,
            launchKey: durable.launchKey, physicalReceiptId: durable.receipt.id });
          if (state.state === "delivered") { await ackRejected(command.id, "process_exited", "Durable closed delivery is complete"); return; }
          if (state.state === "blocked") { await ackRejected(command.id, "process_start_failed", "Durable closed delivery is blocked"); return; }
          options.managedJournal.mixed?.bindRun(durable.runId, "managed");
          let delivery = closedDeliveries.get(durable.runId);
          if (!delivery) {
            delivery = new ManagedDelivery(journal, undefined, nodeId, durable.runId, options.managedJournal.channel);
            delivery.useClosed(durable); closedDeliveries.set(durable.runId, delivery);
          }
          track(delivery.drainClosed()); await ackAccepted(command.id); return;
        }
        await ackRejected(command.id, "process_start_failed", "Durable restart ownership remains unknown; this client cannot adopt a writer"); return;
      }
    }
    // Workspace/materialization or adapter.start may still be in flight after
    // reconnect. Absence from the live map is not proof of exit until that
    // start has either installed its process handle or definitively failed.
    await starting.get(command.payload.run_id);
    if (planningToolRuns.get(command.payload.run_id)?.unsafe) {
      await ackRejected(command.id, "process_start_failed", "Windows planning closure remains unconfirmed"); return;
    }
    if (verificationRuns.get(command.payload.run_id)?.unsafe) {
      await ackRejected(command.id, "process_start_failed", "Verifier process-group closure remains unconfirmed"); return;
    }
    if (runs.has(command.payload.run_id)) {
      await ackAccepted(command.id);
    } else {
      await ackRejected(command.id, "process_exited", `run ${command.payload.run_id} is not active on this node`);
    }
  }

  async function dispatch(message: ServerToNodeMessage): Promise<void> {
    recordSourceCommandPhase("dispatch_admission");
    if (sourceRecovery && sourceReplayEnabled && message.type === "run.stop") sourceStartReplay.stopRun(message.payload.run_id);
    if (sourceRecovery && sourceReplayEnabled) {
      const ordinary = sourceCommandInflight.run(message, sourceReplayScope, dispatchFresh);
      if (ordinary) return ordinary;
    }
    if (!sourceRecovery || !sourceReplayEnabled || message.type !== "run.start") return dispatchFresh(message);
    const sendOutcome = (outcome: SourceStartOutcome) => sendControl({ kind: "command.ack", node_id: nodeId, command_id: message.id,
      ...(outcome.status === "accepted" ? { status: "accepted" as const, message: null } : outcome) });
    let admission: ReturnType<typeof sourceStartReplay.enter>;
    try {
      const scope = sourceReplayScope();
      if (!scope) throw Error("Source startup requires its current authenticated epoch/session");
      // Register before the first await/full audit. Retries cannot queue more
      // synchronous observers ahead of this original startup's native callback.
      admission = sourceStartReplay.enter(message, scope);
    } catch (error) { await sendOutcome({ status: "rejected", error_code: "process_start_failed", message: errorMessage(error) }); return; }
    if (!admission.fresh) {
      // Validate every retransmission before joining an existing reply. Retain only
      // its replay/send lifetime; the original dispatch may continue running after ACK.
      const commandId = admission.command.id;
      if (pendingSourceReplaySends.has(commandId)) return;
      const pending = Symbol(); pendingSourceReplaySends.set(commandId, pending);
      const runId = admission.command.payload.run_id;
      try {
        await sendOutcome(await sourceStartReplay.replay(admission.ticket, sourceReplayScope, () => !planningToolRuns.get(runId)?.unsafe
          && !verificationRuns.get(runId)?.unsafe && !mixedStopIntents.has(runId)));
      } finally {
        if (pendingSourceReplaySends.get(commandId) === pending) pendingSourceReplaySends.delete(commandId);
      }
      return;
    }
    return sourceStartReplay.run(admission.ticket, () => dispatchFresh(admission.command));
  }

  async function dispatchFresh(message: ServerToNodeMessage): Promise<void> {
    if (!sourceRecovery) return dispatchActive(message);
    recordSourceCommandPhase("recovery");
    try { if (await sourceRecovery.handle(message)) {
      if (isOrdinarySourceResultReceipt(message)) throw Error("Source result receipt requires its original ordinary controller");
      return;
    } }
    catch (error) {
      options.productSourceRecovery!.onFailure?.(error instanceof Error ? error : new Error("Recovery control failed"));
      if (isOrdinarySourceResultReceipt(message)) throw error;
      return ackRejected(message.id, "process_start_failed", errorMessage(error));
    }
    if (message.type === "run.event.ack" || message.type === "product.release.health.ack"
      || message.type === "node.session.ready" || message.type === "node.session.pong") return;
    const recovered = message.type.startsWith("product.source.recovery-validation.") || message.type.startsWith("product.source.recovery-validation-review.");
    const clean = message.type.startsWith("product.source.clean-validation.") || message.type.startsWith("product.source.clean-validation-review.");
    if (recovered && !sourceRecovery.isActive()) {
      try { await sourceRecovery.awaitRecoveredActivation(); }
      catch (error) { return ackRejected(message.id, "process_start_failed", errorMessage(error)); }
    }
    if (clean && !sourceRecovery.isActive()) {
      try { await sourceRecovery.awaitCleanActivation(); }
      catch (error) { return ackRejected(message.id, "process_start_failed", errorMessage(error)); }
    }
    if (!sourceRecovery.isActive()) {
      if (isOrdinarySourceResultReceipt(message)) throw Error("Source result receipt has no active original source session");
      return ackRejected(message.id, "process_start_failed", "Guardian registration and accepted recovery checkpoint are not ready");
    }
    if (recovered && !recoveredValidations) return ackRejected(message.id, "process_start_failed", "Original recovered validation controller is unavailable");
    if (clean && !cleanValidations) return ackRejected(message.id, "process_start_failed", "Original clean validation controller is unavailable");
    if (!sourceRecovery.allowsOrdinary() && !recovered && !clean && !((message.type === "product.release" || message.type === "product.release.cancel")
      && (message.payload.imported_recovery && recoveredValidations || message.payload.imported_clean && cleanValidations))) {
      if (isOrdinarySourceResultReceipt(message)) throw Error("Source result receipt has no ordinary source authority");
      return ackRejected(message.id, "process_start_failed", "Recovered epoch requires fresh dedicated validation, independent review and publication");
    }
    const sha = (value: string | Uint8Array) => "sha256:" + createHash("sha256").update(value).digest("hex");
    let operation: RecoveryOperationRefV1 | null = null;
    if (message.type === "product.source.validation.v1") operation = { kind: "validation", operation_id: message.payload.validation_id,
      request_digest: importedValidationRequestDigestV1(message.payload, sha), run_id: message.payload.run_start.run_id };
    else if (message.type === "product.source.validation-review.v1") operation = { kind: "validation_review",
      operation_id: message.payload.review_id, request_digest: importedValidationReviewRequestDigestV1(message.payload, sha) };
    else if (message.type === "product.release" || message.type === "product.release.cancel") operation = { kind: "release",
      operation_id: message.payload.release_id, request_digest: sha(canonicalProductSourceTransferValueV1(message.payload)) };
    let dispatched = false;
    try {
      recordSourceCommandPhase("runtime");
      const runtime = sourceRecovery.readRuntime();
      // Return the promise without awaiting it: only synchronous admission errors
      // before dispatch belong to this rejection, never a later ACK delivery failure.
      recordSourceCommandPhase("dispatch_scope");
      return withWindowsSourceRecoveryOperation(runtime, { operationId: operation?.operation_id ?? message.id,
        bindingDigest: operation?.request_digest ?? sha(canonicalProductSourceTransferValueV1(message)), serverOperation: operation }, () => {
        dispatched = true;
        return dispatchActive(message);
      });
    } catch (error) {
      if (dispatched || message.type !== "run.start") throw error;
      return ackRejected(message.id, "process_start_failed", errorMessage(error));
    }
  }

  async function dispatchActive(message: ServerToNodeMessage): Promise<void> {
    recordSourceCommandPhase("handler");
    if (cleanValidations && await cleanValidations.handle(message)) return;
    if (recoveredValidations && await recoveredValidations.handle(message)) return;
    if(sourceOperations&&await sourceOperations.handle(message))return;
    if(importedReviews&&await importedReviews.handle(message))return;
    if(importedDesigns&&await importedDesigns.handle(message))return;
    if(importedDesignReviews&&await importedDesignReviews.handle(message))return;
    if(importedExecutions&&await importedExecutions.handle(message))return;
    if(importedExecutionReviews&&await importedExecutionReviews.handle(message))return;
    if(importedValidations&&await importedValidations.handle(message))return;
    // A normal return is used by delivery bookkeeping only after the actual
    // controller validates its original local result. Unknown receipts cannot
    // acquire that meaning by falling through the command switch.
    if (isOrdinarySourceResultReceipt(message)) throw Error("Original source result receipt controller is unavailable");
    switch (message.type) {
      case "product.release.cancel": {
        try {
          const receipt = await releaseExecutor.cancel(message.payload);
          await transport.send({ kind: "product.release.receipt", node_id: nodeId, payload: receipt });
          await ackAccepted(message.id);
        } catch (error) { await ackRejected(message.id, "process_start_failed", errorMessage(error)); }
        return;
      }
      case "product.release": {
        try {
          const historical = releaseExecutor.replayReceipt(message.payload);
          if (historical) {
            await transport.send({ kind: "product.release.receipt", node_id: nodeId, payload: historical }); await ackAccepted(message.id); return;
          }
        } catch (error) { return ackRejected(message.id, "process_start_failed", errorMessage(error)); }
        const profile = releaseProfiles.find((item) => item.id === message.payload.release_profile_id);
        if (!profile || [...verificationRuns.values()].some((run) => run.profile.workspace_root === profile.verifier.workspace_root)) {
          return ackRejected(message.id, "process_start_failed", "Release profile unavailable or its workspace is still executing");
        }
        const root = profile.verifier.workspace_root;
        const sourceClaim = `product-release:${message.payload.release_id}`;
        let retry: ReturnType<typeof releaseExecutor.prepareRetry> | undefined;
        try { if (message.payload.retry) retry = releaseExecutor.prepareRetry(message.payload); }
        catch (error) { return ackRejected(message.id, "process_start_failed", errorMessage(error)); }
        let recoveryRelease: PreparedRecoveryValidationRelease | undefined;
        let cleanRelease: PreparedCleanValidationRelease | undefined;
        if (sourceRuntime) {
          try {
            if (message.payload.imported_clean) {
              if (!cleanValidations || !cleanRuntime) throw Error("Clean validation publisher is not active");
              cleanRelease = cleanValidations.prepareRelease(message.payload, retry);
              const original = readPreparedCleanValidationRelease(cleanRelease, message.payload);
              if (!original.readReleaseCapabilities) throw Error("Clean publication lacks original release capabilities");
              releaseExecutor.recordVerification(original.start.run_id, original.profile.project_id, root, original.verification,
                { context: original.start.context_pack.payload, readCapabilities: original.readReleaseCapabilities, importedClean: cleanRelease });
              claimCleanValidationRelease(cleanRuntime, cleanRelease, sourceClaim);
            } else if (message.payload.imported_recovery) {
              if (!recoveredValidations || !recoveryRuntime) throw Error("Recovered validation publisher is not active");
              recoveryRelease = recoveredValidations.prepareRelease(message.payload, retry);
              const original = readPreparedRecoveryValidationRelease(recoveryRelease, message.payload);
              if (!original.readReleaseCapabilities) throw Error("Recovered publication lacks original release capabilities");
              releaseExecutor.recordVerification(original.start.run_id, original.profile.project_id, root, original.verification,
                { context: original.start.context_pack.payload, readCapabilities: original.readReleaseCapabilities, importedRecovery: recoveryRelease });
              claimRecoveryValidationRelease(recoveryRuntime, recoveryRelease, sourceClaim);
            } else if (message.payload.imported_validation) {
              if (!importedValidations) throw Error("Imported validation publisher is not enabled on this node");
              const permit = importedValidations.prepareRelease(message.payload, retry), original = readPreparedImportedValidationRelease(permit, message.payload);
              if (!original.readReleaseCapabilities) throw Error("Validation publication lacks its original local release configuration");
              releaseExecutor.recordVerification(original.start.run_id, original.profile.project_id, root, original.verification,
                { context: original.start.context_pack.payload, readCapabilities: original.readReleaseCapabilities, importedValidation: permit });
              claimImportedValidationRelease(sourceRuntime, permit, sourceClaim);
            } else claimProductSourceRun(sourceRuntime, sourceClaim, root);
          }
          catch (error) { return ackRejected(message.id, "process_start_failed", errorMessage(error)); }
        } else if (message.payload.imported_validation || message.payload.imported_recovery || message.payload.imported_clean) return ackRejected(message.id, "process_start_failed", "Imported publication requires its original source runtime");
        let releaseClosed = false, cleanClaimReleased = false;
        releasingWorkspaces.set(root, (releasingWorkspaces.get(root) ?? 0) + 1);
        try {
          const release = () => releaseExecutor.release(message.payload, retry ? { retry } : undefined);
          const receipt = await (cleanRelease && cleanRuntime ? withWindowsCleanReleaseOperation(cleanRuntime, cleanRelease, release) : release());
          releaseClosed = cleanRelease || options.releaseRetrySession ? releaseExecutor.isAttemptSettled(message.payload) : true;
          if (releaseClosed && cleanRelease && cleanRuntime) {
            // Receipt delivery can synchronously admit a fresh retry. Relinquish
            // only the actually settled publisher's original claim before send.
            releaseCleanValidationClaim(cleanRuntime, cleanRelease, sourceClaim); cleanClaimReleased = true;
          }
          await transport.send({ kind: "product.release.receipt", node_id: nodeId, payload: receipt });
          await ackAccepted(message.id);
        } catch (error) { await ackRejected(message.id, "process_start_failed", errorMessage(error)); }
        finally {
          if (sourceRuntime && releaseClosed) {
            if (cleanRuntime && cleanRelease) { if (!cleanClaimReleased) releaseCleanValidationClaim(cleanRuntime, cleanRelease, sourceClaim); }
            else releaseProductSourceRun(sourceRuntime, sourceClaim);
          }
          if (releaseClosed) {
            const pending = (releasingWorkspaces.get(root) ?? 1) - 1;
            if (pending) releasingWorkspaces.set(root, pending); else releasingWorkspaces.delete(root);
          }
        }
        return;
      }
      case "run.start":
        if (sourceRecovery && sourceReplayEnabled && sourceStartReplay.isStopped(message.payload.run_id)) {
          return ackRejected(message.id, "process_start_failed", "Source startup is fenced by Stop");
        }
        return onRunStart(message);
      case "run.start.owned-result.v1":
        return onRunStartOwnedResult(message);
      case "run.stop":
        return onRunStop(message);
      case "artifact.collect":
        return ackAccepted(message.id);
      case "run.resume":
        return onRunResume(message);
      case "run.event.ack":
      case "product.release.health.ack":
        return; // WebSocket transport owns persisted-event acknowledgements.
      case "node.session.ready":
      case "node.session.pong":
        return; // Only the managed transport may establish session usability.
    }
  }

  const client: NodeClient = {
    productSourceFeatures() {
      if (options.productSourceRecovery) {
        const recovery = options.productSourceRecovery;
        const cleanFeatures: readonly string[] = [SOURCE_CLEAN_RESTART_FEATURE_V1, IMPORTED_CLEAN_VALIDATION_FEATURE_V1,
          IMPORTED_CLEAN_VALIDATION_REVIEW_FEATURE_V1, PRODUCT_RELEASE_CLEAN_FEATURE_V1];
        const features = recovery.features.filter(feature => !cleanFeatures.includes(feature));
        if (!recovery.cleanLifecycle) return Object.freeze(features);
        const operations = options.productSourceOperations;
        if (!sourceRecovery || !features.includes(IMPORTED_VALIDATION_FEATURE_V1) || transport.acknowledgesRunEvents !== true
          || !operations?.importedReview || !operations.importedDesign || !operations.importedDesignReview
          || !operations.importedExecution || !operations.importedExecutionReview || !operations.importedValidation
          || typeof releaseExecutor.fenceCleanWorkspace !== "function" || typeof options.releaseRetrySession !== "function")
          throw Error("Clean discovery requires its installed validation, review and publisher controllers with committed receipts");
        assertCleanDaemonControllerConfiguration(recovery.cleanLifecycle, { nodeId, profiles: verificationProfiles, releases: releaseProfiles });
        // Hello precedes the real registration/checkpoint handshake. Advertise the
        // protected installed path here; the original checkpoint and controllers
        // created at activation remain mandatory for execution below.
        return Object.freeze([...features.filter(feature => !["imported-recovery-validation.v1", "imported-recovery-validation-review.v1", PRODUCT_RESEARCH_REVISION_FEATURE_V1].includes(feature)),
          ...cleanFeatures]);
      }
      if (!sourceRuntime) return Object.freeze([]);
      const roles = readProductSourceRuntimeCapabilities(sourceRuntime);
      return Object.freeze([PRODUCT_SOURCE_TRANSFER_FEATURE_V1,
        ...(roles.researchRevision ? [PRODUCT_RESEARCH_REVISION_FEATURE_V1] : []),
        ...(roles.semantic ? [PRODUCT_SOURCE_TRANSFER_FEATURE_V2] : []),
        ...(roles.measurementV2 ? [PRODUCT_SOURCE_TRANSFER_MEASUREMENT_V2_FEATURE_V1] : []),
        ...(sourceOperations && roles.semantic ? [PRODUCT_SOURCE_OPERATIONS_FEATURE_V1] : []),
        ...(importedReviews && roles.importedReview ? [IMPORTED_PRODUCT_REVIEW_FEATURE_V1] : []),
        ...(importedDesigns && roles.importedDesign ? [IMPORTED_DESIGN_CONTINUATION_FEATURE_V1] : []),
        ...(importedDesignReviews && roles.importedDesignReview ? [IMPORTED_DESIGN_REVIEW_FEATURE_V1] : []),
        ...(importedExecutions && roles.importedExecution ? [IMPORTED_EXECUTION_FEATURE_V1] : []),
        ...(importedExecutionReviews && roles.importedExecution ? [IMPORTED_EXECUTION_REVIEW_FEATURE_V1] : []),
        ...(importedValidations && roles.importedValidation ? [IMPORTED_VALIDATION_FEATURE_V1] : [])]);
    },
    requestManagedRunStop,
    invalidateManagedStartupSession(session, cause): void {
      for (const physical of physicalStarts.values()) {
        if (physical.controller && physical.startupSession && (!session || physical.startupSession === session)) physical.controller.abort(cause);
      }
      for (const ordinary of mixedLegacyStarts.values()) {
        if (ordinary.controller && ordinary.startupSession && (!session || ordinary.startupSession === session)) ordinary.controller.abort(cause);
      }
    },
    async failManagedConnection(cause): Promise<void> {
      // Latch cause and wake/cancel all owned consumers synchronously, before
      // the first awaited stop or database write. A resulting producer cancel
      // is not read back as an earlier user-cancelled terminal.
      for (const physical of physicalStarts.values()) {
        physical.controller?.abort(cause);
        if (physical.managed) {
          if (!physical.managed.settled && !physical.userStopRequested) physical.managed.failure ??= errorMessage(cause).slice(0, 500);
          physical.managed.delivery.cancelUnexposed(cause);
        }
      }
      for (const delivery of closedDeliveries.values()) delivery.cancelUnexposed(cause);
      await client.stop(true);
    },
    start(): void {
      if (!sourceRecovery) {
        releaseReady ??= releaseExecutor.start();
        track(releaseReady);
        void releaseReady.then(() => client.replayReleaseHealth()).catch(() => {});
      }
      unsubscribe = transport.subscribe((message) => {
        // Keep the original rejection/settlement while observing failures that track retains locally.
        track(sourceCommandDiagnostics.run(message, () => dispatch(message)));
      });
    },
    ready(): Promise<void> { if (sourceRecovery && unsubscribe) return Promise.resolve(); return releaseReady ?? Promise.reject(new Error("Node client has not started")); },
    async replayReleaseHealth(): Promise<void> {
      if (sourceRecovery && !sourceRecovery.isActive()) return;
      await client.ready();
      await releaseReady;
      if (healthStopped) return;
      for (const report of releaseExecutor.getHealthReports()) {
        const current = pendingHealth.get(report.request.release_id);
        if (!current || current.sequence < report.sequence) pendingHealth.set(report.request.release_id, report);
      }
      await flushHealth();
    },
    async stop(cancelRunning = false): Promise<void> {
      sourceCommandInflight.invalidate();
      sourceStartReplay.invalidate(); // Wake duplicate waiters before any synchronous shutdown audit.
      const close = () => observeWindowsStopStage("client_close", async () => {
      healthStopped = true;
      if (healthRetry) clearTimeout(healthRetry);
      healthRetry = undefined;
      pendingHealth.clear();
      unsubscribe?.();
      unsubscribe = undefined;
      sourceRecovery?.invalidate(); recoveredValidations?.invalidate(); cleanValidations?.invalidate();
      sourceOperations?.invalidate();importedReviews?.invalidate();importedDesigns?.invalidate();importedDesignReviews?.invalidate();importedExecutions?.invalidate();importedExecutionReviews?.invalidate();importedValidations?.invalidate();
      releaseExecutor.requestStop();
      if (cancelRunning) {
        for (const planning of planningToolRuns.values()) planning.controller.abort();
        for (const verification of verificationRuns.values()) verification.controller.abort();
        for (const [runId, ordinary] of mixedLegacyStarts) {
          mixedStopIntents.add(runId);
          ordinary.controller?.abort(new DeliveryCancelled("Node shutdown requested"));
        }
        for (const physical of physicalStarts.values()) {
          physical.controller?.abort();
          physical.managed?.delivery.cancelUnexposed(new DeliveryCancelled("Node shutdown requested"));
        }
        for (const delivery of closedDeliveries.values()) delivery.cancelUnexposed(new DeliveryCancelled("Node shutdown requested"));
        await Promise.allSettled([...physicalStarts.values()].map((physical) => physical.ready));
        await Promise.allSettled([...starting.values()]);
        const stopped = await Promise.allSettled([
          ...[...runs.entries()].map(([runId, run]) => stopLegacyRun(runId, run)),
          ...[...verificationRuns.entries()].filter(([runId, verification]) => verification.unsafe && !runs.has(runId))
            .map(() => Promise.reject(new VerificationCleanupError("Verifier closure remains unconfirmed after startup failure"))),
          ...[...planningToolRuns.entries()].filter(([runId, planning]) => planning.unsafe && !runs.has(runId))
            .map(() => Promise.reject(new VerificationCleanupError("Windows planning closure remains unconfirmed after startup failure"))),
          ...[...mixedLegacyStarts.entries()]
            .filter(([runId, ordinary]) => !runs.has(runId) && (ordinary.stopFailure
              || (ordinary.adapterInvoked && ordinary.outcome?.kind !== "started" && !ordinary.stopCompleted)))
            .map(([, ordinary]) => Promise.reject(new Error(ordinary.stopFailure ?? "Ordinary startup closure remains uncertain; durable identity is retained"))),
          ...[...physicalStarts.values()]
            .filter((physical) => physical.execution || physical.outcome?.kind === "uncertain")
            .map(async (physical) => { try { await stopPhysical(physical); } finally { await joinOwnedResultFinalization(physical); } }),
        ]);
        const failure = stopped.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      }
      await Promise.allSettled([...inflight]);
      await sourceOperations?.settled();await importedReviews?.settled();await importedDesigns?.settled();await importedDesignReviews?.settled();await importedExecutions?.settled();await importedExecutionReviews?.settled();await importedValidations?.settled();
      await recoveredValidations?.settled(); await cleanValidations?.settled(); await sourceRecovery?.settled();
      await observeWindowsStopStage("publisher_stop", () => releaseExecutor.stop());
      });
      if (recoveryRuntime) {
        let entered = false;
        try {
          recordWindowsStopDiagnostic("guardian_scope_admission", "entered");
          return withWindowsSourceRecoveryOperation(recoveryRuntime, { operationId: "node-stop",
            bindingDigest: "sha256:" + createHash("sha256").update(nodeId).digest("hex"), serverOperation: null }, () => {
              entered = true; recordWindowsStopDiagnostic("guardian_scope_admission", "completed"); return close();
            });
        } catch (error) {
          // A changed configuration cannot suppress cancellation of existing handles.
          // Cleanup may still fail closed; neither path releases the guardian fence.
          if (entered) throw error;
          recordWindowsStopDiagnostic("guardian_scope_admission", "failed", error);
          await observeWindowsStopStage("fallback_close", close); throw error;
        }
      }
      return close();
    }
  };
  return client;
}

function errorMessage(err: unknown): string {
  const message = err instanceof Error && err.message.length > 0 ? err.message : "process start failed";
  const native = readWindowsNativeFailure(err);
  if (!native) return message;
  // The local tag already projects a bounded allowlist. Preserve its exact
  // code/detail pair, never the raw cause, and keep the suffix inside replay's bound.
  const suffix = `\n[windows_native_failure.v1 ${JSON.stringify({ version: 1, ...native })}]`;
  const available = 8192 - suffix.length, truncated = "\n[Startup diagnostic truncated]";
  return (message.length <= available ? message : message.slice(0, available - truncated.length) + truncated) + suffix;
}

/** Same canonical legacy payload identity as journal.admitStart, detached before I/O. */
function snapshotMixedLegacyStart(input: RunStartPayload): { readonly key: string; readonly payload: RunStartPayload } {
  const payload = RunStartPayloadSchema.parse(input);
  const freeze = (value: object): void => {
    for (const child of Object.values(value)) if (child !== null && typeof child === "object") freeze(child);
    Object.freeze(value);
  };
  freeze(payload);
  return Object.freeze({ key: createHash("sha256").update(JSON.stringify(payload)).digest("hex"), payload });
}

/** Recognize only the real shared runner's typed cleanup facts, never error text. */
function confirmedOwnedGitCleanup(error: unknown): boolean {
  const pending: unknown[] = [error], seen = new Set<unknown>();
  let receipts = 0;
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);
    if (item instanceof OwnedGitError) {
      receipts += 1;
      if (!item.receipt.cleanupConfirmed || !item.receipt.observersDisposed) return false;
    }
    const nested = item as { cause?: unknown; errors?: unknown[] };
    pending.push(nested.cause, ...(Array.isArray(nested.errors) ? nested.errors : []));
  }
  return receipts > 0;
}
