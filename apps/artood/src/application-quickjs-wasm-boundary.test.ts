import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { APPLICATION_QUICKJS_BOUNDARY_LIMITS as limits, ApplicationQuickJsBoundaryError,
  createApplicationQuickJsWasmBoundary, type ApplicationQuickJsBoundaryFailure } from "./application-quickjs-wasm-boundary.js";
import { createApplicationArtifactOwner, type ApplicationArtifactByteFile } from "./application-artifact-admission.js";

// Controlled ABI objects and a real linear memory only. No Wasm module, QuickJS
// runtime, product code, process owner or native sandbox executes in this suite.
const names = "bcdefghijklmnopqrst".split("");
const page = 65_536;
function fixture(register = true) {
  let now = 100, allocation = 16_384;
  const clock = vi.fn(() => now);
  const boundary = createApplicationQuickJsWasmBoundary({ lifetimeMs: 1000, epochMilliseconds: 1_700_000_000_000, monotonicNow: clock });
  const memory = boundary.memory;
  const module = { ...boundary.moduleOptions, HEAP8: new Int8Array(memory.buffer), HEAPU8: new Uint8Array(memory.buffer),
    _malloc: vi.fn((bytes: number) => { const pointer = allocation; allocation += Math.ceil(bytes / 8) * 8; return pointer; }), _free: vi.fn() };
  const refresh = () => { module.HEAP8 = new Int8Array(memory.buffer); module.HEAPU8 = new Uint8Array(memory.buffer); };
  const raw: Record<string, unknown> = Object.fromEntries(names.map(name => [name, vi.fn(() => { throw Error("original import must not run"); })]));
  raw.a = memory;
  const grow = vi.fn((bytes: number) => { memory.grow(Math.ceil((bytes - memory.buffer.byteLength) / page)); refresh(); return 1; });
  raw.k = grow;
  const write = (value: string | Uint8Array, address = 1024) => {
    const bytes = typeof value === "string" ? Buffer.from(value) : value;
    const view = new Uint8Array(memory.buffer); view.set(bytes, address); view[address + bytes.length] = 0; return address;
  };
  write("ok", 4096);
  const ffi = { module, QTS_GetString: vi.fn((_context: number, _handle: number) => 4096), QTS_FreeCString: vi.fn() };
  const rt = { alive: true, value: 64 }, ctx = { alive: true, value: 128 };
  const runtime = { alive: true, rt, module, ffi, assertOwned: vi.fn((handle: unknown) => {
    if ((handle as { owner: unknown }).owner !== runtime) throw Error("foreign");
  }), interruptHandler: vi.fn(() => false), moduleLoader: vi.fn((_name: string, _context: unknown) => "export default 1;"),
  moduleNormalizer: vi.fn((_base: string, name: string, _context: unknown) => name) };
  const context = { alive: true, rt, ctx, runtime, module, ffi };
  const handle = { alive: true, value: 256, owner: runtime };
  let imports: Record<string, (...args: unknown[]) => unknown>;
  const wrap = () => imports = boundary.wrapImports({ a: raw }, module).a as Record<string, (...args: unknown[]) => unknown>;
  if (register) { wrap(); boundary.onRuntime(runtime); boundary.onContext(context); }
  return { boundary, memory, module, raw, grow, refresh, ffi, rt, ctx, runtime, context, handle, clock, write, wrap,
    invoke: (name: string, ...args: unknown[]) => imports[name]!(...args), setNow: (value: number) => { now = value; } };
}
function rejected(action: () => unknown, code: ApplicationQuickJsBoundaryFailure) {
  let thrown: unknown;
  try { action(); } catch (error) { thrown = error; }
  expect(thrown).toBeInstanceOf(ApplicationQuickJsBoundaryError);
  expect(thrown).toMatchObject({ name: "ApplicationQuickJsBoundaryError", code, message: `Application QuickJS boundary rejected: ${code}` });
  return thrown;
}

