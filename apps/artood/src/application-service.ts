import type { ApplicationHttpInvocation, ApplicationHttpService } from "./application-http-ingress.js";
import { parseApplicationBrokerCommand, decodeBrokerBytes, type ApplicationBrokerReply } from "./application-broker-control.js";
import { startApplicationBrokerProcess, type PreparedApplicationBrokerProcess, type ApplicationBrokerProcess,
  type ApplicationBrokerProcessReceipt } from "./application-broker-process.js";
import { startApplicationRuntimeProcess, type PreparedApplicationRuntimeProcess, type ApplicationRuntimeProcess,
  type ApplicationRuntimeProcessReceipt } from "./application-runtime-process.js";
import { APPLICATION_RUNTIME_PROCESS_LIMITS as limits } from "./application-runtime-process-protocol.js";

export interface ApplicationServiceInstallation {
  readonly maximumAccess: "read" | "write";
  /** Protected host-local factories. They must return new original opaque
   * preparations; neither accepts request text, argv or a remote profile. */
  prepareRuntime(): PreparedApplicationRuntimeProcess;
  prepareBroker(): PreparedApplicationBrokerProcess;
}

/** Bounded development service only. One request owns one actual guest and one
 * actual broker. It creates no listener/profile/publication and grants no LPAC
 * or product qualification. The existing HTTP ingress owns request admission. */
