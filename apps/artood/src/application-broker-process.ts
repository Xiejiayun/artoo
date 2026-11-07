import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { TextDecoder } from "node:util";
import { z } from "zod";
import { assertWindowsProcessBackend, prepareWindowsProcessBackend, type WindowsProcessBundleBinding } from "./owned/windows-owned-process.js";
import { APPLICATION_BROKER_LIMITS as limits, ApplicationBrokerConfigurationSchema, parseApplicationBrokerCommand,
  decodeBrokerBytes, type ApplicationBrokerAction, type ApplicationBrokerReply } from "./application-broker-control.js";

const lifetimeCapability = "artoo.windows-daemon-supervisor-lifetime.v1";
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const identity = z.object({ pid: z.number().int().positive(), creationTime: z.string().regex(/^\d{1,20}$/u),
  image: z.string().min(1).max(32768), sid: z.string().startsWith("S-1-") }).strict();
const lifetime = z.object({ version: z.literal(1), capability: z.literal(lifetimeCapability), jobCreated: z.boolean(),
  allRootsWaitObserved: z.boolean(), jobEmptyObserved: z.boolean(), allStdoutEof: z.boolean(), allStderrEof: z.boolean(),
  cleanupConfirmed: z.boolean(), gracefulStopArmed: z.boolean(), gracefulStopTimedOut: z.boolean(), forcedJobTermination: z.boolean() }).strict();
const incarnation = z.object({ generation: z.literal(0), daemon: identity, rootWaitObserved: z.boolean(), exitCode: z.number().int().nonnegative().nullable(),
  stdoutEof: z.boolean(), stderrEof: z.boolean(), atomicJobMember: z.boolean() }).strict();
const terminalSchema = z.object({ reason: z.string().max(128), facts: z.object({ launchIdentityDigest: hash,
  incarnations: z.array(incarnation).max(1), lifetimeClosure: lifetime }).strict().nullable() }).strict();
const replySchema = z.object({ version: z.literal(1), sequence: z.number().int().nonnegative(), kind: z.literal("result"),
  // Eight live invocations may each admit 32 data calls in one input batch.
  frames: z.array(z.string().max(limits.lineBytes)).max(256),
  responses: z.array(z.object({ invocation: z.string().max(128), response: z.unknown() }).strict()).max(8),
  terminated: z.array(z.object({ invocation: z.string().max(128), reason: z.enum(["cancelled", "aborted", "expired"]) }).strict()).max(8),
  stopped: z.boolean() }).strict();
