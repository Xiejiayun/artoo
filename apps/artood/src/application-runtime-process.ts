import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename, dirname } from "node:path";
import { realpathSync } from "node:fs";
import { isPromise } from "node:util/types";
import { TextDecoder } from "node:util";
import type { z } from "zod";
import { loadApplicationRuntimeConfiguration, loadApplicationRuntimeHelperManifest, readApplicationRuntimePin } from "./application-runtime-installation.js";
import { APPLICATION_RUNTIME_PROCESS_LIMITS as limits, ApplicationRuntimeFilePinSchema, ApplicationRuntimeNativeOutputSchema,
  ApplicationRuntimeOutputSchema, type ApplicationRuntimeFilePin, type ApplicationRuntimeTerminalSchema,
  decodeApplicationRuntimeBytes } from "./application-runtime-process-protocol.js";

export interface ApplicationRuntimeInstallation {
  readonly helper: ApplicationRuntimeFilePin;
  readonly helperManifest: ApplicationRuntimeFilePin;
  readonly node: ApplicationRuntimeFilePin;
  /** Complete fixed trusted single-file bundle. Protected local admission must
   * bind its reviewed build/import closure; an ordinary tsc entry is not one. */
  readonly entry: ApplicationRuntimeFilePin;
  readonly configuration: ApplicationRuntimeFilePin;
  /** Original protected-local installation/artifact authority, never task text. */
  readonly assertLocalAdmission: () => void;
}
declare const preparedBrand: unique symbol;
export interface PreparedApplicationRuntimeProcess { readonly [preparedBrand]: true }
function admission(check: () => void): void {
  const result: unknown = check();
  if (result !== undefined) {
    if (isPromise(result)) void Reflect.apply(Promise.prototype.then, result, [undefined, () => {}]);
    throw Error("Runtime admission must complete synchronously");
  }
}
function prepare(input: ApplicationRuntimeInstallation) {
  if (process.platform !== "win32" || process.arch !== "x64" || typeof input.assertLocalAdmission !== "function") throw Error("Native Windows runtime installation required");
  const fixed = Object.freeze({ helper: Object.freeze(ApplicationRuntimeFilePinSchema.parse(input.helper)),
    helperManifest: Object.freeze(ApplicationRuntimeFilePinSchema.parse(input.helperManifest)),
    node: Object.freeze(ApplicationRuntimeFilePinSchema.parse(input.node)), entry: Object.freeze(ApplicationRuntimeFilePinSchema.parse(input.entry)),
    configuration: Object.freeze(ApplicationRuntimeFilePinSchema.parse(input.configuration)) });
  if (basename(fixed.helper.path).toLowerCase() !== "artoo-quickjs-process-host.exe"
    || basename(fixed.node.path).toLowerCase() !== "node.exe" || basename(fixed.entry.path) !== "application-runtime.mjs"
    || basename(fixed.configuration.path) !== "application-runtime.json"
    || dirname(fixed.configuration.path) !== dirname(fixed.entry.path)) throw Error("Fixed runtime installation names required");
  const check = input.assertLocalAdmission;
  admission(check); for (const pin of Object.values(fixed)) readApplicationRuntimePin(pin);
  const helperFiles = loadApplicationRuntimeHelperManifest(fixed.helper, fixed.helperManifest);
  const loaded = loadApplicationRuntimeConfiguration(fixed.configuration);
  const closure = new Map<string, ApplicationRuntimeFilePin>(); let bytes = 0;
  for (const pin of [fixed.node, fixed.entry, fixed.configuration, ...loaded.runtimeFiles]) {
    const key = pin.path.toLowerCase(), previous = closure.get(key);
    if (previous) { if (JSON.stringify(previous) !== JSON.stringify(pin)) throw Error("Runtime role pin conflict"); continue; }
    closure.set(key, pin); bytes += pin.bytes;
  }
  if (closure.size > limits.files || bytes > limits.allFileBytes) throw Error("Runtime installation exceeds bound");
  const recheck = (): void => {
    admission(check);
    const current = loadApplicationRuntimeHelperManifest(fixed.helper, fixed.helperManifest);
    if (JSON.stringify(current) !== JSON.stringify(helperFiles)) throw Error("Runtime native package changed");
    for (const pin of closure.values()) readApplicationRuntimePin(pin);
  };
  recheck();
  const systemRoot = realpathSync.native(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "");
  return { fixed, runtimeFiles: loaded.runtimeFiles, recheck, systemRoot, used: false };
}
const preparations = new WeakMap<object, ReturnType<typeof prepare>>();
export function prepareApplicationRuntimeProcess(input: ApplicationRuntimeInstallation): PreparedApplicationRuntimeProcess {
  const token = Object.freeze({}) as PreparedApplicationRuntimeProcess; preparations.set(token, prepare(input)); return token;
}
export interface ApplicationRuntimeProcessReceipt {
  readonly helperPid: number | undefined;
  readonly helper: Readonly<{ spawned: boolean; exited: boolean; closed: boolean; stdoutEof: boolean; stderrEof: boolean;
    exitCode: number | null; closeCode: number | null; signal: NodeJS.Signals | null; closeSignal: NodeJS.Signals | null }>;
  readonly terminal: z.infer<typeof ApplicationRuntimeTerminalSchema> | undefined;
  readonly failure: string | undefined;
  readonly inputsUnchanged: boolean;
  readonly closureConfirmed: boolean;
  readonly normalShutdown: boolean;
  readonly runtimeDisposed: boolean;
  readonly inputBytesWritten: number;
  readonly outputBytesReceived: number;
}
export interface ApplicationRuntimeProcess {
  readonly ready: Promise<void>;
  readonly closed: Promise<ApplicationRuntimeProcessReceipt>;
  /** Resolves after the original native target writes, never merely an ACK queue. */
  receive(bytes: Uint8Array): Promise<void>;
  /** Exactly one reader; only original actual channel bytes, never fixture data. */
  readOutput(): Promise<Uint8Array | undefined>;
  close(): Promise<ApplicationRuntimeProcessReceipt>;
  cancel(): Promise<ApplicationRuntimeProcessReceipt>;
}