describe("fixed QuickJS release-sync 0.32.0 boundary", () => {
  it("uses a private nonshared 16 MiB memory, frozen policy and one exact namespace", () => {
    const f = fixture(false), wrapped = f.boundary.wrapImports({ a: f.raw }, f.module);
    expect(f.memory.buffer).toBeInstanceOf(ArrayBuffer); expect(f.memory.buffer.byteLength).toBe(16 * 1024 * 1024);
    expect(limits.maximumPages * page).toBe(512 * 1024 * 1024);
    expect(Object.isFrozen(f.boundary)).toBe(true); expect(Object.isFrozen(f.boundary.moduleOptions)).toBe(true);
    expect(Object.isFrozen(wrapped)).toBe(true); expect(Object.isFrozen(wrapped.a)).toBe(true);
    expect(Object.keys(wrapped)).toEqual(["a"]); expect(Object.keys(wrapped.a!)).toEqual(["a", ...names]);
    expect(wrapped.a!.a).toBe(f.memory); expect(f.boundary.moduleOptions.thisProgram).toBe("artoo-application");
    expect(f.boundary.moduleOptions.noExitRuntime).toBe(true);
  });

  it.each([0, -1, 1.1, Infinity, NaN, limits.lifetimeMs + 1])("rejects invalid lifetime %s", lifetimeMs => {
    rejected(() => createApplicationQuickJsWasmBoundary({ lifetimeMs }), "clock");
  });
  it.each([NaN, Infinity, -1])("rejects invalid initial monotonic clock %s", value => {
    rejected(() => createApplicationQuickJsWasmBoundary({ lifetimeMs: 1, monotonicNow: () => value }), "clock");
  });
  it("redacts initial clock exceptions and invalid epoch", () => {
    rejected(() => createApplicationQuickJsWasmBoundary({ lifetimeMs: 1, monotonicNow: () => { throw Error("secret"); } }), "clock");
    for (const epochMilliseconds of [NaN, Infinity, 1.1, 8_640_000_000_000_000])
      rejected(() => createApplicationQuickJsWasmBoundary({ lifetimeMs: 1, epochMilliseconds }), "clock");
  });

  it.each(["extra", "missing", "symbol", "accessor", "memory", "notFunction"])("rejects changed import ABI: %s", mode => {
    const f = fixture(false), getter = vi.fn(() => () => 0);
    if (mode === "extra") f.raw.u = () => 0;
    if (mode === "missing") delete f.raw.t;
    if (mode === "symbol") Object.defineProperty(f.raw, Symbol("unknown"), { value: () => 0 });
    if (mode === "accessor") Object.defineProperty(f.raw, "h", { get: getter });
    if (mode === "memory") f.raw.a = new WebAssembly.Memory({ initial: 1 });
    if (mode === "notFunction") f.raw.i = 1;
    rejected(() => f.wrap(), "imports"); expect(getter).not.toHaveBeenCalled();
  });
  it("rejects outer accessors without reading them and unknown namespaces", () => {
    const f = fixture(false), get = vi.fn(() => f.raw);
    rejected(() => f.boundary.wrapImports(Object.defineProperty({}, "a", { get }), f.module), "imports");
    expect(get).not.toHaveBeenCalled();
    const g = fixture(false); rejected(() => g.boundary.wrapImports({ a: g.raw, env: {} }, g.module), "imports");
  });
  it.each(["wasmMemory", "thisProgram", "noExitRuntime", "print", "printErr", "onAbort"])("requires original module option %s", key => {
    const f = fixture(false); (f.module as unknown as Record<string, unknown>)[key] = undefined;
    rejected(() => f.wrap(), "imports");
  });
  it("rejects second wrapping and registration out of order", () => {
    const f = fixture(); rejected(() => f.wrap(), "imports");
    const g = fixture(false); rejected(() => g.boundary.onRuntime(g.runtime), "identity");
    const h = fixture(false); h.wrap(); rejected(() => h.boundary.onContext(h.context), "identity");
  });
  it.each(["print", "printErr", "onAbort"] as const)("turns %s into a fixed sticky terminal", name => {
    const f = fixture(), error = rejected(() => f.boundary.moduleOptions[name]("secret\n"), "forbidden");
    expect(rejected(() => f.boundary.assertActive(), "forbidden")).toBe(error);
  });
  it.each(["b", "c", "j", "l", "q", "r", "s", "t"])("denies import %s before original glue", name => {
    const signatures: Record<string, unknown[]> = { b: [0, 0, 0, 0], c: [1, 0, 0, 0], j: [0, 1], l: [], q: [], r: [0], s: [0, 0, 0, 0, 0], t: [0, 0] };
    const f = fixture(); rejected(() => f.invoke(name, ...signatures[name]!), "forbidden"); expect(f.raw[name]).not.toHaveBeenCalled();
  });
  it("returns fixed errno without calling original imports", () => {
    const f = fixture(); expect(f.invoke("d", 0)).toBe(52); expect(f.invoke("o", 0, 0n, 0, 0)).toBe(70);
    expect(f.raw.d).not.toHaveBeenCalled(); expect(f.raw.o).not.toHaveBeenCalled();
  });
  it.each([["d"], ["d", 0, 0], ["d", "0"], ["d", 2 ** 31], ["d", -(2 ** 31) - 1], ["d", 0.5],
    ["m", 0, 1024], ["m", 1n << 63n, 1024], ["o", 0, -(1n << 63n) - 1n, 0, 0], ["j", 0, NaN]])("validates argument shape %j", (name, ...args) => {
    const f = fixture(); rejected(() => f.invoke(name as string, ...args), "imports");
  });

  it("writes a fixed environment without host settings or raw callbacks", () => {
    const f = fixture(); expect(f.invoke("f", 1024, 1028)).toBe(0);
    const view = new DataView(f.memory.buffer), count = view.getUint32(1024, true), length = view.getUint32(1028, true);
    expect(count).toBe(7); expect(f.invoke("e", 2048, 4096)).toBe(0);
    const values: string[] = []; for (let i = 0; i < count; i++) {
      const pointer = view.getUint32(2048 + i * 4, true), bytes = new Uint8Array(f.memory.buffer);
      values.push(Buffer.from(bytes.subarray(pointer, bytes.indexOf(0, pointer))).toString());
    }
    expect(values).toEqual(["USER=artoo", "LOGNAME=artoo", "PATH=/", "PWD=/", "HOME=/", "LANG=C.UTF-8", "_=artoo-application"]);
    expect(length).toBe(Buffer.byteLength(values.join("\0")) + 1); expect(f.raw.e).not.toHaveBeenCalled(); expect(f.raw.f).not.toHaveBeenCalled();
  });
  it.each([["f", 1024, 1024], ["f", 1025, 2048], ["f", 0, 2048], ["e", 1024, 1028], ["e", -1, 2048]])("rejects environment pointer ranges %j", (name, ...args) => {
    const f = fixture(), before = new Uint8Array(f.memory.buffer).slice(1024, 2048);
    rejected(() => f.invoke(name as string, ...args), "pointer"); expect(new Uint8Array(f.memory.buffer).slice(1024, 2048)).toEqual(before);
  });

  it("normalizes and loads through captured callbacks using original context, bounded UTF-8 and malloc", () => {
    const f = fixture(), base = f.write("app/main.js"), name = f.write("./中.js", 2048);
    const pointer = f.invoke("g", f.rt.value, f.ctx.value, base, name) as number;
    expect(f.runtime.moduleNormalizer).toHaveBeenCalledWith("app/main.js", "./中.js", f.context);
    expect(Buffer.from(new Uint8Array(f.memory.buffer).subarray(pointer, pointer + Buffer.byteLength("./中.js") + 1)).toString()).toBe("./中.js\0");
    const source = f.invoke("h", f.rt.value, f.ctx.value, name) as number;
    expect(f.runtime.moduleLoader).toHaveBeenCalledWith("./中.js", f.context);
    expect(Buffer.from(new Uint8Array(f.memory.buffer).subarray(source, source + 18)).toString()).toBe("export default 1;\0");
    expect(f.module._free).not.toHaveBeenCalled(); expect(f.raw.g).not.toHaveBeenCalled(); expect(f.raw.h).not.toHaveBeenCalled();
  });
  it.each([600, 65_490])("preserves admitted long relative import spelling (%s dot segments) through the captured owner", repetitions => {
    const request = "./".repeat(repetitions) + "value.js", source = `export {value} from ${JSON.stringify(request)};`;
    const file = (path: string, text: string): ApplicationArtifactByteFile => ({ path, bytes: Buffer.from(text) });
    const sha = (bytes: Uint8Array | string) => "sha256:" + createHash("sha256").update(bytes).digest("hex");
    const set = (files: readonly ApplicationArtifactByteFile[]) => {
      const pins = files.map(item => ({ path: item.path, bytes: item.bytes.byteLength, sha256: sha(item.bytes) }))
        .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      return { files: pins, digest: sha(JSON.stringify(pins)) };
    };
    // Controlled captured source and corresponding output text; neither executes.
    const input = { source: [file("product/client/index.html", "<h1>fixture</h1>"), file("product/server/handler.ts", source),
      file("product/server/value.ts", "export const value = 'captured';")],
    artifacts: [file("client/index.html", "<h1>fixture</h1>"), file("server/handler.js", source), file("server/value.js", "export const value = 'captured';")],
    toolchain: [file("compiler/fixed.js", "// inert controlled toolchain pin")] };
    expect(Buffer.byteLength(source)).toBeLessThanOrEqual(131_072); expect(Buffer.byteLength(request)).toBeGreaterThan(limits.nameBytes);
    const owner = createApplicationArtifactOwner({ version: 1, source: set(input.source), artifacts: set(input.artifacts), toolchain: set(input.toolchain) });
    const token = owner.capture(input), f = fixture();
    f.runtime.moduleNormalizer.mockImplementation((base, requested) => owner.resolve(token, base, requested));
    f.runtime.moduleLoader.mockImplementation(name => owner.load(token, name));
    const canonical = f.invoke("g", 64, 128, f.write("server/handler.js"), f.write(request, 4096)) as number;
    expect(f.runtime.moduleNormalizer).toHaveBeenCalledExactlyOnceWith("server/handler.js", request, f.context);
    const result = f.invoke("h", 64, 128, canonical) as number;
    expect(f.runtime.moduleLoader).toHaveBeenCalledExactlyOnceWith("server/value.js", f.context);
    const bytes = new Uint8Array(f.memory.buffer); expect(Buffer.from(bytes.subarray(result, bytes.indexOf(0, result))).toString()).toBe("export const value = 'captured';");
  });
  it("keeps canonical names bounded while independently capping relative request spelling", () => {
    const f = fixture(); rejected(() => f.invoke("g", 64, 128, f.write("base"), f.write("a".repeat(limits.requestBytes + 1), 4096)), "limit");
    expect(f.runtime.moduleNormalizer).not.toHaveBeenCalled();
    const g = fixture(); rejected(() => g.invoke("g", 64, 128, g.write("a".repeat(limits.nameBytes + 1)), g.write("./x.js", 4096)), "limit");
    expect(g.runtime.moduleNormalizer).not.toHaveBeenCalled();
  });
  it.each(["rt", "ctx", "foreignContext", "deadRuntime", "deadContext", "lifetime", "loader", "normalizer", "interrupt", "ffi", "malloc", "free"])("rejects changed original identity %s", mode => {
    const f = fixture(), name = f.write("app/main.js"); let r = f.rt.value, c = f.ctx.value;
    if (mode === "rt") r += 4;
    if (mode === "ctx") c += 4;
    if (mode === "foreignContext") f.context.runtime = { ...f.runtime };
    if (mode === "deadRuntime") f.runtime.alive = false;
    if (mode === "deadContext") f.context.alive = false;
    if (mode === "lifetime") f.runtime.rt = { ...f.rt };
    if (mode === "loader") f.runtime.moduleLoader = vi.fn(() => "replacement");
    if (mode === "normalizer") f.runtime.moduleNormalizer = vi.fn(() => "replacement");
    if (mode === "interrupt") f.runtime.interruptHandler = vi.fn(() => false);
    if (mode === "ffi") f.ffi.QTS_GetString = vi.fn(() => 4096);
    if (mode === "malloc") f.module._malloc = vi.fn(() => 8192);
    if (mode === "free") f.module._free = vi.fn();
    rejected(() => f.invoke("h", r, c, name), "identity");
  });
  it("detects callback identity mutation before copying a result", () => {
    const f = fixture(); f.runtime.moduleLoader.mockImplementation(() => { f.runtime.moduleLoader = vi.fn(() => "new"); return "ok"; });
    rejected(() => f.invoke("h", 64, 128, f.write("app.js")), "identity"); expect(f.module._malloc).not.toHaveBeenCalled();
  });
  it.each([undefined, null, 1, { error: new Error("secret") }, Promise.resolve("source"), new String("source"), "a\0b", "\ud800"])("rejects nonprimitive/error/malformed module result %s", value => {
    const f = fixture(); f.runtime.moduleLoader.mockReturnValue(value as string);
    rejected(() => f.invoke("h", 64, 128, f.write("app.js")), "callback"); expect(f.module._malloc).not.toHaveBeenCalled();
  });
  it("redacts loader exceptions and never reaches original decoding/catch/console wrappers", () => {
    const f = fixture(); f.runtime.moduleLoader.mockImplementation(() => { throw Error("secret guest input"); });
    rejected(() => f.invoke("h", 64, 128, f.write("app.js")), "callback"); expect(f.raw.h).not.toHaveBeenCalled();
  });
  it("rejects malformed, oversized and unterminated UTF-8 before callback", () => {
    for (const bytes of [Uint8Array.of(0xc0, 0xaf), Buffer.alloc(limits.nameBytes + 1, 97)]) {
      const f = fixture(); rejected(() => f.invoke("h", 64, 128, f.write(bytes)), bytes[0] === 0xc0 ? "utf8" : "limit");
      expect(f.runtime.moduleLoader).not.toHaveBeenCalled();
    }
    const f = fixture(), last = f.memory.buffer.byteLength - 1; new Uint8Array(f.memory.buffer)[last] = 97;
    rejected(() => f.invoke("h", 64, 128, last), "limit"); expect(f.runtime.moduleLoader).not.toHaveBeenCalled();
  });
  it("bounds encoded callback bytes separately from JS string length", () => {
    const f = fixture(); f.runtime.moduleNormalizer.mockReturnValue("中".repeat(400));
    rejected(() => f.invoke("g", 64, 128, f.write("app.js"), f.write("x", 2048)), "limit"); expect(f.module._malloc).not.toHaveBeenCalled();
  });
  it("preserves the existing 16 MiB compiled-artifact module ceiling", () => {
    const f = fixture(), bytes = 16 * 1024 * 1024, source = "a".repeat(bytes);
    f.invoke("k", bytes + page); f.runtime.moduleLoader.mockReturnValue(source);
    const pointer = f.invoke("h", 64, 128, f.write("server/handler.js")) as number;
    expect(f.module._malloc).toHaveBeenCalledExactlyOnceWith(bytes + 1);
    expect(Buffer.from(new Uint8Array(f.memory.buffer, pointer, bytes)).equals(Buffer.from(source))).toBe(true);
    expect(new Uint8Array(f.memory.buffer)[pointer + bytes]).toBe(0);
  });
  it("rejects modules beyond the existing compiled-artifact byte ceiling before malloc", () => {
    const f = fixture(); f.runtime.moduleLoader.mockReturnValue("a".repeat(16 * 1024 * 1024 + 1));
    rejected(() => f.invoke("h", 64, 128, f.write("server/handler.js")), "callback"); expect(f.module._malloc).not.toHaveBeenCalled();
  });
  it.each([0, -1, NaN, 1.5, 16 * 1024 * 1024])("rejects invalid malloc result %s without invalid free", value => {
    const f = fixture(); f.module._malloc.mockReturnValue(value);
    rejected(() => f.invoke("h", 64, 128, f.write("app.js")), value === 0 ? "ffi" : "pointer"); expect(f.module._free).not.toHaveBeenCalled();
  });
  it("frees an original valid allocation when the clock expires before ownership transfer", () => {
    const f = fixture(); f.module._malloc.mockImplementation(() => { f.setNow(1100); return 16_384; });
    rejected(() => f.invoke("h", 64, 128, f.write("app.js")), "clock"); expect(f.module._free).toHaveBeenCalledExactlyOnceWith(16_384);
  });

  it("dispatches interrupt only to original runtime and requires primitive boolean", () => {
    const f = fixture(); expect(f.invoke("i", 64)).toBe(0); f.runtime.interruptHandler.mockReturnValue(true); expect(f.invoke("i", 64)).toBe(1);
    expect(f.runtime.interruptHandler).toHaveBeenCalledWith(f.runtime); expect(f.raw.i).not.toHaveBeenCalled();
    f.runtime.interruptHandler.mockReturnValue(1 as unknown as boolean); rejected(() => f.invoke("i", 64), "callback");
  });
  it("allows controlled growth only through captured glue, refreshing all public views", () => {
    const f = fixture(), before = f.memory.buffer.byteLength;
    expect(f.invoke("k", before)).toBe(1); expect(f.grow).not.toHaveBeenCalled();
    expect(f.invoke("k", before + 1)).toBe(1); expect(f.memory.buffer.byteLength).toBe(before + page);
    expect(f.grow).toHaveBeenCalledExactlyOnceWith(before + 1); expect(f.module.HEAP8.buffer).toBe(f.memory.buffer); expect(f.module.HEAPU8.buffer).toBe(f.memory.buffer);
    expect(f.invoke("k", limits.maximumPages * page + 1)).toBe(0); expect(f.grow).toHaveBeenCalledTimes(1);
  });
  it("rejects stale glue views after growth", () => {
    const f = fixture(); f.grow.mockImplementation(() => { f.memory.grow(1); return 1; });
    rejected(() => f.invoke("k", f.memory.buffer.byteLength + 1), "memory");
  });
  it.each([0, 2, NaN, undefined])("rejects lying or malformed growth result %s", result => {
    const f = fixture(); f.grow.mockImplementation(() => { f.memory.grow(1); f.refresh(); return result as number; });
    rejected(() => f.invoke("k", f.memory.buffer.byteLength + 1), "memory");
  });
  it("accepts actual failed growth with unchanged memory", () => {
    const f = fixture(); f.grow.mockReturnValue(0); expect(f.invoke("k", f.memory.buffer.byteLength + 1)).toBe(0); f.boundary.assertActive();
  });
  it("rejects detached/partial public heap views before any import", () => {
    const f = fixture(); f.module.HEAPU8 = f.module.HEAPU8.subarray(1); rejected(() => f.invoke("d", 0), "memory");
    const g = fixture(); g.memory.grow(1); rejected(() => g.boundary.assertActive(), "memory");
  });

  it("provides fixed epoch plus monotonic elapsed and rejects rollback/deadline", () => {
    const f = fixture(); expect(f.invoke("p")).toBe(1_700_000_000_000); f.setNow(101.9); expect(f.invoke("p")).toBe(1_700_000_000_001);
    f.setNow(101); rejected(() => f.invoke("p"), "clock");
    const g = fixture(); g.setNow(1100); rejected(() => g.boundary.assertActive(), "clock");
  });
  it.each([NaN, Infinity])("rejects later invalid clock %s", value => {
    const f = fixture(); f.setNow(value); rejected(() => f.boundary.assertActive(), "clock");
  });
  it("redacts later clock exceptions", () => {
    const f = fixture(); f.clock.mockImplementation(() => { throw Error("secret"); }); rejected(() => f.boundary.assertActive(), "clock");
  });
  it.each([0n, -1n, 1_709_251_200n, -8_640_000_000_000n, 8_640_000_000_000n])("preserves supported Date values under explicit UTC: %s", seconds => {
    const f = fixture(); f.invoke("m", seconds, 2048); const view = new DataView(f.memory.buffer);
    const values = Array.from({ length: 10 }, (_, i) => view.getInt32(2048 + i * 4, true));
    const date = new Date(Number(seconds) * 1000);
    expect(values.slice(0, 7)).toEqual([date.getUTCSeconds(), date.getUTCMinutes(), date.getUTCHours(), date.getUTCDate(), date.getUTCMonth(), date.getUTCFullYear() - 1900, date.getUTCDay()]);
    expect(values[7]).toBeGreaterThanOrEqual(0); expect(values[7]).toBeLessThan(366); expect(values.slice(8)).toEqual([0, 0]);
    if (seconds === 1_709_251_200n) expect(values[7]).toBe(60);
  });
  it("writes bounded UTC names and zero offsets into disjoint destinations", () => {
    const f = fixture(); f.invoke("n", 1024, 1028, 2048, 2080); const view = new DataView(f.memory.buffer);
    expect(view.getInt32(1024, true)).toBe(0); expect(view.getInt32(1028, true)).toBe(0);
    for (const address of [2048, 2080]) expect(Array.from(new Uint8Array(f.memory.buffer, address, 17))).toEqual([85, 84, 67, ...Array<number>(14).fill(0)]);
    expect(f.raw.n).not.toHaveBeenCalled();
  });
  it("rejects out-of-Date-range or overlapping time writes", () => {
    const f = fixture(); rejected(() => f.invoke("m", 8_640_000_000_001n, 2048), "clock");
    const g = fixture(); rejected(() => g.invoke("n", 1024, 1028, 2048, 2050), "pointer");
  });

  it("reads original FFI CString with bounded UTF-8 and frees exactly once", () => {
    const f = fixture(); f.write("中😀", 4096);
    expect(f.boundary.boundedReadString(f.context, f.handle, 7)).toBe("中😀");
    expect(f.runtime.assertOwned).toHaveBeenCalledExactlyOnceWith(f.handle); expect(f.ffi.QTS_GetString).toHaveBeenCalledExactlyOnceWith(128, 256);
    expect(f.ffi.QTS_FreeCString).toHaveBeenCalledExactlyOnceWith(128, 4096); expect(f.module._free).not.toHaveBeenCalled();
  });
  it("accepts empty CString with zero byte allowance and preserves UTF-8 BOM", () => {
    const f = fixture(); f.write("", 4096); expect(f.boundary.boundedReadString(f.context, f.handle, 0)).toBe("");
    f.write("\ufeffx", 4096); expect(f.boundary.boundedReadString(f.context, f.handle, 4)).toBe("\ufeffx");
  });
  it.each(["tooLong", "invalidUtf8", "unterminated", "clock", "mutation"])("frees valid CString even after %s", mode => {
    const f = fixture(), originalFree = f.ffi.QTS_FreeCString; let expected: ApplicationQuickJsBoundaryFailure = "limit", address = 4096;
    if (mode === "invalidUtf8") { f.write(Uint8Array.of(0xff), address); expected = "utf8"; }
    if (mode === "unterminated") { address = f.memory.buffer.byteLength - 1; new Uint8Array(f.memory.buffer)[address] = 97; }
    f.ffi.QTS_GetString.mockImplementation(() => {
      if (mode === "clock") { f.setNow(1100); expected = "clock"; }
      if (mode === "mutation") { f.ffi.QTS_FreeCString = vi.fn(); expected = "identity"; }
      return address;
    });
    // expected must be set before the assertion because the callback runs inside it.
    if (mode === "clock") expected = "clock"; if (mode === "mutation") expected = "identity";
    rejected(() => f.boundary.boundedReadString(f.context, f.handle, 1), expected);
    expect(originalFree).toHaveBeenCalledExactlyOnceWith(128, address); expect(f.module._free).not.toHaveBeenCalled();
  });
  it.each([0, -1, NaN, 1.5, 16 * 1024 * 1024])("never deallocates invalid CString pointer %s", pointer => {
    const f = fixture(); f.ffi.QTS_GetString.mockReturnValue(pointer); rejected(() => f.boundary.boundedReadString(f.context, f.handle, 2), "pointer");
    expect(f.ffi.QTS_FreeCString).not.toHaveBeenCalled(); expect(f.module._free).not.toHaveBeenCalled();
  });
  it("makes FFI cleanup failure terminal and fixed", () => {
    const f = fixture(); f.ffi.QTS_FreeCString.mockImplementation(() => { throw Error("secret"); });
    const error = rejected(() => f.boundary.boundedReadString(f.context, f.handle, 2), "ffi"); expect(rejected(() => f.boundary.assertActive(), "ffi")).toBe(error);
  });
  it("rejects wrong context, foreign/dead handles and invalid handle ranges before GetString", () => {
    const wrongContext = fixture(); rejected(() => wrongContext.boundary.boundedReadString({ ...wrongContext.context }, wrongContext.handle, 2), "identity");
    expect(wrongContext.ffi.QTS_GetString).not.toHaveBeenCalled();
    for (const mode of ["foreign", "dead", "pointer"]) {
      const f = fixture(); if (mode === "foreign") f.handle.owner = { ...f.runtime }; if (mode === "dead") f.handle.alive = false; if (mode === "pointer") f.handle.value = 0;
      rejected(() => f.boundary.boundedReadString(f.context, f.handle, 2), mode === "foreign" ? "callback" : mode === "dead" ? "identity" : "pointer");
      expect(f.ffi.QTS_GetString).not.toHaveBeenCalled();
    }
  });
  it.each([-1, 0.5, Infinity, limits.stringBytes + 1])("rejects read byte allowance %s", maximum => {
    const f = fixture(); rejected(() => f.boundary.boundedReadString(f.context, f.handle, maximum), "limit"); expect(f.ffi.QTS_GetString).not.toHaveBeenCalled();
  });
  it("documents the caller length check needed to reject embedded NUL instead of a valid-looking prefix", () => {
    const f = fixture(), guestString = '{"ok":true}\0ignored'; f.write(guestString, 4096);
    const decoded = f.boundary.boundedReadString(f.context, f.handle, 100);
    expect(decoded).toBe('{"ok":true}'); expect(decoded.length).not.toBe(guestString.length);
    // The session owns this mandatory UTF-16 length equality gate before JSON parse.
    expect(f.ffi.QTS_FreeCString).toHaveBeenCalledExactlyOnceWith(128, 4096);
  });

  it("bounds total imports and remains sticky", () => {
    const f = fixture(); for (let i = 0; i < limits.imports; i++) f.invoke("d", 0);
    const error = rejected(() => f.invoke("d", 0), "limit"); expect(rejected(() => f.boundary.assertActive(), "limit")).toBe(error);
  });
  it("bounds total clock, Date and growth calls", () => {
    const clockBoundary = createApplicationQuickJsWasmBoundary({ lifetimeMs: 1, monotonicNow: () => 0 });
    for (let i = 0; i < limits.clockReads; i++) clockBoundary.assertActive(); rejected(() => clockBoundary.assertActive(), "limit");
    const f = fixture(); for (let i = 0; i < limits.dateCalls; i++) f.invoke("p"); rejected(() => f.invoke("p"), "limit");
    const g = fixture(); for (let i = 0; i < limits.growthCalls; i++) g.invoke("k", g.memory.buffer.byteLength); rejected(() => g.invoke("k", g.memory.buffer.byteLength), "limit");
    expect(g.grow).not.toHaveBeenCalled();
  });
  it("bounds total module calls and string reads", () => {
    const f = fixture(), name = f.write("x"); f.runtime.moduleLoader.mockReturnValue("");
    for (let i = 0; i < limits.moduleCalls; i++) f.invoke("h", 64, 128, name); rejected(() => f.invoke("h", 64, 128, name), "limit");
    const g = fixture(); g.write("", 4096); for (let i = 0; i < limits.stringReads; i++) g.boundary.boundedReadString(g.context, g.handle, 0);
    rejected(() => g.boundary.boundedReadString(g.context, g.handle, 0), "limit"); expect(g.ffi.QTS_FreeCString).toHaveBeenCalledTimes(limits.stringReads);
  });
  it("bounds cumulative decoded bytes and frees the read that crosses the budget", () => {
    const f = fixture(); f.write("a".repeat(limits.stringBytes), 4096);
    for (let i = 0; i < 31; i++) f.boundary.boundedReadString(f.context, f.handle, limits.stringBytes);
    rejected(() => f.boundary.boundedReadString(f.context, f.handle, limits.stringBytes), "limit"); expect(f.ffi.QTS_FreeCString).toHaveBeenCalledTimes(32);
  });
  it("bounds cumulative copied bytes before an additional allocation", () => {
    const f = fixture(), name = f.write("x"), source = "a".repeat(limits.writtenBytes / 4); f.runtime.moduleLoader.mockReturnValue(source); f.module._malloc.mockReturnValue(16_384);
    for (let i = 0; i < 3; i++) f.invoke("h", 64, 128, name);
    rejected(() => f.invoke("h", 64, 128, name), "limit"); expect(f.module._malloc).toHaveBeenCalledTimes(3);
  });
  it("closes idempotently and gives no subsequent authority", () => {
    const f = fixture(); f.boundary.close(); f.boundary.close(); const error = rejected(() => f.invoke("d", 0), "closed");
    expect(rejected(() => f.boundary.boundedReadString(f.context, f.handle, 2), "closed")).toBe(error); expect(f.ffi.QTS_GetString).not.toHaveBeenCalled();
  });
});
