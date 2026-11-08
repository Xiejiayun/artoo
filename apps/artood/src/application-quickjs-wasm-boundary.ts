/** Exact release-sync 0.32.0 host boundary. This module does not load or execute
 * QuickJS/Wasm/product code and does not establish process/resource qualification. */
export const APPLICATION_QUICKJS_BOUNDARY_LIMITS = Object.freeze({
  initialPages: 256, maximumPages: 8192, lifetimeMs: 180_000,
  imports: 65_536, arguments: 262_144, clockReads: 262_144, dateCalls: 16_384,
  moduleCalls: 4_096, stringReads: 8_192, growthCalls: 256,
  nameBytes: 1_024, requestBytes: 131_072, stringBytes: 1_048_576, sourceBytes: 16_777_216,
  decodedBytes: 33_554_432, writtenBytes: 33_554_432,
});
export type ApplicationQuickJsBoundaryFailure = "closed" | "imports" | "identity" | "pointer"
  | "limit" | "clock" | "forbidden" | "utf8" | "ffi" | "callback" | "memory";
export class ApplicationQuickJsBoundaryError extends Error {
  constructor(readonly code: ApplicationQuickJsBoundaryFailure) {
    super(`Application QuickJS boundary rejected: ${code}`); this.name = "ApplicationQuickJsBoundaryError";
  }
}
export interface ApplicationQuickJsWasmBoundaryOptions {
  readonly lifetimeMs: number;
  /** Fixed host epoch anchor; Date.now advances by the monotonic elapsed time. */
  readonly epochMilliseconds?: number;
  /** Trusted owner clock, never a guest callback. */
  readonly monotonicNow?: () => number;
}
export interface ApplicationQuickJsWasmBoundary {
  readonly memory: WebAssembly.Memory;
  readonly moduleOptions: Readonly<{ wasmMemory: WebAssembly.Memory; thisProgram: string; noExitRuntime: true;
    print: (...values: unknown[]) => never; printErr: (...values: unknown[]) => never; onAbort: (...values: unknown[]) => never }>;
  wrapImports(imports: unknown, moduleArg: unknown): WebAssembly.Imports;
  onRuntime(runtime: unknown): void;
  /** Call after setModuleLoader and before any eval. */
  onContext(context: unknown): void;
  /** Caller must first require a primitive guest string and bound its UTF-16
   * length, then require decoded.length to equal that length before using it.
   * QTS_GetString is NUL-terminated and cannot itself prove the full length. */
  boundedReadString(context: unknown, handle: unknown, maxBytes: number): string;
  assertActive(): void;
  close(): void;
}
type HostFunction = (...args: unknown[]) => unknown;
type ObjectFields = Record<string, unknown>;
interface PointerLifetime { readonly value: number; readonly alive: boolean }
interface Runtime {
  readonly alive: boolean; readonly rt: PointerLifetime; readonly module: ObjectFields; readonly ffi: ObjectFields;
  readonly assertOwned: HostFunction; readonly interruptHandler: HostFunction;
  readonly moduleLoader: HostFunction; readonly moduleNormalizer: HostFunction;
}
interface Context {
  readonly alive: boolean; readonly ctx: PointerLifetime; readonly rt: PointerLifetime;
  readonly runtime: Runtime; readonly module: ObjectFields; readonly ffi: ObjectFields;
}
const page = 65_536;
// Only the fixed compiler entry selects this profile. Request/configuration
// data cannot supply limits. Runtime v1 still uses its exact original values.
export const APPLICATION_COMPILER_WASM_BOUNDARY_LIMITS = Object.freeze({ ...APPLICATION_QUICKJS_BOUNDARY_LIMITS,
  lifetimeMs: 30_000, stringBytes: 100 * 1024 * 1024, decodedBytes: 100 * 1024 * 1024 + 1,
});
const environment = Object.freeze(["USER=artoo", "LOGNAME=artoo", "PATH=/", "PWD=/", "HOME=/",
  "LANG=C.UTF-8", "_=artoo-application"]);
const environmentBytes = Buffer.from(environment.join("\0") + "\0");
const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get;
const signatures = Object.freeze({ b: "iiii", c: "iiii", d: "i", e: "ii", f: "ii", g: "iiii", h: "iii",
  i: "i", j: "id", k: "i", l: "", m: "li", n: "iiii", o: "ilii", p: "", q: "", r: "i", s: "iiiii", t: "ii" });
