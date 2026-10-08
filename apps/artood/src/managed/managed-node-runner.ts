import type { NodeHeartbeat, NodeHello } from "@artoo/protocol";
import type { Journal } from "./journal-types.js";
import { createNodeClient, type NodeClientOptions } from "../node-client.js";
import { createManagedWebSocketTransport, type ManagedWebSocketTransport } from "./managed-ws-transport.js";
import { DeliveryStopped, monotonicMs, type RunDeliveryMode } from "./managed-delivery.js";
import { isOwnedRunAdapter } from "../process-adapter.js";
import { createRegistryHeartbeat } from "../heartbeat.js";

export interface ManagedNodeRunnerOptions extends Omit<NodeClientOptions, "transport" | "managedJournal" | "nodeId"> {
  url: string; hello: NodeHello; journal: Journal; WebSocketImpl?: typeof WebSocket;
  heartbeat?: () => NodeHeartbeat; heartbeatIntervalMs?: number; reconnectDelayMs?: number;
  /** Explicit local choice; absent retains the managed-only composition. */
  mixed?: { readonly allowNewAllocations: boolean };
}
export interface ManagedNodeRunner {
  start(): Promise<void>;
  /** Joins genuine physical cleanup. Caller separately owns journal.close(). */
  stop(): Promise<void>;
  /** Explicit local user action, scoped to this Node's owned managed run. */
  requestStop(runId: string): Promise<void>;
  readonly link: ManagedWebSocketTransport;
  /** Resolves at the first unexpected failure, before its cleanup starts. */
  readonly failed: Promise<Error>;
  readonly failure: Error | undefined;
  readonly lossDeadlineTickMs: number | undefined;
}

