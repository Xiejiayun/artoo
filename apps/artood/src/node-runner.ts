import { observeWindowsStopStage, recordWindowsStopDiagnostic } from "./windows-stop-diagnostics.js";
import type { NodeHeartbeat, NodeHello, RuntimeAdapter } from "@artoo/protocol";
import { PRODUCT_DESIGN_REVISION_FEATURE_V1, SOURCE_CLEAN_RESTART_FEATURE_V1, IMPORTED_CLEAN_VALIDATION_FEATURE_V1, IMPORTED_CLEAN_VALIDATION_REVIEW_FEATURE_V1, PRODUCT_RELEASE_CLEAN_FEATURE_V1 } from "@artoo/domain";

import type { AdapterRegistry } from "./adapter-registry.js";
import type { ArtifactUploader } from "./artifact-upload.js";
import { createRegistryHeartbeat } from "./heartbeat.js";
import { createNodeClient } from "./node-client.js";
import { createWebSocketTransport } from "./ws-transport.js";
import type { GitExecutor, WorkspaceConfig } from "./workspace-binding.js";
import { VERIFICATION_FEATURE, PRODUCT_STAGE_VERIFICATION_FEATURE, VERIFICATION_CAPABILITIES_FEATURE, MEASUREMENT_PLAN_FEATURE, MEASUREMENT_PLAN_V2_FEATURE,
  verificationSupported, prepareVerificationProfiles, attachWindowsVerificationBackend, readWindowsVerificationBackend,
  productDesignRevisionVerificationSupported, type VerificationProfile } from "./verification.js";
