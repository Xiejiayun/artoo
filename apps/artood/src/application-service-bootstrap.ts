import { fileURLToPath } from "node:url";
import { installApplicationBootstrapControl } from "./application-bootstrap-control.js";
import { installApplicationPublicationBootstrapControl } from "./application-publication-bootstrap-control.js";
import { applicationServiceSelection, prepareApplicationBootstrap, readApplicationBootstrapPublication } from "./application-bootstrap-admission.js";
import type { LocalApplicationService } from "./application-local-service.js";
import { APPLICATION_PUBLICATION_STATUS_LIMITS, type ApplicationPublicationProbeBinding } from "./application-publication-process-protocol.js";

function output(stream: NodeJS.WriteStream, value: unknown, maximum = 4096): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(value) + "\n");
  if (bytes.length > maximum) throw Error("Application bootstrap: status output exceeds bound");
  return new Promise((resolve, reject) => stream.write(bytes, error => error ? reject(error) : resolve()));
}

/** No daemon, model, arbitrary command or process adoption. Normal shutdown
 * awaits the actual installed service; the outer observer owns exit/close/EOF. */
export async function runApplicationServiceBootstrap(): Promise<void> {
  const control = installApplicationBootstrapControl(process.stdin, process), failedOutput = new AbortController();
  const startupStop = new AbortController(), publicationStop = new AbortController();
  const signal = AbortSignal.any([control.signal, failedOutput.signal, startupStop.signal, publicationStop.signal]);
  let publicationControl: ReturnType<typeof installApplicationPublicationBootstrapControl> | undefined;
  let outputFailure: Error | undefined, service: LocalApplicationService | undefined;
  let readClosure: (() => unknown) | undefined;
  let publication: ApplicationPublicationProbeBinding | undefined, readPublication: (() => unknown) | undefined;
  let unsubscribe: (() => void) | undefined, statuses = Promise.resolve();
  const publicationOutput = (value: unknown) => {
    statuses = statuses.then(() => output(process.stdout, value, APPLICATION_PUBLICATION_STATUS_LIMITS.lineBytes));
    void statuses.catch(error => outputFailed(error instanceof Error ? error : Error("Publication output failed", { cause: error })));
    return statuses;
  };
  let phase: "starting" | "listening" | "settled" = "starting", drainWork: Promise<void> | undefined;
  const drain = () => {
    // A listener that has not finished its readiness handoff is still startup.
    // Abort that operation and join any owner it returns later in the normal path.
    if (phase !== "listening" || !service || signal.aborted) { startupStop.abort(); return; }
    if (drainWork) return;
    try { drainWork = Promise.resolve(service.drain()); }
    catch (error) { drainWork = Promise.reject(error); }
    // A failed drain escalates the same installed owner to cancellation. The
    // exact rejection is joined below; this handler does not replace its cause.
    void drainWork.catch(() => failedOutput.abort());
  };
  const assertDrain = () => {
    if (publicationControl?.reason === "stdin-drain") {
      if (signal.aborted) throw Error("Application publication drain was cancelled");
      return;
    }
    if (!control.drainSignal.aborted) return;
    if (!drainWork) throw Error("Application drain cancelled startup before readiness");
    if (signal.aborted) throw Error("Application drain was cancelled");
  };
  const outputFailed = (error: Error) => { outputFailure ??= error; failedOutput.abort(); };
  control.drainSignal.addEventListener("abort", drain, { once: true });
  process.stdout.on("error", outputFailed); process.stderr.on("error", outputFailed);
  try {
    const selected = prepareApplicationBootstrap(applicationServiceSelection(process.argv.slice(2)), fileURLToPath(import.meta.url));
    const publicationBinding = selected.operation === "publication-reopen" ? readApplicationBootstrapPublication(selected.options.bootstrap) : undefined;
    if (publicationBinding?.control) {
      publicationControl = installApplicationPublicationBootstrapControl(process.stdin, { identity: publicationBinding.identity,
        selection: publicationBinding.control, signal, onStatus: publicationOutput });
      const failed = () => publicationStop.abort(publicationControl!.failure);
      publicationControl.signal.addEventListener("abort", failed, { once: true });
      if (publicationControl.signal.aborted) failed();
    } else if (selected.shutdown === "stdin") control.enableStdin();
    selected.assertCurrent();
    if (!signal.aborted) {
      const api = await import("./application-service-host-api.js");
      selected.assertCurrent();
      if (!signal.aborted) {
        if (selected.operation === "initialize" || selected.operation === "publication-initialize") {
          if (selected.operation === "publication-initialize") {
            const result = await api.initializeApplicationPublicationPackage(selected.options, signal);
            selected.assertCurrent();
            if (control.failure || outputFailure) throw control.failure ?? outputFailure;
            if (signal.aborted) throw Error("Application publication initialization cancelled before handoff");
            await publicationOutput({ version: 1, kind: "application-publication.initialized", ...result,
              closure: api.readInitializedApplicationClosure(result.reference) });
            if (control.failure || outputFailure) throw control.failure ?? outputFailure;
            selected.assertCurrent();
            if (signal.aborted) throw Error("Application publication initialization cancelled before handoff");
            return;
          }
          const reference = await api.initializeApplicationPackage(selected.options, signal);
          selected.assertCurrent();
          if (control.failure || outputFailure) throw control.failure ?? outputFailure;
          if (signal.aborted) throw Error("Application package initialization cancelled before handoff");
          await output(process.stdout, { version: 1, kind: "application-service.initialized", reference,
            closure: api.readInitializedApplicationClosure(reference), qualified_for_product: false });
          if (control.failure || outputFailure) throw control.failure ?? outputFailure;
          selected.assertCurrent();
          if (signal.aborted) throw Error("Application package initialization cancelled before handoff");
          return;
        }
        service = selected.operation === "publication-reopen" ? await api.reopenInstalledApplicationPublicationService(selected.options, signal)
          : await api.reopenInstalledApplicationService(selected.options, signal);
        const original = service; readClosure = () => api.readInstalledApplicationClosure(original);
        if (selected.operation === "publication-reopen") {
          publication = readApplicationBootstrapPublication(selected.options.bootstrap);
          if (!publication) throw Error("Original publication bootstrap binding required");
          readPublication = () => api.readInstalledApplicationPublication(original).counters;
          const identity = publication.identity;
          const initialControl = publicationControl
            ? await publicationControl.attach(api.readInstalledApplicationPublicationControl(original)) : undefined;
          selected.assertCurrent();
          if (signal.aborted) throw Error("Application publication listener cancelled before handoff");
          // A parent may consume the pipe before its write callback runs. Once
          // this status is emitted, a fixed drain must act on this ready owner.
          phase = "listening";
          // Queue the listening status before subscribing; callbacks are bounded
          // by the original ingress's 256 admissions and actual settlements.
          const listening = publicationOutput({ version: 1, kind: "application-publication.listening", identity,
            ...api.readInstalledApplicationPublication(original), maximum_requests: 256, maximum_concurrent: 1,
            ...(initialControl ? { control: initialControl } : {}) });
          unsubscribe = api.subscribeInstalledApplicationPublication(original, counters => {
            void publicationOutput({ version: 1, kind: "application-publication.progress", identity, counters });
          });
          await listening;
        }
      }
    }
    if (service) {
      selected.assertCurrent();
      if (signal.aborted) await service.close();
      else {
        if (!publication) await output(process.stdout, { version: 1, kind: "application-service.listening", origin: service.origin,
          qualified_for_product: false, maximum_requests: 256, maximum_concurrent: 1 });
        if (signal.aborted) await service.close();
        else phase = "listening";
      }
      await service.closed;
      if (drainWork) await drainWork;
      if (publicationControl) {
        if (signal.aborted) throw publicationControl.failure ?? Error("Application publication control was cancelled");
        await publicationControl.finish();
      }
    }
    phase = "settled";
    if (control.failure || publicationControl?.failure || outputFailure) throw control.failure ?? publicationControl?.failure ?? outputFailure;
    assertDrain();
    selected.assertCurrent();
    unsubscribe?.(); unsubscribe = undefined;
    if (publication) await publicationOutput({ version: 1, kind: "application-publication.closed", identity: publication.identity,
      reason: publicationControl?.reason ?? control.reason ?? "budget-exhausted", counters: readPublication!(), closure: readClosure!() });
    else await output(process.stdout, { version: 1, kind: "application-service.closed", started: !!service,
      reason: control.reason ?? "budget-exhausted", ...(service ? { closure: readClosure!() } : {}), qualified_for_product: false });
    if (control.failure || publicationControl?.failure || outputFailure) throw control.failure ?? publicationControl?.failure ?? outputFailure;
    assertDrain();
  } catch (error) {
    phase = "settled";
    failedOutput.abort();
    const cleanup = service ? await Promise.allSettled([Promise.resolve().then(() => service!.close()), service.closed,
      ...(drainWork ? [drainWork] : [])]) : [];
    const failures = cleanup.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError([error, ...failures], "Application bootstrap failed; original closure remains uncertain");
    throw error;
  } finally {
    unsubscribe?.();
    control.drainSignal.removeEventListener("abort", drain);
    publicationControl?.dispose();
    control.dispose(); process.stdout.off("error", outputFailed); process.stderr.off("error", outputFailed);
  }
}

if (process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url)) {
  void runApplicationServiceBootstrap().catch(async error => {
    process.exitCode = 1;
    const ignore = () => {}; process.stderr.on("error", ignore);
    try { await output(process.stderr, { version: 1, kind: "application-service.failed", qualified_for_product: false,
      error: (error instanceof Error ? error.message : "Application service failed").slice(0, 1024) }); }
    catch { /* A broken status pipe cannot authorize cleanup or successful exit. */ }
    finally { process.stderr.off("error", ignore); }
  });
}
