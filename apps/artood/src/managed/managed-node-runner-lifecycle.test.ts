import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNodeClient } from "../node-client.js";
import { createProcessAdapter } from "../process-adapter.js";
import { createManagedNodeRunner, type ManagedNodeRunner, type ManagedNodeRunnerOptions } from "./managed-node-runner.js";
import { createManagedWebSocketTransport, type ManagedWebSocketTransport } from "./managed-ws-transport.js";
import { DeliveryStopped } from "./managed-delivery.js";
import type { Journal } from "./journal-types.js";

vi.mock("../node-client.js", () => ({ createNodeClient: vi.fn() }));
vi.mock("./managed-ws-transport.js", () => ({ createManagedWebSocketTransport: vi.fn() }));
// Uses the real adapter factory solely for construction/identity validation.
// The client and connection are lifecycle doubles; no process is launched and
// these assertions make no physical ownership or network qualification claim.
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); void promise.catch(() => {});
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const owned: Array<{ runner: ManagedNodeRunner; release(): void }> = [];
const pendingCleanup: Array<() => void> = [];
beforeEach(() => { vi.mocked(createNodeClient).mockReset(); vi.mocked(createManagedWebSocketTransport).mockReset(); });
afterEach(async () => {
  for (const release of pendingCleanup.splice(0)) release();
  for (const entry of owned) entry.release();
  await Promise.allSettled(owned.splice(0).map(({ runner }) => runner.stop()));
});
function fixture(mixed?: { allowNewAllocations: boolean },
  workspace: ManagedNodeRunnerOptions["workspace"] = { worktreeBaseRepo: "/Users/fixture/source", allowedRoots: ["/Users/fixture"] }) {
  const ready = deferred<void>();
  const state = { connected: false };
  const client = { start: vi.fn(), stop: vi.fn(async (_cancel?: boolean) => {}),
    invalidateManagedStartupSession: vi.fn(), requestManagedRunStop: vi.fn(async () => {}),
    failManagedConnection: vi.fn(async () => {}) };
  const close = vi.fn(async () => { state.connected = false; ready.reject(new DeliveryStopped("intentional link close")); });
  const link = { ready: ready.promise, start: vi.fn(), close, bindRun: vi.fn(),
    get connected() { return state.connected; }, transport: {}, channel: {} } as unknown as ManagedWebSocketTransport;
  vi.mocked(createNodeClient).mockReturnValue(client); vi.mocked(createManagedWebSocketTransport).mockReturnValue(link);
  const runner = createManagedNodeRunner({ url: "wss://artoo.example/api/v1/node?token=fixture",
    hello: { kind: "node.hello", node_id: "computer_1", protocol_version: "test", artood_version: "test",
      machine: { hostname: "fixture", os: "darwin", arch: "arm64" } },
    adapter: createProcessAdapter({ command: [process.execPath], allowedRoots: ["/Users/fixture"] }),
    workspace,
    journal: { namespace: "fixture_namespace" } as Journal, ...(mixed ? { mixed } : {}) });
  const transportOptions = vi.mocked(createManagedWebSocketTransport).mock.calls[0]![0];
  owned.push({ runner, release() { ready.resolve(); } });
  return { runner, client, link, close, state, ready, transportOptions };
}