export interface ApplicationBrokerFilePin { readonly path: string; readonly bytes: number; readonly sha256: string }
export interface ApplicationBrokerInstallation {
  readonly native: WindowsProcessBundleBinding;
  readonly node: ApplicationBrokerFilePin;
  /** Complete fixed trusted single-file bundle, never a generated product entry. */
  readonly entry: ApplicationBrokerFilePin;
  readonly configuration: ApplicationBrokerFilePin;
  /** Protected node-local authority: immutable broker installation AND broker-only storage. */
  readonly assertLocalAdmission: () => void;
}
declare const preparedBrand: unique symbol;
export interface PreparedApplicationBrokerProcess { readonly [preparedBrand]: true }
const preparations = new WeakMap<object, ReturnType<typeof prepare>>();
const sha = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
function synchronousAdmission(check: () => void): void {
  const result: unknown = check();
  if (result !== undefined) {
    // A thenable is never awaited into authority. Retain the synchronous failure
    // while consuming a rejected Promise so it cannot become an unhandled error.
    if (result !== null && (typeof result === "object" || typeof result === "function")
      && typeof (result as { then?: unknown }).then === "function") void Promise.resolve(result).catch(() => {});
    throw Error("Broker admission must complete synchronously");
  }
}
function verifyPin(pin: ApplicationBrokerFilePin): Buffer {
  if (!isAbsolute(pin.path) || realpathSync.native(pin.path) !== pin.path || !hash.safeParse(pin.sha256).success
    || !Number.isSafeInteger(pin.bytes) || pin.bytes < 1 || pin.bytes > 536_870_912) throw Error("Invalid broker installation pin");
  const before = lstatSync(pin.path, { bigint: true }), bytes = readFileSync(pin.path), after = lstatSync(pin.path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || !after.isFile() || after.nlink !== 1n
    || before.ino !== after.ino || before.dev !== after.dev || before.mtimeNs !== after.mtimeNs || before.size !== after.size
    || bytes.length !== pin.bytes || BigInt(bytes.length) !== after.size || sha(bytes) !== pin.sha256) throw Error("Broker installation changed");
  return bytes;
}
function prepare(input: ApplicationBrokerInstallation) {
  if (process.platform !== "win32" || typeof input.assertLocalAdmission !== "function"
    || basename(input.entry.path) !== "application-broker.mjs" || basename(input.node.path).toLowerCase() !== "node.exe")
    throw Error("Fixed trusted native Windows broker installation required");
  const nativeAdmission = input.native.assertLocalInstallation;
  const native = Object.freeze({ ...input.native, assertLocalInstallation: () => synchronousAdmission(nativeAdmission) });
  const fixed = Object.freeze({ ...input, native, node: Object.freeze({ ...input.node }), entry: Object.freeze({ ...input.entry }), configuration: Object.freeze({ ...input.configuration }) });
  const backend = prepareWindowsProcessBackend(native);
  const manifest = JSON.parse(readFileSync(join(native.directory, "manifest.json"), "utf8")) as { executable: string; capabilities?: string[] };
  if (!manifest.capabilities?.includes(lifetimeCapability)) throw Error("Native lifetime supervisor capability required");
  const nativeImage = realpathSync.native(join(native.directory, manifest.executable));
  const admission = fixed.assertLocalAdmission;
  const recheck = () => { synchronousAdmission(admission); assertWindowsProcessBackend(backend); verifyPin(fixed.node); verifyPin(fixed.entry); verifyPin(fixed.configuration); };
  recheck();
  if (fixed.configuration.bytes > 65_536) throw Error("Broker configuration exceeds bound");
  const config = ApplicationBrokerConfigurationSchema.parse(JSON.parse(verifyPin(fixed.configuration).toString("utf8")));
  const systemRoot = realpathSync.native(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "");
  if (!isAbsolute(systemRoot)) throw Error("Fixed Windows system directory required");
  return { fixed, nativeImage, config, systemRoot, recheck, used: false };
}
export function prepareApplicationBrokerProcess(input: ApplicationBrokerInstallation): PreparedApplicationBrokerProcess {
  const prepared = Object.freeze({}) as PreparedApplicationBrokerProcess; preparations.set(prepared, prepare(input)); return prepared;
}
export interface ApplicationBrokerProcessReceipt {
  readonly helperPid: number | undefined;
  readonly helper: Readonly<{ spawned: boolean; exited: boolean; closed: boolean; stdoutEof: boolean; stderrEof: boolean;
    exitCode: number | null; closeCode: number | null; signal: NodeJS.Signals | null; closeSignal: NodeJS.Signals | null }>;
  readonly terminal: z.infer<typeof terminalSchema> | undefined;
  readonly failure: string | undefined;
  readonly inputsUnchanged: boolean;
  readonly normalShutdown: boolean;
  readonly inputChunksWritten: number;
  readonly inputBytesWritten: number;
}
export interface ApplicationBrokerProcess {
  readonly ready: Promise<void>;
  /** Always resolves with original observations, including failed/uncertain closure. */
  readonly closed: Promise<ApplicationBrokerProcessReceipt>;
  command(action: Exclude<ApplicationBrokerAction, { kind: "shutdown" }>): Promise<ApplicationBrokerReply>;
  stop(): Promise<ApplicationBrokerProcessReceipt>;
  cancel(): Promise<ApplicationBrokerProcessReceipt>;
}

