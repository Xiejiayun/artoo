import { createServer } from "node:http";
import type { Socket } from "node:net";
import { createApplicationService } from "./application-service.js";
import { createApplicationHttpIngress, APPLICATION_HTTP_LIMITS, readApplicationHttpCounters, subscribeApplicationHttpCounters,
  readApplicationPublicationHttpControl, type ApplicationHttpInvocation } from "./application-http-ingress.js";
import { readApplicationBootstrapPublication, type PreparedApplicationBootstrapAdmission } from "./application-bootstrap-admission.js";
import type { ApplicationPublicationCounters } from "./application-publication-process-protocol.js";
import { ApplicationPublicationQuiescenceSchema, type ApplicationPublicationQuiescence } from "./application-publication-control-protocol.js";
import type { ApplicationPublicationHostOperations } from "./application-publication-bootstrap-control.js";
import { startApplicationBrokerProcess, type ApplicationBrokerProcess, type ApplicationBrokerProcessReceipt } from "./application-broker-process.js";
import { revokeApplicationClientReader, type ApplicationClientReader } from "./application-artifact-admission.js";
import { describeApplicationServiceProfile, assertApplicationServiceOpenStore, prepareProfileApplicationBroker, prepareProfileApplicationRuntime, prepareProfileApplicationClient,
  type PreparedApplicationServiceProfile, type ApplicationServiceBinding } from "./application-service-profile.js";

/** Explicit first creation only. A failed initialization is retained, never
 * deleted, overwritten or adopted by an automatic create/open fallback. */
export async function initializeApplicationStore(profile: PreparedApplicationServiceProfile, signal?: AbortSignal): Promise<ApplicationBrokerProcessReceipt> {
  return openAndCloseApplicationStore(profile, "create", "initialization", signal);
}

/** Validate an existing SQLite store through its original broker, without a
 * product invocation or listener. Missing/invalid stores never fall back to create. */
export async function checkExistingApplicationStore(profile: PreparedApplicationServiceProfile, signal?: AbortSignal): Promise<ApplicationBrokerProcessReceipt> {
  return openAndCloseApplicationStore(profile, "open", "preflight", signal);
}

async function openAndCloseApplicationStore(profile: PreparedApplicationServiceProfile, mode: "create" | "open",
  operation: "initialization" | "preflight", signal?: AbortSignal): Promise<ApplicationBrokerProcessReceipt> {
  let broker: ApplicationBrokerProcess | undefined;
  let cancellation: Promise<ApplicationBrokerProcessReceipt> | undefined;
  const cancel = () => {
    const owner = broker;
    if (owner && !cancellation) {
      cancellation = Promise.resolve().then(() => owner.cancel());
      void cancellation.catch(() => {}); // The exact outcome is retained by failure cleanup below.
    }
  };
  try {
    if (signal?.aborted) throw Error(`Application store ${operation} cancelled`);
    const prepared = prepareProfileApplicationBroker(profile, mode);
    if (signal?.aborted) throw Error(`Application store ${operation} cancelled`);
    broker = startApplicationBrokerProcess(prepared);
    signal?.addEventListener("abort", cancel, { once: true }); if (signal?.aborted) cancel();
    await broker.ready;
    if (signal?.aborted) throw Error(`Application store ${operation} cancelled`);
    const receipt = await broker.stop();
    if (!receipt.normalShutdown || signal?.aborted) throw Error(`Application store ${operation} did not close normally`);
    return receipt;
  } catch (error) {
    if (!broker) throw error;
    cancel();
    const cleanup = await Promise.allSettled([cancellation!, broker.closed]);
    // Keep both exact original observations, including a failed/uncertain receipt.
    throw Object.assign(Error(`Application store ${operation} failed; store retained`, { cause: error }), { cleanup });
  } finally { signal?.removeEventListener("abort", cancel); }
}

