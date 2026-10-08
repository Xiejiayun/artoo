import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { installShutdownHandlers, main, provisionManagedJournal, runDaemonEntrypoint, type ShutdownHost } from "./main.js";
import * as journal from "./managed/journal.js";
import * as bootstrap from "./managed/managed-bootstrap.js";
import * as ordinary from "./node-runner.js";
import * as adapter from "./process-adapter.js";
import * as registry from "./adapter-registry.js";
import * as transport from "./managed/managed-ws-transport.js";
import { DeliveryCancelled } from "./managed/managed-delivery.js";

// IPC/lifecycle doubles only. These tests never create a journal, process or socket.
const requestId = "e2f12780-312b-45e1-83f8-d58bc36e0271";
const launchId = "efdf3450-23fc-4e8a-8b18-993f5bf78e31";
const namespace = "b97dd4fc-abcf-4a11-b9e5-8b2a7eac60fb";
const preparationEnv = { ARTOO_JOURNAL_VERSION: "1", ARTOO_JOURNAL_SERVER_ORIGIN: "https://artoo.example",
  ARTOO_JOURNAL_NODE_ID: "computer_1", ARTOO_JOURNAL_DIRECTORY: "/Users/fixture/Artoo/journal",
  ARTOO_JOURNAL_CONTROLLER_SCOPE: "controller_1", ARTOO_JOURNAL_REQUEST_ID: requestId };
const workerEnv = { ...preparationEnv, ARTOO_JOURNAL_NAMESPACE: namespace, ARTOO_MANAGED_EXECUTION: "0",
  ARTOO_WORKER_LAUNCH_ID: launchId, ARTOO_NODE_URL: "wss://artoo.example/api/v1/node?token=fixture",
  ARTOO_NODE_ID: "computer_1", ARTOO_ALLOWED_ROOTS: "/Users/fixture", ARTOO_WORKTREE_BASE_REPO: "/Users/fixture/source",
  ARTOO_RUNTIMES: "codex" };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); void promise.catch(() => {});
  return { promise, resolve, reject };
}
const releases: Array<() => void> = [], hosts: IpcHost[] = [], pending: Promise<unknown>[] = [];
function gate() { const value = deferred<void>(); releases.push(() => value.resolve()); return value; }
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function observe<T>(work: Promise<T>): Promise<T> { void work.catch(() => {}); pending.push(work); return work; }
function causes(error: unknown): unknown[] { return error instanceof AggregateError ? [error, ...error.errors.flatMap(causes)] : [error]; }
class IpcHost extends EventEmitter implements ShutdownHost {
  connected: boolean | undefined = true;
  argv = ["electron", "/app/daemon/artood.mjs", "--prepared-journal"];
  autoSend = true;
  autoDisconnect = true;
  frames: Array<{ message: Record<string, unknown>; callback(error: Error | null): void; acknowledged: boolean }> = [];
  events: string[] = [];
  exit = vi.fn((code: number) => { this.events.push(`exit:${code}`); });
  send = vi.fn((message: Record<string, unknown>, callback: (error: Error | null) => void) => {
    const frame = { message, callback, acknowledged: false }; this.frames.push(frame); this.events.push(`send:${String(message.type)}`);
    if (this.autoSend) queueMicrotask(() => { if (!frame.acknowledged) { frame.acknowledged = true; callback(null); } });
    return true;
  });
  disconnect = vi.fn(() => {
    this.events.push("disconnect.requested"); this.connected = false;
    if (this.autoDisconnect) queueMicrotask(() => this.emit("disconnect"));
  });
  acknowledge(type: string, error: Error | null = null): void {
    const frame = this.frames.find((entry) => entry.message.type === type && !entry.acknowledged);
    if (!frame) throw new Error(`No pending ${type} frame`);
    frame.acknowledged = true; frame.callback(error);
  }
  finishDisconnect(): void { this.connected = false; this.emit("disconnect"); }
  constructor() { super(); hosts.push(this); }
}
let provision: MockInstance<typeof journal.provisionLocalJournal>;
let managed: MockInstance<typeof bootstrap.createManagedBootstrap>;
let legacy: MockInstance<typeof ordinary.createArtoodNode>;
let processAdapter: MockInstance<typeof adapter.createProcessAdapter>;
let openJournal: MockInstance<typeof journal.openLocalJournal>;
let createRegistry: MockInstance<typeof registry.createAdapterRegistry>;
let createTransport: MockInstance<typeof transport.createManagedWebSocketTransport>;
beforeEach(() => {
  provision = vi.spyOn(journal, "provisionLocalJournal").mockResolvedValue({ namespace, pragmas: {} });
  managed = vi.spyOn(bootstrap, "createManagedBootstrap"); legacy = vi.spyOn(ordinary, "createArtoodNode");
  processAdapter = vi.spyOn(adapter, "createProcessAdapter");
  openJournal = vi.spyOn(journal, "openLocalJournal").mockRejectedValue(new Error("Unexpected journal open in IPC fixture"));
  createRegistry = vi.spyOn(registry, "createAdapterRegistry");
  createTransport = vi.spyOn(transport, "createManagedWebSocketTransport").mockImplementation(() => { throw new Error("Unexpected transport construction in IPC fixture"); });
});
afterEach(async () => {
  vi.useRealTimers();
  for (const release of releases.splice(0)) release();
  for (const host of hosts) {
    host.autoSend = true; host.autoDisconnect = true;
    for (const frame of host.frames) if (!frame.acknowledged) { frame.acknowledged = true; frame.callback(null); }
    host.emit("SIGTERM"); host.finishDisconnect();
  }
  await Promise.allSettled(pending.splice(0)); await tick();
  hosts.splice(0); vi.restoreAllMocks();
});
function nodeFixture(settings: { delayReady?: boolean; delayStop?: boolean } = {}) {
  const ready = gate(), stopped = gate(), failed = deferred<Error>(), events: string[] = [];
  if (!settings.delayReady) ready.resolve(); if (!settings.delayStop) stopped.resolve();
  const node = { failed: failed.promise,
    start: vi.fn(async () => { events.push("node.start"); await ready.promise; events.push("node.ready"); }),
    stop: vi.fn(async () => { events.push("node.stop"); ready.reject(new DeliveryCancelled("start cancelled by Stop")); await stopped.promise; events.push("node.stopped"); }) };
  managed.mockReturnValue(node); legacy.mockReturnValue(node);
  return { node, ready, stopped, failed, events };
}

