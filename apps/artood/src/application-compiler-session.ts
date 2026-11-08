import type { ApplicationQuickJSContext, ApplicationQuickJSHandle, ApplicationQuickJSModule,
  ApplicationQuickJSResult, ApplicationQuickJSRuntime, ApplicationQuickJSSessionBoundary } from "./application-quickjs-session.js";
import { APPLICATION_COMPILER_LIMITS, parseApplicationCompilerRequestText } from "./application-compiler-contract.js";
export const APPLICATION_COMPILER_SESSION_LIMITS = Object.freeze({ heapBytes: 384 * 1024 * 1024, stackBytes: 1024 * 1024,
  lifetimeMs: 30_000, bootstrapBytes: 48 * 1024 * 1024 });
export interface ApplicationCompilerSession {
  compile(bytes: Uint8Array): Buffer;
  assertDisposed(): void;
  close(): void;
}
export interface ApplicationCompilerSessionOptions {
  readonly module: ApplicationQuickJSModule;
  readonly boundary: ApplicationQuickJSSessionBoundary;
  readonly typescript: string;
  readonly guest: string;
  readonly deadline: number;
  readonly now?: () => number;
}
const used = new WeakSet<ApplicationQuickJSModule>();
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const getter = (name: string) => Object.getOwnPropertyDescriptor(typedArray, name)!.get!;
const lengthOf = getter("byteLength"), bufferOf = getter("buffer"), offsetOf = getter("byteOffset");
const arrayBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")!.get!;
const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get;
function requestView(bytes: Uint8Array): Uint8Array {
  if (!(bytes instanceof Uint8Array)) throw Error("compiler-session-storage");
  const buffer = Reflect.apply(bufferOf, bytes, []), length: number = Reflect.apply(lengthOf, bytes, []);
  Reflect.apply(arrayBufferLength, buffer, []);
  if (length < 1 || length > APPLICATION_COMPILER_LIMITS.inputBytes || resizable && Reflect.apply(resizable, buffer, [])) throw Error("compiler-session-storage");
  return new Uint8Array(buffer, Reflect.apply(offsetOf, bytes, []), length);
}
/** Fixed trusted compiler scripts are interpreted by QuickJS. Product TypeScript
 * enters only as a primitive JSON string; emitted JavaScript is never evaluated. */