export interface LocalApplicationService {
  readonly origin: string;
  /** Listener, transports and every original invocation settlement were awaited.
   * This host lifecycle promise is not a serialized native receipt. */
  readonly closed: Promise<void>;
  /** Stop admission, preserve accepted requests and await their normal original
   * closure. A later close/failure can still cancel this same drain. */
  drain(): Promise<void>;
  /** Stop admission and cancel outstanding work; still await original closure. */
  close(): Promise<void>;
}
export interface ApplicationLocalServiceClosure {
  readonly version: 1; readonly invocations: number; readonly runtime_normal_closures: number;
  readonly broker_normal_closures: number; readonly listener_closed: true;
}
const normalClosures = new WeakMap<object, () => ApplicationLocalServiceClosure>();
const publicationControls = new WeakMap<object, ApplicationPublicationHostOperations>();
export function readApplicationLocalPublicationControl(service: LocalApplicationService): ApplicationPublicationHostOperations {
  const control = publicationControls.get(service); if (!control) throw Error("Original controlled publication listener required"); return control;
}
const counterReaders = new WeakMap<object, { read(): ApplicationPublicationCounters;
  subscribe(listener: (counters: ApplicationPublicationCounters) => void): () => void }>();
export function readApplicationLocalServiceCounters(service: LocalApplicationService): ApplicationPublicationCounters {
  const saved = counterReaders.get(service); if (!saved) throw Error("Original application listener required"); return saved.read();
}
export function subscribeApplicationLocalServiceCounters(service: LocalApplicationService, listener: (counters: ApplicationPublicationCounters) => void): () => void {
  const saved = counterReaders.get(service); if (!saved) throw Error("Original application listener required"); return saved.subscribe(listener);
}
/** An original closed listener owns this observation; a copied service or JSON
 * cannot supply the normal native-closure counts used by application verification. */
export function readApplicationLocalServiceClosure(service: LocalApplicationService): ApplicationLocalServiceClosure {
  const read = normalClosures.get(service); if (!read) throw Error("Original application listener required"); return read();
}

/** A bounded loopback application API. Installation and database creation are
 * separate commands; each request opens the existing store under its fixed profile. */
