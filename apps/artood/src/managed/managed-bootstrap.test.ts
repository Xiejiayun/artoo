import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createManagedBootstrap, type ManagedBootstrap, type ManagedBootstrapOptions } from "./managed-bootstrap.js";
import { openLocalJournal } from "./journal.js";
import type { Journal } from "./journal-types.js";
import { createManagedNodeRunner, type ManagedNodeRunner } from "./managed-node-runner.js";
import { DeliveryCancelled } from "./managed-delivery.js";

vi.mock("./journal.js", () => ({ openLocalJournal: vi.fn() }));
vi.mock("./managed-node-runner.js", () => ({ createManagedNodeRunner: vi.fn() }));

// Lifecycle doubles only. No producer, physical receipt, SQLite or socket is used.
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const owned: Array<{ node: ManagedBootstrap; release(): void }> = [];
beforeEach(() => { vi.mocked(openLocalJournal).mockReset(); vi.mocked(createManagedNodeRunner).mockReset(); });
afterEach(async () => {
  for (const entry of owned) entry.release();
  await Promise.allSettled(owned.splice(0).map(({ node }) => node.stop()));
});
function options(): ManagedBootstrapOptions {
  return { url: "wss://artoo.example/api/v1/node?token=fixture", allowNewAllocations: false,
    hello: { kind: "node.hello", node_id: "computer_1", protocol_version: "test", artood_version: "test",
      machine: { hostname: "fixture", os: "darwin", arch: "arm64" } },
    binding: { version: 1, serverOrigin: "https://artoo.example", nodeId: "computer_1",
      directory: "/Users/fixture/Artoo/journal", controllerScope: "controller_1", expectedNamespace: "namespace_1" },
    workspace: { worktreeBaseRepo: "/Users/fixture/source", allowedRoots: ["/Users/fixture"] } };
}
function fixture(settings: { delayOpen?: boolean; delayReady?: boolean; delayStop?: boolean; delayClose?: boolean;
  workspace?: ManagedBootstrapOptions["workspace"] } = {}) {
  const events: string[] = [];
  const opened = deferred<Journal>(), ready = deferred<void>(), stopped = deferred<void>(), closed = deferred<void>();
  const journalFailure = deferred<Error>(), runnerFailure = deferred<Error>();
  if (!settings.delayReady) ready.resolve();
  if (!settings.delayStop) stopped.resolve();
  if (!settings.delayClose) closed.resolve();
  const closeJournal = vi.fn(async () => { events.push("journal.close"); await closed.promise; events.push("journal.closed"); });
  const startRunner = vi.fn(async () => { events.push("runner.start"); await ready.promise; events.push("runner.ready"); });
  const stopRunner = vi.fn(async () => {
    events.push("runner.stop"); ready.reject(new DeliveryCancelled("ready cancelled by Stop"));
    await stopped.promise; events.push("runner.stopped");
  });
  const journal = { namespace: "namespace_1", failed: journalFailure.promise, close: closeJournal } as unknown as Journal;
  const runner = { failed: runnerFailure.promise, start: startRunner, stop: stopRunner } as unknown as ManagedNodeRunner;
  if (!settings.delayOpen) opened.resolve(journal);
  vi.mocked(openLocalJournal).mockImplementation(() => { events.push("journal.open"); return opened.promise; });
  vi.mocked(createManagedNodeRunner).mockImplementation(() => { events.push("runner.construct"); return runner; });
  const config = options(); if (settings.workspace) config.workspace = settings.workspace;
  const node = createManagedBootstrap(config);
  owned.push({ node, release() { opened.resolve(journal); ready.resolve(); stopped.resolve(); closed.resolve(); } });
  return { config, node, journal, runner, events, opened, ready, stopped, closed, journalFailure, runnerFailure,
    closeJournal, startRunner, stopRunner };
}
function causes(error: unknown): unknown[] {
  return error instanceof AggregateError ? [error, ...error.errors.flatMap(causes)] : [error];
}

