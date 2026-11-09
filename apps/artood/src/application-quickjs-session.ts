import type { ApplicationArtifactOwner, CapturedApplicationArtifact } from "./application-artifact-admission.js";
import { APPLICATION_WIRE_LIMITS, ApplicationWireEncoder } from "./application-wire-v1.js";

/** Structural subset of the actual quickjs-emscripten 0.32.0 public API. No
 * interpreter, default variant or generated module is loaded by this module. */
export interface ApplicationQuickJSHandle { readonly alive: boolean; dispose(): void }
export type ApplicationQuickJSResult<T> = { readonly value: T; readonly error?: undefined }
  | { readonly error: ApplicationQuickJSHandle; readonly value?: undefined };
export type ApplicationQuickJSPromiseState = { readonly type: "pending" }
  | { readonly type: "fulfilled"; readonly value: ApplicationQuickJSHandle; readonly notAPromise?: boolean }
  | { readonly type: "rejected"; readonly error: ApplicationQuickJSHandle };
type ModuleText = string | { error: Error };
export interface ApplicationQuickJSContext {
  readonly alive: boolean;
  readonly runtime: ApplicationQuickJSRuntime;
  readonly undefined: ApplicationQuickJSHandle;
  evalCode(code: string, filename: string, options: { type: "global" | "module" }): ApplicationQuickJSResult<ApplicationQuickJSHandle>;
  getPromiseState(handle: ApplicationQuickJSHandle): ApplicationQuickJSPromiseState;
  typeof(handle: ApplicationQuickJSHandle): string;
  getProp(handle: ApplicationQuickJSHandle, key: string | number): ApplicationQuickJSHandle;
  getNumber(handle: ApplicationQuickJSHandle): number;
  newString(text: string): ApplicationQuickJSHandle;
  callFunction(fn: ApplicationQuickJSHandle, self: ApplicationQuickJSHandle, ...args: ApplicationQuickJSHandle[]): ApplicationQuickJSResult<ApplicationQuickJSHandle>;
  dispose(): void;
}
export interface ApplicationQuickJSRuntime {
  readonly alive: boolean;
  newContext(): ApplicationQuickJSContext;
  setMemoryLimit(bytes: number): void;
  setMaxStackSize(bytes: number): void;
  setInterruptHandler(handler: (runtime: ApplicationQuickJSRuntime) => boolean): void;
  setModuleLoader(loader: (name: string, context: ApplicationQuickJSContext) => ModuleText,
    normalizer: (base: string, name: string, context: ApplicationQuickJSContext) => ModuleText): void;
  hasPendingJob(): boolean;
  executePendingJobs(count: number): ApplicationQuickJSResult<number>;
  dispose(): void;
}
export interface ApplicationQuickJSModule { newRuntime(): ApplicationQuickJSRuntime }
export interface ApplicationQuickJSSessionBoundary {
  /** Register the exact originals with the before-start import adapter. These
   * callbacks cannot establish that the module/Wasm instance is qualified. */
  onRuntime(runtime: ApplicationQuickJSRuntime): void;
  onContext(context: ApplicationQuickJSContext): void;
  /** Must bound the actual FFI pointer/UTF-8 decode BEFORE host allocation. A
   * callback using plain context.getString is not an acceptable implementation. */
  boundedReadString(context: ApplicationQuickJSContext, handle: ApplicationQuickJSHandle, maxBytes: number): string;
}
export const APPLICATION_QUICKJS_SESSION_LIMITS = Object.freeze({
  heapBytes: 134_217_728, stackBytes: 524_288, lifetimeMs: 30_000,
  operations: 8_192, jobs: 4_096, jobsPerPump: 64, moduleCalls: 1_024,
  bootstrapBytes: 1_048_576, inputBytes: 33_554_432, outputBytes: 16_777_216,
  inputMessages: 4_096, outputMessages: 4_096, drainMessages: 64,
});
const limits = APPLICATION_QUICKJS_SESSION_LIMITS;
export const APPLICATION_QUICKJS_BOOTSTRAP_ID = "application-runtime-guest-bootstrap.js";
type State = "initializing" | "ready" | "closed" | "failed";
type Failure = "input" | "output" | "module" | "guest" | "deadline" | "jobs" | "operations" | "owner" | "dispose";
export class ApplicationQuickJSSessionError extends Error {
  constructor(readonly code: Failure | "closed") { super("Application QuickJS session stopped: " + code); }
}
export interface ApplicationQuickJSSessionStatus {
  readonly state: State; readonly failure: Failure | null; readonly jobs: number;
  readonly operations: number; readonly guestDisposed: boolean; readonly qualifiedForProduct: false;
}
export interface ApplicationQuickJSSession {
  /** Executes at most 64 individual jobs. Empty job queues do not settle an
   * invocation or turn an unresolved top-level await into a ready module. */
  pump(): ApplicationQuickJSSessionStatus;
  receive(messageJson: string): void;
  drain(): readonly string[];
  close(): void;
  readonly status: ApplicationQuickJSSessionStatus;
}
export interface ApplicationQuickJSSessionOptions {
  readonly module: ApplicationQuickJSModule;
  readonly artifactOwner: ApplicationArtifactOwner;
  readonly captured: CapturedApplicationArtifact;
  readonly boundary: ApplicationQuickJSSessionBoundary;
  /** Absolute original monotonic deadline; never renewed by pump or messages. */
  readonly deadline: number;
  readonly now?: () => number;
}
const usedModules = new WeakSet<ApplicationQuickJSModule>();