type ImportName = keyof typeof signatures;

export function createApplicationQuickJsWasmBoundary(options: ApplicationQuickJsWasmBoundaryOptions): ApplicationQuickJsWasmBoundary {
  return createBoundary(options, APPLICATION_QUICKJS_BOUNDARY_LIMITS);
}
export function createApplicationCompilerWasmBoundary(options: ApplicationQuickJsWasmBoundaryOptions): ApplicationQuickJsWasmBoundary {
  return createBoundary(options, APPLICATION_COMPILER_WASM_BOUNDARY_LIMITS);
}
function createBoundary(options: ApplicationQuickJsWasmBoundaryOptions,
  limits: Readonly<Record<keyof typeof APPLICATION_QUICKJS_BOUNDARY_LIMITS, number>>): ApplicationQuickJsWasmBoundary {
  if (!Number.isSafeInteger(options.lifetimeMs) || options.lifetimeMs < 1 || options.lifetimeMs > limits.lifetimeMs)
    throw new ApplicationQuickJsBoundaryError("clock");
  const lifetimeMs = options.lifetimeMs, clock = options.monotonicNow ?? (() => performance.now());
  const epoch = options.epochMilliseconds ?? Date.now();
  if (!Number.isSafeInteger(epoch) || Math.abs(epoch) + lifetimeMs > 8_640_000_000_000_000)
    throw new ApplicationQuickJsBoundaryError("clock");
  let first: number;
  try { first = clock(); } catch { throw new ApplicationQuickJsBoundaryError("clock"); }
  if (!Number.isFinite(first) || first < 0) throw new ApplicationQuickJsBoundaryError("clock");
  const memory = new WebAssembly.Memory({ initial: limits.initialPages, maximum: limits.maximumPages, shared: false });
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let failure: ApplicationQuickJsBoundaryError | undefined, closed = false, wrapped = false, last = first;
  let imports = 0, argumentsRead = 0, clockReads = 0, dateCalls = 0, moduleCalls = 0, stringReads = 0, growthCalls = 0;
  let decodedBytes = 0, writtenBytes = 0;
  let module: ObjectFields | undefined, malloc: HostFunction | undefined, free: HostFunction | undefined;
  let runtime: Runtime | undefined, context: Context | undefined, rt: PointerLifetime | undefined, ctx: PointerLifetime | undefined;
  let runtimePointer = 0, contextPointer = 0, ffi: ObjectFields | undefined;
  let assertOwned: HostFunction | undefined, interrupt: HostFunction | undefined, loader: HostFunction | undefined, normalizer: HostFunction | undefined;
  let getString: HostFunction | undefined, freeCString: HostFunction | undefined;
  const reject = (code: ApplicationQuickJsBoundaryFailure): never => { failure ??= new ApplicationQuickJsBoundaryError(code); throw failure; };
  const output = (..._values: unknown[]): never => reject("forbidden");
  const moduleOptions = Object.freeze({ wasmMemory: memory, thisProgram: "artoo-application", noExitRuntime: true as const,
    print: output, printErr: output, onAbort: output });
  const object = (value: unknown): ObjectFields => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return reject("identity");
    return value as ObjectFields;
  };
  const fn = (value: unknown): HostFunction => typeof value === "function" ? value as HostFunction : reject("identity");
  const buffer = (): ArrayBuffer => {
    const bytes = memory.buffer;
    if (!(bytes instanceof ArrayBuffer) || resizable && Reflect.apply(resizable, bytes, []) || bytes.byteLength < page * limits.initialPages
      || bytes.byteLength > page * limits.maximumPages || bytes.byteLength % page) return reject("memory");
    if (module && (!(module.HEAP8 instanceof Int8Array) || !(module.HEAPU8 instanceof Uint8Array)
      || module.HEAP8.buffer !== bytes || module.HEAPU8.buffer !== bytes
      || module.HEAP8.byteOffset !== 0 || module.HEAPU8.byteOffset !== 0
      || module.HEAP8.byteLength !== bytes.byteLength || module.HEAPU8.byteLength !== bytes.byteLength)) return reject("memory");
    return bytes;
  };
  const active = (): number => {
    if (failure) throw failure; if (closed) return reject("closed");
    if (++clockReads > limits.clockReads) return reject("limit");
    let now: number;
    try { now = clock(); } catch { return reject("clock"); }
    if (!Number.isFinite(now) || now < last || now - first >= lifetimeMs) return reject("clock");
    last = now; buffer(); return now;
  };
  const range = (pointer: unknown, bytes: number, alignment = 1): number => {
    const length = buffer().byteLength;
    if (typeof pointer !== "number" || !Number.isSafeInteger(pointer) || pointer < 1 || pointer % alignment
      || !Number.isSafeInteger(bytes) || bytes < 1 || pointer > length - bytes) return reject("pointer");
    return pointer;
  };
  const separate = (ranges: readonly (readonly [number, number])[]) => {
    for (let i = 0; i < ranges.length; i++) for (let j = 0; j < i; j++) {
      const a = ranges[i]!, b = ranges[j]!;
      if (a[0] < b[0] + b[1] && b[0] < a[0] + a[1]) reject("pointer");
    }
  };
  const chargeWrite = (bytes: number) => { writtenBytes += bytes; if (writtenBytes > limits.writtenBytes) reject("limit"); };
  const readCString = (pointer: unknown, maximum: number): string => {
    const start = range(pointer, 1), view = new Uint8Array(buffer());
    const end = Math.min(view.length, start + maximum + 1); let cursor = start;
    while (cursor < end && view[cursor] !== 0) cursor++;
    if (cursor === end) return reject("limit");
    decodedBytes += cursor - start + 1;
    if (decodedBytes > limits.decodedBytes) return reject("limit");
    try { return decoder.decode(view.subarray(start, cursor)); } catch { return reject("utf8"); }
  };
  const runtimeIdentity = (pointer: unknown) => {
    active();
    if (!runtime || !rt || runtime.rt !== rt || !runtime.alive || !rt.alive || rt.value !== runtimePointer
      || pointer !== runtimePointer || runtime.module !== module || runtime.ffi !== ffi
      || runtime.assertOwned !== assertOwned || runtime.interruptHandler !== interrupt) reject("identity");
    range(pointer, 4, 4);
  };
  const contextIdentity = (rtPointer: unknown, ctxPointer: unknown) => {
    runtimeIdentity(rtPointer);
    if (!context || !ctx || context.ctx !== ctx || context.rt !== rt || !context.alive || !ctx.alive
      || ctx.value !== contextPointer || ctxPointer !== contextPointer || context.runtime !== runtime
      || context.module !== module || context.ffi !== ffi || runtime!.moduleLoader !== loader || runtime!.moduleNormalizer !== normalizer
      || ffi!.QTS_GetString !== getString || ffi!.QTS_FreeCString !== freeCString || module!._malloc !== malloc || module!._free !== free)
      reject("identity");
    range(ctxPointer, 4, 4);
  };
  const call = (operation: HostFunction, receiver: unknown, args: unknown[]): unknown => {
    try { return Reflect.apply(operation, receiver, args); } catch { return reject("callback"); }
  };
  const copyResult = (value: unknown, maximum: number): number => {
    if (typeof value !== "string" || value.length > maximum || !value.isWellFormed() || value.includes("\0")) return reject("callback");
    const length = Buffer.byteLength(value);
    if (length > maximum) return reject("limit");
    chargeWrite(length + 1); active();
    const pointer = call(malloc!, module, [length + 1]);
    if (pointer === 0) return reject("ffi");
    const address = range(pointer, length + 1);
    let transferred = false;
    try {
      active(); const bytes = Buffer.from(value), view = new Uint8Array(buffer());
      view.set(bytes, address); view[address + bytes.length] = 0; active(); transferred = true; return address;
    } finally { if (!transferred) call(free!, module, [address]); }
  };
  const enter = (name: ImportName, args: readonly unknown[]) => {
    active(); imports++; argumentsRead += args.length;
    const signature = signatures[name];
    if (imports > limits.imports || argumentsRead > limits.arguments) reject("limit");
    if (args.length !== signature.length || args.some((value, index) => {
      const kind = signature[index];
      return kind === "l" ? typeof value !== "bigint" || value < -(1n << 63n) || value >= 1n << 63n
        : kind === "i" ? typeof value !== "number" || !Number.isInteger(value) || value < -2_147_483_648 || value > 2_147_483_647
          : typeof value !== "number" || !Number.isFinite(value);
    })) reject("imports");
  };
  const dateCall = () => { if (++dateCalls > limits.dateCalls) reject("limit"); };
  return Object.freeze({ memory, moduleOptions, assertActive: () => { active(); }, close: () => { closed = true; },
    wrapImports(input: unknown, moduleArg: unknown): WebAssembly.Imports {
      active(); if (wrapped) return reject("imports");
      const outer = object(input), argument = object(moduleArg);
      const exact = (value: ObjectFields, expected: string[]) => {
        const descriptors = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(descriptors);
        if (names.length !== expected.length || expected.some(name => !Object.hasOwn(descriptors, name)
          || !("value" in descriptors[name]!))) reject("imports");
      };
      exact(outer, ["a"]); const raw = object(outer.a); exact(raw, ["a", ...Object.keys(signatures)]);
      if (raw.a !== memory || Object.entries(moduleOptions).some(([key, value]) => argument[key] !== value)) return reject("imports");
      for (const name of Object.keys(signatures)) if (typeof raw[name] !== "function") return reject("imports");
      // The exact pinned glue's growth function refreshes private typed views as
      // well as HEAP8/U8. Direct memory.grow here would leave its private views stale.
      const grow = raw.k as HostFunction; module = argument; buffer(); wrapped = true;
      const guarded: Record<string, WebAssembly.ImportValue> = { a: memory };
      const methods: Partial<Record<ImportName, HostFunction>> = {
        d: () => 52, o: () => 70,
        f: (count, bytes) => { const a = range(count, 4, 4), b = range(bytes, 4, 4); separate([[a, 4], [b, 4]]);
          chargeWrite(8); const view = new DataView(buffer()); view.setUint32(a, environment.length, true); view.setUint32(b, environmentBytes.length, true); return 0; },
        e: (pointers, text) => { const a = range(pointers, environment.length * 4, 4), b = range(text, environmentBytes.length);
          separate([[a, environment.length * 4], [b, environmentBytes.length]]); chargeWrite(environment.length * 4 + environmentBytes.length);
          const bytes = new Uint8Array(buffer()), view = new DataView(buffer()); bytes.set(environmentBytes, b);
          let offset = 0; for (let i = 0; i < environment.length; i++) { view.setUint32(a + 4 * i, b + offset, true); offset += Buffer.byteLength(environment[i]!) + 1; } return 0; },
        g: (r, c, base, name) => { contextIdentity(r, c); if (++moduleCalls > limits.moduleCalls) return reject("limit");
          // Admission preserves long relative spellings that normalize to a
          // captured canonical name; only requests use the source-file byte cap.
          const parent = readCString(base, limits.nameBytes), requested = readCString(name, limits.requestBytes);
          const result = call(normalizer!, undefined, [parent, requested, context]); contextIdentity(r, c); return copyResult(result, limits.nameBytes); },
        h: (r, c, name) => { contextIdentity(r, c); if (++moduleCalls > limits.moduleCalls) return reject("limit");
          const result = call(loader!, undefined, [readCString(name, limits.nameBytes), context]); contextIdentity(r, c); return copyResult(result, limits.sourceBytes); },
        i: r => { runtimeIdentity(r); const result = call(interrupt!, undefined, [runtime]); runtimeIdentity(r);
          if (typeof result !== "boolean") return reject("callback"); return result ? 1 : 0; },
        k: requested => { if (++growthCalls > limits.growthCalls) return reject("limit");
          const bytes = requested as number, before = buffer().byteLength;
          if (bytes < 1) return reject("pointer"); if (bytes > limits.maximumPages * page) return 0; if (bytes <= before) return 1;
          const result = call(grow, undefined, [bytes]); const after = buffer().byteLength;
          if (![0, 1, false, true].includes(result as number | boolean) || (result ? after < bytes : after !== before)) return reject("memory");
          active(); return result ? 1 : 0; },
        m: (seconds, address) => { dateCall(); const pointer = range(address, 40, 4), value = seconds as bigint;
          if (value < -8_640_000_000_000n || value > 8_640_000_000_000n) return reject("clock");
          const date = new Date(Number(value) * 1000), year = date.getUTCFullYear();
          const months = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
            ? [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335] : [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
          const values = [date.getUTCSeconds(), date.getUTCMinutes(), date.getUTCHours(), date.getUTCDate(), date.getUTCMonth(), date.getUTCFullYear() - 1900,
            date.getUTCDay(), months[date.getUTCMonth()]! + date.getUTCDate() - 1, 0, 0];
          if (values.some(item => !Number.isFinite(item))) return reject("clock"); chargeWrite(40);
          const view = new DataView(buffer()); values.forEach((item, index) => view.setInt32(pointer + index * 4, item, true)); },
        n: (timezone, daylight, standard, summer) => { dateCall(); const a = range(timezone, 4, 4), b = range(daylight, 4, 4), c = range(standard, 17), d = range(summer, 17);
          separate([[a, 4], [b, 4], [c, 17], [d, 17]]); chargeWrite(42); const view = new DataView(buffer()), bytes = new Uint8Array(buffer());
          view.setInt32(a, 0, true); view.setInt32(b, 0, true); for (const pointer of [c, d]) { bytes.fill(0, pointer, pointer + 17); bytes.set([85, 84, 67], pointer); } },
        p: () => { dateCall(); return Math.floor(epoch + active() - first); },
      };
      for (const name of Object.keys(signatures) as ImportName[]) guarded[name] = (...args: unknown[]) => {
        enter(name, args); const operation = methods[name]; if (!operation) return reject("forbidden");
        return operation(...args);
      };
      return Object.freeze({ a: Object.freeze(guarded) });
    },
    onRuntime(value: unknown): void {
      active(); if (!wrapped || runtime) return reject("identity");
      const candidate = object(value) as unknown as Runtime;
      rt = object(candidate.rt) as unknown as PointerLifetime;
      runtimePointer = range(rt.value, 4, 4);
      if (!candidate.alive || !rt.alive || candidate.module !== module) return reject("identity");
      ffi = object(candidate.ffi); if (ffi.module !== module) return reject("identity");
      assertOwned = fn(candidate.assertOwned); interrupt = fn(candidate.interruptHandler); runtime = candidate;
      runtimeIdentity(runtimePointer);
    },
    onContext(value: unknown): void {
      active(); if (!runtime || context) return reject("identity");
      const candidate = object(value) as unknown as Context;
      if (candidate.runtime !== runtime || candidate.rt !== rt || candidate.module !== module || candidate.ffi !== ffi || !candidate.alive) return reject("identity");
      ctx = object(candidate.ctx) as unknown as PointerLifetime;
      if (!ctx.alive) return reject("identity"); contextPointer = range(ctx.value, 4, 4);
      loader = fn(runtime.moduleLoader); normalizer = fn(runtime.moduleNormalizer);
      malloc = fn(module!._malloc); free = fn(module!._free); getString = fn(ffi!.QTS_GetString); freeCString = fn(ffi!.QTS_FreeCString);
      context = candidate; contextIdentity(runtimePointer, contextPointer);
    },
    boundedReadString(value: unknown, input: unknown, maximum: number): string {
      active(); if (value !== context) return reject("identity"); contextIdentity(runtimePointer, contextPointer);
      if (++stringReads > limits.stringReads || !Number.isSafeInteger(maximum) || maximum < 0 || maximum > limits.stringBytes) return reject("limit");
      const handle = object(input); if (handle.alive !== true) return reject("identity");
      call(assertOwned!, runtime, [input]); const handlePointer = range(handle.value, 8, 4);
      const pointer = call(getString!, ffi, [contextPointer, handlePointer]);
      // An invalid result is terminal; never feed an out-of-range value to a
      // deallocator. A valid original CString is always freed, even after failure.
      const address = range(pointer, 1);
      try { contextIdentity(runtimePointer, contextPointer); const result = readCString(address, maximum); active(); return result; }
      finally {
        try { Reflect.apply(freeCString!, ffi, [contextPointer, address]); } catch { reject("ffi"); }
      }
    },
  });
}
