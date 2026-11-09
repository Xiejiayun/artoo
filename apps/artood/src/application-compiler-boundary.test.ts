// Real bounded linear memory plus controlled ABI identities, no Wasm execution.
import { describe, expect, it, vi } from "vitest";
import { createApplicationCompilerWasmBoundary, createApplicationQuickJsWasmBoundary,
  APPLICATION_COMPILER_WASM_BOUNDARY_LIMITS, APPLICATION_QUICKJS_BOUNDARY_LIMITS } from "./application-quickjs-wasm-boundary.js";
function fixture(compiler: boolean) {
  const boundary = (compiler ? createApplicationCompilerWasmBoundary : createApplicationQuickJsWasmBoundary)({ lifetimeMs: 1000, monotonicNow: () => 100 });
  const memory = boundary.memory, module = { ...boundary.moduleOptions, HEAP8: new Int8Array(memory.buffer), HEAPU8: new Uint8Array(memory.buffer),
    _malloc: vi.fn(() => 8192), _free: vi.fn() };
  const ffi = { module, QTS_GetString: vi.fn(() => 4096), QTS_FreeCString: vi.fn() }, rt = { alive: true, value: 64 }, ctx = { alive: true, value: 128 };
  const runtime = { alive: true, rt, module, ffi, assertOwned: vi.fn(), interruptHandler: vi.fn(() => false),
    moduleLoader: vi.fn(() => { throw Error("forbidden"); }), moduleNormalizer: vi.fn(() => { throw Error("forbidden"); }) };
  const context = { alive: true, rt, ctx, runtime, module, ffi }, handle = { alive: true, value: 256 };
  const raw = { ...Object.fromEntries("bcdefghijklmnopqrst".split("").map(name => [name, vi.fn(() => { throw Error("raw forbidden"); })])), a: memory };
  boundary.wrapImports({ a: raw }, module); boundary.onRuntime(runtime); boundary.onContext(context);
  return { boundary, memory, ffi, context, handle };
}
describe("fixed compiler-only bounded CString profile", () => {
  it("keeps runtime limits unchanged and enforces a 30-second compiler ceiling", () => {
    expect(APPLICATION_QUICKJS_BOUNDARY_LIMITS.stringBytes).toBe(1024 * 1024);
    expect(APPLICATION_QUICKJS_BOUNDARY_LIMITS.lifetimeMs).toBe(180000);
    expect(APPLICATION_COMPILER_WASM_BOUNDARY_LIMITS.maximumPages).toBe(APPLICATION_QUICKJS_BOUNDARY_LIMITS.maximumPages);
    expect(() => createApplicationCompilerWasmBoundary({ lifetimeMs: 30001 })).toThrow();
  });
  it("allows a bounded compiler result beyond the runtime string cap and frees the original CString", () => {
    const f = fixture(true), length = 2 * 1024 * 1024;
    new Uint8Array(f.memory.buffer).fill(97, 4096, 4096 + length);
    expect(f.boundary.boundedReadString(f.context, f.handle, length)).toHaveLength(length);
    expect(f.ffi.QTS_FreeCString).toHaveBeenCalledWith(128, 4096); f.boundary.close();
    const runtime = fixture(false);
    expect(() => runtime.boundary.boundedReadString(runtime.context, runtime.handle, length)).toThrow();
    expect(runtime.ffi.QTS_GetString).not.toHaveBeenCalled(); runtime.boundary.close();
  });
  it("rejects output larger than the fixed requested bound and still frees a valid original CString", () => {
    const f = fixture(true); new Uint8Array(f.memory.buffer).fill(97, 4096, 4096 + 17);
    expect(() => f.boundary.boundedReadString(f.context, f.handle, 16)).toThrow();
    expect(f.ffi.QTS_FreeCString).toHaveBeenCalledOnce(); f.boundary.close();
  });
});