import { PRODUCT_RELEASE_FEATURE, PRODUCT_RELEASE_HEALTH_FEATURE, PRODUCT_RELEASE_ACCEPTANCE_FEATURE, prepareReleaseProfiles, readReleaseCapabilities, releaseProfileExecutionSupported, type ReleaseProfile } from "./product-release.js";
import { PRODUCT_RELEASE_RETRY_FEATURE_V1 } from "@artoo/domain";
import { assertWindowsProcessBackend, type PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";
import type { PreparedWindowsReleaseStorage } from "./windows-release-storage.js";
import { prepareProductSourceNode } from "./product-source-node.js";
import { prepareProductSourceConfiguration } from "./product-source-config.js";
import { prepareWindowsDaemonSupervisorAuthority, type PreparedWindowsDaemonSupervisorAuthority } from "./windows-supervisor-authority.js";
import type { PreparedCleanDaemonConfiguration } from "./windows-clean-local-configuration.js";
import type { ResearchOptions } from "./research.js";
import type { SourceCommandDiagnostic } from "./source-command-diagnostics.js";

/**
 * The artood node daemon: wires a {@link createWebSocketTransport} (real WS to
 * `ws /api/v1/node`) and a runtime (single {@link RuntimeAdapter} or an
 * {@link AdapterRegistry} for multi-runtime) together through {@link createNodeClient}.
 * The same node-client contract drives a real process adapter over a real
 * transport; with a registry, `run.start.runtime` selects the adapter.
 */
export interface ArtoodNodeOptions {
  url: string;
  hello: NodeHello;
  /** Single-runtime mode. Provide this OR registry. */
  adapter?: RuntimeAdapter;
  /** Multi-runtime mode: run.start.runtime selects the adapter. */
  registry?: AdapterRegistry;
  heartbeat?: () => NodeHeartbeat;
  heartbeatIntervalMs?: number;
  /** Node-side workspace materialization config (git worktree mode). */
  workspace?: WorkspaceConfig;
  /** Git executor for worktree materialization; defaults to the real git CLI. */
  git?: GitExecutor;
  WebSocketImpl?: typeof WebSocket;
  uploadArtifact?: ArtifactUploader;
  acknowledgeRunEvents?: boolean;
  reconnectDelayMs?: number;
  verificationProfiles?: readonly VerificationProfile[];
  /** Local opaque authority; never derived from hello, a task or serialized profile metadata. */
  windowsProcessBackend?: PreparedWindowsProcessBackend;
  releaseProfiles?: readonly ReleaseProfile[];
  /** Prepared by main from all configured write roots, never from wire metadata. */
  windowsReleaseStorage?: ReadonlyMap<string, PreparedWindowsReleaseStorage>;
  /** Protected administrator file; enabled only for ordinary native Windows nodes. */
  productSourceConfigFile?: string;
  /** Selected only by the local supervised CLI; native qualification remains authoritative. */
  requireSupervisorLifetime?: boolean;
  prepareCleanLifecycle?: (supervisor: PreparedWindowsDaemonSupervisorAuthority) => PreparedCleanDaemonConfiguration;
  /** Same research settings passed to the author runtime; source configuration cannot substitute them. */
  research?: ResearchOptions;
  /** Trusted local sink; supervised launch binds this to its original daemon output. */
  sourceCommandDiagnostic?: (value: SourceCommandDiagnostic) => unknown;
}

export interface ArtoodNode {
  /** Connects, sends node.hello, and starts dispatching commands to the adapter. */
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Managed lifecycle failure notification; plain nodes keep their existing surface. */
  readonly failed?: Promise<Error>;
  /** Source readiness includes the current guardian registration and accepted recovery receipt. */
  readonly executionReady?: Promise<void>;
}

export function createArtoodNode(options: ArtoodNodeOptions): ArtoodNode {
  const windowsBackend = options.windowsProcessBackend;
  const sourceFile = options.productSourceConfigFile;
  if (options.prepareCleanLifecycle && (!options.requireSupervisorLifetime || !sourceFile))
    throw Error("Clean lifecycle preparation requires the dedicated native supervised startup");
  if (sourceFile !== undefined && (!sourceFile || !windowsBackend || !options.workspace?.allowedRoots?.length || options.hello.managed_receipts)) {
    throw new Error("Product source configuration requires ordinary native Windows execution and complete write roots");
  }
  if (windowsBackend !== undefined) {
    if (process.platform !== "win32") throw new Error("Windows process installation is supported only on Windows");
    if (options.hello.managed_receipts !== undefined) throw new Error("Windows process installation cannot be combined with managed execution");
    assertWindowsProcessBackend(windowsBackend);
  }
  const verificationProfiles = prepareVerificationProfiles(options.verificationProfiles, options.workspace?.allowedRoots);
  if (windowsBackend !== undefined) for (const profile of verificationProfiles) attachWindowsVerificationBackend(profile, windowsBackend);
  const advertisedVerificationProfiles = verificationSupported() ? verificationProfiles
    : process.platform === "win32" && windowsBackend !== undefined
      ? verificationProfiles.filter(profile => readWindowsVerificationBackend(profile) === windowsBackend) : [];
  const releaseProfiles = prepareReleaseProfiles(options.releaseProfiles, verificationProfiles, {
    windowsStorage: options.windowsReleaseStorage, writableRoots: options.workspace?.allowedRoots,
  });
  const advertisedReleaseProfiles = releaseProfiles.filter(releaseProfileExecutionSupported);
  const hello: NodeHello = structuredClone(options.hello);
  // Discovery is derived only from this worker's validated local configuration.
  // Inherited caller advertisements must not invent a capability or scope.
  delete hello.verification_profiles;
  delete hello.release_profiles;
  delete hello.owned_result_profiles;
  delete hello.product_source_routing;
  const configuredFeatures = (hello.execution_features ?? []).filter((feature) => ![VERIFICATION_FEATURE, PRODUCT_STAGE_VERIFICATION_FEATURE, VERIFICATION_CAPABILITIES_FEATURE,
    MEASUREMENT_PLAN_FEATURE, MEASUREMENT_PLAN_V2_FEATURE, PRODUCT_RELEASE_FEATURE, PRODUCT_RELEASE_HEALTH_FEATURE, PRODUCT_RELEASE_ACCEPTANCE_FEATURE, PRODUCT_RELEASE_RETRY_FEATURE_V1,
      PRODUCT_DESIGN_REVISION_FEATURE_V1,
      "owned-result-run.v1", "product-source-transfer.v1", "product-source-transfer.v2", "product-source-transfer.measurement-v2.v1",
      "product-source-operations.v1", "product-research-revision.v1", "imported-product-review.v1", "imported-design-continuation.v1", "imported-design-review.v1", "imported-execution.v1", "imported-execution-review.v1", "imported-validation.v1",
      "product.source.recovery.v1", SOURCE_CLEAN_RESTART_FEATURE_V1, IMPORTED_CLEAN_VALIDATION_FEATURE_V1, IMPORTED_CLEAN_VALIDATION_REVIEW_FEATURE_V1, PRODUCT_RELEASE_CLEAN_FEATURE_V1,
      "imported-recovery-validation.v1", "imported-recovery-validation-review.v1"].includes(feature));
  if (advertisedVerificationProfiles.length) {
    configuredFeatures.push(VERIFICATION_FEATURE, PRODUCT_STAGE_VERIFICATION_FEATURE);
    if (advertisedVerificationProfiles.some((profile) => profile.capabilities)) configuredFeatures.push(VERIFICATION_CAPABILITIES_FEATURE);
    if (advertisedVerificationProfiles.some((profile) => profile.measurement_plan_policy?.version === 1)) configuredFeatures.push(MEASUREMENT_PLAN_FEATURE);
    if (advertisedVerificationProfiles.some((profile) => profile.measurement_plan_policy?.version === 2)) configuredFeatures.push(MEASUREMENT_PLAN_V2_FEATURE);
    if (advertisedVerificationProfiles.some(productDesignRevisionVerificationSupported)) configuredFeatures.push(PRODUCT_DESIGN_REVISION_FEATURE_V1);
    hello.verification_profiles = advertisedVerificationProfiles.map((profile) => Object.freeze({
      profile_id: profile.id, project_id: profile.project_id, workspace_root: profile.workspace_root,
      ...(profile.capabilities ? { capabilities: profile.capabilities } : {}),
    }));
    Object.freeze(hello.verification_profiles);
  }
  if (advertisedReleaseProfiles.length) {
    configuredFeatures.push(PRODUCT_RELEASE_FEATURE, PRODUCT_RELEASE_RETRY_FEATURE_V1);
    if (advertisedReleaseProfiles.some((profile) => profile.monitoring)) configuredFeatures.push(PRODUCT_RELEASE_HEALTH_FEATURE);
    if (advertisedReleaseProfiles.some((profile) => profile.criterion_acceptance)) configuredFeatures.push(PRODUCT_RELEASE_ACCEPTANCE_FEATURE);
    hello.release_profiles = advertisedReleaseProfiles.map((profile) => {
      const capabilities = readReleaseCapabilities(profile);
      return Object.freeze({ profile_id: profile.id, project_id: profile.project_id, workspace_root: profile.verifier.workspace_root,
        verification_profile_id: profile.verifier.id, target_kind: "static_site" as const, ...(capabilities ? { capabilities } : {}) });
    });
    Object.freeze(hello.release_profiles);
  }
  if (hello.execution_features !== undefined || configuredFeatures.length) hello.execution_features = configuredFeatures;
  if (hello.execution_features) Object.freeze(hello.execution_features);
  Object.freeze(hello.machine);
  if (hello.managed_receipts) Object.freeze(hello.managed_receipts);
  Object.freeze(hello);
  let transport: ReturnType<typeof createWebSocketTransport> | null = null;
  let client: ReturnType<typeof createNodeClient> | null = null;
  let source: ReturnType<typeof prepareProductSourceNode> | undefined;
  let cleanLifecycle: PreparedCleanDaemonConfiguration | undefined;
  let sourceAttempted = false, sessionInvalidated = false;
  let shutdown: Promise<void> | undefined;
  let resolveExecution: (() => void) | undefined, rejectExecution: ((error: Error) => void) | undefined;
  const executionReady = sourceFile === undefined || !options.requireSupervisorLifetime ? undefined : new Promise<void>((resolve, reject) => {
    resolveExecution = resolve; rejectExecution = reject;
  });
  // Ordinary callers need not wait for this optional lifecycle signal.
  void executionReady?.catch(() => {});
  let reportFailure!: (error: Error) => void;
  const failed = sourceFile === undefined ? undefined : new Promise<Error>(resolve => {
    reportFailure = error => { rejectExecution?.(error); resolve(error); };
  });

  function stop(): Promise<void> {
    if (shutdown) return shutdown;
    sessionInvalidated = true;
    rejectExecution?.(new Error("Source execution stopped before current-session registration completed"));
    shutdown = (async () => {
      const activeTransport = transport;
      if (!activeTransport?.connected) await observeWindowsStopStage("transport_close", () => activeTransport?.close());
      const deadline = setTimeout(() => { void activeTransport?.close(); }, 8000);
      try {
        await client?.stop(true);
        // Failure or uncertain closure keeps the runtime owner and workspace claims.
        recordWindowsStopDiagnostic("source_close", "entered");
        try { source?.close(); recordWindowsStopDiagnostic("source_close", "completed"); }
        catch (error) { recordWindowsStopDiagnostic("source_close", "failed", error); throw error; }
        source = undefined;
      } finally {
        clearTimeout(deadline);
        await observeWindowsStopStage("transport_close", () => activeTransport?.close());
        client = null; transport = null;
      }
    })();
    return shutdown;
  }

  return {
    ...(failed ? { failed } : {}),
    ...(executionReady ? { executionReady } : {}),
    async start(): Promise<void> {
      if (sourceFile !== undefined && sessionInvalidated) throw new Error("Product source session ended; construct a new node after recovery");
      if (transport !== null && client !== null) {
        await transport.ready;
        return;
      }
      if (sourceFile !== undefined && sourceAttempted) throw new Error("Product source session ended; construct a new node after recovery");
      shutdown = undefined;
      sessionInvalidated = false;
      // A local installation changed between construction and start must not
      // publish a previously qualified hello or open an execution connection.
      if (windowsBackend !== undefined) {
        assertWindowsProcessBackend(windowsBackend);
        for (const profile of advertisedVerificationProfiles) {
          if (readWindowsVerificationBackend(profile) !== windowsBackend) throw new Error("Windows verification binding changed before startup");
        }
      }
      if (sourceFile !== undefined) {
        sourceAttempted = true;
        try {
          // An internal selector is not authority. Reject an ordinary source
          // configuration before its preparation could acquire owner.lock.
          if (options.requireSupervisorLifetime && !prepareProductSourceConfiguration({ file: sourceFile,
            allowedRoots: options.workspace!.allowedRoots! }).config.recovery) throw Error("Supervised execution requires recovery configuration");
          source = prepareProductSourceNode({ file: sourceFile, url: options.url, nodeId: hello.node_id,
            allowedRoots: options.workspace!.allowedRoots!, windowsBackend: windowsBackend!, profiles: verificationProfiles,
            releaseProfiles, research: options.research, acknowledgeRunEvents: options.acknowledgeRunEvents === true });
          const prepared = source;
          if (prepared.recoveryRequired) {
            const supervisor = await prepareWindowsDaemonSupervisorAuthority(windowsBackend!, { requireLifetime: options.requireSupervisorLifetime === true });
            if (sessionInvalidated || source !== prepared) throw Error("Source startup stopped during native qualification");
            prepared.qualifyRecovery(supervisor);
            cleanLifecycle = options.prepareCleanLifecycle?.(supervisor);
          } else if (options.requireSupervisorLifetime) throw Error("Supervised execution requires recovery configuration");
        } catch (error) {
          rejectExecution?.(error instanceof Error ? error : Error("Source startup failed"));
          throw error;
        }
      }
      // In registry mode, default to a heartbeat that advertises the registered
      // runtimes' capability tags (so the server learns runtime capabilities for
      // scheduling). An explicit `heartbeat` option overrides this escape hatch.
      const heartbeat =
        options.heartbeat ??
        (options.registry
          ? createRegistryHeartbeat({ nodeId: hello.node_id, registry: options.registry })
          : undefined);
      const connectionHello: NodeHello = source ? { ...hello, execution_features: [...(hello.execution_features ?? [])] } : hello;
      try {
        transport = createWebSocketTransport({
          url: options.url,
          hello: connectionHello,
          heartbeat,
          heartbeatIntervalMs: options.heartbeatIntervalMs,
          acknowledgeRunEvents: options.acknowledgeRunEvents,
          reconnectDelayMs: options.reconnectDelayMs,
          reconnect: source === undefined,
          onFatalDisconnect: () => {
            if (sourceFile === undefined) { void client?.stop(true); return; }
            sessionInvalidated = true;
            reportFailure(new Error("Product source connection ended; in-process continuation authority cannot resume on a new session"));
            void stop().catch(error => { reportFailure(error instanceof Error ? error : new Error("Product source shutdown failed")); });
          },
          onConnected: () => { void client?.replayReleaseHealth().catch(() => {}); },
          WebSocketImpl: options.WebSocketImpl
        });
        // Observe early connection rejection even if controller construction fails.
        const connectionReady = transport.ready.then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
        client = createNodeClient({
          nodeId: hello.node_id,
          transport,
          adapter: options.adapter,
          registry: options.registry,
          workspace: options.workspace,
          git: options.git,
          uploadArtifact: options.uploadArtifact,
          verificationProfiles, releaseProfiles,
          sourceCommandDiagnostic: options.sourceCommandDiagnostic,
          releaseRetrySession: () => {
            if (sessionInvalidated || !transport?.connected) return undefined;
            source?.assertCurrent(); return transport.currentSessionIdentity();
          },
          ...(source ? {
            ...(source.recoveryConfiguration ? { productSourceRecovery: { configuration: source.recoveryConfiguration, features: source.features,
              ...(cleanLifecycle ? { cleanLifecycle } : {}),
              replaySession: () => sessionInvalidated || !transport?.connected ? undefined : transport.currentSessionIdentity(),
              isCurrent: () => {
                if (sessionInvalidated || !transport?.connected || !source) return false;
                source.assertCurrent(); return true;
              },
              onFailure: (error: Error) => {
                sessionInvalidated = true; reportFailure(error);
                void stop().catch(cause => { reportFailure(cause instanceof Error ? cause : new Error("Recovery shutdown failed")); });
              },
              ...(executionReady ? { onReady: () => {
                if (sessionInvalidated || !transport?.connected || !source) throw Error("Source readiness lost its original session");
                resolveExecution?.();
              } } : {}),
              activate: (runtime: Parameters<ReturnType<typeof prepareProductSourceNode>["activateRecovery"]>[0]) => {
                if (sessionInvalidated || !transport?.connected || !source) throw Error("Recovery activation lost the current source session");
                return source.activateRecovery(runtime);
              } } } : { productSourceRuntime: source.runtime }),
            ...(source.semanticClient ? { productSourceOperations: { client: source.semanticClient,
              isCurrent: () => {
                if (sessionInvalidated || !transport?.connected || !source) return false;
                source.assertCurrent(); return true;
              }, importedReview: source.importedReview, importedDesign: source.importedDesign, importedDesignReview: source.importedDesignReview, importedExecution: source.importedExecution, importedExecutionReview: source.importedExecutionReview, importedValidation: source.importedValidation } } : {}) } : {})
        });
        if (source) {
          source.assertDiscovery();
          const features = client.productSourceFeatures?.();
          if (!features) throw new Error("Product source controller discovery is unavailable");
          connectionHello.execution_features = Object.freeze([...(hello.execution_features ?? []), ...features]) as string[];
          connectionHello.product_source_routing = source.routing;
          Object.freeze(connectionHello);
        }
        // Subscribe before the connection is registered for dispatch (server only
        // dispatches after node.hello), then wait for open + hello.
        client.start();
        await client.ready();
        const connection = await connectionReady;
        if (!connection.ok) throw connection.error;
        if (source && !source.recoveryRequired) resolveExecution?.();
      } catch (err) {
        try { await stop(); }
        catch (cleanup) { throw new AggregateError([err, cleanup], "Node startup failed and closure is uncertain"); }
        throw err;
      }
    },
    stop,
  };
}
