import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname } from "node:path";
import { isPromise } from "node:util/types";
import { TextDecoder } from "node:util";
import type { z } from "zod";
import { createApplicationCompilerCaptureOwner, type ApplicationCompilerContent,
  type CapturedApplicationCompilerContent } from "./application-compiler-capture.js";
import { loadApplicationCompilerConfiguration } from "./application-compiler-installation.js";
import { APPLICATION_COMPILER_PROCESS_LIMITS as limits, ApplicationCompilerNativeOutputSchema } from "./application-compiler-process-protocol.js";
import { loadApplicationRuntimeHelperManifest, readApplicationRuntimePin } from "./application-runtime-installation.js";
import { ApplicationRuntimeFilePinSchema, decodeApplicationRuntimeBytes,
  type ApplicationRuntimeFilePin, type ApplicationRuntimeTerminalSchema } from "./application-runtime-process-protocol.js";

export interface ApplicationCompilerInstallation {
  readonly helper: ApplicationRuntimeFilePin;
  readonly helperManifest: ApplicationRuntimeFilePin;
  readonly node: ApplicationRuntimeFilePin;
  /** Fixed reviewed single-file compiler host bundle, not an ordinary tsc entry. */
  readonly entry: ApplicationRuntimeFilePin;
  readonly configuration: ApplicationRuntimeFilePin;
  /** Original protected-local authority. Task text cannot provide this callback. */
  readonly assertLocalAdmission: () => void;
}
declare const preparedBrand: unique symbol;
export interface PreparedApplicationCompilerProcess { readonly [preparedBrand]: true }
function admission(check: () => void): void {
  const result: unknown = check();
  if (result !== undefined) {
    if (isPromise(result)) void Reflect.apply(Promise.prototype.then, result, [undefined, () => {}]);
    throw Error("Compiler admission must complete synchronously");
  }
}
function prepare(input: ApplicationCompilerInstallation) {
  const names = ["helper", "helperManifest", "node", "entry", "configuration", "assertLocalAdmission"];
  if (process.platform !== "win32" || process.arch !== "x64" || !input || typeof input.assertLocalAdmission !== "function"
    || Reflect.ownKeys(input).length !== names.length || names.some(name => !Object.hasOwn(input, name)))
    throw Error("Fixed native Windows compiler installation required");
  const fixed = Object.freeze({ helper: Object.freeze(ApplicationRuntimeFilePinSchema.parse(input.helper)),
    helperManifest: Object.freeze(ApplicationRuntimeFilePinSchema.parse(input.helperManifest)),
    node: Object.freeze(ApplicationRuntimeFilePinSchema.parse(input.node)), entry: Object.freeze(ApplicationRuntimeFilePinSchema.parse(input.entry)),
    configuration: Object.freeze(ApplicationRuntimeFilePinSchema.parse(input.configuration)) });
  if (basename(fixed.helper.path) !== "artoo-quickjs-process-host.exe"
    || basename(fixed.node.path).toLowerCase() !== "node.exe" || basename(fixed.entry.path) !== "application-compiler-process.mjs"
    || basename(fixed.configuration.path) !== "application-compiler-process.json"
    || dirname(fixed.configuration.path) !== dirname(fixed.entry.path)) throw Error("Fixed compiler installation names required");
  const check = input.assertLocalAdmission;
  admission(check); for (const pin of Object.values(fixed)) readApplicationRuntimePin(pin);
  const helperFiles = loadApplicationRuntimeHelperManifest(fixed.helper, fixed.helperManifest);
  const loaded = loadApplicationCompilerConfiguration(fixed.configuration);
  const files = Object.freeze(loaded.files.map(pin => Object.freeze(ApplicationRuntimeFilePinSchema.parse(pin))));
  const closure = new Map<string, ApplicationRuntimeFilePin>(); let bytes = 0;
  for (const pin of [fixed.node, fixed.entry, fixed.configuration, ...files]) {
    const key = pin.path.toLowerCase(), previous = closure.get(key);
    if (previous) { if (JSON.stringify(previous) !== JSON.stringify(pin)) throw Error("Compiler role pin conflict"); continue; }
    closure.set(key, pin); bytes += pin.bytes;
  }
  if (closure.size > limits.files || bytes > limits.allFileBytes) throw Error("Compiler installation exceeds bound");
  const recheck = (): void => {
    admission(check);
    const current = loadApplicationRuntimeHelperManifest(fixed.helper, fixed.helperManifest);
    if (JSON.stringify(current) !== JSON.stringify(helperFiles)) throw Error("Compiler native package changed");
    // Re-read the complete fixed package inventory, not only listed file hashes.
    if (JSON.stringify(loadApplicationCompilerConfiguration(fixed.configuration).files) !== JSON.stringify(files))
      throw Error("Compiler toolchain package changed");
    for (const pin of closure.values()) readApplicationRuntimePin(pin);
  };
  recheck();
  const compilerInputs = Object.freeze({ compilerVersion: loaded.compilerInputs.compilerVersion,
    libraries: Object.freeze(loaded.compilerInputs.libraries.map(file => Object.freeze({ path: file.path, text: file.text }))) });
  const systemRoot = realpathSync.native(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "");
  return { fixed, files, recheck, compilerInputs, systemRoot, used: false };
}
const preparations = new WeakMap<object, ReturnType<typeof prepare>>();
export function prepareApplicationCompilerProcess(input: ApplicationCompilerInstallation): PreparedApplicationCompilerProcess {
  const token = Object.freeze({}) as PreparedApplicationCompilerProcess; preparations.set(token, prepare(input)); return token;
}