/** The owner must provide a fresh independently selected, guarded Wasm module.
 * Product JavaScript is evaluated only by its actual QuickJS context. This
 * component cannot qualify the raw imports, native process, broker or release. */
export function createApplicationQuickJSSession(options: ApplicationQuickJSSessionOptions): ApplicationQuickJSSession {
  const module = options.module, captured = options.captured, deadline = options.deadline;
  const now = options.now ?? performance.now.bind(performance);
  const entry = options.artifactOwner.entry.bind(options.artifactOwner);
  const load = options.artifactOwner.load.bind(options.artifactOwner);
  const resolve = options.artifactOwner.resolve.bind(options.artifactOwner);
  const readToolchain = options.artifactOwner.readToolchain.bind(options.artifactOwner);
  const onRuntime = options.boundary.onRuntime.bind(options.boundary);
  const onContext = options.boundary.onContext.bind(options.boundary);
  const readString = options.boundary.boundedReadString.bind(options.boundary);
  const initialTime = now();
  if (!Number.isFinite(initialTime) || !Number.isFinite(deadline) || deadline <= initialTime
    || deadline - initialTime > limits.lifetimeMs || usedModules.has(module)) throw new ApplicationQuickJSSessionError("owner");
  usedModules.add(module);
  let state: State = "initializing", failure: Failure | undefined, previousTime = initialTime;
  let runtime: ApplicationQuickJSRuntime | undefined, vm: ApplicationQuickJSContext | undefined;
  let factory: ApplicationQuickJSHandle | undefined, evaluation: ApplicationQuickJSHandle | undefined;
  let guest: ApplicationQuickJSHandle | undefined, receive: ApplicationQuickJSHandle | undefined, drain: ApplicationQuickJSHandle | undefined;
  const owned = new Set<ApplicationQuickJSHandle>();
  let jobs = 0, operations = 0, moduleCalls = 0, inputBytes = 0, outputBytes = 0, inputMessages = 0, outputMessages = 0;
  let disposed = false, disposing = false, disposalUncertain = false;
  const snapshot = (): ApplicationQuickJSSessionStatus => Object.freeze({ state, failure: failure ?? null,
    jobs, operations, guestDisposed: disposed, qualifiedForProduct: false });
  function dispose(): void {
    if (disposed || disposing) return;
    disposing = true; let clean = true;
    for (const handle of [...owned].reverse()) {
      try { if (handle.alive) handle.dispose(); if (handle.alive) clean = false; } catch { clean = false; }
    }
    owned.clear();
    for (const scope of [vm, runtime]) if (scope) {
      try { if (scope.alive) scope.dispose(); if (scope.alive) clean = false; } catch { clean = false; }
    }
    // A failed handle release may remain unconfirmed after its parent scope
    // closes. Later close() calls cannot manufacture successful cleanup evidence.
    disposalUncertain ||= !clean;
    disposed = clean && !disposalUncertain; disposing = false;
    if (disposalUncertain) { failure = "dispose"; state = "failed"; }
  }
  function fail(code: Failure): never {
    failure ??= code; state = "failed"; dispose(); throw new ApplicationQuickJSSessionError(failure);
  }
  function checkTime(): boolean {
    const time = now();
    if (!Number.isFinite(time) || time < previousTime) { failure ??= "owner"; return false; }
    previousTime = time;
    if (time >= deadline) { failure ??= "deadline"; return false; }
    return true;
  }
  function check(): void {
    if (state === "closed" || state === "failed") throw new ApplicationQuickJSSessionError(failure ?? "closed");
    if (failure || !checkTime()) fail(failure ?? "deadline");
  }
  function operation(): void { check(); if (++operations > limits.operations) fail("operations"); }
  function own(handle: ApplicationQuickJSHandle): ApplicationQuickJSHandle {
    if (!handle || !handle.alive || handle === vm?.undefined) return fail("owner");
    owned.add(handle); return handle;
  }
  function drop(handle: ApplicationQuickJSHandle): void {
    if (!owned.has(handle)) return fail("owner");
    let clean = false;
    try { handle.dispose(); clean = !handle.alive; } catch { /* Kept for the bounded final disposal attempt. */ }
    if (!clean) return fail("dispose"); owned.delete(handle);
  }
  function result(value: ApplicationQuickJSResult<ApplicationQuickJSHandle>): ApplicationQuickJSHandle {
    if (value.error) { own(value.error); return fail("guest"); }
    return own(value.value);
  }
  function property(handle: ApplicationQuickJSHandle, key: string | number): ApplicationQuickJSHandle {
    check(); const value = own(vm!.getProp(handle, key)); check(); return value;
  }
  function count(handle: ApplicationQuickJSHandle, maximum: number): number {
    const length = property(handle, "length");
    try {
      if (vm!.typeof(length) !== "number") return fail("output");
      const value = vm!.getNumber(length); check();
      if (!Number.isSafeInteger(value) || value < 0 || value > maximum) return fail("output");
      return value;
    } finally { if (owned.has(length)) drop(length); }
  }
  function string(handle: ApplicationQuickJSHandle, maximum: number): string {
    check(); if (vm!.typeof(handle) !== "string") return fail("output");
    const length = count(handle, maximum); // Bound code-unit amplification before the raw reader.
    const value = readString(vm!, handle, maximum); check();
    // QTS_GetString exposes a C string. Embedded NUL truncation must never turn
    // a different guest string into an accepted host message.
    if (typeof value !== "string" || value.length !== length || Buffer.byteLength(value) > maximum
      || Buffer.from(value).toString("utf8") !== value) return fail("output");
    return value;
  }
  function call(fn: ApplicationQuickJSHandle, self: ApplicationQuickJSHandle, args: ApplicationQuickJSHandle[] = []): ApplicationQuickJSHandle {
    check(); const value = result(vm!.callFunction(fn, self, ...args)); check(); return value;
  }
  function guestState(): void {
    const value = property(guest!, "status");
    try {
      const status = string(value, 16);
      if (status === "shutdown") { state = "closed"; dispose(); }
      else if (status !== "open") fail("guest");
    } finally { if (owned.has(value)) drop(value); }
  }
  function settleModule(): boolean {
    if (state !== "initializing") return true;
    check(); const outcome = vm!.getPromiseState(evaluation!);
    if (outcome.type === "fulfilled" && !outcome.notAPromise) own(outcome.value);
    if (outcome.type === "rejected") own(outcome.error);
    check();
    if (outcome.type === "pending") return false;
    if (outcome.type === "rejected") return fail("guest");
    // 0.32 returns the ORIGINAL BORROWED input for notAPromise. Transfer that
    // already-owned evaluation handle; only a real Promise yields a second owner.
    let namespace: ApplicationQuickJSHandle;
    if (outcome.notAPromise) {
      if (outcome.value !== evaluation) return fail("owner"); namespace = evaluation!;
    } else { namespace = outcome.value; drop(evaluation!); }
    evaluation = undefined;
    if (vm!.typeof(namespace) !== "object") return fail("guest");
    const handler = property(namespace, "handle");
    if (vm!.typeof(handler) !== "function") return fail("guest");
    guest = call(factory!, vm!.undefined, [handler]);
    drop(handler); drop(namespace); drop(factory!); factory = undefined;
    if (vm!.typeof(guest) !== "object") return fail("guest");
    receive = property(guest, "receive"); drain = property(guest, "drain");
    if (vm!.typeof(receive) !== "function" || vm!.typeof(drain) !== "function") return fail("guest");
    state = "ready"; guestState(); return true;
  }
  const protect = <T>(work: () => T): T => {
    try { return work(); } catch (error) {
      if (error instanceof ApplicationQuickJSSessionError) throw error;
      return fail("owner"); // Never dump, coerce or forward a product/FFI exception.
    }
  };
  protect(() => {
    operation();
    const root = entry(captured), bootstrapBytes = readToolchain(captured, APPLICATION_QUICKJS_BOOTSTRAP_ID);
    if (!(bootstrapBytes instanceof Uint8Array) || bootstrapBytes.byteLength > limits.bootstrapBytes) return fail("owner");
    const bootstrap = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bootstrapBytes);
    const source = load(captured, root); check();
    runtime = module.newRuntime();
    runtime.setMemoryLimit(limits.heapBytes); runtime.setMaxStackSize(limits.stackBytes);
    runtime.setInterruptHandler(original => {
      try { if (original !== runtime || !checkTime()) failure ??= "owner"; }
      catch { failure ??= "owner"; }
      return !!failure || state === "closed" || state === "failed";
    });
    onRuntime(runtime);
    vm = runtime.newContext(); if (vm.runtime !== runtime) return fail("owner");
    const moduleError = () => ({ error: new Error("Application module rejected") });
    runtime.setModuleLoader((name, context) => {
      try {
        // A loader runs within the original QuickJS stack. Record sticky failure
        // here; dispose only after eval/pump returns to this host owner.
        if (failure || !checkTime() || state === "closed" || state === "failed" || context !== vm
          || ++moduleCalls > limits.moduleCalls) throw Error();
        return load(captured, name);
      }
      catch { failure ??= "module"; return moduleError(); }
    }, (base, name, context) => {
      try {
        if (failure || !checkTime() || state === "closed" || state === "failed" || context !== vm
          || ++moduleCalls > limits.moduleCalls) throw Error();
        return resolve(captured, base, name);
      }
      catch { failure ??= "module"; return moduleError(); }
    });
    onContext(vm);
    factory = result(vm.evalCode(bootstrap, APPLICATION_QUICKJS_BOOTSTRAP_ID, { type: "global" })); check();
    if (vm.typeof(factory) !== "function") return fail("guest");
    evaluation = result(vm.evalCode(source, root, { type: "module" })); check();
    settleModule();
  });
  return Object.freeze({
    get status() { return snapshot(); },
    pump() { return protect(() => {
      operation();
      for (let index = 0; index < limits.jobsPerPump; index++) {
        settleModule(); check();
        if (!runtime!.hasPendingJob()) break;
        if (jobs >= limits.jobs) return fail("jobs");
        // The negative/default count drains without a finite limit in 0.32.
        const ran = runtime!.executePendingJobs(1);
        if (ran.error) { own(ran.error); return fail("guest"); }
        if (ran.value !== 0 && ran.value !== 1) return fail("owner");
        jobs += ran.value; check();
        if (ran.value === 0) break;
      }
      settleModule(); if (state === "ready") guestState(); return snapshot();
    }); },
    receive(messageJson: string) { protect(() => {
      operation(); if (state !== "ready") return fail("input");
      if (typeof messageJson !== "string" || messageJson.length > APPLICATION_WIRE_LIMITS.frameBytes) return fail("input");
      const bytes = Buffer.byteLength(messageJson);
      if (bytes > APPLICATION_WIRE_LIMITS.frameBytes || ++inputMessages > limits.inputMessages
        || (inputBytes += bytes) > limits.inputBytes) return fail("input");
      try { new ApplicationWireEncoder("host-to-application").encode(messageJson); } catch { return fail("input"); }
      const input = own(vm!.newString(messageJson));
      try { drop(call(receive!, guest!, [input])); guestState(); }
      finally { if (owned.has(input)) drop(input); }
    }); },
    drain() { return protect(() => {
      operation(); if (state !== "ready") return fail("output");
      const list = call(drain!, guest!), messages: string[] = [];
      try {
        if (vm!.typeof(list) !== "object") return fail("output");
        const length = count(list, limits.drainMessages);
        for (let index = 0; index < length; index++) {
          const item = property(list, index);
          try {
            const text = string(item, APPLICATION_WIRE_LIMITS.frameBytes);
            if (++outputMessages > limits.outputMessages || (outputBytes += Buffer.byteLength(text)) > limits.outputBytes) return fail("output");
            try { new ApplicationWireEncoder("application-to-host").encode(text); } catch { return fail("output"); }
            messages.push(text);
          } finally { if (owned.has(item)) drop(item); }
        }
        guestState(); return Object.freeze(messages);
      } finally { if (owned.has(list)) drop(list); }
    }); },
    close() { if (state !== "failed") state = "closed"; dispose(); },
  });
}