export function createApplicationService(installation: ApplicationServiceInstallation): ApplicationHttpService {
  const maximumAccess = installation.maximumAccess;
  if (maximumAccess !== "read" && maximumAccess !== "write") throw Error("Fixed application access required");
  const prepareRuntime = installation.prepareRuntime.bind(installation), prepareBroker = installation.prepareBroker.bind(installation);
  return Object.freeze({ maximumAccess, begin(action: Parameters<ApplicationHttpService["begin"]>[0], signal: AbortSignal): ApplicationHttpInvocation {
    // Validate before allocating any native work. Broker validates again against
    // its actual immutable local maximum, scope and existing request contract.
    const validated = parseApplicationBrokerCommand({ ...action, version: 1, sequence: 0 });
    if (validated.kind !== "begin" || validated.access === "write" && maximumAccess !== "write"
      || validated.purpose !== "application" && maximumAccess !== "read") throw Error("Application service policy rejected");
    const deadline = performance.now() + validated.lifetimeMs;
    let runtime: ApplicationRuntimeProcess | undefined, broker: ApplicationBrokerProcess | undefined;
    let stopped = false, finishing = false, failed: Error | undefined;
    let resolveResponse!: (value: string) => void, rejectResponse!: (reason: Error) => void;
    let resolveSettled!: () => void, rejectSettled!: (reason: Error) => void, rejectInterrupted!: (reason: Error) => void;
    const response = new Promise<string>((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject; }); void response.catch(() => {});
    const settled = new Promise<void>((resolve, reject) => { resolveSettled = resolve; rejectSettled = reject; }); void settled.catch(() => {});
    const interrupted = new Promise<never>((_resolve, reject) => { rejectInterrupted = reject; }); void interrupted.catch(() => {});
    const abort = (code: string): void => {
      if (stopped) return; stopped = true; failed = Error(code);
      rejectInterrupted(failed); rejectResponse(failed);
      // These are the exact original owners. Never send broker.cancel(invocation)
      // after a response removed its handle, and never infer rollback from stop.
      if (runtime) void runtime.cancel().catch(() => {});
      if (broker) void broker.cancel().catch(() => {});
    };
    const cancel = (): void => abort("Application invocation cancelled");
    const timer = setTimeout(() => abort("Application original deadline elapsed"), Math.max(1, deadline - performance.now()));
    signal.addEventListener("abort", cancel, { once: true }); if (signal.aborted) cancel();
    const check = (): number => {
      const remaining = Math.floor(deadline - performance.now());
      if (stopped || remaining < 1) { abort("Application original deadline elapsed"); throw failed!; }
      return remaining;
    };
    const live = async <T>(work: Promise<T>): Promise<T> => { const result = await Promise.race([work, interrupted]); check(); return result; };
    // Yield before preparation/spawn so begin always returns the original
    // cancellable handle before any native work can exist.
    void Promise.resolve().then(async () => {
      let result: string | undefined;
      try {
        check(); const runtimePreparation = prepareRuntime(); check(); const brokerPreparation = prepareBroker(); check();
        runtime = startApplicationRuntimeProcess(runtimePreparation, deadline); check();
        broker = startApplicationBrokerProcess(brokerPreparation, deadline); check();
        void runtime.closed.then(() => { if (!finishing) abort("Application runtime closed before completion"); });
        void broker.closed.then(() => { if (!finishing) abort("Application broker closed before completion"); });
        await live(Promise.all([runtime.ready, broker.ready]));
        let reply = await live(broker.command({ kind: "begin", invocation: validated.invocation,
          requestJson: validated.requestJson, purpose: validated.purpose, access: validated.access, lifetimeMs: check() }));
        const accept = async (value: ApplicationBrokerReply): Promise<string | undefined> => {
          if (value.stopped || value.terminated.length || value.responses.length > 1) throw Error("Application broker terminated invocation");
          for (const encoded of value.frames) {
            const bytes = decodeBrokerBytes(encoded, 1_048_580);
            for (let offset = 0; offset < bytes.length; offset += limits.childChunkBytes) {
              await live(runtime!.receive(bytes.subarray(offset, offset + limits.childChunkBytes)));
            }
          }
          if (!value.responses.length) return;
          if (value.responses[0]!.invocation !== validated.invocation) throw Error("Application broker response correlation");
          return JSON.stringify(value.responses[0]);
        };
        for (;;) {
          result = await accept(reply); if (result !== undefined) break;
          const bytes = await live(runtime.readOutput());
          if (!bytes) throw Error("Application runtime output ended before response");
          // Serial loop: exactly one existing broker.command at a time. The
          // original binary wire is neither decoded/resequenced nor fabricated.
          reply = await live(broker.command({ kind: "receive", data: Buffer.from(bytes).toString("base64") }));
        }
        check(); finishing = true;
        // Runtime close is an independent trusted control followed by actual
        // stdin EOF. broker.stop's private shutdown wire is never claimed sent.
        const receipts = await live(Promise.all([runtime.close(), broker.stop()]));
        if (!receipts[0].normalShutdown || !receipts[1].normalShutdown) throw Error("Application normal closure not established");
        check(); resolveSettled(); resolveResponse(result);
      } catch (error) {
        if (!failed) failed = error instanceof Error ? error : Error("Application invocation failed");
        rejectResponse(failed); finishing = true;
        if (runtime) void runtime.cancel().catch(() => {});
        if (broker) void broker.cancel().catch(() => {});
        const closures = await Promise.allSettled([runtime?.closed, broker?.closed]);
        const runtimeReceipt = closures[0]!.status === "fulfilled" ? closures[0]!.value as ApplicationRuntimeProcessReceipt | undefined : undefined;
        const brokerReceipt = closures[1]!.status === "fulfilled" ? closures[1]!.value as ApplicationBrokerProcessReceipt | undefined : undefined;
        // The current broker API binds complete closure only in normalShutdown.
        // Do not promote its raw failure facts into a new closure capability.
        if ((!runtime || runtimeReceipt?.closureConfirmed) && (!broker || brokerReceipt?.normalShutdown)) resolveSettled();
        else rejectSettled(Error("Application owner closure remains uncertain"));
      } finally {
        clearTimeout(timer); signal.removeEventListener("abort", cancel);
      }
    }).catch(error => { rejectResponse(error instanceof Error ? error : Error("Application failed")); rejectSettled(Error("Application owner closure remains uncertain")); });
    return Object.freeze({ response, settled, cancel });
  } });
}