/** Creates the original helper itself. It cannot adopt a PID or serialized closure. */
export function startApplicationBrokerProcess(prepared: PreparedApplicationBrokerProcess): ApplicationBrokerProcess {
  const saved = preparations.get(prepared); if (!saved || saved.used) throw Error("Original unused broker preparation required");
  saved.recheck(); saved.used = true;
  const { fixed, nativeImage, systemRoot, config } = saved;
  const environment = { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: join(systemRoot, "System32") };
  const launch = { version: 1, kind: "launch", node: fixed.node, entry: fixed.entry, configuration: fixed.configuration,
    cwd: dirname(fixed.entry.path), args: ["--application-broker-v1", fixed.configuration.path], env: environment,
    maxRestarts: 0, restartBackoffMs: 0, lifetimeMs: 180_000, outputLimitBytes: 16_777_216,
    lifetimeOwnership: { version: 1, cleanupTimeoutMs: 15_000, gracefulStopMs: 15_000 } };
  const launchLine = JSON.stringify(launch) + "\n";
  if (Buffer.byteLength(launchLine) >= 65_536) throw Error("Broker launch exceeds native bound");
  // Reserve cancellation correlation before any process exists. Later RNG failure
  // cannot prevent this original owner from requesting native containment.
  const cancellationNonce = randomUUID();
  const child = spawn(nativeImage, ["--daemon-supervisor-v1"], { cwd: dirname(nativeImage), windowsHide: true,
    shell: false, detached: false, stdio: ["pipe", "pipe", "pipe"], env: environment });
  const observed: ApplicationBrokerProcessReceipt["helper"] extends Readonly<infer T> ? T : never = {
    spawned: false, exited: false, closed: false, stdoutEof: false, stderrEof: false, exitCode: null, closeCode: null, signal: null, closeSignal: null };
  let failure: string | undefined, terminal: z.infer<typeof terminalSchema> | undefined, terminalKind: string | undefined;
  let nativeReady: { supervisor: z.infer<typeof identity>; launchIdentityDigest: string } | undefined, daemon: z.infer<typeof identity> | undefined;
  let brokerReady = false, stopping = false, stoppedReply = false, stopNonce: string | undefined;
  let sequence = 0, brokerSequence = 0, outputBytes = 0, brokerBytes = 0, diagnosticBytes = 0, sentBytes = 0, chunks = 0, writtenBytes = 0, writtenChunks = 0;
  let nativePending = "", brokerPending = "", targetStdoutEof = false, targetStderrEof = false, rootExit: number | undefined;
  const nativeDecoder = new TextDecoder("utf-8", { fatal: true }), brokerDecoder = new TextDecoder("utf-8", { fatal: true });
  let resolveReady!: () => void, rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; }); void ready.catch(() => {});
  type NativePending = { nonce: string; kind: string; bytes: number; ack: boolean; written: boolean; resolve: () => void; reject: (error: Error) => void };
  let input: NativePending | undefined;
  let pendingReply: { sequence: number; resolve: (value: ApplicationBrokerReply) => void; reject: (error: Error) => void } | undefined;
  let work: Promise<ApplicationBrokerReply> | undefined, stopWork: Promise<ApplicationBrokerProcessReceipt> | undefined;
  let emergency: ReturnType<typeof setTimeout> | undefined;
  const startup = setTimeout(() => fail("startup-deadline"), 30_000);
  const duration = setTimeout(() => fail("lifetime-deadline"), 180_000);
  function fail(code: string): void {
    failure ??= code; rejectReady(Error(failure));
    input?.reject(Error(failure)); input = undefined; pendingReply?.reject(Error(failure)); pendingReply = undefined;
    if (observed.closed) return;
    if (!stopNonce) {
      stopNonce = cancellationNonce;
      try { child.stdin.write(JSON.stringify({ version: 1, kind: "stop", nonce: stopNonce }) + "\n", () => {}); }
      catch { /* Failure stays sticky; the original-helper cleanup deadline below remains armed. */ }
    }
    // Killing the original helper remains failure/uncertain closure; no PID is reopened.
    emergency ??= setTimeout(() => { failure ??= "closure-deadline"; child.kill(); }, 40_000);
  }
  function maybeReady(): void { if (nativeReady && daemon && brokerReady && !failure) { clearTimeout(startup); resolveReady(); } }
  function nativeControl(kind: "daemon-input" | "arm-graceful-stop", bytes?: Buffer): Promise<void> {
    if (failure || observed.closed || input || !daemon || stopNonce) return Promise.reject(Error("Broker control unavailable"));
    if (bytes && (++chunks > limits.nativeChunks || bytes.length < 1 || bytes.length > limits.nativeChunkBytes)) return Promise.reject(Error("Broker input bound"));
    return new Promise<void>((resolve, reject) => {
      const nonce = randomUUID(); input = { nonce, kind, bytes: bytes?.length ?? 0, ack: false, written: !bytes, resolve, reject };
      const line = JSON.stringify({ version: 1, kind, nonce, generation: 0, ...(bytes ? { data: bytes.toString("base64") } : {}) }) + "\n";
      child.stdin.write(line, error => { if (error) fail("control-write"); });
    });
  }
  function finishInputAck(): void {
    if (!input || !input.ack || !input.written) return;
    const current = input; input = undefined; current.resolve();
  }
  function brokerLine(line: string): void {
    if (Buffer.byteLength(line) > limits.lineBytes) throw Error("broker-line-bound");
    const value = JSON.parse(line) as unknown;
    if (!brokerReady) {
      const readyValue = z.object({ version: z.literal(1), kind: z.literal("ready"), protocol: z.literal("artoo.application-broker.v1"),
        maximumAccess: z.enum(["read", "write"]) }).strict().parse(value);
      if (readyValue.maximumAccess !== config.maximumAccess) throw Error("broker-access-changed"); brokerReady = true; maybeReady(); return;
    }
    const reply = replySchema.parse(value);
    if (!pendingReply || reply.sequence !== pendingReply.sequence || (reply.stopped && !stopping)) throw Error("broker-reply-binding");
    for (const encoded of reply.frames) decodeBrokerBytes(encoded, 1_048_580);
    if (reply.stopped) stoppedReply = true;
    const current = pendingReply; pendingReply = undefined; current.resolve(reply);
  }
  function nativeLine(line: string): void {
    if (Buffer.byteLength(line) > 65_536) throw Error("native-line-bound");
    const frame = z.object({ version: z.literal(1), sequence: z.number().int().nonnegative(), kind: z.string(), payload: z.unknown() }).strict().parse(JSON.parse(line));
    if (frame.sequence !== sequence++ || terminalKind) throw Error("native-sequence");
    if (frame.kind === "supervisor_ready") {
      const value = z.object({ capability: z.literal("artoo.windows-daemon-supervisor.v1"), supervisor: identity, launchIdentityDigest: hash,
        lifetimeOwnership: z.object({ version: z.literal(1), capability: z.literal(lifetimeCapability), cleanupTimeoutMs: z.literal(15_000),
          gracefulStopMs: z.literal(15_000), sharedJob: z.literal(true) }).strict() }).strict().parse(frame.payload);
      if (nativeReady || value.supervisor.pid !== child.pid || value.supervisor.image.toLowerCase() !== nativeImage.toLowerCase()) throw Error("supervisor-identity");
      nativeReady = value; maybeReady();
    } else if (frame.kind === "daemon_started") {
      const value = z.object({ generation: z.literal(0), daemon: identity, launchIdentityDigest: hash, atomicJobMember: z.literal(true) }).strict().parse(frame.payload);
      if (!nativeReady || daemon || value.launchIdentityDigest !== nativeReady.launchIdentityDigest
        || value.daemon.image.toLowerCase() !== fixed.node.path.toLowerCase() || value.daemon.sid !== nativeReady.supervisor.sid
        || BigInt(value.daemon.creationTime) <= BigInt(nativeReady.supervisor.creationTime)) throw Error("broker-identity");
      daemon = value.daemon; maybeReady();
    } else if (frame.kind === "daemon_output") {
      const value = z.object({ generation: z.literal(0), stream: z.enum(["stdout", "stderr"]), data: z.string() }).strict().parse(frame.payload);
      const bytes = decodeBrokerBytes(value.data, 16_384);
      if (value.stream === "stderr") { if (targetStderrEof) throw Error("output-after-eof"); diagnosticBytes += bytes.length; }
      else {
        if (targetStdoutEof) throw Error("output-after-eof");
        brokerBytes += bytes.length; if (brokerBytes > limits.totalOutputBytes) throw Error("broker-output-bound");
        brokerPending += brokerDecoder.decode(bytes, { stream: true });
        for (let end; (end = brokerPending.indexOf("\n")) >= 0;) { const value = brokerPending.slice(0, end); brokerPending = brokerPending.slice(end + 1); brokerLine(value); }
        if (Buffer.byteLength(brokerPending) > limits.lineBytes) throw Error("broker-line-bound");
      }
    } else if (frame.kind === "command_ack") {
      const value = z.object({ nonce: z.string().uuid(), kind: z.string(), generation: z.literal(0) }).strict().parse(frame.payload);
      if (stopNonce && value.kind === "stop" && value.nonce === stopNonce) return;
      if (!input || input.ack || value.nonce !== input.nonce || value.kind !== input.kind) throw Error("input-ack-binding");
      input.ack = true; finishInputAck();
    } else if (frame.kind === "daemon_input_written") {
      const value = z.object({ generation: z.literal(0), bytes: z.number().int().min(1).max(limits.nativeChunkBytes) }).strict().parse(frame.payload);
      if (!input || input.kind !== "daemon-input" || input.written || input.bytes !== value.bytes) throw Error("input-written-binding");
      writtenBytes += value.bytes; writtenChunks++; input.written = true; finishInputAck();
    } else if (frame.kind === "daemon_pipe_eof") {
      const value = z.object({ generation: z.literal(0), stream: z.enum(["stdout", "stderr"]) }).strict().parse(frame.payload);
      if (value.stream === "stdout") { if (targetStdoutEof) throw Error("duplicate-eof"); targetStdoutEof = true; brokerPending += brokerDecoder.decode(); if (brokerPending.length) throw Error("truncated-broker-output"); }
      else { if (targetStderrEof) throw Error("duplicate-eof"); targetStderrEof = true; }
    } else if (frame.kind === "daemon_exit") {
      const value = z.object({ generation: z.literal(0), daemon: identity, rootWaitObserved: z.literal(true), exitCode: z.number().int().nonnegative(),
        exitTime: z.string().regex(/^\d+$/u), stdoutEof: z.boolean(), stderrEof: z.boolean() }).strict().parse(frame.payload);
      if (rootExit !== undefined || !daemon || JSON.stringify(value.daemon) !== JSON.stringify(daemon)) throw Error("exit-identity"); rootExit = value.exitCode;
    } else if (frame.kind === "supervisor_stopped" || frame.kind === "supervisor_failed") {
      terminalKind = frame.kind; terminal = terminalSchema.parse(frame.payload);
      if (frame.kind === "supervisor_failed") fail("native-lifecycle-failed");
    } else throw Error("unexpected-native-frame");
    if (diagnosticBytes > 65_536) throw Error("diagnostic-bound");
  }
  child.once("spawn", () => { observed.spawned = true; });
  child.once("exit", (code, signal) => { observed.exited = true; observed.exitCode = code; observed.signal = signal; });
  child.on("error", () => fail("helper-process")); child.stdin.on("error", () => fail("helper-input"));
  child.stdout.on("error", () => fail("helper-output")); child.stderr.on("error", () => fail("helper-diagnostic"));
  child.stdout.on("data", (bytes: Buffer) => {
    try {
      outputBytes += bytes.length; if (outputBytes > 24_000_000) throw Error("native-output-bound");
      nativePending += nativeDecoder.decode(bytes, { stream: true });
      for (let end; (end = nativePending.indexOf("\n")) >= 0;) {
        const line = nativePending.slice(0, end); nativePending = nativePending.slice(end + 1);
        // A rejected late ACK must not hide a following terminal in the same read.
        // Failure remains sticky; continue bounded parsing for actual closure facts.
        try { nativeLine(line); } catch { fail("native-protocol"); }
      }
      if (Buffer.byteLength(nativePending) > 65_536) throw Error("native-line-bound");
    } catch { fail("native-protocol"); }
  });
  child.stderr.on("data", (bytes: Buffer) => { diagnosticBytes += bytes.length; if (diagnosticBytes > 65_536) fail("diagnostic-bound"); });
  child.stdout.once("end", () => { observed.stdoutEof = true; try { nativePending += nativeDecoder.decode(); if (nativePending.length) fail("native-truncated"); } catch { fail("native-utf8"); } });
  child.stderr.once("end", () => { observed.stderrEof = true; });
  const closed = new Promise<ApplicationBrokerProcessReceipt>(resolve => child.once("close", (code, signal) => {
    observed.closed = true; observed.closeCode = code; observed.closeSignal = signal;
    clearTimeout(startup); clearTimeout(duration); clearTimeout(emergency);
    rejectReady(Error("Original broker owner closed")); input?.reject(Error("Original broker owner closed")); input = undefined;
    pendingReply?.reject(Error("Original broker owner closed")); pendingReply = undefined;
    let unchanged = false; try { saved.recheck(); unchanged = true; } catch { failure ??= "installation-changed"; }
    const facts = terminal?.facts, target = facts?.incarnations[0], closure = facts?.lifetimeClosure;
    const normal = !failure && observed.spawned && observed.exited && observed.stdoutEof && observed.stderrEof
      && code === 0 && observed.exitCode === 0 && signal === null && observed.signal === null
      && terminalKind === "supervisor_stopped" && terminal?.reason === "stopped" && stoppedReply && stopping
      && !!nativeReady && facts?.launchIdentityDigest === nativeReady.launchIdentityDigest && !!daemon && !!target
      && JSON.stringify(target.daemon) === JSON.stringify(daemon) && target.generation === 0 && target.rootWaitObserved
      && rootExit === 0 && target.exitCode === 0 && target.stdoutEof && target.stderrEof && target.atomicJobMember
      && targetStdoutEof && targetStderrEof && !!closure?.jobCreated && closure.allRootsWaitObserved && closure.jobEmptyObserved
      && closure.allStdoutEof && closure.allStderrEof && closure.cleanupConfirmed && closure.gracefulStopArmed
      && !closure.gracefulStopTimedOut && !closure.forcedJobTermination && unchanged && writtenBytes === sentBytes;
    resolve(Object.freeze({ helperPid: child.pid, helper: Object.freeze({ ...observed }), terminal,
      failure: failure ?? (normal ? undefined : "normal-closure-not-established"), inputsUnchanged: unchanged,
      normalShutdown: normal, inputChunksWritten: writtenChunks, inputBytesWritten: writtenBytes }));
  }));
  function dispatch(action: ApplicationBrokerAction): Promise<ApplicationBrokerReply> {
    if (work || failure || observed.closed || (stopping && action.kind !== "shutdown")) return Promise.reject(Error("Broker command unavailable"));
    let bytes: Buffer, current: number;
    try {
      const command = parseApplicationBrokerCommand({ ...action, version: 1, sequence: brokerSequence++ }); current = command.sequence;
      bytes = Buffer.from(JSON.stringify(command) + "\n");
      if (bytes.length > limits.lineBytes || sentBytes + bytes.length > limits.totalInputBytes) throw Error("Broker input bound");
      sentBytes += bytes.length;
    } catch (error) { fail("broker-command-invalid"); return Promise.reject(error); }
    const operation = (async () => {
      const timer = setTimeout(() => fail("command-deadline"), 15_000);
      try {
        await ready;
        const reply = new Promise<ApplicationBrokerReply>((resolve, reject) => { pendingReply = { sequence: current, resolve, reject }; });
        void reply.catch(() => {});
        for (let offset = 0; offset < bytes.length; offset += limits.nativeChunkBytes) await nativeControl("daemon-input", bytes.subarray(offset, offset + limits.nativeChunkBytes));
        if (failure || stopNonce || observed.closed) throw Error("Broker delivery no longer current");
        const value = await reply;
        if (failure || stopNonce || observed.closed) throw Error("Broker delivery no longer current");
        return value;
      } catch (error) { fail("broker-command-failed"); throw error; }
      finally { clearTimeout(timer); }
    })();
    work = operation; void operation.finally(() => { if (work === operation) work = undefined; }).catch(() => {}); return operation;
  }
  function stop(): Promise<ApplicationBrokerProcessReceipt> {
    return stopWork ??= (async () => {
      try {
        await ready; if (work) await work; stopping = true;
        const timer = setTimeout(() => fail("stop-deadline"), 35_000);
        try { await nativeControl("arm-graceful-stop"); await dispatch({ kind: "shutdown" }); await closed; }
        finally { clearTimeout(timer); }
      } catch { fail("broker-stop-failed"); }
      return await closed;
    })();
  }
  child.stdin.write(launchLine, error => { if (error) fail("launch-write"); });
  return Object.freeze({ ready, closed, command: (action: Exclude<ApplicationBrokerAction, { kind: "shutdown" }>) => dispatch(action),
    stop, cancel: () => { fail("cancelled"); return closed; } });
}