export interface ApplicationCompilerProcessReceipt {
  readonly helperPid: number | undefined;
  readonly helper: Readonly<{ spawned: boolean; exited: boolean; closed: boolean; stdoutEof: boolean; stderrEof: boolean;
    exitCode: number | null; closeCode: number | null; signal: NodeJS.Signals | null; closeSignal: NodeJS.Signals | null }>;
  readonly terminal: z.infer<typeof ApplicationRuntimeTerminalSchema> | undefined;
  readonly failure: string | undefined;
  readonly inputsUnchanged: boolean;
  readonly closureConfirmed: boolean;
  readonly normalShutdown: boolean;
  readonly contentValidated: boolean;
  readonly inputBytesWritten: number;
  readonly outputBytesReceived: number;
  readonly qualified_for_product: false;
}
export interface ApplicationCompilerProcess {
  /** Content is withheld until this original helper and target have both closed. */
  readonly completed: Promise<CapturedApplicationCompilerContent>;
  readonly closed: Promise<ApplicationCompilerProcessReceipt>;
  read(captured: CapturedApplicationCompilerContent): ApplicationCompilerContent;
  cancel(): Promise<ApplicationCompilerProcessReceipt>;
}

const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const getter = (name: string) => Object.getOwnPropertyDescriptor(typedArray, name)!.get!;
const byteLengthOf = getter("byteLength"), bufferOf = getter("buffer"), byteOffsetOf = getter("byteOffset");
const arrayBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")!.get!;
const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get;
function copyRequest(bytes: Uint8Array): Buffer {
  // Measure original storage before allocation. Shadowed accessors, shared,
  // resizable and detached storage cannot redefine the request byte budget.
  try {
    if (!(bytes instanceof Uint8Array)) throw Error();
    const buffer: unknown = Reflect.apply(bufferOf, bytes, []), length: number = Reflect.apply(byteLengthOf, bytes, []);
    Reflect.apply(arrayBufferLength, buffer, []);
    if (length < 1 || length > limits.requestBytes || resizable && Reflect.apply(resizable, buffer, [])) throw Error();
    return Buffer.from(new Uint8Array(buffer as ArrayBuffer, Reflect.apply(byteOffsetOf, bytes, []), length));
  } catch { throw Error("compiler-request-storage"); }
}

/** Deadline belongs to the initiating host. No adopted PID, serialized owner,
 * raw output reader, caller command or selectable execution mode is accepted. */