describe("managed runner failure notification and cleanup joining", () => {
  it.each([undefined, true, false])("advertises fresh-allocation capability for mixed choice %s", async (choice) => {
    const f = fixture(choice === undefined ? undefined : { allowNewAllocations: choice });
    expect(f.transportOptions.hello.execution_features).toEqual(choice === false ? [] : ["workspace-allocation.per-run-v1"]);
    expect(f.transportOptions.allowLegacyRuns).toBe(choice !== undefined);
    expect(vi.mocked(createNodeClient).mock.calls[0]![0].managedJournal?.mixed?.allowNewAllocations).toBe(choice);
    await f.runner.stop();
  });

  it("starts prepared opt-out without a base repository while preserving the ordinary and receipt lanes", async () => {
    const f = fixture({ allowNewAllocations: false }, { allowedRoots: ["/Users/fixture"] }), failed = vi.fn();
    void f.runner.failed.then(failed); f.ready.resolve(); await f.runner.start();
    expect(f.transportOptions.allowLegacyRuns).toBe(true); expect(f.transportOptions.namespace).toBe("fixture_namespace");
    expect(f.transportOptions.hello.execution_features).toEqual([]);
    const options = vi.mocked(createNodeClient).mock.calls[0]![0];
    expect(options.workspace).toEqual({ allowedRoots: ["/Users/fixture"] });
    expect(options.managedJournal?.mixed?.allowNewAllocations).toBe(false);
    options.managedJournal?.mixed?.bindRun("ordinary_1", "legacy");
    options.managedJournal?.mixed?.bindRun("closed_1", "managed");
    expect(f.link.bindRun).toHaveBeenNthCalledWith(1, "ordinary_1", "legacy");
    expect(f.link.bindRun).toHaveBeenNthCalledWith(2, "closed_1", "managed");
    expect(f.client.start).toHaveBeenCalledTimes(1); await f.runner.stop(); await tick();
    expect(failed).not.toHaveBeenCalled(); expect(f.runner.failure).toBeUndefined();
  });

  it.each([undefined, true])("still requires a base repository when new allocation choice is %s", (choice) => {
    expect(() => fixture(choice === undefined ? undefined : { allowNewAllocations: choice }, { allowedRoots: ["/Users/fixture"] }))
      .toThrow("explicit local workspace configuration");
    expect(createManagedWebSocketTransport).not.toHaveBeenCalled(); expect(createNodeClient).not.toHaveBeenCalled();
  });

  it.each([{ allowedRoots: undefined }, { allowedRoots: [] }])("still requires allowed roots for prepared opt-out with roots %j", ({ allowedRoots }) => {
    expect(() => fixture({ allowNewAllocations: false }, { allowedRoots })).toThrow("explicit local workspace configuration");
    expect(createManagedWebSocketTransport).not.toHaveBeenCalled(); expect(createNodeClient).not.toHaveBeenCalled();
  });

  it("does not publish failure when intentional Stop cancels pending readiness", async () => {
    const f = fixture(), failed = vi.fn(); void f.runner.failed.then(failed);
    const start = f.runner.start(); void start.catch(() => {}); const stop = f.runner.stop();
    expect(f.runner.stop()).toBe(stop); await stop; await expect(start).rejects.toThrow("intentional link close"); await tick();
    expect(failed).not.toHaveBeenCalled(); expect(f.runner.failure).toBeUndefined();
  });

  it("publishes only the first fatal cause and starts owned cleanup once", async () => {
    const f = fixture(), original = new Error("first connection failure");
    f.transportOptions.onFatal!(original); f.transportOptions.onFatal!(new Error("later failure"));
    expect(await f.runner.failed).toBe(original); expect(f.runner.failure).toBe(original);
    expect(f.client.failManagedConnection).toHaveBeenCalledTimes(1); expect(f.client.failManagedConnection).toHaveBeenCalledWith(original);
    await f.runner.stop(); expect(await f.runner.failed).toBe(original);
  });

  it("joins pending consumers after Stop failure before rejecting cleanup", async () => {
    const f = fixture(), drained = deferred<void>(), original = new Error("producer Stop uncertain");
    pendingCleanup.push(() => drained.resolve());
    f.state.connected = true;
    f.client.stop.mockImplementation(async (cancel) => { if (cancel) throw original; await drained.promise; });
    const stop = f.runner.stop(); const observed = stop.catch((error: unknown) => error);
    expect(await f.runner.failed).toBe(original); await vi.waitFor(() => expect(f.client.stop).toHaveBeenCalledWith());
    let done = false; void observed.then(() => { done = true; }); await tick(); expect(done).toBe(false);
    expect(f.close).toHaveBeenCalled(); drained.resolve(); expect(await observed).toBe(original);
  });

  it("closes a transient loss synchronously during Stop instead of allowing a reconnect generation", async () => {
    const f = fixture(), stopping = deferred<void>(), failed = vi.fn(); pendingCleanup.push(() => stopping.resolve());
    f.state.connected = true; f.ready.resolve(); await f.runner.start(); void f.runner.failed.then(failed);
    f.client.stop.mockImplementation(async (cancel) => { if (cancel) await stopping.promise; });
    const stopped = f.runner.stop(); await vi.waitFor(() => expect(f.client.stop).toHaveBeenCalledWith(true));
    expect(f.close).not.toHaveBeenCalled(); f.state.connected = false;
    f.transportOptions.onSessionLost!(new Error("transient socket loss during Stop"), undefined);
    expect(f.close).toHaveBeenCalledTimes(1); // Before transport lose() can enqueue reconnect.
    await tick(); expect(failed).not.toHaveBeenCalled(); stopping.resolve(); await stopped;
    expect(failed).not.toHaveBeenCalled(); expect(f.runner.failure).toBeUndefined();
  });

  it("still publishes a real fatal policy failure while requested Stop is pending", async () => {
    const f = fixture(), stopping = deferred<void>(), policy = new Error("credential rejected"); pendingCleanup.push(() => stopping.resolve());
    f.state.connected = true; f.ready.resolve(); await f.runner.start();
    f.client.stop.mockImplementation(async (cancel) => { if (cancel) await stopping.promise; });
    const stopped = f.runner.stop(); await vi.waitFor(() => expect(f.client.stop).toHaveBeenCalledWith(true));
    f.transportOptions.onFatal!(policy); expect(await f.runner.failed).toBe(policy);
    expect(f.client.failManagedConnection).toHaveBeenCalledWith(policy); stopping.resolve(); await stopped;
    expect(f.runner.failure).toBe(policy);
  });

  it("retains both readiness and failure-cleanup causes", async () => {
    const f = fixture(), original = new Error("qualified ready failed"), cleanup = new Error("failure cleanup uncertain");
    f.client.failManagedConnection.mockRejectedValue(cleanup);
    const start = f.runner.start(); const observed = start.catch((error: unknown) => error);
    f.ready.reject(original); f.transportOptions.onFatal!(original);
    expect(await f.runner.failed).toBe(original);
    const error = await observed; expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([original, cleanup]);
    await expect(f.runner.stop()).rejects.toBe(cleanup);
  });

  it("joins a failed socket close initiated by fatal handling", async () => {
    const f = fixture(), original = new Error("fatal peer"), closeError = new Error("socket close failed");
    f.close.mockRejectedValueOnce(closeError);
    f.transportOptions.onFatal!(original); expect(await f.runner.failed).toBe(original);
    await expect(f.runner.stop()).rejects.toBe(closeError); expect(f.client.stop).toHaveBeenCalledWith();
  });
});
