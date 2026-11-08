import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { canonicalProductSourceTransferValueV1 as canonical, SourceSupervisorIdentityV1Schema,
  SourceSupervisorLaunchV1Schema, SourceSupervisedCleanClosureV1Schema, inspectSourceCleanClosureV1, sourceCleanDigestV1,
  type SourceCleanStopIntentV1, type SourceCleanStopReceiptV1, type SourceSupervisedCleanClosureV1,
  type SourceSupervisorLaunchV1 } from "@artoo/domain";
import { SupervisedLifecycle, supervisedEnvironment, SUPERVISED_DAEMON, installSupervisedStdinControl,
  supervisedStdinControlEnabled, type SupervisorProcessObservation } from "./windows-daemon-launcher.js";
import { sourceLifecycleObserverIdentity, sourceLifecycleObserverFailure, bindSourceLifecycleLaunch, prepareSourceCleanStop,
  commitSourceCleanStop, type PreparedSourceLifecycleObserver } from "./source-lifecycle-observer.js";
import { readCleanSupervisorConfiguration, assertCleanStableDescriptor, captureClosedSourceHistory,
  type PreparedCleanSupervisorConfiguration } from "./windows-clean-local-configuration.js";

const sha = (bytes: string | Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const hash = (value: unknown) => sha(canonical(value));
const PREFIX = "ARTOO_SOURCE_LIFECYCLE_V1 ";
const nativeReady = z.object({ supervisor: SourceSupervisorIdentityV1Schema,
  launchIdentityDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).passthrough();
const nativeOutput = z.object({ generation: z.number().int().min(0).max(8), stream: z.enum(["stdout", "stderr"]), data: z.string() }).strict();
const descriptor = z.object({ version: z.literal(1), kind: z.literal("source-lifecycle"), nonce: z.string().uuid(),
  pid: z.number().int().positive(), launch: SourceSupervisorLaunchV1Schema }).strict();
const nativeIncarnation = z.object({ generation: z.number().int().min(0).max(8), daemon: SourceSupervisorIdentityV1Schema,
  rootWaitObserved: z.literal(true), exitCode: z.number().int().nonnegative(), stdoutEof: z.literal(true),
  stderrEof: z.literal(true), atomicJobMember: z.literal(true) }).strict();
const nativeTerminal = z.object({ kind: z.literal("supervisor_stopped"), payload: z.object({ reason: z.literal("stopped"),
  facts: z.object({ launchIdentityDigest: z.string(), incarnations: z.array(nativeIncarnation).min(1).max(9),
    lifetimeClosure: z.object({ version: z.literal(1), capability: z.literal("artoo.windows-daemon-supervisor-lifetime.v1"),
      jobCreated: z.literal(true), allRootsWaitObserved: z.literal(true), jobEmptyObserved: z.literal(true), allStdoutEof: z.literal(true),
      allStderrEof: z.literal(true), cleanupConfirmed: z.literal(true), gracefulStopArmed: z.literal(true),
      gracefulStopTimedOut: z.literal(false), forcedJobTermination: z.boolean() }).strict() }).strict() }).strict() }).passthrough();

declare const closureBrand: unique symbol;
export interface PreparedSupervisedCleanClosure { readonly [closureBrand]: true }
interface Closure {
  child: ChildProcessWithoutNullStreams; observer: PreparedSourceLifecycleObserver; lifecycle: SupervisedLifecycle;
  observed: SupervisorProcessObservation; intent: SourceCleanStopIntentV1; value: SourceSupervisedCleanClosureV1; consumed: boolean;
}
const closures = new WeakMap<object, Closure>();

/** Only this consumer is public. There is deliberately no function accepting a
 * ChildProcess, terminal JSON or observation object to construct a closure. */
export function consumeOriginalSupervisedCleanClosure(token: PreparedSupervisedCleanClosure,
  observer: PreparedSourceLifecycleObserver, intent: SourceCleanStopIntentV1): SourceSupervisedCleanClosureV1 {
  const saved = closures.get(token);
  if (!saved || saved.consumed || saved.observer !== observer || canonical(saved.intent) !== canonical(intent)
    || saved.child.exitCode !== 0 || saved.child.signalCode !== null) throw Error("One original unconsumed supervised closure is required");
  sourceLifecycleObserverIdentity(observer); saved.lifecycle.confirm(saved.observed);
  inspectSourceCleanClosureV1(intent, saved.value, sha); saved.consumed = true; return saved.value;
}
export interface CleanSupervisedOwner {
  readonly ready: Promise<void>;
  readonly completion: Promise<CleanSupervisedCompletion>;
  /** Explicit user stop never requires accepted H6 and never requests restart. */
  stop(): Promise<void>;
  /** The original Server freezes accepted H6 before native arm/shutdown. */
  transitionAfterAcceptedH6(): Promise<void>;
}
export type CleanSupervisedCompletion = Readonly<{ reason: "planned-transition"; receipt: SourceCleanStopReceiptV1 }
  | { reason: "user-stop"; receipt?: SourceCleanStopReceiptV1 }>;

/** Production extraction point: this function creates and retains the actual
 * native child itself. The common launcher hook must delegate its spawn/control
 * block here, never attach this module after a process was started elsewhere. */
export function startCleanWindowsSupervisor(options: { configuration: PreparedCleanSupervisorConfiguration;
  observer: PreparedSourceLifecycleObserver; onReady?(generation: number): void; manageStopSignals?: boolean }): CleanSupervisedOwner {
  if (process.platform !== "win32" || process.connected !== undefined) throw Error("Standalone native Windows lifecycle required");
  const fixed = readCleanSupervisorConfiguration(options.configuration), identity = sourceLifecycleObserverIdentity(options.observer);
  const stdinControl = supervisedStdinControlEnabled(fixed.env.ARTOO_SUPERVISED_STDIN_CONTROL);
  if (identity.node_id !== fixed.nodeId) throw Error("Clean observer and configured node differ");
  const nonce = randomUUID(), childEnv = supervisedEnvironment(fixed.env, nonce);
  childEnv.ARTOO_SOURCE_LIFECYCLE_OBSERVER_ID = identity.observer_id;
  childEnv.ARTOO_SOURCE_CLEAN_CONFIG_FILE = fixed.lineageFile.path;
  if (fixed.bootstrapGit) childEnv.ARTOO_SUPERVISED_BOOTSTRAP_GIT = JSON.stringify(fixed.bootstrapGit);
  const launch = { version: 1, kind: "launch", node: fixed.node, entry: fixed.entry, configuration: fixed.localFile,
    runtimeManifest: fixed.runtimeManifest, cwd: dirname(fixed.entry.path), args: [SUPERVISED_DAEMON], env: childEnv,
    maxRestarts: 8, restartBackoffMs: 1000, lifetimeMs: 86400000, outputLimitBytes: 16777216,
    lifetimeOwnership: { version: 1, cleanupTimeoutMs: 15000, gracefulStopMs: 45000 } };
  const line = JSON.stringify(launch) + "\n"; if (Buffer.byteLength(line) >= 65536) throw Error("Clean supervisor launch exceeds the native input bound");
  const systemRoot = fixed.env.SystemRoot ?? fixed.env.SYSTEMROOT;
  if (!systemRoot || !isAbsolute(systemRoot)) throw Error("Local Windows system directory required");
  const child = spawn(fixed.nativeImage.path, ["--daemon-supervisor-v1"], { cwd: dirname(fixed.nativeImage.path), windowsHide: true,
    shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"],
    env: { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: join(systemRoot, "System32") } });
  const observed: SupervisorProcessObservation = { spawned: false, exited: false, closed: false, stdoutEof: false, stderrEof: false,
    exitCode: null, closeCode: null, signal: null, closeSignal: null };
  const lifecycle = new SupervisedLifecycle(nonce, fixed.runtimeManifest, (generation, diagnostic) => {
    process.stderr.write(JSON.stringify({ kind: "artoo.supervised.startup", generation, diagnostic }) + "\n");
  }), decoder = new StringDecoder("utf8");
  const daemonOutputs = new Map<number, { pid: number; decoder: StringDecoder; pending: string; described: boolean }>();
  let pending = "", diagnosticBytes = 0, failure: Error | undefined, stopping = false, completed = false, readyNow = false, userStopped = false;
  let native: z.infer<typeof nativeReady> | undefined, terminal: unknown, bound: SourceSupervisorLaunchV1 | undefined;
  let intent: SourceCleanStopIntentV1 | undefined, stopWork: Promise<void> | undefined, transitionWork: Promise<void> | undefined,
    armWork: Promise<void> | undefined, bindingWork: Promise<void> = Promise.resolve();
  const plannedWait = new AbortController();
  let startup: ReturnType<typeof setTimeout> | undefined, cleanup: ReturnType<typeof setTimeout> | undefined, emergency: ReturnType<typeof setTimeout> | undefined;
  let resolveReady!: () => void, rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; }); void ready.catch(() => {});
  let resolveStarted!: () => void, rejectStarted!: (error: Error) => void;
  const started = new Promise<void>((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; }); void started.catch(() => {});
  const write = (value: unknown) => {
    if (observed.closed) return;
    child.stdin.write(JSON.stringify(value) + "\n", error => { if (error) fail(Error("Original supervisor control write failed")); });
  };
  const fail = (cause: unknown) => {
    if (completed) return;
    failure ??= cause instanceof Error ? cause : Error("Original clean supervisor failed"); readyNow = false; rejectReady(failure); rejectStarted(failure); clearTimeout(startup);
    if (observed.closed) return; // A late Stop/failure cannot leave an emergency timer after joined closure.
    if (!stopping) { stopping = true; write({ version: 1, kind: "stop", nonce: randomUUID() }); }
    emergency ??= setTimeout(() => { failure ??= Error("Original supervisor closure remains unknown"); child.kill(); }, 40000);
  };
  const armStop = (): Promise<void> => armWork ??= (async () => {
    // User Stop may arrive before ready/H6. Arm only the actual started daemon;
    // the original startup deadline still bounds a missing native start.
    await started;
    if (failure || observed.closed) throw Error("Original native daemon is unavailable for stop");
    stopping = true; readyNow = false; clearTimeout(startup); write(lifecycle.arm(randomUUID()));
    cleanup = setTimeout(() => { fail(Error("Graceful clean supervisor deadline elapsed")); child.kill(); },
      launch.lifetimeOwnership.gracefulStopMs + launch.lifetimeOwnership.cleanupTimeoutMs + 5000);
  })();
  const stop = (): Promise<void> => {
    userStopped = true; plannedWait.abort(); rejectReady(Error("User stopped the original native owner before transition"));
    return stopWork ??= armStop().catch(error => { fail(error); throw error; });
  };
  const transitionAfterAcceptedH6 = (): Promise<void> => transitionWork ??= (async () => {
    await ready;
    if (userStopped) return;
    if (!readyNow || stopping || !bound || failure) throw Error("Clean transition requires the current registered daemon");
    // Only the original authenticated Server may select and freeze the H6
    // origin and complete operation set. A model/output cannot trigger this.
    intent = await prepareSourceCleanStop(options.observer, { waitForAcceptedH6: true, signal: plannedWait.signal });
    if (failure || observed.closed || canonical(intent.launch) !== canonical(bound)) throw Error("Clean stop lost its original live launch");
    await armStop();
  })().catch(error => {
    if (userStopped && plannedWait.signal.aborted) return;
    fail(error); throw error;
  });
  const requestStop = () => { void stop().catch(() => {}); };
  if (options.manageStopSignals !== false) { process.on("SIGINT", requestStop); process.on("SIGTERM", requestStop); }
  const removeStdin = stdinControl && options.manageStopSignals !== false
    ? installSupervisedStdinControl(process.stdin, requestStop, fail) : () => {};
  const closed = new Promise<void>(resolve => child.once("close", (code, signal) => {
    observed.closed = true; observed.closeCode = code; observed.closeSignal = signal;
    rejectStarted(Error("Original supervisor closed before daemon start"));
    rejectReady(Error("Original supervisor closed before daemon readiness")); resolve();
  }));
  child.once("spawn", () => { observed.spawned = true; });
  child.once("exit", (code, signal) => { observed.exited = true; observed.exitCode = code; observed.signal = signal; });
  child.on("error", () => fail(Error("Original native supervisor failed"))); child.stdin.on("error", () => fail(Error("Native supervisor input failed")));
  child.stdout.on("error", () => fail(Error("Native supervisor output failed"))); child.stderr.on("error", () => fail(Error("Native supervisor diagnostics failed")));
  child.stderr.on("data", (bytes: Buffer) => { diagnosticBytes += bytes.length; if (diagnosticBytes > 65536) fail(Error("Native supervisor diagnostics exceeded bound")); });
  child.stderr.once("end", () => { observed.stderrEof = true; });
  const inspectDaemonOutput = (raw: unknown) => {
    const output = nativeOutput.parse(raw); if (output.stream !== "stdout") return;
    const stream = daemonOutputs.get(output.generation); if (!stream) throw Error("Clean descriptor has no original daemon incarnation");
    const bytes = Buffer.from(output.data, "base64"); if (bytes.toString("base64") !== output.data) throw Error("Invalid native daemon output encoding");
    stream.pending += stream.decoder.write(bytes); if (Buffer.byteLength(stream.pending) > 65536) throw Error("Clean private descriptor exceeds bound");
    for (let end; (end = stream.pending.indexOf("\n")) >= 0;) {
      const line = stream.pending.slice(0, end); stream.pending = stream.pending.slice(end + 1); if (!line.startsWith(PREFIX)) continue;
      const value = descriptor.parse(JSON.parse(line.slice(PREFIX.length)));
      if (stream.described || output.generation !== lifecycle.generation || value.nonce !== nonce || value.pid !== stream.pid || !native
        || value.launch.observer_id !== identity.observer_id || value.launch.launch_identity_digest !== native.launchIdentityDigest
        || canonical(value.launch.supervisor) !== canonical(native.supervisor) || value.launch.runtime_manifest_digest !== fixed.runtimeManifest.sha256)
        throw Error("Clean private descriptor changed its original daemon, native Supervisor or observer");
      assertCleanStableDescriptor(options.configuration, value.launch.stable); stream.described = true;
      bindingWork = bindingWork.then(async () => {
        if (userStopped) return; // A user stop needs native closure, not a new continuation binding.
        if (failure || observed.closed || output.generation !== lifecycle.generation) throw Error("Clean descriptor binding lost its current incarnation");
        if (bound) { if (canonical(bound) !== canonical(value.launch)) throw Error("Clean launch changed across daemon incarnations"); }
        else { await bindSourceLifecycleLaunch(options.observer, value.launch); bound = value.launch; }
        if (userStopped) return;
        if (failure || observed.closed || output.generation !== lifecycle.generation) throw Error("Clean bind acknowledgement lost its current incarnation");
        // Only public binding data crosses this private child pipe. The observer
        // challenge never enters the daemon or a model environment.
        write({ version: 1, kind: "daemon-input", nonce: randomUUID(), generation: output.generation,
          data: Buffer.from(JSON.stringify({ version: 1, kind: "source-lifecycle-bound", nonce,
            observer_id: identity.observer_id, launch_identity_digest: value.launch.launch_identity_digest }) + "\n").toString("base64") });
      }); void bindingWork.catch(fail);
    }
  };
  child.stdout.on("data", (bytes: Buffer) => {
    try {
      pending += decoder.write(bytes); if (Buffer.byteLength(pending) > 1024 * 1024) throw Error("Native supervisor frame exceeds bound");
      for (let end; (end = pending.indexOf("\n")) >= 0;) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        const frame = JSON.parse(line) as { kind: string; payload: unknown }, action = lifecycle.accept(frame);
        if (frame.kind === "supervisor_ready") native = nativeReady.parse(frame.payload);
        if (action === "started") {
          const value = z.object({ generation: z.number().int(), daemon: SourceSupervisorIdentityV1Schema }).passthrough().parse(frame.payload);
          daemonOutputs.set(value.generation, { pid: value.daemon.pid, decoder: new StringDecoder("utf8"), pending: "", described: false });
          resolveStarted();
          readyNow = false; clearTimeout(startup); startup = setTimeout(() => fail(Error("Clean daemon readiness timed out")), 300000);
        }
        if (frame.kind === "daemon_output") inspectDaemonOutput(frame.payload);
        if (action === "ready" && lifecycle.ready && !stopping && !userStopped) {
          if (!bound || !daemonOutputs.get(lifecycle.generation)?.described) throw Error("Clean daemon announced readiness before independent lifecycle binding");
          readyNow = true; clearTimeout(startup); resolveReady(); options.onReady?.(lifecycle.generation);
        }
        if (action === "armed") write({ version: 1, kind: "daemon-input", nonce: randomUUID(), generation: lifecycle.generation,
          data: Buffer.from(JSON.stringify({ version: 1, kind: "shutdown", nonce }) + "\n").toString("base64") });
        if (action === "terminal") terminal = frame;
      }
    } catch (error) { fail(error); }
  });
  child.stdout.once("end", () => { pending += decoder.end(); observed.stdoutEof = true; if (pending) fail(Error("Native supervisor ended with an incomplete frame")); });
  void sourceLifecycleObserverFailure(options.observer).then(fail);
  startup = setTimeout(() => fail(Error("Clean supervisor did not start a registered daemon")), 120000);
  child.stdin.write(line, error => { if (error) fail(Error("Initial native supervisor control write failed")); });
  const completion: Promise<CleanSupervisedCompletion> = (async () => {
    try {
      await closed; process.stderr.write(JSON.stringify(lifecycle.diagnosticClosure(observed)) + "\n");
      await bindingWork;
      if (failure) throw failure;
      if (!native || !userStopped && (!intent || !bound)) throw Error("Clean closure lacks its original prepared stop and binding");
      lifecycle.confirm(observed); readCleanSupervisorConfiguration(options.configuration);
      const original = nativeTerminal.parse(terminal), facts = original.payload.facts;
      if (!intent) { completed = true; return Object.freeze({ reason: "user-stop" as const }); }
      const retained = captureClosedSourceHistory(options.configuration, intent);
      const value = SourceSupervisedCleanClosureV1Schema.parse({ version: 1, kind: "whole-supervisor-job-closed.v1", stop_id: intent.stop_id,
        intent_digest: sourceCleanDigestV1(intent, sha), observer_id: identity.observer_id, supervisor: native.supervisor,
        launch_identity_digest: native.launchIdentityDigest, native_terminal_digest: hash(original), retained_history_digest: retained.retained_history_digest,
        incarnations: facts.incarnations.map(item => ({ generation: item.generation, identity: item.daemon, root_wait_observed: item.rootWaitObserved,
          exit_code: item.exitCode, stdout_eof: item.stdoutEof, stderr_eof: item.stderrEof, atomic_job_member: item.atomicJobMember,
          // Native lifetime v1 CleanupLifetime requires every original history
          // item's InputSettled before cleanupConfirmed can be true (native3,
          // Supervisor.cs:599). This is derived only after original child/Job
          // closure; a copied terminal JSON cannot reach this private producer.
          input_settled: true })), normal_daemon_shutdown: true, graceful_stop_armed: true, graceful_stop_timed_out: false,
        job_empty_observed: true, forced_job_termination: facts.lifetimeClosure.forcedJobTermination,
        parent: { spawned: observed.spawned, exited: observed.exited, closed: observed.closed, stdout_eof: observed.stdoutEof,
          stderr_eof: observed.stderrEof, exit_code: observed.exitCode, close_code: observed.closeCode, signal: observed.signal,
          close_signal: observed.closeSignal, inputs_unchanged: true } });
      inspectSourceCleanClosureV1(intent, value, sha);
      const token = Object.freeze({}) as PreparedSupervisedCleanClosure;
      closures.set(token, { child, observer: options.observer, lifecycle, observed, intent, value, consumed: false });
      // This call consumes the sole token and returns only a committed receipt.
      // It cannot reconnect, construct a replacement observer or adopt a PID.
      const receipt = await commitSourceCleanStop(options.observer, token); completed = true;
      return userStopped ? Object.freeze({ reason: "user-stop" as const, receipt })
        : Object.freeze({ reason: "planned-transition" as const, receipt });
    } finally {
      clearTimeout(startup); clearTimeout(cleanup); clearTimeout(emergency);
      process.off("SIGINT", requestStop); process.off("SIGTERM", requestStop); removeStdin();
    }
  })(); void completion.catch(() => {});
  return Object.freeze({ ready, completion, stop, transitionAfterAcceptedH6 });
}