describe("prepared managed bootstrap lifecycle", () => {
  it("constructs lazily and Stop before start opens nothing or reports a failure", async () => {
    const f = fixture(), failed = vi.fn(); void f.node.failed.then(failed);
    expect(openLocalJournal).not.toHaveBeenCalled(); expect(createManagedNodeRunner).not.toHaveBeenCalled();
    const first = f.node.stop(); expect(f.node.stop()).toBe(first); await first;
    await expect(f.node.start()).rejects.toThrow("stopped"); await tick();
    expect(failed).not.toHaveBeenCalled(); expect(openLocalJournal).not.toHaveBeenCalled();
  });

  it("coalesces start and Stop and waits for runner readiness", async () => {
    const f = fixture({ delayReady: true }), failed = vi.fn(); void f.node.failed.then(failed);
    const start = f.node.start(); expect(f.node.start()).toBe(start);
    await vi.waitFor(() => expect(f.startRunner).toHaveBeenCalledTimes(1));
    let ready = false; void start.then(() => { ready = true; }); await tick(); expect(ready).toBe(false);
    f.ready.resolve(); await start; expect(ready).toBe(true);
    const stop = f.node.stop(); expect(f.node.stop()).toBe(stop); await stop;
    expect(openLocalJournal).toHaveBeenCalledTimes(1); expect(f.stopRunner).toHaveBeenCalledTimes(1); expect(f.closeJournal).toHaveBeenCalledTimes(1);
    expect(f.events.indexOf("runner.stopped")).toBeLessThan(f.events.indexOf("journal.close")); expect(failed).not.toHaveBeenCalled();
  });

  it("closes a late journal open after Stop without constructing or connecting a runner", async () => {
    const f = fixture({ delayOpen: true }), failed = vi.fn(); void f.node.failed.then(failed);
    const starting = f.node.start(); void starting.catch(() => {});
    const stopping = f.node.stop(); f.opened.resolve(f.journal); await stopping;
    await expect(starting).rejects.toThrow("stopped"); expect(createManagedNodeRunner).not.toHaveBeenCalled();
    expect(f.closeJournal).toHaveBeenCalledTimes(1); expect(failed).not.toHaveBeenCalled();
  });

  it("joins startup cancellation, runner cleanup and journal close in that order", async () => {
    const f = fixture({ delayReady: true, delayStop: true, delayClose: true }), failed = vi.fn(); void f.node.failed.then(failed);
    const starting = f.node.start(); void starting.catch(() => {}); await vi.waitFor(() => expect(f.startRunner).toHaveBeenCalledTimes(1));
    const stopping = f.node.stop(); await vi.waitFor(() => expect(f.stopRunner).toHaveBeenCalledTimes(1));
    expect(f.closeJournal).not.toHaveBeenCalled(); f.stopped.resolve();
    await vi.waitFor(() => expect(f.closeJournal).toHaveBeenCalledTimes(1));
    let done = false; void stopping.then(() => { done = true; }); await tick(); expect(done).toBe(false);
    f.closed.resolve(); await stopping; await expect(starting).rejects.toThrow(); expect(failed).not.toHaveBeenCalled();
  });

  it("reports an open failure as the first cause even when Stop was already requested", async () => {
    const f = fixture({ delayOpen: true }), error = new Error("journal open failed");
    const starting = f.node.start(); void starting.catch(() => {}); const stopping = f.node.stop(); void stopping.catch(() => {});
    f.opened.reject(error); expect(await f.node.failed).toBe(error);
    await expect(starting).rejects.toBe(error); await expect(stopping).rejects.toBe(error);
    expect(createManagedNodeRunner).not.toHaveBeenCalled(); expect(f.closeJournal).not.toHaveBeenCalled();
  });

  it("preserves constructor and journal cleanup errors", async () => {
    const f = fixture(), original = new Error("runner construction failed"), cleanup = new Error("journal close failed");
    vi.mocked(createManagedNodeRunner).mockImplementation(() => { throw original; }); f.closeJournal.mockRejectedValue(cleanup);
    const starting = f.node.start(); const rejected = starting.catch((error: unknown) => error);
    expect(await f.node.failed).toBe(original);
    const error = await rejected; expect(causes(error)).toEqual(expect.arrayContaining([original, cleanup]));
    expect(f.startRunner).not.toHaveBeenCalled(); expect(f.closeJournal).toHaveBeenCalledTimes(1);
  });

  it("retains ready failure plus both cleanup errors and exposes only the first failure", async () => {
    const f = fixture({ delayReady: true }), original = new Error("ready rejected");
    const producer = new Error("runner cleanup failed"), storage = new Error("storage cleanup failed");
    f.stopRunner.mockRejectedValue(producer); f.closeJournal.mockRejectedValue(storage);
    const starting = f.node.start(); const rejected = starting.catch((error: unknown) => error);
    await vi.waitFor(() => expect(f.startRunner).toHaveBeenCalledTimes(1));
    f.runnerFailure.resolve(original); f.ready.reject(original);
    expect(await f.node.failed).toBe(original); const error = await rejected;
    expect(causes(error)).toEqual(expect.arrayContaining([original, producer, storage]));
    await expect(f.node.stop()).rejects.toBe(error); expect(f.stopRunner).toHaveBeenCalledTimes(1); expect(f.closeJournal).toHaveBeenCalledTimes(1);
  });

  it("reacts to idle journal failure and closes the journal only after runner cleanup joins", async () => {
    const f = fixture({ delayStop: true }); await f.node.start();
    const original = new Error("idle journal worker exited"), later = new Error("connection also failed");
    f.journalFailure.resolve(original); expect(await f.node.failed).toBe(original);
    await vi.waitFor(() => expect(f.stopRunner).toHaveBeenCalledTimes(1)); expect(f.closeJournal).not.toHaveBeenCalled();
    f.runnerFailure.resolve(later); f.stopped.resolve();
    const error = await f.node.stop().catch((cause: unknown) => cause);
    expect(causes(error)).toEqual(expect.arrayContaining([original, later])); expect(await f.node.failed).toBe(original);
    expect(f.events.indexOf("runner.stopped")).toBeLessThan(f.events.indexOf("journal.close"));
  });

  it("does not connect a resource whose failure was already published when open returned", async () => {
    const f = fixture(), error = new Error("opened journal is already unavailable"); f.journalFailure.resolve(error);
    await expect(f.node.start()).rejects.toBe(error); expect(await f.node.failed).toBe(error);
    expect(createManagedNodeRunner).not.toHaveBeenCalled(); expect(f.closeJournal).toHaveBeenCalledTimes(1);
  });

  it("stops an already-failed constructed runner without calling its start", async () => {
    const f = fixture(), error = new Error("constructed runner unavailable"); f.runnerFailure.resolve(error);
    await expect(f.node.start()).rejects.toBe(error); expect(await f.node.failed).toBe(error);
    expect(f.startRunner).not.toHaveBeenCalled(); expect(f.stopRunner).toHaveBeenCalledTimes(1); expect(f.closeJournal).toHaveBeenCalledTimes(1);
  });

  it("a fatal notification during requested Stop prevents a successful shutdown result", async () => {
    const f = fixture({ delayStop: true }); await f.node.start();
    const stopping = f.node.stop(); void stopping.catch(() => {}); await vi.waitFor(() => expect(f.stopRunner).toHaveBeenCalledTimes(1));
    const error = new Error("fatal during Stop"); f.runnerFailure.resolve(error); expect(await f.node.failed).toBe(error);
    f.stopped.resolve(); await expect(stopping).rejects.toBe(error); expect(f.closeJournal).toHaveBeenCalledTimes(1);
  });

  it("keeps the exact prepared binding and opt-out snapshot across lazy startup", async () => {
    const f = fixture();
    // Mutating the caller's later configuration cannot swap an opened profile.
    (f.config.binding as { directory: string }).directory = "/Users/fixture/other";
    f.config.allowNewAllocations = true; f.config.workspace!.allowedRoots!.push("/other");
    await f.node.start();
    expect(openLocalJournal).toHaveBeenCalledWith({ directory: "/Users/fixture/Artoo/journal", controllerScope: "controller_1",
      nodeId: "computer_1", expectedNamespace: "namespace_1" });
    expect(vi.mocked(createManagedNodeRunner).mock.calls[0]![0]).toMatchObject({ journal: f.journal,
      mixed: { allowNewAllocations: false }, workspace: { allowedRoots: ["/Users/fixture"] } });
  });

  it("preserves prepared opt-out startup without a repository for existing ordinary capability", async () => {
    const f = fixture({ workspace: { allowedRoots: ["/Users/fixture"] } }), failed = vi.fn();
    void f.node.failed.then(failed); await f.node.start();
    expect(vi.mocked(createManagedNodeRunner).mock.calls[0]![0]).toMatchObject({ journal: f.journal,
      mixed: { allowNewAllocations: false }, workspace: { allowedRoots: ["/Users/fixture"] } });
    expect(vi.mocked(createManagedNodeRunner).mock.calls[0]![0].workspace?.worktreeBaseRepo).toBeUndefined();
    expect(f.startRunner).toHaveBeenCalledTimes(1); await f.node.stop(); await tick();
    expect(f.events.indexOf("runner.stopped")).toBeLessThan(f.events.indexOf("journal.close"));
    expect(failed).not.toHaveBeenCalled();
  });
});
