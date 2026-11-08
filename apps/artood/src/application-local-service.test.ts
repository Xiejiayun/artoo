// Every listener, process, profile and owner below is a controlled stand-in.
// This suite never opens a real socket, database or native process.
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationHttpIngressOptions, ApplicationHttpAdmissionStop, ApplicationHttpInvocation } from "./application-http-ingress.js";
import type { ApplicationBrokerProcess, ApplicationBrokerProcessReceipt } from "./application-broker-process.js";
const state = vi.hoisted(() => ({ createServer: vi.fn(), createIngress: vi.fn(), createService: vi.fn(),
  assertStore: vi.fn(), describe: vi.fn(), prepareBroker: vi.fn(), prepareRuntime: vi.fn(), startBroker: vi.fn() }));
vi.mock("node:http", () => ({ createServer: state.createServer }));
vi.mock("node:child_process", () => ({ spawn: () => { throw Error("No real process allowed"); }, spawnSync: () => { throw Error("No real process allowed"); } }));
vi.mock("./application-service.js", () => ({ createApplicationService: state.createService }));
vi.mock("./application-http-ingress.js", () => ({ APPLICATION_HTTP_LIMITS: { headerBytes: 16_384 }, createApplicationHttpIngress: state.createIngress }));
vi.mock("./application-broker-process.js", () => ({ startApplicationBrokerProcess: state.startBroker }));
vi.mock("./application-service-profile.js", () => ({ describeApplicationServiceProfile: state.describe,
  assertApplicationServiceOpenStore: state.assertStore, prepareProfileApplicationBroker: state.prepareBroker, prepareProfileApplicationRuntime: state.prepareRuntime }));