export function startApplicationCompilerProcess(token: PreparedApplicationCompilerProcess, request: Uint8Array,
  deadline: number): ApplicationCompilerProcess {
  const saved = preparations.get(token);
  if (!saved || saved.used || !Number.isFinite(deadline)) throw Error("Original unused compiler preparation required");
  saved.used = true;
  const requestBytes = copyRequest(request);
  const capture = createApplicationCompilerCaptureOwner(requestBytes, saved.compilerInputs);
  saved.recheck();
  const remaining = Math.floor(deadline - performance.now());
  if (remaining < 1 || remaining > limits.lifetimeMs) throw Error("Compiler original deadline elapsed");
  const { fixed } = saved;
  const launch = Buffer.from(JSON.stringify({ version: 1, kind: "launch", node: fixed.node, entry: fixed.entry,
    configuration: fixed.configuration, runtimeFiles: saved.files, cwd: dirname(fixed.entry.path), lifetimeMs: remaining }) + "\n");
  if (launch.length > limits.nativeLineBytes) throw Error("Compiler launch exceeds bound");
  const cancelNonce = randomUUID();
  const child = spawn(fixed.helper.path, ["--application-quickjs-compiler-owner-v1"], { cwd: dirname(fixed.helper.path), windowsHide: true,
    detached: false, shell: false, stdio: ["pipe", "pipe", "pipe"], env: { SystemRoot: saved.systemRoot, WINDIR: saved.systemRoot } });
  const observed = { spawned: false, exited: false, closed: false, stdoutEof: false, stderrEof: false,
    exitCode: null as number | null, closeCode: null as number | null, signal: null as NodeJS.Signals | null, closeSignal: null as NodeJS.Signals | null };
  let failure: string | undefined, started: z.infer<typeof ApplicationCompilerNativeOutputSchema> & { kind: "started" } | undefined;
  let terminal: ApplicationCompilerProcessReceipt["terminal"], admitted = false, cancelled = false, inputClosed = false, contentEof = false;
  let nativeSequence = 0, controlSequence = 0, helperBytes = 0, helperErrors = 0, targetBytes = 0, targetErrors = 0, writtenBytes = 0, writes = 0;
  let nativePending = "", queuedBytes = 0, captured: CapturedApplicationCompilerContent | undefined, delivered = false;
  const decoder = new TextDecoder("utf-8", { fatal: true }), queue: Buffer[] = [];
  let reader: { resolve: (value: Uint8Array | undefined) => void; reject: (error: Error) => void } | undefined;
  let resolveAdmitted!: () => void, rejectAdmitted!: (error: Error) => void;
  const admissionReady = new Promise<void>((resolve, reject) => { resolveAdmitted = resolve; rejectAdmitted = reject; });
  void admissionReady.catch(() => {});
  let pending: { nonce: string; kind: "write" | "close-input"; bytes: number; resolve: () => void; reject: (error: Error) => void } | undefined;
  let emergency: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => fail("compiler-deadline"), Math.max(1, deadline - performance.now()));
  function revoke(): void { if (captured) { capture.revoke(captured); captured = undefined; } delivered = false; }
  function fail(code: string): void {
    failure ??= code; revoke(); rejectAdmitted(Error(failure)); pending?.reject(Error(failure)); pending = undefined;
    reader?.reject(Error(failure)); reader = undefined; queue.length = 0; queuedBytes = 0;
    if (observed.closed) return;
    if (!cancelled) {
      cancelled = true;
      try { child.stdin.write(JSON.stringify({ version: 1, sequence: controlSequence++, kind: "cancel", nonce: cancelNonce }) + "\n", () => {}); }
      catch { /* The original helper still owns the Job. Transport failure proves no closure. */ }
    }
    emergency ??= setTimeout(() => { child.kill(); }, limits.cleanupMs + 2_000);
  }
  function check(): void {
    if (failure || observed.closed || performance.now() >= deadline) { fail("compiler-unavailable"); throw Error(failure); }
  }
  function nativeControl(kind: "write" | "close-input", bytes?: Buffer): Promise<void> {
    check();
    if (pending || !admitted || inputClosed || bytes && (++writes > limits.nativeWrites || bytes.length < 1 || bytes.length > limits.nativeChunkBytes))
      throw Error("compiler-write-bound");
    const nonce = randomUUID();
    return new Promise<void>((resolve, reject) => {
      pending = { nonce, kind, bytes: bytes?.length ?? 0, resolve, reject };
      try { child.stdin.write(JSON.stringify({ version: 1, sequence: controlSequence++, kind, nonce,
        ...(bytes ? { data: bytes.toString("base64") } : {}) }) + "\n", error => { if (error) fail("compiler-control-write"); }); }
      catch { fail("compiler-control-write"); }
    });
  }
  const contentStream: AsyncIterable<Uint8Array> = { async *[Symbol.asyncIterator]() {
    for (;;) {
      if (failure) throw Error(failure);
      let bytes = queue.shift();
      if (bytes) queuedBytes -= bytes.length;
      else if (contentEof) return;
      else bytes = await new Promise<Uint8Array | undefined>((resolve, reject) => { reader = { resolve, reject }; }) as Buffer | undefined;
      if (bytes === undefined) return;
      yield bytes;
    }
  } };
  const captureWork = capture.capture(contentStream).then(value => {
    captured = value; if (failure) revoke();
  }, () => { fail("compiler-content-rejected"); });
  function nativeLine(line: string): void {
    if (Buffer.byteLength(line) + 1 > limits.nativeLineBytes) throw Error("compiler-native-line");
    const frame = ApplicationCompilerNativeOutputSchema.parse(JSON.parse(line));
    if (frame.sequence !== nativeSequence || terminal) throw Error("compiler-native-sequence");
    nativeSequence++;
    if (frame.kind === "started") {
      if (started || frame.payload.pid === child.pid || frame.payload.image !== fixed.node.path) throw Error("compiler-target-identity");
      started = frame;
    } else if (frame.kind === "admitted") {
      if (!started || admitted || frame.payload.remainingMs > remaining) throw Error("compiler-native-admission");
      admitted = true; if (!failure) resolveAdmitted();
    } else if (frame.kind === "input-written" || frame.kind === "input-closed") {
      if (failure) return;
      if (!pending || pending.nonce !== frame.payload.nonce || pending.kind !== (frame.kind === "input-written" ? "write" : "close-input"))
        throw Error("compiler-write-binding");
      if (frame.kind === "input-written") {
        if (frame.payload.bytes !== pending.bytes) throw Error("compiler-write-count"); writtenBytes += frame.payload.bytes;
      } else inputClosed = true;
      const current = pending; pending = undefined; current.resolve();
    } else if (frame.kind === "output") {
      if (!started) throw Error("compiler-output-before-start");
      const bytes = decodeApplicationRuntimeBytes(frame.payload.data, 8192);
      if (frame.payload.stream === "stderr") {
        targetErrors += bytes.length; if (targetErrors > limits.stderrBytes) throw Error("compiler-stderr-bound"); fail("compiler-target-stderr");
      } else {
        targetBytes += bytes.length; if (targetBytes > limits.responseBytes) throw Error("compiler-stdout-bound");
        if (failure) return;
        if (reader) { const current = reader; reader = undefined; current.resolve(bytes); }
        else { queuedBytes += bytes.length; if (queuedBytes > limits.queuedOutputBytes) throw Error("compiler-output-queue"); queue.push(bytes); }
      }
    } else {
      if (started && frame.payload.pid !== started.payload.pid || !started && frame.payload.pid !== null) throw Error("compiler-terminal-binding");
      terminal = Object.freeze(frame.payload);
      // This frame is not host EOF. Only the original helper close can finish capture.
    }
  }
  child.once("spawn", () => { observed.spawned = true; });
  child.once("exit", (code, signal) => { observed.exited = true; observed.exitCode = code; observed.signal = signal; });
  child.once("error", () => fail("compiler-helper-error"));
  child.stdin.on("error", () => fail("compiler-helper-input"));
  child.stdout.on("data", (bytes: Buffer) => {
    try {
      helperBytes += bytes.length; if (helperBytes > limits.helperOutputBytes) throw Error("compiler-helper-output-bound");
      nativePending += decoder.decode(bytes, { stream: true });
      for (let end; (end = nativePending.indexOf("\n")) >= 0;) {
        const line = nativePending.slice(0, end); nativePending = nativePending.slice(end + 1);
        // A rejected ordered ACK cannot hide a later actual terminal in one read.
        // Invalid schema/sequence never resynchronizes the ownership counter.
        try { nativeLine(line); } catch { fail("compiler-native-protocol"); }
      }
      if (Buffer.byteLength(nativePending) > limits.nativeLineBytes) throw Error("compiler-native-line");
    } catch { fail("compiler-native-protocol"); }
  });
  child.stderr.on("data", (bytes: Buffer) => { helperErrors += bytes.length; fail(helperErrors > limits.stderrBytes ? "compiler-helper-stderr-bound" : "compiler-helper-stderr"); });
  child.stdout.on("error", () => fail("compiler-helper-output"));
  child.stderr.on("error", () => fail("compiler-helper-output"));
  child.stdout.once("end", () => { observed.stdoutEof = true; try { nativePending += decoder.decode(); if (nativePending.length) fail("compiler-native-truncated"); } catch { fail("compiler-native-utf8"); } });
  child.stderr.once("end", () => { observed.stderrEof = true; });
  const closed = new Promise<ApplicationCompilerProcessReceipt>(resolve => child.once("close", (code, signal) => {
    observed.closed = true; observed.closeCode = code; observed.closeSignal = signal;
    clearTimeout(emergency);
    rejectAdmitted(Error("Original compiler owner closed"));
    if (pending) { pending.reject(Error("Original compiler owner closed")); pending = undefined; failure ??= "compiler-input-unsettled"; }
    void (async () => {
      const closure = observed.spawned && observed.exited && observed.stdoutEof && observed.stderrEof && !!terminal
        && terminal.originalExitObserved && terminal.jobAssigned && terminal.jobLimitsReadBack && terminal.jobEmptyObserved
        && terminal.inputSettled && terminal.inputClosed && terminal.stdoutEof && terminal.stderrEof && terminal.outputTasksSettled;
      const normalProcess = closure && !failure && !!terminal && terminal.failure === null && terminal.exitCode === 0
        && !terminal.terminationRequested && !terminal.terminationSucceeded && terminal.inputsUnchanged
        && code === 0 && observed.exitCode === 0 && signal === null && observed.signal === null
        && admitted && inputClosed && writtenBytes === requestBytes.length;
      if (!normalProcess) fail("compiler-normal-closure-not-established");
      else { contentEof = true; const current = reader; reader = undefined; current?.resolve(undefined); }
      await captureWork;
      let unchanged = false; try { saved.recheck(); unchanged = true; } catch { fail("compiler-installation-changed"); }
      // Original expiry also applies to synchronous content/hash/admission work.
      if (performance.now() >= deadline) fail("compiler-deadline");
      clearTimeout(timer);
      const normal = normalProcess && !failure && unchanged && !!captured && queuedBytes === 0;
      if (!normal) fail("compiler-completion-not-established");
      delivered = normal;
      resolve(Object.freeze({ helperPid: child.pid, helper: Object.freeze({ ...observed }), terminal,
        failure, inputsUnchanged: unchanged, closureConfirmed: closure, normalShutdown: normal, contentValidated: !!captured,
        inputBytesWritten: writtenBytes, outputBytesReceived: targetBytes, qualified_for_product: false }));
    })().catch(() => {
      fail("compiler-close-finalization"); clearTimeout(timer);
      resolve(Object.freeze({ helperPid: child.pid, helper: Object.freeze({ ...observed }), terminal, failure,
        inputsUnchanged: false, closureConfirmed: false, normalShutdown: false, contentValidated: false,
        inputBytesWritten: writtenBytes, outputBytesReceived: targetBytes, qualified_for_product: false }));
    });
  }));
  const completed = closed.then(receipt => {
    if (!receipt.normalShutdown || failure || !delivered || !captured) throw Error(failure ?? "compiler-completion-not-established");
    return captured;
  });
  void completed.catch(() => {});
  void (async () => {
    try {
      await admissionReady; check();
      for (let offset = 0; offset < requestBytes.length; offset += limits.nativeChunkBytes) {
        await nativeControl("write", requestBytes.subarray(offset, offset + limits.nativeChunkBytes)); check();
      }
      await nativeControl("close-input");
    } catch { fail("compiler-input"); }
  })();
  try { child.stdin.write(launch, error => { if (error) fail("compiler-launch-write"); }); } catch { fail("compiler-launch-write"); }
  return Object.freeze({ completed, closed,
    read(value: CapturedApplicationCompilerContent) {
      if (!delivered || failure || !captured || value !== captured) throw Error("Original completed compiler capture required");
      return capture.read(value);
    },
    cancel() { fail("cancelled"); return closed; },
  });
}