/** Qualified Node composition. Its caller separately owns the journal lifetime. */
export function createManagedNodeRunner(options: ManagedNodeRunnerOptions): ManagedNodeRunner {
  if (!options.workspace?.allowedRoots?.length
    || (options.mixed?.allowNewAllocations !== false && !options.workspace.worktreeBaseRepo)) {
    throw new Error("Managed node requires explicit local workspace configuration");
  }
  const adapters = options.registry ? options.registry.runtimes().map((entry) => options.registry!.resolve(entry.runtime)) : [options.adapter];
  if (!adapters.length || adapters.some((adapter) => !adapter || !isOwnedRunAdapter(adapter))) throw new Error("Managed allocation feature requires genuine owned process adapters");
  let lossDeadline: number | undefined, lossCause: Error | undefined, lossTimer: ReturnType<typeof setTimeout> | undefined;
  let failure: Error | undefined, failureWork: Promise<void> | undefined, failureClose: Promise<void> | undefined, stopWork: Promise<void> | undefined;
  let stoppingLossClose: Promise<void> | undefined;
  let starting: Promise<void> | undefined, stopping = false;
  let resolveFailure!: (error: Error) => void;
  const failed = new Promise<Error>((resolve) => { resolveFailure = resolve; });
  // Receipt negotiation is independent of fresh-allocation capability. A
  // prepared opt-out keeps its qualified session and historical recovery.
  const hello: NodeHello = { ...options.hello,
    execution_features: options.mixed?.allowNewAllocations === false ? [] : ["workspace-allocation.per-run-v1"] };
  const link = createManagedWebSocketTransport({ url: options.url, namespace: options.journal.namespace, hello,
    WebSocketImpl: options.WebSocketImpl,
    allowLegacyRuns: options.mixed !== undefined,
    heartbeat: options.heartbeat ?? (options.registry ? createRegistryHeartbeat({ nodeId: hello.node_id, registry: options.registry }) : undefined),
    heartbeatIntervalMs: options.heartbeatIntervalMs, reconnectDelayMs: options.reconnectDelayMs,
    onSessionLost(error, previous) {
      client.invalidateManagedStartupSession(previous, error);
      if (stopping) {
        // lose() has not scheduled its reconnect yet. Close synchronously so a
        // requested Stop cannot create another generation and a synthetic fatal.
        if (!stoppingLossClose) {
          try { stoppingLossClose = link.close(); }
          catch (cause) { stoppingLossClose = Promise.reject(cause); }
          void stoppingLossClose.catch((cause: unknown) => latchFailure(cause instanceof Error ? cause : new Error(String(cause))));
        }
        return;
      }
      if (failure || lossDeadline !== undefined) return;
      lossCause = error; lossDeadline = monotonicMs() + 30000;
      lossTimer = setTimeout(expireLoss, 30000);
    },
    onSessionUsable() {
      if (stopping || failure) return false;
      if (lossDeadline !== undefined && monotonicMs() >= lossDeadline) { expireLoss(); return false; }
      clearTimeout(lossTimer); lossTimer = undefined; lossDeadline = undefined; lossCause = undefined;
      return true;
    },
    onFatal: fail,
  });
  const client = createNodeClient({ ...options, nodeId: hello.node_id, transport: link.transport,
    managedJournal: { journal: options.journal, channel: link.channel,
      ...(options.mixed ? { mixed: { allowNewAllocations: options.mixed.allowNewAllocations,
        bindRun: (runId: string, mode: RunDeliveryMode) => link.bindRun(runId, mode) } } : {}) } });
  function latchFailure(cause: Error): void {
    if (!failure) { failure = cause; resolveFailure(cause); }
  }
  function fail(cause: Error): void {
    if (failure) return;
    latchFailure(cause); clearTimeout(lossTimer);
    // The async method latches every owned run's cause and cancels its waits
    // synchronously before its first awaited genuine stop/database operation.
    failureWork = client.failManagedConnection(cause);
    void failureWork.catch(() => {}); // Joined by stop(); never treated as success.
    try { failureClose = link.close(); }
    catch (error) { failureClose = Promise.reject(error); }
    void failureClose.catch(() => {}); // Joined by stop(), including a failed socket close.
  }
  function expireLoss(): void {
    if (lossDeadline === undefined || stopping || failure) return;
    if (monotonicMs() < lossDeadline) { lossTimer = setTimeout(expireLoss, lossDeadline - monotonicMs()); return; }
    fail(new DeliveryStopped(`Managed session-loss grace expired: ${lossCause?.message ?? "peer unavailable"}`));
  }
  return {
    link, failed,
    requestStop(runId) { return client.requestManagedRunStop(runId); },
    get failure() { return failure; },
    get lossDeadlineTickMs() { return lossDeadline; },
    start() {
      if (stopping || failure) return Promise.reject(failure ?? new DeliveryStopped("Managed node was stopped"));
      if (starting) return starting;
      let ready = link.ready;
      try {
        client.start(); // Business subscription exists before the first socket.
        link.start();
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        fail(error); ready = Promise.reject(error);
      }
      starting = ready.catch(async (cause: unknown) => {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        if (!stopping) fail(error); // Closing during an intentional Stop rejects ready too.
        try { await failureWork; }
        catch (cleanup) { throw new AggregateError([error, cleanup], `${error.message}; managed producer cleanup also failed`, { cause: error }); }
        throw error;
      });
      return starting;
    },
    stop() {
      if (stopWork) return stopWork;
      stopping = true; clearTimeout(lossTimer);
      stopWork = (async () => {
        const errors: Error[] = [];
        const remember = (cause: unknown): void => {
          const error = cause instanceof Error ? cause : new Error(String(cause));
          if (!errors.includes(error)) errors.push(error);
          latchFailure(error);
        };
        const join = async (work: () => Promise<void>): Promise<void> => { try { await work(); } catch (error) { remember(error); } };
        if (!link.connected) await join(() => link.close());
        let graceClose: Promise<void> | undefined;
        const grace = setTimeout(() => {
          graceClose = Promise.resolve().then(() => link.close());
          void graceClose.catch(remember);
        }, 8000);
        try {
          await join(() => client.stop(true));
          // Closing releases remaining receipt waiters even when physical Stop
          // reported uncertainty. Join them before the caller closes SQLite.
          await join(() => link.close());
          if (failureWork) await join(() => failureWork!);
          if (failureClose) await join(() => failureClose!);
          if (stoppingLossClose) await join(() => stoppingLossClose!);
          await join(() => client.stop());
          if (graceClose) await join(() => graceClose!);
        } finally { clearTimeout(grace); }
        if (errors.length === 1) throw errors[0];
        if (errors.length) throw new AggregateError(errors, `${errors[0]?.message}; additional managed runner cleanup failures`, { cause: errors[0] });
      })();
      return stopWork;
    },
  };
}