describe("owned journal provisioning entrypoint", () => {
  it("bypasses provider/registry/connection config and observes reply then disconnect before exit", async () => {
    const host = new IpcHost(); host.argv[2] = "--provision-managed-journal"; host.autoSend = false; host.autoDisconnect = false;
    const completed = deferred<{ namespace: string; pragmas: Record<string, string | number> }>();
    releases.push(() => completed.resolve({ namespace, pragmas: {} })); provision.mockReturnValue(completed.promise);
    const work = observe(runDaemonEntrypoint({ ...preparationEnv, ARTOO_RUNTIMES: "not-a-runtime", ARTOO_CODEX_BINARY: "relative",
      ARTOO_CODEX_PROVIDER_URL: "not-a-url", ARTOO_NODE_URL: "not-a-node-url" }, host));
    expect(provision).toHaveBeenCalledWith({ directory: preparationEnv.ARTOO_JOURNAL_DIRECTORY,
      controllerScope: "controller_1", nodeId: "computer_1" });
    expect(processAdapter).not.toHaveBeenCalled(); expect(managed).not.toHaveBeenCalled(); expect(legacy).not.toHaveBeenCalled();
    expect(host.frames).toEqual([]); completed.resolve({ namespace, pragmas: {} });
    await vi.waitFor(() => expect(host.frames).toHaveLength(1));
    expect(host.frames[0]!.message).toEqual({ type: "journal.provisioned", requestId, namespace });
    expect(host.disconnect).not.toHaveBeenCalled(); expect(host.exit).not.toHaveBeenCalled();
    host.acknowledge("journal.provisioned"); await vi.waitFor(() => expect(host.disconnect).toHaveBeenCalledTimes(1));
    expect(host.exit).not.toHaveBeenCalled(); host.finishDisconnect(); await work;
    expect(host.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it.each([undefined, false])("requires an owned IPC connection, got %s", async (connected) => {
    const host = new IpcHost(); host.connected = connected;
    await expect(observe(provisionManagedJournal(preparationEnv, host))).rejects.toThrow("connected desktop IPC owner");
    expect(provision).not.toHaveBeenCalled(); expect(host.frames).toEqual([]); expect(host.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it.each([
    { ARTOO_JOURNAL_REQUEST_ID: "invalid" }, { ARTOO_JOURNAL_VERSION: "2" }, { ARTOO_JOURNAL_NODE_ID: "" },
    { ARTOO_JOURNAL_SERVER_ORIGIN: "https://artoo.example/path" }, { ARTOO_JOURNAL_DIRECTORY: "relative" },
    { ARTOO_JOURNAL_NAMESPACE: namespace },
  ])("rejects incomplete or adopting provision input %j without opening storage", async (change) => {
    const host = new IpcHost(); await expect(observe(provisionManagedJournal({ ...preparationEnv, ...change }, host))).rejects.toThrow();
    expect(provision).not.toHaveBeenCalled(); expect(host.frames).toEqual([]); expect(host.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("rejects combined selectors before any configuration or storage path", async () => {
    const host = new IpcHost(); host.argv.push("--provision-managed-journal");
    await expect(observe(runDaemonEntrypoint(preparationEnv, host))).rejects.toThrow("cannot be combined");
    expect(provision).not.toHaveBeenCalled(); expect(processAdapter).not.toHaveBeenCalled(); expect(host.frames).toEqual([]);
    expect(host.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("retains the provisioning failure plus disconnect failure and never returns a successful receipt", async () => {
    const host = new IpcHost(), original = new Error("partial journal retained"), cleanup = new Error("disconnect failed");
    provision.mockRejectedValue(original); host.disconnect.mockImplementation(() => { throw cleanup; });
    const error = await observe(provisionManagedJournal(preparationEnv, host)).catch((cause: unknown) => cause);
    expect(causes(error)).toEqual(expect.arrayContaining([original, cleanup])); expect(host.frames).toEqual([]);
    expect(provision).toHaveBeenCalledTimes(1); expect(host.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it.each(["SIGTERM", "disconnect"])("joins provisioning after %s and sends no late receipt", async (event) => {
    const host = new IpcHost(), completed = deferred<{ namespace: string; pragmas: Record<string, string | number> }>();
    releases.push(() => completed.resolve({ namespace, pragmas: {} })); provision.mockReturnValue(completed.promise);
    const work = observe(provisionManagedJournal(preparationEnv, host));
    if (event === "disconnect") host.finishDisconnect(); else host.emit(event);
    expect(host.exit).not.toHaveBeenCalled(); expect(host.frames).toEqual([]); completed.resolve({ namespace, pragmas: {} });
    await expect(work).rejects.toThrow(); expect(host.frames).toEqual([]); expect(host.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("a failed reply callback cannot be repaired by a late success callback", async () => {
    const host = new IpcHost(), failure = new Error("reply send failed"); host.autoSend = false;
    const work = observe(provisionManagedJournal(preparationEnv, host)); await vi.waitFor(() => expect(host.frames).toHaveLength(1));
    const callback = host.frames[0]!.callback; host.acknowledge("journal.provisioned", failure);
    await expect(work).rejects.toBe(failure); callback(null); await tick(); expect(host.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("a missing disconnect observation times out without claiming success", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const host = new IpcHost(); host.autoDisconnect = false;
    const work = observe(provisionManagedJournal(preparationEnv, host)); await tick();
    expect(host.disconnect).toHaveBeenCalledTimes(1); expect(host.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000); await expect(work).rejects.toThrow("disconnect was not observed");
    host.finishDisconnect(); expect(host.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("a missing provision send callback cannot produce a successful exit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const host = new IpcHost(); host.autoSend = false;
    const work = observe(provisionManagedJournal(preparationEnv, host)); await tick();
    expect(host.frames).toHaveLength(1); expect(host.disconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000); await expect(work).rejects.toThrow("message acknowledgement timed out");
    host.acknowledge("journal.provisioned"); await tick(); expect(host.exit).toHaveBeenCalledExactlyOnceWith(1);
  });
});

describe("normal worker launch correlation and lifecycle reports", () => {
  it.each([
    { name: "required config", env: { ARTOO_ALLOWED_ROOTS: "" }, args: ["--prepared-journal"], error: "ARTOO_ALLOWED_ROOTS" },
    { name: "saved binding", env: { ARTOO_JOURNAL_VERSION: "2" }, args: ["--prepared-journal"], error: "ARTOO_JOURNAL_VERSION" },
    { name: "explicit selector", env: {}, args: [], error: "explicit --prepared-journal" },
    { name: "runtime config", env: { ARTOO_RUNTIMES: "unregistered" }, args: ["--prepared-journal"], error: "unknown runtime preset" },
  ])("closes owned IPC after early $name failure without constructing resources", async ({ env, args, error }) => {
    const host = new IpcHost(); host.argv = ["electron", "/daemon/artood.mjs", ...args]; host.autoDisconnect = false;
    const work = observe(runDaemonEntrypoint({ ...workerEnv, ...env }, host));
    expect(host.disconnect).toHaveBeenCalledTimes(1); expect(host.exit).not.toHaveBeenCalled();
    expect(createRegistry).not.toHaveBeenCalled(); expect(processAdapter).not.toHaveBeenCalled();
    expect(managed).not.toHaveBeenCalled(); expect(legacy).not.toHaveBeenCalled();
    expect(openJournal).not.toHaveBeenCalled(); expect(provision).not.toHaveBeenCalled(); expect(createTransport).not.toHaveBeenCalled();
    expect(host.frames).toEqual([]); expect(host.listenerCount("message")).toBe(0);
    host.finishDisconnect(); await expect(work).rejects.toThrow(error);
    host.emit("message", { type: "shutdown", launchId }); host.emit("SIGTERM"); host.finishDisconnect(); await tick();
    expect(host.disconnect).toHaveBeenCalledTimes(1); expect(host.exit).toHaveBeenCalledExactlyOnceWith(1); expect(host.frames).toEqual([]);
  });

  it("retains constructor and disconnect failures without reporting ready or stopped", async () => {
    const host = new IpcHost(), f = nodeFixture(), original = new Error("node construction rejected"), cleanup = new Error("early disconnect failed");
    managed.mockImplementation(() => { throw original; }); host.disconnect.mockImplementation(() => { throw cleanup; });
    const error = await observe(runDaemonEntrypoint(workerEnv, host)).catch((cause: unknown) => cause);
    expect(causes(error)).toEqual(expect.arrayContaining([original, cleanup]));
    expect(f.node.start).not.toHaveBeenCalled(); expect(f.node.stop).not.toHaveBeenCalled();
    expect(openJournal).not.toHaveBeenCalled(); expect(createTransport).not.toHaveBeenCalled(); expect(host.frames).toEqual([]);
    expect(host.disconnect).toHaveBeenCalledTimes(1); expect(host.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("bounds unobserved early disconnect and exits nonzero once while retaining the config error", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const host = new IpcHost(); host.autoDisconnect = false;
    const work = observe(runDaemonEntrypoint({ ...workerEnv, ARTOO_ALLOWED_ROOTS: "" }, host));
    expect(host.disconnect).toHaveBeenCalledTimes(1); expect(host.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000); const error = await work.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AggregateError);
    expect(causes(error).map((cause) => cause instanceof Error ? cause.message : String(cause)))
      .toEqual(expect.arrayContaining([expect.stringContaining("ARTOO_ALLOWED_ROOTS"), "Desktop IPC disconnect was not observed"]));
    host.finishDisconnect(); await tick(); expect(host.exit).toHaveBeenCalledExactlyOnceWith(1); expect(host.frames).toEqual([]);
    expect(createRegistry).not.toHaveBeenCalled(); expect(openJournal).not.toHaveBeenCalled(); expect(createTransport).not.toHaveBeenCalled();
  });

  it("preserves natural standalone rejection for a pre-start constructor failure", async () => {
    const host = new IpcHost(), f = nodeFixture(), original = new Error("standalone constructor rejected");
    host.connected = undefined; host.argv = ["node", "/daemon/artood.mjs"]; managed.mockImplementation(() => { throw original; });
    await expect(observe(runDaemonEntrypoint({ ...workerEnv, ARTOO_WORKER_LAUNCH_ID: undefined }, host))).rejects.toBe(original);
    expect(f.node.start).not.toHaveBeenCalled(); expect(f.node.stop).not.toHaveBeenCalled(); expect(host.frames).toEqual([]);
    expect(host.disconnect).not.toHaveBeenCalled(); expect(host.exit).not.toHaveBeenCalled();
    expect(openJournal).not.toHaveBeenCalled(); expect(createTransport).not.toHaveBeenCalled();
  });

  it("reports ready only after startup, then waits for cleanup, stopped callback and disconnect", async () => {
    const host = new IpcHost(), f = nodeFixture({ delayReady: true, delayStop: true }); host.autoSend = false; host.autoDisconnect = false;
    const work = observe(main(workerEnv, host)); expect(f.node.start).toHaveBeenCalledTimes(1); expect(host.frames).toEqual([]);
    f.ready.resolve(); await vi.waitFor(() => expect(host.frames).toHaveLength(1));
    expect(host.frames[0]!.message).toEqual({ type: "worker.ready", launchId });
    let ready = false; void work.then(() => { ready = true; }); await tick(); expect(ready).toBe(false);
    host.acknowledge("worker.ready"); expect(await work).toBe(f.node);
    host.emit("message", { type: "shutdown", launchId: requestId }); host.emit("message", { type: "shutdown" });
    expect(f.node.stop).not.toHaveBeenCalled();
    host.emit("message", { type: "shutdown", launchId }); host.emit("SIGTERM"); expect(f.node.stop).toHaveBeenCalledTimes(1);
    expect(host.frames).toHaveLength(1); f.stopped.resolve(); await vi.waitFor(() => expect(host.frames).toHaveLength(2));
    expect(host.frames[1]!.message).toEqual({ type: "worker.stopped", launchId }); expect(host.disconnect).not.toHaveBeenCalled();
    host.acknowledge("worker.stopped"); await vi.waitFor(() => expect(host.disconnect).toHaveBeenCalledTimes(1));
    expect(host.exit).not.toHaveBeenCalled(); host.finishDisconnect(); await tick(); expect(host.exit).toHaveBeenCalledExactlyOnceWith(0);
    host.emit("message", { type: "shutdown", launchId }); expect(f.node.stop).toHaveBeenCalledTimes(1);
  });

  it("Stop before readiness suppresses ready and joins startup cancellation before exit zero", async () => {
    const host = new IpcHost(), f = nodeFixture({ delayReady: true, delayStop: true });
    const work = observe(main(workerEnv, host)); host.emit("message", { type: "shutdown", launchId });
    expect(host.frames).toEqual([]); expect(host.exit).not.toHaveBeenCalled(); f.ready.resolve(); f.stopped.resolve();
    await expect(work).rejects.toBeInstanceOf(DeliveryCancelled);
    expect(host.frames.map((entry) => entry.message.type)).toEqual(["worker.stopped"]); expect(host.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("a ready callback arriving after Stop cannot complete main as a running worker", async () => {
    const host = new IpcHost(), f = nodeFixture({ delayStop: true }); host.autoSend = false;
    const work = observe(main(workerEnv, host)); await vi.waitFor(() => expect(host.frames).toHaveLength(1));
    // The one ready send was invoked before Stop; it cannot be unsent. No new
    // ready frame or successful startup result may follow the Stop latch.
    host.emit("message", { type: "shutdown", launchId }); host.acknowledge("worker.ready");
    let started = false; void work.then(() => { started = true; }, () => {}); await tick(); expect(started).toBe(false);
    f.stopped.resolve(); await vi.waitFor(() => expect(host.frames).toHaveLength(2)); host.acknowledge("worker.stopped");
    await expect(work).rejects.toBeInstanceOf(DeliveryCancelled);
    expect(host.frames.map((entry) => entry.message.type)).toEqual(["worker.ready", "worker.stopped"]);
    expect(host.exit).toHaveBeenCalledExactlyOnceWith(0); expect(f.node.stop).toHaveBeenCalledTimes(1);
  });

  it("failure published with readiness suppresses ready and keeps exit nonzero after clean cleanup", async () => {
    const host = new IpcHost(), f = nodeFixture({ delayReady: true }), original = new Error("journal failed at readiness");
    const work = observe(main(workerEnv, host)); f.failed.resolve(original); f.ready.resolve();
    await expect(work).rejects.toBe(original);
    expect(host.frames.map((entry) => entry.message.type)).toEqual(["worker.stopped"]); expect(host.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("ready callback failure starts joined shutdown and retains its original cause", async () => {
    const host = new IpcHost(), f = nodeFixture({ delayStop: true }), failure = new Error("ready IPC failed"); host.autoSend = false;
    const work = observe(main(workerEnv, host)); await vi.waitFor(() => expect(host.frames).toHaveLength(1));
    host.acknowledge("worker.ready", failure); await vi.waitFor(() => expect(f.node.stop).toHaveBeenCalledTimes(1));
    expect(host.exit).not.toHaveBeenCalled(); f.stopped.resolve(); await vi.waitFor(() => expect(host.frames).toHaveLength(2));
    host.acknowledge("worker.stopped"); await expect(work).rejects.toBe(failure); expect(host.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("never sends stopped after failed cleanup and preserves first plus cleanup errors", async () => {
    const host = new IpcHost(), f = nodeFixture({ delayStop: true });
    const original = new Error("first lifecycle failure"), cleanup = new Error("physical cleanup uncertain"), disconnect = new Error("disconnect failed");
    f.node.stop.mockImplementation(async () => { await f.stopped.promise; throw cleanup; });
    host.disconnect.mockImplementation(() => { throw disconnect; });
    const registration = installShutdownHandlers(f.node, host, { launchId }); f.failed.resolve(original); await tick();
    expect(host.frames).toEqual([]); expect(host.exit).not.toHaveBeenCalled(); f.stopped.resolve();
    const error = await registration.completion!.catch((cause: unknown) => cause);
    expect(causes(error)).toEqual(expect.arrayContaining([original, cleanup, disconnect]));
    expect(registration.failure).toBe(original); expect(host.frames).toEqual([]); expect(host.exit).toHaveBeenCalledExactlyOnceWith(1); registration();
  });

  it("IPC owner loss stops the worker without a matching shutdown message", async () => {
    const host = new IpcHost(), f = nodeFixture(); await observe(main(workerEnv, host));
    host.finishDisconnect(); await tick(); expect(f.node.stop).toHaveBeenCalledTimes(1);
    expect(host.frames.map((entry) => entry.message.type)).toEqual(["worker.ready"]); expect(host.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it.each([undefined, "not-a-uuid"])("prepared IPC launch rejects missing/invalid launch ID %s before construction", async (id) => {
    const host = new IpcHost(); nodeFixture();
    await expect(observe(main({ ...workerEnv, ARTOO_WORKER_LAUNCH_ID: id }, host))).rejects.toThrow("ARTOO_WORKER_LAUNCH_ID");
    expect(managed).not.toHaveBeenCalled(); expect(processAdapter).not.toHaveBeenCalled(); expect(host.frames).toEqual([]);
    expect(createRegistry).not.toHaveBeenCalled(); expect(openJournal).not.toHaveBeenCalled(); expect(createTransport).not.toHaveBeenCalled();
    expect(host.disconnect).toHaveBeenCalledTimes(1); expect(host.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("keeps standalone prepared startup without IPC reports or a launch ID", async () => {
    const host = new IpcHost(), f = nodeFixture(); host.connected = undefined; host.argv = ["node", "/daemon/artood.mjs"];
    expect(await observe(main({ ...workerEnv, ARTOO_WORKER_LAUNCH_ID: undefined }, host))).toBe(f.node);
    expect(host.frames).toEqual([]); host.emit("SIGTERM"); await tick(); expect(host.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("correlates ordinary desktop launches when a launch ID is provided", async () => {
    const host = new IpcHost(), f = nodeFixture(); host.argv = ["electron", "/daemon/artood.mjs"];
    const env = { ARTOO_NODE_URL: workerEnv.ARTOO_NODE_URL, ARTOO_NODE_ID: "computer_1", ARTOO_ALLOWED_ROOTS: "/Users/fixture",
      ARTOO_RUNTIMES: "codex", ARTOO_WORKER_LAUNCH_ID: launchId };
    expect(await observe(main(env, host))).toBe(f.node); expect(legacy).toHaveBeenCalledTimes(1); expect(managed).not.toHaveBeenCalled();
    expect(host.frames[0]!.message).toEqual({ type: "worker.ready", launchId });
    host.emit("message", { type: "shutdown", launchId }); await tick(); expect(host.exit).toHaveBeenCalledExactlyOnceWith(0);
  });
});
