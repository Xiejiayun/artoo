import { createServer } from "node:http";
import type { Socket } from "node:net";
import { createApplicationService } from "./application-service.js";
import { createApplicationHttpIngress, APPLICATION_HTTP_LIMITS, type ApplicationHttpInvocation } from "./application-http-ingress.js";
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
  close(): Promise<void>;
}
export interface ApplicationLocalServiceClosure {
  readonly version: 1; readonly invocations: number; readonly runtime_normal_closures: number;
  readonly broker_normal_closures: number; readonly listener_closed: true;
}
const normalClosures = new WeakMap<object, () => ApplicationLocalServiceClosure>();
/** An original closed listener owns this observation; a copied service or JSON
 * cannot supply the normal native-closure counts used by application verification. */
export function readApplicationLocalServiceClosure(service: LocalApplicationService): ApplicationLocalServiceClosure {
  const read = normalClosures.get(service); if (!read) throw Error("Original application listener required"); return read();
}

/** A bounded loopback application API. Installation and database creation are
 * separate commands; each request opens the existing store under its fixed profile. */
export async function startLocalApplicationService(profile: PreparedApplicationServiceProfile): Promise<LocalApplicationService> {
  const binding = describeApplicationServiceProfile(profile);
  assertApplicationServiceOpenStore(profile); // Metadata/admission only, before binding a listener.
  const clientReader = binding.sameOrigin ? prepareProfileApplicationClient(profile) : undefined;
  // A client authority must also close if construction fails before a listener
  // exists. Once created, the ingress/listener lifetime owns its single revoke.
  try { return await startBoundLocalApplicationService(profile, binding, clientReader); }
  catch (error) {
    if (clientReader) revokeApplicationClientReader(clientReader);
    throw error;
  }
}
async function startBoundLocalApplicationService(profile: PreparedApplicationServiceProfile,
  binding: ApplicationServiceBinding, clientReader: ApplicationClientReader | undefined): Promise<LocalApplicationService> {
  let successfulInvocations = 0, normallyClosed = false;
  const service = createApplicationService({ maximumAccess: binding.maximumAccess,
    prepareRuntime: () => prepareProfileApplicationRuntime(profile), prepareBroker: () => prepareProfileApplicationBroker(profile, "open"),
    observeNormalClosure: () => { successfulInvocations++; } });
  const handles: ApplicationHttpInvocation[] = [], transports = new Set<Promise<void>>(), sockets = new Set<Socket>();
  const headerTimers = new Map<Socket, ReturnType<typeof setTimeout>>();
  const clearHeaderTimer = (socket: Socket) => {
    const timer = headerTimers.get(socket);
    if (timer !== undefined) { clearTimeout(timer); headerTimers.delete(socket); }
  };
  const failures: unknown[] = [];
  const ingress = createApplicationHttpIngress({ origin: binding.origin, purpose: "application", access: binding.maximumAccess,
    timeoutMs: binding.timeoutMs, maximumConcurrent: 1, readOnlyGet: true,
    ...(clientReader ? { clientReader } : {}),
    service: { maximumAccess: service.maximumAccess, begin(action, signal) {
      const handle = service.begin(action, signal); handles.push(handle); return handle;
    } } });
  let stopping = false, listened = false, cancelled = false, closeWork: Promise<void> | undefined;
  let resolveClosed!: () => void, rejectClosed!: (error: unknown) => void;
  const closed = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; }); void closed.catch(() => {});
  const server = createServer({ maxHeaderSize: APPLICATION_HTTP_LIMITS.headerBytes, insecureHTTPParser: false }, (request, response) => {
    clearHeaderTimer(request.socket); // The parser has delivered complete headers.
    if (stopping) { response.destroy(); return; }
    const work = ingress.handle(request, response); transports.add(work);
    void work.then(() => transports.delete(work), error => { transports.delete(work); failures.push(error); void stop(true).catch(() => {}); });
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
    if (stopping || sockets.size >= 16) { socket.destroy(); return; }
    sockets.add(socket);
    // Node checks headersTimeout on a periodic connection scan (30 seconds by
    // default). Enforce this phase directly, without extending it on new bytes.
    headerTimers.set(socket, setTimeout(() => socket.destroy(), Math.min(5_000, binding.timeoutMs)));
    // Absolute connection lifetime, not a sliding inactivity timer. It includes
    // header-only connections and never extends the original ingress deadline.
    const timer = setTimeout(() => socket.destroy(), binding.timeoutMs + 5_000);
    socket.once("close", () => { clearHeaderTimer(socket); clearTimeout(timer); sockets.delete(socket); });
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
    stopping = true;
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
    void stop(reason !== "budget_exhausted").catch(() => {});
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const error = (failure: Error) => { server.off("listening", ready); reject(failure); };
      const ready = () => { listened = true; server.off("error", error); resolve(); };
      server.once("error", error); server.once("listening", ready);
      server.listen({ host: "127.0.0.1", port: binding.port, exclusive: true });
    });
    const result = Object.freeze({ origin: binding.origin, closed, close: () => stop(true) });
    normalClosures.set(result, () => {
      if (!normallyClosed || successfulInvocations !== handles.length) throw Error("Application invocation normal closure is incomplete");
      return Object.freeze({ version: 1, invocations: handles.length, runtime_normal_closures: successfulInvocations,
        broker_normal_closures: successfulInvocations, listener_closed: true });
    });
    return result;
  } catch (error) {
    const cleanup = await Promise.allSettled([stop(true)]);
    throw Object.assign(Error("Application listener startup failed", { cause: error }), { cleanup });
  }
}
