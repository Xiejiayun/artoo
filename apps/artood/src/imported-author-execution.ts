import { adapterRunEventBodySchema, type AgentInstanceConfig, type AgentInstanceHandle, type RuntimeAdapter, type RunEventMessage,
  type NodeSideTransport } from "@artoo/protocol";
import type { RunVerificationPayload, RunStartPayload } from "@artoo/domain";
import { bindWindowsVerifiedExecution, assertWindowsVerifiedExecutionClosed, type WindowsVerifiedExecutionAdmission } from "./process-adapter.js";
import type { PreparedVerificationProfile } from "./verification.js";
import type { ArtifactUploader } from "./artifact-upload.js";

type Event = RunEventMessage["event"];
/** Shared H3/H5 mechanics only. Stage admission and one-use permissions stay in their runtime owners. */
export function createImportedAuthorExecution(options: {
  adapter: RuntimeAdapter; config: AgentInstanceConfig; profile: PreparedVerificationProfile; signal: AbortSignal;
  stage: "design" | "implementation" | "validation"; assertCurrent: () => void; markNativeAttempted: () => void; prepareFinal: () => void;
  verify: () => Promise<RunVerificationPayload>; emit: (event: Event) => Promise<void>;
  beforeCompleted?: (evidence: RunVerificationPayload) => void;
  beforeFailed?: (failure: { kind: "author-failed"; reason: string } | { kind: "verification-failed"; reason: string; verification: RunVerificationPayload }) => void;
}) {
  const { adapter, config, profile, signal } = options;
  const label = options.stage === "design" ? "Imported-design" : options.stage === "implementation" ? "Imported implementation" : "Imported validation";
  let handle: AgentInstanceHandle | undefined, admission: WindowsVerifiedExecutionAdmission | undefined;
  let pending: "author" | "verifier" | undefined, stopWork: Promise<void> | undefined, stopError: unknown, deliveryUncertain = false;
  const stop = () => { if (handle && !stopWork) stopWork = adapter.stop(handle, "user_cancelled").catch(error => { stopError = error; }); };
  const send = async (event: Event) => { try { await options.emit(event); } catch (error) { deliveryUncertain = true; throw error; } };
  return {
    async run(): Promise<RunVerificationPayload | undefined> {
      admission = bindWindowsVerifiedExecution(adapter, config, profile, signal, options.assertCurrent);
      pending = "author"; options.markNativeAttempted(); handle = await adapter.start(config);
      signal.addEventListener("abort", stop, { once: true }); if (signal.aborted) stop();
      let terminal = false, evidence: RunVerificationPayload | undefined;
      for await (const yielded of adapter.streamEvents(handle)) {
        const event = adapterRunEventBodySchema.parse(yielded);
        if (event.type === "run.lifecycle" && ["completed", "failed", "cancelled"].includes(event.payload.phase)) {
          await stopWork; if (stopError) throw stopError;
          assertWindowsVerifiedExecutionClosed(admission, handle); pending = undefined;
          if (event.payload.phase === "completed" && !signal.aborted) {
            // An uncertain final verifier can never borrow the author's closure.
            options.prepareFinal(); pending = "verifier";
            const verified = await options.verify(); pending = undefined;
            await send({ type: "run.verification", payload: verified });
            if (verified.outcome === "passed") evidence = verified;
            if (options.stage !== "design" && !evidence) event.payload = { phase: "failed", reason: verified.reason ?? "Product verification did not pass" };
            if (options.stage === "validation" && verified.outcome === "failed" && !signal.aborted)
              options.beforeFailed?.({ kind: "verification-failed", reason: verified.reason ?? "Validation verification failed", verification: verified });
            if (evidence && !signal.aborted) options.beforeCompleted?.(evidence);
          } else if (options.stage === "validation" && event.payload.phase === "failed" && !signal.aborted) {
            // This is the adapter's explicit terminal failure after original native closure.
            // Generic exceptions and cleanup failures never enter this typed callback.
            options.beforeFailed?.({ kind: "author-failed", reason: event.payload.reason ?? "Validation author failed" });
          }
          if (signal.aborted) event.payload = { phase: "cancelled", reason: "user_cancelled" };
          await send(event); terminal = true; break;
        }
        await send(event);
      }
      if (!terminal) throw Error(label + " writer did not emit a terminal lifecycle");
      return evidence;
    },
    assertClosed() {
      if (!admission || !handle) throw Error("Original imported author closure is unavailable");
      assertWindowsVerifiedExecutionClosed(admission, handle);
    },
    async failure(error: unknown): Promise<{ outcome: "failed"; closed: true; reason: string } | { outcome: "uncertain"; closed: false; reason: string }> {
      let reason = error instanceof Error ? error.message : label + " execution failed";
      if (pending === "author" && handle && admission) {
        try { if (stopWork) await stopWork; else await adapter.stop(handle, "shutdown"); if (stopError) throw stopError;
          assertWindowsVerifiedExecutionClosed(admission, handle); pending = undefined; }
        catch (closureError) { reason += "; author closure unconfirmed: " + (closureError instanceof Error ? closureError.message : String(closureError)); }
      }
      if (!pending && !deliveryUncertain) {
        try { await send({ type: "run.lifecycle", payload: { phase: "failed", reason: reason.slice(0, 2000) } }); }
        catch { /* The original delivery uncertainty remains in the result below. */ }
      }
      return pending || deliveryUncertain
        ? { outcome: "uncertain", closed: false, reason: reason.slice(0, 2000) || label + " closure is uncertain" }
        : { outcome: "failed", closed: true, reason: reason.slice(0, 2000) || label + " execution failed" };
    },
    dispose() { signal.removeEventListener("abort", stop); },
  };
}

/** Both author paths await committed event receipts in sequence, including artifact upload. */
export function createImportedAuthorEmitter(options: { nodeId: string; transport: NodeSideTransport; start: RunStartPayload;
  current: () => void; uploadArtifact?: ArtifactUploader }): (event: Event) => Promise<void> {
  if (options.transport.acknowledgesRunEvents !== true) throw Error("Imported author requires committed run-event receipts");
  let sequence = 0;
  return async raw => {
    options.current();
    const event = raw.type === "artifact.created" && options.uploadArtifact
      ? await options.uploadArtifact(options.start.run_id, options.start.workspace.root, raw) : raw;
    options.current(); await options.transport.send({ kind: "run.event", node_id: options.nodeId,
      run_id: options.start.run_id, sequence: sequence++, event });
  };
}
