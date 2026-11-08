// Controlled public QuickJS API objects only; no Wasm or guest code executes.
import { describe, expect, it, vi } from "vitest";
import { createApplicationCompilerSession, APPLICATION_COMPILER_SESSION_LIMITS } from "./application-compiler-session.js";
import type { ApplicationQuickJSContext, ApplicationQuickJSHandle, ApplicationQuickJSModule } from "./application-quickjs-session.js";
class Handle implements ApplicationQuickJSHandle { alive = true; constructor(readonly value: unknown) {} dispose() { this.alive = false; } }
function fixture() {
  let time = 100, output = '{"controlled":true}\n', vmAlive = true, runtimeAlive = true;
  const handles: Handle[] = [], own = (value: unknown) => { const handle = new Handle(value); handles.push(handle); return handle; };
  const vm = { get alive() { return vmAlive; }, undefined: new Handle(undefined),
    evalCode: vi.fn((_source: string, name: string) => ({ value: own(name === "fixed-compiler-entry.js" ? (() => {}) : 0) })),
    typeof: vi.fn((handle: Handle) => typeof handle.value), getProp: vi.fn((handle: Handle, name: string) => {
      if (name !== "length" || typeof handle.value !== "string") throw Error("unexpected property"); return own(handle.value.length);
    }), getNumber: vi.fn((handle: Handle) => handle.value), newString: vi.fn((text: string) => own(text)),
    callFunction: vi.fn(() => ({ value: own(output) })), getString: vi.fn(() => { throw Error("unbounded reader forbidden"); }),
    dispose: vi.fn(() => { vmAlive = false; }), getPromiseState() { throw Error("unexpected promise"); } };
  const runtime = { get alive() { return runtimeAlive; }, newContext: vi.fn(() => vm), setMemoryLimit: vi.fn(), setMaxStackSize: vi.fn(),
    setInterruptHandler: vi.fn(), setModuleLoader: vi.fn(), hasPendingJob: vi.fn(() => false), executePendingJobs() { throw Error("unexpected job"); },
    dispose: vi.fn(() => { runtimeAlive = false; }) };
  const boundary = { onRuntime: vi.fn(), onContext: vi.fn(), boundedReadString: vi.fn((_vm: ApplicationQuickJSContext, handle: ApplicationQuickJSHandle) => (handle as Handle).value as string) };
  const module = { newRuntime: vi.fn(() => runtime) } as unknown as ApplicationQuickJSModule;
  return { vm, runtime, module, boundary, handles, now: () => time, setTime: (value: number) => { time = value; }, setOutput: (value: string) => { output = value; },
    create: () => createApplicationCompilerSession({ module, boundary, typescript: "// trusted TypeScript bytes", guest: "// trusted fixed guest", deadline: 2100, now: () => time }) };
}
const request = () => Buffer.from(JSON.stringify({ version: 1, kind: "compile", request_id: "controlled", source: [
  { path: "product/client/index.html", text: "<title>controlled</title>" }, { path: "product/server/handler.ts", text: "export const handle = () => 1;" } ] }));
describe("fixed compiler session controlled ownership", () => {
  it("evaluates only trusted bootstraps and passes the product request as a string argument", () => {
    const f = fixture(), session = f.create(), result = session.compile(request());
    expect(result.toString()).toBe('{"controlled":true}\n'); expect(f.vm.newString).toHaveBeenCalledWith(request().toString());
    expect(f.vm.evalCode.mock.calls.map(call => call[1])).toEqual(["fixed-typescript-5.9.3.js", "application-compiler-guest.js", "fixed-compiler-entry.js"]);
    expect(f.vm.evalCode.mock.calls.some(call => call[0].includes("product/server"))).toBe(false); expect(f.vm.getString).not.toHaveBeenCalled();
    expect(f.boundary.boundedReadString).toHaveBeenCalledWith(f.vm, expect.any(Handle), 100 * 1024 * 1024);
    expect(f.runtime.setMemoryLimit).toHaveBeenCalledWith(APPLICATION_COMPILER_SESSION_LIMITS.heapBytes);
    expect(f.runtime.setMaxStackSize).toHaveBeenCalledWith(APPLICATION_COMPILER_SESSION_LIMITS.stackBytes);
    session.assertDisposed(); expect(f.handles.every(handle => !handle.alive)).toBe(true);
    expect(() => session.compile(request())).toThrow("used"); expect(() => f.create()).toThrow("owner");
  });
  it("sets only rejecting module callbacks before registering the context", () => {
    const f = fixture(), session = f.create();
    const callbacks = f.runtime.setModuleLoader.mock.calls[0]! as unknown as [() => void, () => void];
    expect(() => callbacks[0]()).toThrow("forbidden"); expect(() => callbacks[1]()).toThrow("forbidden");
    expect(f.runtime.setModuleLoader.mock.invocationCallOrder[0]).toBeLessThan(f.boundary.onContext.mock.invocationCallOrder[0]!); session.close();
  });
  it.each(["type", "length", "nul", "jobs", "ffi", "deadline"])("rejects %s and disposes without delivering output", kind => {
    const f = fixture(), session = f.create();
    if (kind === "type") f.vm.typeof.mockReturnValue("object");
    if (kind === "length") f.vm.getNumber.mockReturnValue(100 * 1024 * 1024 + 1);
    if (kind === "nul") { f.setOutput("before\0after"); f.boundary.boundedReadString.mockReturnValue("before"); }
    if (kind === "jobs") f.runtime.hasPendingJob.mockReturnValue(true);
    if (kind === "ffi") f.boundary.boundedReadString.mockImplementation(() => { throw Error("controlled pointer rejection"); });
    if (kind === "deadline") f.boundary.boundedReadString.mockImplementation((_vm, handle) => { f.setTime(2100); return (handle as Handle).value as string; });
    expect(() => session.compile(request())).toThrow(); session.assertDisposed();
    if (kind === "type" || kind === "length") expect(f.boundary.boundedReadString).not.toHaveBeenCalled();
  });
  it("permanently records uncertain disposal and does not manufacture cleanup on another close", () => {
    const f = fixture(), session = f.create(); f.vm.dispose.mockImplementation(() => { throw Error("controlled disposal failure"); });
    expect(() => session.compile(request())).toThrow("disposal"); session.close(); expect(() => session.assertDisposed()).toThrow("disposal");
    expect(f.vm.dispose).toHaveBeenCalledOnce(); expect(f.runtime.dispose).toHaveBeenCalledOnce();
  });
  it("disposes failed startup without returning a session or dumping a guest error", () => {
    const f = fixture(); f.vm.evalCode.mockImplementation(() => ({ error: new Handle("private guest text") }) as never);
    expect(() => f.create()).toThrow("compiler-session-startup"); expect(f.vm.dispose).toHaveBeenCalledOnce(); expect(f.runtime.dispose).toHaveBeenCalledOnce();
  });
});
