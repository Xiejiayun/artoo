import { createWindowsStopDiagnostics, type WindowsStopDiagnostic } from "./windows-stop-diagnostics.js";
import { markWindowsNativeFailure } from "./owned/windows-process-diagnostic.js";
// Real node-client activation ordering with controlled native/runtime and publisher boundaries.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeSideTransport, RuntimeAdapter } from "@artoo/protocol";
import * as recoveryClient from "./source-recovery-client.js";
import * as recovery from "./windows-source-recovery.js";
import * as source from "./product-source-runtime.js";
import * as publication from "./product-release.js";
import { createNodeClient } from "./node-client.js";
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => { Object.defineProperty(process, "platform", { ...platform, value: "win32" }); });
afterEach(() => { vi.restoreAllMocks(); Object.defineProperty(process, "platform", platform); });
function fixture(supervised = true) {
  let live = true, active = true, resolve!: () => void, reject!: (error: Error) => void;
  const initialized = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  const publisher = { start: vi.fn(() => initialized), stop: vi.fn(async () => {}), requestStop: vi.fn(), getHealthReports: () => [] };
  vi.spyOn(publication, "createProductReleaseExecutor").mockReturnValue(publisher as unknown as ReturnType<typeof publication.createProductReleaseExecutor>);
  const controller = { isActive: () => active, invalidate() { active = false; }, settled: async () => {} };
  const create = vi.spyOn(recoveryClient, "createProductSourceRecoveryClient").mockReturnValue(controller as unknown as ReturnType<typeof recoveryClient.createProductSourceRecoveryClient>);
  vi.spyOn(recovery, "withWindowsSourceRecoveryOperation").mockImplementation((_runtime, _descriptor, work) => work());
  const runtime = Object.freeze({}) as recovery.PreparedWindowsSourceRecoveryRuntime;
  const sourceRuntime = Object.freeze({}) as source.PreparedProductSourceRuntime;
  vi.spyOn(recovery, "readWindowsRecoverySourceRuntime").mockReturnValue(sourceRuntime);
  vi.spyOn(source, "assertProductSourceRuntimeConfiguration").mockImplementation(() => {});
  const ready = vi.fn(), failed = vi.fn();
  const unsubscribe = vi.fn();
  const transport: NodeSideTransport = { acknowledgesRunEvents: true, send: async () => {}, subscribe: () => unsubscribe };
  const adapter: RuntimeAdapter = { runtimeId: "fixture", async start() { throw Error("Execution is forbidden in this fixture"); },
    async *streamEvents() {}, async stop() {}, async collectArtifacts() { return []; } };
  const client = createNodeClient({ nodeId: "node", transport, adapter, productSourceRecovery: { configuration: {} as never,
    features: [], isCurrent: () => live, activate: () => sourceRuntime, ...(supervised ? { onReady: ready } : {}), onFailure: failed } });
  client.start();
  const activate = () => create.mock.calls[0]![0].activate(runtime);
  return { client, publisher, activate, resolve, reject, ready, failed, unsubscribe, controller, disconnect() { live = false; } };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
describe("registered source publisher initialization", () => {
  it("does not report execution-ready until fresh publication listeners finish", async () => {
    const f = fixture(); f.activate(); await flush(); expect(f.ready).not.toHaveBeenCalled();
    expect(f.publisher.start).toHaveBeenCalledTimes(1); f.resolve(); await flush(); expect(f.ready).toHaveBeenCalledTimes(1);
    expect(f.failed).not.toHaveBeenCalled(); await f.client.stop(true);
  });
  it("reports publisher failure without an intervening ready notification", async () => {
    const f = fixture(); f.activate(); const error = Error("controlled publisher failure"); f.reject(error); await flush();
    expect(f.ready).not.toHaveBeenCalled(); expect(f.failed).toHaveBeenCalledWith(error); await f.client.stop(true);
  });
  it("rejects an initialization completion after its original session disconnects", async () => {
    const f = fixture(); f.activate(); f.disconnect(); f.resolve(); await flush();
    expect(f.ready).not.toHaveBeenCalled(); expect(f.failed).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/current registered session/) }));
    await f.client.stop(true);
  });
  it("cannot publish readiness after shutdown invalidates the registration", async () => {
    const f = fixture(); f.activate(); const stopping = f.client.stop(true); f.resolve(); await stopping; await flush();
    expect(f.ready).not.toHaveBeenCalled(); expect(f.failed).toHaveBeenCalled();
  });
  it("does not add the supervised readiness failure path to ordinary recovery clients", async () => {
    const f = fixture(false); f.activate(); f.disconnect(); f.resolve(); await flush();
    expect(f.ready).not.toHaveBeenCalled(); expect(f.failed).not.toHaveBeenCalled(); await f.client.stop(true);
  });
});

describe("supervised stop admission diagnostics", () => {
  it("joins fallback close after scope rejection, then retains the original failed stop", async () => {
    const f = fixture(); f.activate(); f.resolve(); await flush();
    const original = markWindowsNativeFailure(Error("private-stop-scope-path"), "native_nonzero_exit");
    vi.mocked(recovery.withWindowsSourceRecoveryOperation).mockImplementation((_runtime, descriptor, work) => {
      if (descriptor.operationId === "node-stop") throw original; return work();
    });
    let finish!: () => void;
    f.publisher.stop.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const events: WindowsStopDiagnostic[] = [], diagnostics = createWindowsStopDiagnostics(value => events.push(value));
    let settled = false;
    const stopping = diagnostics.run(() => f.client.stop(true));
    const checked = expect(stopping).rejects.toBe(original); void stopping.then(() => { settled = true; }, () => { settled = true; });
    for (let i = 0; i < 12 && f.publisher.stop.mock.calls.length === 0; i++) await flush();
    expect(f.unsubscribe).toHaveBeenCalledTimes(1); expect(f.controller.isActive()).toBe(false);
    expect(f.publisher.requestStop).toHaveBeenCalledTimes(1); expect(f.publisher.stop).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    expect(events.filter(value => value.status === "failed")).toEqual([expect.objectContaining({ phase: "guardian_scope_admission",
      error_code: "stop_stage_failed", native_failure_code: "native_nonzero_exit" })]);
    finish(); await checked; expect(settled).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ phase: "fallback_close", status: "completed" }));
    expect(JSON.stringify(events)).not.toContain("private-stop-scope-path");
  });
});
