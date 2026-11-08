import { fileURLToPath } from "node:url";
import { installApplicationBootstrapControl } from "./application-bootstrap-control.js";
import { applicationServiceSelection, prepareApplicationBootstrap } from "./application-bootstrap-admission.js";
import type { LocalApplicationService } from "./application-local-service.js";

function output(stream: NodeJS.WriteStream, value: unknown): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(value) + "\n");
  if (bytes.length > 4096) throw Error("Application bootstrap: status output exceeds bound");
  return new Promise((resolve, reject) => stream.write(bytes, error => error ? reject(error) : resolve()));
}

/** No daemon, model, arbitrary command or process adoption. Normal shutdown
 * awaits the actual installed service; the outer observer owns exit/close/EOF. */
export async function runApplicationServiceBootstrap(): Promise<void> {
  const control = installApplicationBootstrapControl(process.stdin, process), failedOutput = new AbortController();
  const startupStop = new AbortController();
  const signal = AbortSignal.any([control.signal, failedOutput.signal, startupStop.signal]);
  let outputFailure: Error | undefined, service: LocalApplicationService | undefined;
  let readClosure: (() => unknown) | undefined;
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
    if (!control.drainSignal.aborted) return;
    if (!drainWork) throw Error("Application drain cancelled startup before readiness");
    if (signal.aborted) throw Error("Application drain was cancelled");
  };
  const outputFailed = (error: Error) => { outputFailure ??= error; failedOutput.abort(); };
  control.drainSignal.addEventListener("abort", drain, { once: true });
  process.stdout.on("error", outputFailed); process.stderr.on("error", outputFailed);
  try {
    const selected = prepareApplicationBootstrap(applicationServiceSelection(process.argv.slice(2)), fileURLToPath(import.meta.url));
    if (selected.shutdown === "stdin") control.enableStdin();
    selected.assertCurrent();
    if (!signal.aborted) {
      const api = await import("./application-service-host-api.js");
      selected.assertCurrent();
      if (!signal.aborted) {
        if (selected.operation === "initialize") {
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
        service = await api.reopenInstalledApplicationService(selected.options, signal);
        const original = service; readClosure = () => api.readInstalledApplicationClosure(original);
      }
    }
    if (service) {
      selected.assertCurrent();
      if (signal.aborted) await service.close();
      else {
        await output(process.stdout, { version: 1, kind: "application-service.listening", origin: service.origin,
          qualified_for_product: false, maximum_requests: 256, maximum_concurrent: 1 });
        if (signal.aborted) await service.close();
        else phase = "listening";
      }
      await service.closed;
      if (drainWork) await drainWork;
    }
    phase = "settled";
    if (control.failure || outputFailure) throw control.failure ?? outputFailure;
    assertDrain();
    selected.assertCurrent();
    await output(process.stdout, { version: 1, kind: "application-service.closed", started: !!service,
      reason: control.reason ?? "budget-exhausted", ...(service ? { closure: readClosure!() } : {}), qualified_for_product: false });
    if (control.failure || outputFailure) throw control.failure ?? outputFailure;
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
    control.drainSignal.removeEventListener("abort", drain);
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