export function createApplicationCompilerSession(input: ApplicationCompilerSessionOptions): ApplicationCompilerSession {
  const { module, typescript, guest, deadline } = input, boundary = input.boundary;
  const now = input.now ?? performance.now.bind(performance); let previous = now();
  if (!Number.isFinite(previous) || !Number.isFinite(deadline) || deadline <= previous
    || deadline - previous > APPLICATION_COMPILER_SESSION_LIMITS.lifetimeMs || used.has(module)) throw Error("compiler-session-owner");
  used.add(module);
  const check = () => { const time = now(); if (!Number.isFinite(time) || time < previous || time >= deadline) throw Error("compiler-session-deadline"); previous = time; };
  let runtime: ApplicationQuickJSRuntime | undefined, vm: ApplicationQuickJSContext | undefined;
  let invoked = false, disposed = false, disposalFailed = false;
  const handles = new Set<ApplicationQuickJSHandle>();
  const own = (value: ApplicationQuickJSHandle): ApplicationQuickJSHandle => {
    if (!value || !value.alive || value === vm?.undefined) throw Error("compiler-session-handle"); handles.add(value); return value;
  };
  function close(): void {
    if (disposed || disposalFailed) return;
    let clean = true;
    for (const handle of [...handles].reverse()) {
      try { if (handle.alive) handle.dispose(); if (handle.alive) clean = false; } catch { clean = false; }
    }
    handles.clear();
    for (const scope of [vm, runtime]) if (scope) {
      try { if (scope.alive) scope.dispose(); if (scope.alive) clean = false; } catch { clean = false; }
    }
    disposed = clean; disposalFailed = !clean;
  }
  const assertDisposed = () => { if (!disposed || disposalFailed || vm?.alive !== false || runtime?.alive !== false) throw Error("compiler-session-disposal"); };
  const drop = (handle: ApplicationQuickJSHandle) => {
    if (!handles.has(handle)) throw Error("compiler-session-handle");
    handle.dispose(); if (handle.alive) throw Error("compiler-session-disposal"); handles.delete(handle);
  };
  const result = (value: ApplicationQuickJSResult<ApplicationQuickJSHandle>) => {
    if (value.error) { own(value.error); throw Error("compiler-session-guest"); } return own(value.value);
  };
  let compile: ApplicationQuickJSHandle;
  try {
    const bootstraps = [typescript, guest];
    if (bootstraps.some(text => typeof text !== "string" || !text.isWellFormed())
      || bootstraps.reduce((sum, text) => sum + Buffer.byteLength(text), 0) > APPLICATION_COMPILER_SESSION_LIMITS.bootstrapBytes)
      throw Error("compiler-session-bootstrap");
    check(); runtime = module.newRuntime(); runtime.setMemoryLimit(APPLICATION_COMPILER_SESSION_LIMITS.heapBytes);
    runtime.setMaxStackSize(APPLICATION_COMPILER_SESSION_LIMITS.stackBytes);
    runtime.setInterruptHandler(() => { try { check(); return false; } catch { return true; } });
    // Both callbacks always reject; no product import or guest host function can
    // cross into the host. The boundary binds these exact original identities.
    runtime.setModuleLoader(() => { throw Error("compiler-module-forbidden"); }, () => { throw Error("compiler-module-forbidden"); });
    boundary.onRuntime(runtime); vm = runtime.newContext(); boundary.onContext(vm); check();
    for (const [index, text] of bootstraps.entries()) {
      const evaluated = result(vm.evalCode(text, index === 0 ? "fixed-typescript-5.9.3.js" : "application-compiler-guest.js", { type: "global" }));
      check(); drop(evaluated);
    }
    compile = result(vm.evalCode("__artooApplicationCompilerV1.compileApplicationGuestRequestJson", "fixed-compiler-entry.js", { type: "global" }));
    if (vm.typeof(compile) !== "function" || runtime.hasPendingJob()) throw Error("compiler-session-entry"); check();
  } catch { close(); throw Error("compiler-session-startup"); }
  return Object.freeze({
    compile(bytes: Uint8Array): Buffer {
      if (invoked || disposed || disposalFailed) throw Error("compiler-session-used"); invoked = true;
      let output: Buffer | undefined;
      try {
        check();
        const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(requestView(bytes));
        parseApplicationCompilerRequestText(text); check();
        const argument = own(vm!.newString(text)); check();
        const value = result(vm!.callFunction(compile, vm!.undefined, argument)); check(); drop(argument);
        if (vm!.typeof(value) !== "string") throw Error("compiler-session-output");
        const lengthHandle = own(vm!.getProp(value, "length"));
        if (vm!.typeof(lengthHandle) !== "number") throw Error("compiler-session-output");
        const length = vm!.getNumber(lengthHandle); drop(lengthHandle);
        if (!Number.isSafeInteger(length) || length < 1 || length > APPLICATION_COMPILER_LIMITS.outputBytes) throw Error("compiler-session-output");
        const decoded = boundary.boundedReadString(vm!, value, APPLICATION_COMPILER_LIMITS.outputBytes); check();
        if (typeof decoded !== "string" || decoded.length !== length || !decoded.isWellFormed()
          || Buffer.byteLength(decoded) > APPLICATION_COMPILER_LIMITS.outputBytes || runtime!.hasPendingJob()) throw Error("compiler-session-output");
        output = Buffer.from(decoded, "utf8"); drop(value); check();
      } finally { close(); }
      assertDisposed(); check(); return output;
    }, assertDisposed, close,
  });
}
