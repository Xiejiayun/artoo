import { afterEach, describe, expect, it, vi } from "vitest";
import { openLocalJournal, provisionLocalJournal } from "./journal.js";

interface WorkerView {
  emit(event: string, ...args: unknown[]): boolean;
  postMessage: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
}
const doubles = vi.hoisted(() => ({ workers: [] as WorkerView[] }));
vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  class WorkerDouble extends EventEmitter {
    postMessage = vi.fn((message: { op: string }) => {
      if (message.op === "close") queueMicrotask(() => this.emit("exit", 0));
    });
    terminate = vi.fn(async () => { this.emit("exit", 1); return 1; });
    constructor() { super(); doubles.workers.push(this); }
  }
  return { Worker: WorkerDouble };
});

// Worker notification/lifetime model only: this file does not create a process,
// SQLite database, durable permit or physical producer receipt.
const location = { directory: "/Users/fixture/journal", controllerScope: "fixture_controller", nodeId: "fixture_node" };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
afterEach(() => { for (const worker of doubles.workers.splice(0)) worker.emit("exit", 0); });
async function fixture() {
  const opening = openLocalJournal({ ...location, expectedNamespace: "fixture_namespace" });
  const worker = doubles.workers.at(-1)!;
  worker.emit("message", { kind: "ready", namespace: "fixture_namespace", incarnation: "fixture_incarnation", pragmas: {} });
  return { journal: await opening, worker };
}

describe("journal first-failure notification and close ownership", () => {
  it("coalesces intentional close without publishing a failure", async () => {
    const { journal, worker } = await fixture(), failed = vi.fn(); void journal.failed.then(failed);
    const first = journal.close(); expect(journal.close()).toBe(first); await first; await tick();
    expect(worker.postMessage.mock.calls.filter(([message]) => message.op === "close")).toHaveLength(1);
    expect(worker.terminate).not.toHaveBeenCalled(); expect(failed).not.toHaveBeenCalled();
  });

  it("reports an idle worker exit immediately and never replaces the first failure", async () => {
    const { journal, worker } = await fixture();
    worker.emit("exit", 0); const first = await journal.failed;
    expect(first.message).toContain("ownership is unknown");
    worker.emit("error", new Error("later worker error")); expect(await journal.failed).toBe(first);
    await journal.close(); expect(worker.postMessage).not.toHaveBeenCalled();
  });

  it("resolves first failure before rejecting outstanding operations", async () => {
    const { journal, worker } = await fixture(), events: string[] = [], first = new Error("worker storage lost");
    void journal.failed.then(() => { events.push("failure"); });
    const request = journal.lookupRun({ expectedNamespace: journal.namespace, runId: "run_1" });
    const rejected = request.catch((error: unknown) => { events.push("operation"); return error; });
    worker.emit("error", first);
    expect(await journal.failed).toBe(first); expect(await rejected).toBe(first); expect(events).toEqual(["failure", "operation"]);
    await journal.close();
  });

  it("publishes a failed operation reply before that individual request rejects", async () => {
    const { journal, worker } = await fixture(), events: string[] = [];
    void journal.failed.then(() => { events.push("failure"); });
    const request = journal.lookupRun({ expectedNamespace: journal.namespace, runId: "run_1" });
    const rejected = request.catch((error: unknown) => { events.push("operation"); return error; });
    const sent = worker.postMessage.mock.calls[0]![0] as { id: string };
    worker.emit("message", { kind: "error", id: sent.id, message: "storage operation failed" });
    const first = await journal.failed; expect(first.message).toBe("storage operation failed");
    expect(await rejected).toBe(first); expect(events).toEqual(["failure", "operation"]); await journal.close();
  });

  it("joins failed close and failed termination and retains both causes", async () => {
    const { journal, worker } = await fixture(), closing = new Error("close send failed"), termination = new Error("termination failed");
    worker.postMessage.mockImplementation(() => { throw closing; }); worker.terminate.mockRejectedValue(termination);
    const close = journal.close(); const rejected = close.catch((error: unknown) => error);
    expect(await journal.failed).toBe(closing);
    const error = await rejected; expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([closing, termination]); expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(journal.close()).toBe(close);
  });

  it("does not classify a nonzero requested close as an intentional success", async () => {
    const { journal, worker } = await fixture();
    worker.postMessage.mockImplementation(() => { queueMicrotask(() => worker.emit("exit", 7)); });
    const close = journal.close(); void close.catch(() => {});
    expect((await journal.failed).message).toContain("code 7"); await expect(close).rejects.toThrow("code 7");
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it("preserves invalid-open identity together with a later cleanup failure", async () => {
    const opening = openLocalJournal({ ...location, expectedNamespace: "expected" });
    const worker = doubles.workers.at(-1)!, cleanup = new Error("close write failed");
    worker.postMessage.mockImplementation(() => { throw cleanup; });
    worker.emit("message", { kind: "ready", namespace: "wrong", incarnation: "fixture", pragmas: {} });
    const error = await opening.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AggregateError); expect((error as AggregateError).errors[0]).toMatchObject({ message: "Unexpected journal identity" });
    expect((error as AggregateError).errors[1]).toBe(cleanup); expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("retains the existing successful explicit provision receipt and natural worker exit", async () => {
    const provisioning = provisionLocalJournal(location), worker = doubles.workers.at(-1)!;
    worker.emit("message", { kind: "provisioned", namespace: "new_namespace", pragmas: { synchronous: 2 } });
    worker.emit("exit", 0);
    await expect(provisioning).resolves.toEqual({ namespace: "new_namespace", pragmas: { synchronous: 2 } });
    expect(worker.postMessage).not.toHaveBeenCalled(); expect(worker.terminate).not.toHaveBeenCalled();
  });
});