export async function startLocalApplicationService(profile: PreparedApplicationServiceProfile, publication?: PreparedApplicationBootstrapAdmission): Promise<LocalApplicationService> {
  const binding = describeApplicationServiceProfile(profile);
  assertApplicationServiceOpenStore(profile); // Metadata/admission only, before binding a listener.
  const clientReader = binding.sameOrigin ? prepareProfileApplicationClient(profile) : undefined;
  // A client authority must also close if construction fails before a listener
  // exists. Once created, the ingress/listener lifetime owns its single revoke.
  try { return await startBoundLocalApplicationService(profile, binding, clientReader, publication); }
  catch (error) {
    if (clientReader) revokeApplicationClientReader(clientReader);
    throw error;
  }
}
async function startBoundLocalApplicationService(profile: PreparedApplicationServiceProfile,
  binding: ApplicationServiceBinding, clientReader: ApplicationClientReader | undefined, publication?: PreparedApplicationBootstrapAdmission): Promise<LocalApplicationService> {
  let successfulInvocations = 0, normallyClosed = false;
  const service = createApplicationService({ maximumAccess: binding.maximumAccess,
    prepareRuntime: () => prepareProfileApplicationRuntime(profile), prepareBroker: () => prepareProfileApplicationBroker(profile, "open"),
    observeNormalClosure: () => { successfulInvocations++; } });
  const handles: ApplicationHttpInvocation[] = [], transports = new Set<Promise<void>>(), sockets = new Set<Socket>();
  const requestSockets = new Set<Socket>(), socketClosures = new Map<Socket, Promise<void>>();
  const headerTimers = new Map<Socket, ReturnType<typeof setTimeout>>();
  const clearHeaderTimer = (socket: Socket) => {
    const timer = headerTimers.get(socket);
    if (timer !== undefined) { clearTimeout(timer); headerTimers.delete(socket); }
  };
  const failures: unknown[] = [];
  const ingress = createApplicationHttpIngress({ origin: binding.origin, purpose: "application", access: binding.maximumAccess,
    timeoutMs: binding.timeoutMs, maximumConcurrent: 1, readOnlyGet: true,
    ...(clientReader ? { clientReader } : {}),
    ...(publication ? { publication } : {}),
    service: { maximumAccess: service.maximumAccess, begin(action, signal) {
      const handle = service.begin(action, signal); handles.push(handle); return handle;
    } } });
  const publicationControl = publication && readApplicationBootstrapPublication(publication)?.control
    ? readApplicationPublicationHttpControl(ingress) : undefined;
  let quiescent = false;
  let stopping = false, listened = false, cancelled = false, closeWork: Promise<void> | undefined, drainWork: Promise<void> | undefined;
  let resolveClosed!: () => void, rejectClosed!: (error: unknown) => void;
  const closed = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; }); void closed.catch(() => {});
  const server = createServer({ maxHeaderSize: APPLICATION_HTTP_LIMITS.headerBytes, insecureHTTPParser: false }, (request, response) => {
    clearHeaderTimer(request.socket); // The parser has delivered complete headers.
    if (stopping || publicationControl?.mode === "paused") { response.destroy(); return; }
    requestSockets.add(request.socket);
    const work = ingress.handle(request, response); transports.add(work);
    void work.then(() => { transports.delete(work); requestSockets.delete(request.socket); }, error => {
      transports.delete(work); requestSockets.delete(request.socket); failures.push(error); void stop(true).catch(() => {});
    });
  });
  // Preserve all raw headers for ingress's count/duplicate checks. The parser's
  // independent byte ceiling bounds allocation; maxHeadersCount=64 would truncate.
  server.maxHeadersCount = 0;
  server.maxConnections = 16;
  server.headersTimeout = Math.min(5_000, binding.timeoutMs);
  server.requestTimeout = binding.timeoutMs;
  server.keepAliveTimeout = 1;
  server.maxRequestsPerSocket = 1;
  server.on("connection", socket => {
    if (stopping || publicationControl?.mode === "paused" || sockets.size >= 16) { socket.destroy(); return; }
    sockets.add(socket);
    socketClosures.set(socket, new Promise<void>(resolve => socket.once("close", resolve)));
    // Node checks headersTimeout on a periodic connection scan (30 seconds by
    // default). Enforce this phase directly, without extending it on new bytes.
    headerTimers.set(socket, setTimeout(() => socket.destroy(), Math.min(5_000, binding.timeoutMs)));
    // Absolute connection lifetime, not a sliding inactivity timer. It includes
    // header-only connections and never extends the original ingress deadline.
    const timer = setTimeout(() => socket.destroy(), binding.timeoutMs + 5_000);
    socket.once("close", () => { clearHeaderTimer(socket); clearTimeout(timer); sockets.delete(socket); socketClosures.delete(socket); });
    socket.on("error", () => socket.destroy());
  });
  server.on("checkContinue", (_request, response) => response.destroy());
  server.on("checkExpectation", (_request, response) => response.destroy());
  server.on("upgrade", (_request, socket) => socket.destroy());
  server.on("connect", (_request, socket) => socket.destroy());
  server.on("clientError", (_error, socket) => socket.destroy());
  const serverError = (error: Error) => { if (listened) { failures.push(error); void stop(true).catch(() => {}); } };
  server.on("error", serverError);

  function stop(cancel: boolean): Promise<void> {
    stopping = true; quiescent = false;
    if (cancel && !cancelled) {
      cancelled = true; ingress.close();
      // Transport termination forwards the same cancellation; it never settles
      // the original owner's promise or proves a database rollback.
      for (const socket of sockets) socket.destroy();
    }
    if (closeWork) return closeWork;
    closeWork = (async () => {
      try {
      const listener = new Promise<void>((resolve, reject) => {
        server.close(error => {
          if (error && (listened || (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING")) reject(error); else resolve();
        });
        server.closeIdleConnections();
      });
      // The final admitted request may still be reading its body when the budget
      // stops admission. First await every transport's begin-creation path, then
      // capture the complete original-owner set. Listener failure cannot skip it.
      const transportOutcomes = await Promise.allSettled([listener, ...transports]);
      const ownerOutcomes = await Promise.allSettled(handles.map(handle => handle.settled));
      const outcomes = [...transportOutcomes, ...ownerOutcomes];
      const errors = [...failures, ...outcomes.flatMap(result => result.status === "rejected" ? [result.reason] : [])];
      if (errors.length) throw new AggregateError(errors, "Application listener or original owner closure failed");
      normallyClosed = true;
      } finally {
        // Budget exhaustion drains its last admitted asset/API request before
        // revocation. Failed closure still relinquishes the same client reader.
        if (clientReader) revokeApplicationClientReader(clientReader);
      }
    })();
    void closeWork.then(resolveClosed, rejectClosed); return closeWork;
  }
  void ingress.admissionFailed.then(() => {
    failures.push(Error("Application ingress failed closed"));
    void stop(true).catch(() => {});
  });
  void ingress.admissionStopped.then(reason => {
    // A lifetime-budget stop drains the last admitted request without cancelling
    // it. A later explicit close can still escalate that same shutdown.
    void stop(reason !== "budget_exhausted" && reason !== "draining").catch(() => {});
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const error = (failure: Error) => { server.off("listening", ready); reject(failure); };
      const ready = () => { listened = true; server.off("error", error); resolve(); };
      server.once("error", error); server.once("listening", ready);
      server.listen({ host: "127.0.0.1", port: binding.port, exclusive: true });
    });
    const readNormalClosure = () => {
      if (!normallyClosed || successfulInvocations !== handles.length) throw Error("Application invocation normal closure is incomplete");
      return Object.freeze({ version: 1 as const, invocations: handles.length, runtime_normal_closures: successfulInvocations,
        broker_normal_closures: successfulInvocations, listener_closed: true as const });
    };
    const drain = () => {
      ingress.drain(); // Synchronous admission stop, before returning to the caller.
      if (!drainWork) {
        drainWork = stop(false).then(() => {
          if (cancelled) throw Error("Application normal drain was cancelled");
          readNormalClosure();
        });
        void drainWork.catch(() => {}); // The original result is still returned to the caller.
      }
      return drainWork;
    };
    const result = Object.freeze({ origin: binding.origin, closed, drain, close: () => stop(true) });
    normalClosures.set(result, readNormalClosure);
    counterReaders.set(result, { read: () => readApplicationHttpCounters(ingress),
      subscribe: listener => subscribeApplicationHttpCounters(ingress, listener) });
    if (publicationControl) {
      const pause = (): Promise<ApplicationPublicationQuiescence> => {
        if (stopping) throw Error("Original publication listener is stopping");
        publicationControl.pause(); quiescent = false; // Synchronous before capturing any asynchronous joins.
        const connections = [...socketClosures.entries()];
        for (const [socket] of connections) if (!requestSockets.has(socket)) socket.destroy();
        return (async () => {
          // Body admission can create its owner after pause. First join its
          // transport path, then capture every original runtime/broker handle.
          const transportOutcomes = await Promise.allSettled([...transports]);
          const ownerOutcomes = await Promise.allSettled(handles.map(handle => handle.settled));
          for (const [socket] of connections) socket.destroy();
          const connectionOutcomes = await Promise.allSettled(connections.map(([, ended]) => ended));
          const errors = [...failures, ...[...transportOutcomes, ...ownerOutcomes, ...connectionOutcomes]
            .flatMap(outcome => outcome.status === "rejected" ? [outcome.reason] : [])];
          if (errors.length) throw new AggregateError(errors, "Original publication quiescence has unsettled transports or owners");
          if (stopping || publicationControl.mode !== "paused" || successfulInvocations !== handles.length)
            throw Error("Original publication quiescence was interrupted or owner closure is unconfirmed");
          const proof = ApplicationPublicationQuiescenceSchema.parse({ counters: readApplicationHttpCounters(ingress),
            closure: { version: 1, scope: "original-native-owners", invocations: handles.length,
              runtime_normal_closures: successfulInvocations, broker_normal_closures: successfulInvocations } });
          quiescent = true; return proof;
        })();
      };
      publicationControls.set(result, Object.freeze({ pause,
        probe(path: string, nonce: string): Promise<ApplicationPublicationQuiescence> {
          if (!quiescent || stopping) throw Error("Original publication probe requires completed quiescence");
          quiescent = false;
          const settled = publicationControl.probe(path, nonce);
          return settled.then(() => pause());
        },
        resume() {
          if (!quiescent || stopping) throw Error("Original publication resume requires completed quiescence");
          publicationControl.resume(); quiescent = false;
        }, drain,
      }));
    }
    return result;
  } catch (error) {
    const cleanup = await Promise.allSettled([stop(true)]);
    throw Object.assign(Error("Application listener startup failed", { cause: error }), { cleanup });
  }
}