import { initializeApplicationStore, checkExistingApplicationStore, startLocalApplicationService } from "./application-local-service.js";
import type { PreparedApplicationServiceProfile } from "./application-service-profile.js";
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
const profile = Object.freeze({}) as PreparedApplicationServiceProfile;
class Socket extends EventEmitter {
  destroyed = false;
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit("close"); } }
}
class Server extends EventEmitter {
  mode: "ready" | "failure" = "ready";
  maxHeadersCount = 64; maxConnections = 0; headersTimeout = 0; requestTimeout = 0; keepAliveTimeout = 0; maxRequestsPerSocket = 0;
  closeFailure?: Error; closeCallback?: (error?: Error) => void; holdClose = false;
  listen = vi.fn((_options: unknown) => { queueMicrotask(() => this.mode === "failure" ? this.emit("error", Error("controlled bind failure")) : this.emit("listening")); });
  close = vi.fn((callback: (error?: Error) => void) => { if (this.holdClose) this.closeCallback = callback; else callback(this.closeFailure); });
  closeIdleConnections = vi.fn();
}
let server: Server, stopAdmission: ReturnType<typeof deferred<ApplicationHttpAdmissionStop>>, failAdmission: ReturnType<typeof deferred<void>>, ingressClose: ReturnType<typeof vi.fn>;
let ingressOptions: ApplicationHttpIngressOptions;
const receipt = { normalShutdown: true } as ApplicationBrokerProcessReceipt;
beforeEach(() => {
  vi.clearAllMocks(); server = new Server(); stopAdmission = deferred(); failAdmission = deferred();
  state.describe.mockReturnValue({ origin: "http://127.0.0.1:31000", port: 31000, timeoutMs: 1000, maximumAccess: "write", qualifiedForProduct: false });
  state.assertStore.mockReset(); state.createServer.mockReturnValue(server);
  state.createService.mockReturnValue({ maximumAccess: "write", begin: vi.fn() });
  ingressClose = vi.fn(() => stopAdmission.resolve("closed"));
  state.createIngress.mockImplementation((options: ApplicationHttpIngressOptions) => {
    ingressOptions = options; return { admissionStopped: stopAdmission.promise, admissionFailed: failAdmission.promise, close: ingressClose, handle: vi.fn(async () => {}) };
  });
  state.prepareBroker.mockReset().mockReturnValue(Object.freeze({})); state.startBroker.mockReset();
});
afterEach(() => { vi.useRealTimers(); });
function addOwner(handle: ApplicationHttpInvocation) {
  vi.mocked(state.createService.mock.results[0]!.value.begin).mockReturnValueOnce(handle);
  return ingressOptions.service.begin({ kind: "begin", invocation: "local-test", requestJson: "{}", purpose: "application", access: "read", lifetimeMs: 1000 }, new AbortController().signal);
}
describe("bounded installed application listener ownership", () => {
  it("checks existing storage before binding and fixes browser policy and listener limits", async () => {
    const live = await startLocalApplicationService(profile);
    expect(state.assertStore).toHaveBeenCalledWith(profile); expect(state.startBroker).not.toHaveBeenCalled();
    expect(ingressOptions).toMatchObject({ readOnlyGet: true, maximumConcurrent: 1, purpose: "application", access: "write" });
    expect(server.listen).toHaveBeenCalledWith({ host: "127.0.0.1", port: 31000, exclusive: true });
    expect(server).toMatchObject({ maxHeadersCount: 0, maxConnections: 16, headersTimeout: 1000, requestTimeout: 1000, maxRequestsPerSocket: 1 });
    await live.close(); await live.closed;
  });
  it("does not bind a listener if the fixed existing-store admission fails", async () => {
    state.assertStore.mockImplementation(() => { throw Error("missing existing store"); });
    await expect(startLocalApplicationService(profile)).rejects.toThrow("missing existing store"); expect(state.createServer).not.toHaveBeenCalled();
  });
  it("keeps exact original handles and waits for both listener close and owner settlement", async () => {
    const live = await startLocalApplicationService(profile), settlement = deferred<void>(); server.holdClose = true;
    const handle = { response: Promise.resolve("{}"), settled: settlement.promise, cancel: vi.fn() };
    expect(addOwner(handle)).toBe(handle);
    const close = live.close(); expect(live.close()).toBe(close);
    let done = false; void close.then(() => { done = true; });
    server.closeCallback!(); await Promise.resolve(); expect(done).toBe(false);
    settlement.resolve(); await close; expect(server.close).toHaveBeenCalledOnce(); await live.closed;
  });
  it("still awaits other original settlements after a listener or owner failure", async () => {
    const live = await startLocalApplicationService(profile), other = deferred<void>();
    const failed = Promise.reject(Error("uncertain original closure")); void failed.catch(() => {});
    addOwner({ response: Promise.resolve("{}"), settled: failed, cancel() {} });
    addOwner({ response: Promise.resolve("{}"), settled: other.promise, cancel() {} });
    server.closeFailure = Error("controlled listener close failure");
    let done = false; const closing = live.close(); void closing.catch(() => { done = true; });
    await new Promise<void>(resolve => setImmediate(resolve)); expect(done).toBe(false);
    other.resolve(); await expect(closing).rejects.toThrow("closure failed"); await expect(live.closed).rejects.toThrow("closure failed");
  });
  it("closes the original listener on bind failure and returns its cleanup outcome", async () => {
    server.mode = "failure";
    const error = await startLocalApplicationService(profile).catch(error => error);
    expect(error.message).toBe("Application listener startup failed"); expect(error.cleanup).toEqual([{ status: "fulfilled", value: undefined }]);
    expect(server.close).toHaveBeenCalledOnce(); expect(state.startBroker).not.toHaveBeenCalled();
  });
  it("drains a lifetime-budget stop without cancelling the last owner, with explicit shutdown escalation", async () => {
    const live = await startLocalApplicationService(profile), settlement = deferred<void>();
    addOwner({ response: Promise.resolve("{}"), settled: settlement.promise, cancel() {} });
    stopAdmission.resolve("budget_exhausted"); await Promise.resolve();
    expect(server.close).toHaveBeenCalledOnce(); expect(ingressClose).not.toHaveBeenCalled();
    const closing = live.close(); expect(ingressClose).toHaveBeenCalledOnce(); settlement.resolve(); await closing;
  });
  it("captures a late owner after budget shutdown begins and still awaits it after transport completion", async () => {
    const live = await startLocalApplicationService(profile), transport = deferred<void>(), settlement = deferred<void>();
    state.createIngress.mock.results[0]!.value.handle.mockReturnValueOnce(transport.promise);
    // Controlled delayed body: its ingress handle exists before service.begin.
    state.createServer.mock.calls[0]![1]({}, { destroy: vi.fn() });
    stopAdmission.resolve("budget_exhausted"); await Promise.resolve();
    addOwner({ response: Promise.resolve("{}"), settled: settlement.promise, cancel() {} });
    let done = false; void live.closed.then(() => { done = true; });
    transport.resolve(); await new Promise<void>(resolve => setImmediate(resolve)); expect(done).toBe(false);
    settlement.resolve(); await live.closed; expect(ingressClose).not.toHaveBeenCalled();
  });
  it("retains an admission failure and a later server error as failed lifecycle outcomes", async () => {
    const live = await startLocalApplicationService(profile);
    failAdmission.resolve(); stopAdmission.resolve("failed"); await expect(live.closed).rejects.toThrow("closure failed");
    expect(ingressClose).toHaveBeenCalledOnce();
  });
  it("upgrades a budget drain to failure even when the last original owner settles normally", async () => {
    const live = await startLocalApplicationService(profile), transport = deferred<void>();
    state.createIngress.mock.results[0]!.value.handle.mockReturnValueOnce(transport.promise);
    state.createServer.mock.calls[0]![1]({}, { destroy: vi.fn() });
    stopAdmission.resolve("budget_exhausted"); await Promise.resolve();
    addOwner({ response: Promise.resolve("{}"), settled: Promise.resolve(), cancel() {} });
    failAdmission.resolve(); transport.resolve();
    await expect(live.closed).rejects.toThrow("closure failed"); expect(ingressClose).toHaveBeenCalledOnce();
  });
  it.each([1000, 10_000])("closes incomplete headers at their original limit with a %i ms request budget", async timeoutMs => {
    state.describe.mockReturnValue({ ...state.describe(), timeoutMs });
    vi.useFakeTimers(); const opening = startLocalApplicationService(profile); await vi.runAllTicks(); const live = await opening;
    const sockets = Array.from({ length: 17 }, () => new Socket()); for (const socket of sockets) server.emit("connection", socket);
    expect(sockets[16]!.destroyed).toBe(true);
    const headerLimit = Math.min(5000, timeoutMs);
    await vi.advanceTimersByTimeAsync(headerLimit - 1);
    expect(sockets.slice(0, 16).every(socket => !socket.destroyed)).toBe(true);
    for (const socket of sockets.slice(0, 16)) socket.emit("data", Buffer.from("partial header"));
    await vi.advanceTimersByTimeAsync(1); expect(sockets.every(socket => socket.destroyed)).toBe(true);
    expect(state.createIngress.mock.results[0]!.value.handle).not.toHaveBeenCalled(); await live.close();
  });
  it("clears the header phase on a complete request while retaining the original absolute socket deadline", async () => {
    state.describe.mockReturnValue({ ...state.describe(), timeoutMs: 10_000 });
    vi.useFakeTimers(); const opening = startLocalApplicationService(profile); await vi.runAllTicks(); const live = await opening;
    const socket = new Socket(), transport = deferred<void>(); server.emit("connection", socket);
    await vi.advanceTimersByTimeAsync(4000);
    state.createIngress.mock.results[0]!.value.handle.mockReturnValueOnce(transport.promise);
    state.createServer.mock.calls[0]![1]({ socket }, { destroy: vi.fn() });
    await vi.advanceTimersByTimeAsync(1000); expect(socket.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(9999); expect(socket.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(socket.destroyed).toBe(true);
    transport.resolve(); await live.close();
  });
  it("clears both connection timers when the original socket closes early", async () => {
    vi.useFakeTimers(); const opening = startLocalApplicationService(profile); await vi.runAllTicks(); const live = await opening;
    const socket = new Socket(); server.emit("connection", socket);
    expect(vi.getTimerCount()).toBe(2); socket.destroy(); expect(vi.getTimerCount()).toBe(0); await live.close();
  });
  it("rejects Upgrade, CONNECT, Expect and parser-error paths without dispatching product work", async () => {
    const live = await startLocalApplicationService(profile), socket = new Socket(), response = { destroy: vi.fn() };
    server.emit("upgrade", {}, socket); expect(socket.destroyed).toBe(true);
    server.emit("checkContinue", {}, response); server.emit("checkExpectation", {}, response); expect(response.destroy).toHaveBeenCalledTimes(2);
    expect(state.createService.mock.results[0]!.value.begin).not.toHaveBeenCalled();
    await live.close();
  });
});
describe.each([
  { mode: "create" as const, label: "initialization", operation: initializeApplicationStore },
  { mode: "open" as const, label: "preflight", operation: checkExistingApplicationStore },
])("separate original broker store $label", ({ mode, label, operation }) => {
  function broker() {
    const ready = deferred<void>(), closed = deferred<ApplicationBrokerProcessReceipt>();
    const owner = { ready: ready.promise, closed: closed.promise, command: vi.fn(), stop: vi.fn(() => closed.promise), cancel: vi.fn(() => closed.promise) } satisfies ApplicationBrokerProcess;
    state.startBroker.mockReturnValue(owner); return { owner, ready, closed };
  }
  it("uses only its fixed mode and waits for the actual normal stop receipt", async () => {
    const f = broker(), work = operation(profile); f.ready.resolve(); await Promise.resolve();
    expect(state.prepareBroker).toHaveBeenCalledExactlyOnceWith(profile, mode); expect(f.owner.stop).toHaveBeenCalledOnce();
    let done = false; void work.then(() => { done = true; }); await Promise.resolve(); expect(done).toBe(false);
    f.closed.resolve(receipt); await expect(work).resolves.toBe(receipt);
    expect(state.createServer).not.toHaveBeenCalled(); expect(state.prepareRuntime).not.toHaveBeenCalled(); expect(f.owner.command).not.toHaveBeenCalled();
  });
  it("creates no work if already cancelled", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(operation(profile, controller.signal)).rejects.toThrow(`Application store ${label} cancelled`);
    expect(state.prepareBroker).not.toHaveBeenCalled(); expect(state.startBroker).not.toHaveBeenCalled();
  });
  it("never changes modes after admission rejects a missing or invalid store", async () => {
    const failure = Error("controlled store admission failure"); state.prepareBroker.mockImplementation(() => { throw failure; });
    await expect(operation(profile)).rejects.toBe(failure);
    expect(state.prepareBroker).toHaveBeenCalledExactlyOnceWith(profile, mode); expect(state.startBroker).not.toHaveBeenCalled();
  });
  it("does not start a process after cancellation during preparation", async () => {
    const controller = new AbortController(); state.prepareBroker.mockImplementation(() => { controller.abort(); return Object.freeze({}); });
    await expect(operation(profile, controller.signal)).rejects.toThrow(`Application store ${label} cancelled`);
    expect(state.prepareBroker).toHaveBeenCalledExactlyOnceWith(profile, mode); expect(state.startBroker).not.toHaveBeenCalled();
  });
  it("rejects a stop receipt without normal closure and retains both original outcomes", async () => {
    const f = broker(), failed = { normalShutdown: false, failure: "controlled abnormal exit" } as ApplicationBrokerProcessReceipt;
    const work = operation(profile); f.ready.resolve(); f.closed.resolve(failed);
    const error = await work.catch(error => error);
    expect(error.message).toBe(`Application store ${label} failed; store retained`);
    expect(error.cause.message).toBe(`Application store ${label} did not close normally`);
    expect(error.cleanup).toEqual([{ status: "fulfilled", value: failed }, { status: "fulfilled", value: failed }]);
    expect(f.owner.stop).toHaveBeenCalledOnce(); expect(f.owner.cancel).toHaveBeenCalledOnce();
  });
  it("awaits the original closed promise after startup cancellation and preserves exact failed receipts", async () => {
    const f = broker(), controller = new AbortController(), work = operation(profile, controller.signal);
    controller.abort(); f.ready.reject(Error("cancelled startup"));
    let done = false; void work.catch(() => { done = true; }); await new Promise<void>(resolve => setImmediate(resolve));
    expect(done).toBe(false); expect(f.owner.cancel).toHaveBeenCalled();
    const failed = { normalShutdown: false, failure: "cancelled" } as ApplicationBrokerProcessReceipt;
    f.closed.resolve(failed); const error = await work.catch(error => error);
    expect(error.cleanup).toEqual([{ status: "fulfilled", value: failed }, { status: "fulfilled", value: failed }]);
  });
  it("retains a throwing original cancellation and still awaits the independent closed promise", async () => {
    const f = broker(), failure = Error("controlled cancellation throw");
    f.owner.cancel.mockImplementation(() => { throw failure; });
    const work = operation(profile); f.ready.reject(Error("controlled startup failure"));
    let done = false; void work.catch(() => { done = true; }); await new Promise<void>(resolve => setImmediate(resolve));
    expect(done).toBe(false); const failed = { normalShutdown: false } as ApplicationBrokerProcessReceipt;
    f.closed.resolve(failed); const error = await work.catch(error => error);
    expect(error.cleanup).toEqual([{ status: "rejected", reason: failure }, { status: "fulfilled", value: failed }]);
  });
});