/** Deadline is the initiating host's original performance.now() expiry. This
 * creates the original helper; it cannot adopt a PID or serialized owner. */
export function startApplicationRuntimeProcess(token: PreparedApplicationRuntimeProcess, deadline: number): ApplicationRuntimeProcess {
  const saved = preparations.get(token);
  if (!saved || saved.used || !Number.isFinite(deadline)) throw Error("Original unused runtime preparation required");
  saved.recheck();
  const remaining = Math.floor(deadline - performance.now());
  if (remaining < 1 || remaining > limits.lifetimeMs) throw Error("Runtime original deadline elapsed");
  const { fixed } = saved;
  const launch = Buffer.from(JSON.stringify({ version: 1, kind: "launch", node: fixed.node, entry: fixed.entry,
    configuration: fixed.configuration, runtimeFiles: saved.runtimeFiles, cwd: dirname(fixed.entry.path), lifetimeMs: remaining }) + "\n");
  if (launch.length > limits.nativeLineBytes) throw Error("Runtime launch exceeds bound");
  const cancelNonce = randomUUID();
  saved.used = true;
  const child = spawn(fixed.helper.path, ["--application-quickjs-owner-v1"], { cwd: dirname(fixed.helper.path), windowsHide: true,
    detached: false, shell: false, stdio: ["pipe", "pipe", "pipe"], env: { SystemRoot: saved.systemRoot, WINDIR: saved.systemRoot } });
  const observed = { spawned: false, exited: false, closed: false, stdoutEof: false, stderrEof: false,
    exitCode: null as number | null, closeCode: null as number | null, signal: null as NodeJS.Signals | null, closeSignal: null as NodeJS.Signals | null };
  let failure: string | undefined, started: z.infer<typeof ApplicationRuntimeNativeOutputSchema> & { kind: "started" } | undefined;
  let terminal: ApplicationRuntimeProcessReceipt["terminal"], admitted = false, runtimeReady = false, runtimeDisposed = false;
  let stopping = false, cancelled = false, inputClosed = false, nativeSequence = 0, childSequence = 0, controlSequence = 0, commandSequence = 0;
  let helperBytes = 0, helperErrors = 0, targetBytes = 0, targetErrors = 0, outputBytes = 0, sentBytes = 0, writtenBytes = 0, writes = 0;
  let nativePending = "", childPending = "", queuedBytes = 0;
  const nativeDecoder = new TextDecoder("utf-8", { fatal: true }), targetDecoder = new TextDecoder("utf-8", { fatal: true });
  const queue: Buffer[] = [];
  let reader: { resolve: (value: Uint8Array | undefined) => void; reject: (error: Error) => void } | undefined;
  let resolveReady!: () => void, rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; }); void ready.catch(() => {});
  let pending: { nonce: string; kind: "write" | "close-input"; bytes: number; resolve: () => void; reject: (error: Error) => void } | undefined;
  let working: Promise<void> | undefined, closeWork: Promise<ApplicationRuntimeProcessReceipt> | undefined;
  let emergency: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => fail("runtime-deadline"), Math.max(1, deadline - performance.now()));
  function fail(code: string): void {
    failure ??= code; rejectReady(Error(failure)); pending?.reject(Error(failure)); pending = undefined;
    reader?.reject(Error(failure)); reader = undefined; queue.length = 0; queuedBytes = 0;
    if (observed.closed) return;
    if (!cancelled) {
      cancelled = true;
      try { child.stdin.write(JSON.stringify({ version: 1, sequence: controlSequence++, kind: "cancel", nonce: cancelNonce }) + "\n", () => {}); }
      catch { /* Original helper still owns the Job; retain uncertain closure on transport failure. */ }
    }
    emergency ??= setTimeout(() => { child.kill(); }, limits.cleanupMs + 2_000);
  }
  function check(): void { if (failure || observed.closed || performance.now() >= deadline) { fail("runtime-unavailable"); throw Error(failure); } }
  function nativeControl(kind: "write" | "close-input", bytes?: Buffer): Promise<void> {
    check();
    if (pending || !admitted || inputClosed || bytes && (++writes > limits.nativeWrites || bytes.length < 1 || bytes.length > limits.nativeChunkBytes)) throw Error("runtime-write-bound");
    const nonce = randomUUID();
    return new Promise<void>((resolve, reject) => {
      pending = { nonce, kind, bytes: bytes?.length ?? 0, resolve, reject };
      try { child.stdin.write(JSON.stringify({ version: 1, sequence: controlSequence++, kind, nonce,
        ...(bytes ? { data: bytes.toString("base64") } : {}) }) + "\n", error => { if (error) fail("runtime-control-write"); }); }
      catch { fail("runtime-control-write"); }
    });
  }
  async function send(kind: "receive" | "close", data?: Uint8Array): Promise<void> {
    check();
    if (commandSequence >= limits.inputCommands) throw Error("runtime-command-bound");
    const bytes = Buffer.from(JSON.stringify({ version: 1, sequence: commandSequence++, kind,
      ...(data ? { data: Buffer.from(data).toString("base64") } : {}) }) + "\n");
    sentBytes += bytes.length;
    if (bytes.length > limits.childLineBytes || sentBytes > limits.childInputBytes - 256) throw Error("runtime-input-bound");
    for (let offset = 0; offset < bytes.length; offset += limits.nativeChunkBytes) {
      await nativeControl("write", bytes.subarray(offset, offset + limits.nativeChunkBytes)); check();
    }
  }
  function targetLine(line: string): void {
    if (Buffer.byteLength(line) + 1 > limits.childLineBytes) throw Error("runtime-output-line");
    const value = ApplicationRuntimeOutputSchema.parse(JSON.parse(line));
    if (value.sequence !== childSequence++ || runtimeDisposed) throw Error("runtime-output-sequence");
    if (value.kind === "ready") {
      if (runtimeReady || stopping) throw Error("runtime-ready"); runtimeReady = true;
      if (admitted && !failure) resolveReady();
    } else if (value.kind === "output") {
      if (!runtimeReady || stopping) throw Error("runtime-output-state");
      const bytes = decodeApplicationRuntimeBytes(value.payload.data, limits.childChunkBytes); outputBytes += bytes.length;
      if (reader) { const current = reader; reader = undefined; current.resolve(bytes); }
      else {
        queuedBytes += bytes.length;
        if (queuedBytes > limits.queuedOutputBytes) throw Error("runtime-output-queue"); queue.push(bytes);
      }
    } else {
      if (!runtimeReady || !stopping) throw Error("runtime-closed-state"); runtimeDisposed = true;
    }
  }
  function nativeLine(line: string): void {
    if (Buffer.byteLength(line) + 1 > limits.nativeLineBytes) throw Error("runtime-native-line");
    const frame = ApplicationRuntimeNativeOutputSchema.parse(JSON.parse(line));
    if (frame.sequence !== nativeSequence || terminal) throw Error("runtime-native-sequence");
    nativeSequence++;
    if (frame.kind === "started") {
      if (started || frame.payload.pid === child.pid || frame.payload.image.toLowerCase() !== fixed.node.path.toLowerCase()) throw Error("runtime-target-identity");
      started = frame;
    } else if (frame.kind === "admitted") {
      if (!started || admitted || frame.payload.remainingMs > remaining) throw Error("runtime-native-admission");
      admitted = true; if (runtimeReady && !failure) resolveReady();
    } else if (frame.kind === "input-written" || frame.kind === "input-closed") {
      if (failure) return;
      if (!pending || pending.nonce !== frame.payload.nonce || pending.kind !== (frame.kind === "input-written" ? "write" : "close-input")) throw Error("runtime-write-binding");
      if (frame.kind === "input-written") {
        if (frame.payload.bytes !== pending.bytes) throw Error("runtime-write-count"); writtenBytes += frame.payload.bytes;
      } else inputClosed = true;
      const current = pending; pending = undefined; current.resolve();
    } else if (frame.kind === "output") {
      if (!started) throw Error("runtime-output-before-start");
      const bytes = decodeApplicationRuntimeBytes(frame.payload.data, 8192);
      if (frame.payload.stream === "stderr") { targetErrors += bytes.length; if (targetErrors > limits.stderrBytes) throw Error("runtime-stderr-bound"); fail("runtime-target-stderr"); }
      else {
        targetBytes += bytes.length; if (targetBytes > limits.childOutputBytes) throw Error("runtime-stdout-bound");
        if (failure) return;
        childPending += targetDecoder.decode(bytes, { stream: true });
        for (let end; (end = childPending.indexOf("\n")) >= 0;) {
          const value = childPending.slice(0, end); childPending = childPending.slice(end + 1); targetLine(value);
        }
        if (Buffer.byteLength(childPending) > limits.childLineBytes) throw Error("runtime-output-line");
      }
    } else {
      if (started && frame.payload.pid !== started.payload.pid || !started && frame.payload.pid !== null) throw Error("runtime-terminal-binding");
      terminal = frame.payload;
      if (!failure) { childPending += targetDecoder.decode(); if (childPending.length) throw Error("runtime-output-truncated"); }
    }
  }
  child.once("spawn", () => { observed.spawned = true; });
  child.once("exit", (code, signal) => { observed.exited = true; observed.exitCode = code; observed.signal = signal; });
  child.once("error", () => fail("runtime-helper-error"));
  child.stdin.on("error", () => fail("runtime-helper-input"));
  child.stdout.on("data", (bytes: Buffer) => {
    try {
      helperBytes += bytes.length; if (helperBytes > limits.helperOutputBytes) throw Error("runtime-helper-output-bound");
      nativePending += nativeDecoder.decode(bytes, { stream: true });
      for (let end; (end = nativePending.indexOf("\n")) >= 0;) {
        const line = nativePending.slice(0, end); nativePending = nativePending.slice(end + 1);
        // A valid ordered frame with a rejected ACK binding cannot hide a later
        // original terminal in this same OS read. Invalid schema/sequence never
        // resynchronizes the counter and cannot yield a closure capability.
        try { nativeLine(line); } catch { fail("runtime-native-protocol"); }
      }
      if (Buffer.byteLength(nativePending) > limits.nativeLineBytes) throw Error("runtime-native-line");
    } catch { fail("runtime-native-protocol"); }
  });
  child.stderr.on("data", (bytes: Buffer) => { helperErrors += bytes.length; fail(helperErrors > limits.stderrBytes ? "runtime-helper-stderr-bound" : "runtime-helper-stderr"); });
  child.stdout.on("error", () => fail("runtime-helper-output"));
  child.stderr.on("error", () => fail("runtime-helper-output"));
  child.stdout.once("end", () => { observed.stdoutEof = true; try { nativePending += nativeDecoder.decode(); if (nativePending.length) fail("runtime-native-truncated"); } catch { fail("runtime-native-utf8"); } });
  child.stderr.once("end", () => { observed.stderrEof = true; });
  const closed = new Promise<ApplicationRuntimeProcessReceipt>(resolve => child.once("close", (code, signal) => {
    observed.closed = true; observed.closeCode = code; observed.closeSignal = signal;
    clearTimeout(timer); clearTimeout(emergency);
    rejectReady(Error("Original runtime owner closed")); pending?.reject(Error("Original runtime owner closed")); pending = undefined;
    let unchanged = false; try { saved.recheck(); unchanged = true; } catch { failure ??= "runtime-installation-changed"; }
    // The timer cannot run during synchronous admission/hash work. Its original
    // expiry still applies to the receipt after that work finally returns.
    if (performance.now() >= deadline) failure ??= "runtime-deadline";
    const closure = observed.spawned && observed.exited && observed.stdoutEof && observed.stderrEof && !!terminal
      && terminal.originalExitObserved && terminal.jobAssigned && terminal.jobLimitsReadBack && terminal.jobEmptyObserved
      && terminal.inputSettled && terminal.inputClosed && terminal.stdoutEof && terminal.stderrEof && terminal.outputTasksSettled;
    const normal = closure && !failure && !!terminal && terminal.failure === null && terminal.exitCode === 0
      && !terminal.terminationRequested && !terminal.terminationSucceeded && terminal.inputsUnchanged && unchanged
      && code === 0 && observed.exitCode === 0 && signal === null && observed.signal === null
      && stopping && inputClosed && runtimeDisposed && queuedBytes === 0 && writtenBytes === sentBytes;
    if (!normal) failure ??= "runtime-normal-closure-not-established";
    if (reader) { const current = reader; reader = undefined; if (failure) current.reject(Error(failure)); else current.resolve(undefined); }
    resolve(Object.freeze({ helperPid: child.pid, helper: Object.freeze({ ...observed }), terminal,
      failure, inputsUnchanged: unchanged, closureConfirmed: closure, normalShutdown: normal, runtimeDisposed,
      inputBytesWritten: writtenBytes, outputBytesReceived: outputBytes }));
  }));
  function receive(bytes: Uint8Array): Promise<void> {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > limits.childChunkBytes || working || stopping) return Promise.reject(Error("Runtime receive unavailable"));
    const copy = Buffer.from(bytes);
    const operation = (async () => { try { await ready; check(); await send("receive", copy); } catch (error) { fail("runtime-receive"); throw error; } })();
    working = operation; void operation.finally(() => { if (working === operation) working = undefined; }).catch(() => {}); return operation;
  }
  function close(): Promise<ApplicationRuntimeProcessReceipt> {
    return closeWork ??= (async () => {
      try {
        await ready; if (working) await working; check(); stopping = true;
        if (queuedBytes) throw Error("runtime-undelivered-output");
        await send("close"); await nativeControl("close-input");
      } catch { fail("runtime-close"); }
      return await closed;
    })();
  }
  try { child.stdin.write(launch, error => { if (error) fail("runtime-launch-write"); }); } catch { fail("runtime-launch-write"); }
  return Object.freeze({ ready, closed, receive,
    readOutput() {
      if (reader) return Promise.reject(Error("Runtime output already has an original reader"));
      if (failure) return Promise.reject(Error(failure));
      const bytes = queue.shift(); if (bytes) { queuedBytes -= bytes.length; return Promise.resolve(bytes); }
      if (observed.closed) return Promise.resolve(undefined);
      return new Promise<Uint8Array | undefined>((resolve, reject) => { reader = { resolve, reject }; });
    }, close, cancel() { fail("cancelled"); return closed; },
  });
}
