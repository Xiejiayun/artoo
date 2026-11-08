// Controlled mechanism tests only. No adapter, verifier or native process is executed.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeToServerMessage, RunEventMessage, RuntimeAdapter } from "@artoo/protocol";
import type { RunVerificationPayload } from "@artoo/domain";
const native = vi.hoisted(() => ({ bind: vi.fn(() => ({})), closed: vi.fn() }));
vi.mock("./process-adapter.js", () => ({ bindWindowsVerifiedExecution: native.bind, assertWindowsVerifiedExecutionClosed: native.closed }));
import { createImportedAuthorExecution, createImportedAuthorEmitter } from "./imported-author-execution.js";
type Event = RunEventMessage["event"];
beforeEach(() => vi.clearAllMocks());
function fixture(stage: "design" | "implementation" = "implementation") {
  const controller = new AbortController(), events: Event[] = [], order: string[] = [];
  const evidence = { version: 1, outcome: "passed" } as RunVerificationPayload;
  const adapter: RuntimeAdapter = { runtimeId: "controlled", start: vi.fn(async () => ({ runId: "controlled-run" })),
    stop: vi.fn(async () => {}), collectArtifacts: async () => [],
    async *streamEvents() { yield { type: "run.lifecycle" as const, payload: { phase: "completed" as const, reason: null } }; } };
  const options: Parameters<typeof createImportedAuthorExecution>[0] = { stage, adapter, config: {} as never, profile: {} as never,
    signal: controller.signal, assertCurrent: vi.fn(), markNativeAttempted: vi.fn(), prepareFinal: vi.fn(() => { order.push("prepare"); }),
    verify: vi.fn(async () => { order.push("verify"); return evidence; }),
    emit: vi.fn(async event => { events.push(event); order.push(event.type); }), beforeCompleted: vi.fn(() => { order.push("provenance"); }) };
  return { controller, events, order, evidence, adapter, options, runner: createImportedAuthorExecution(options) };
}
describe("shared imported author mechanics", () => {
  it.each(["design", "implementation"] as const)("preserves %s closure and commits verification before completion", async stage => {
    const f = fixture(stage); expect(await f.runner.run()).toBe(f.evidence);
    expect(native.closed).toHaveBeenCalledTimes(1); expect(f.options.markNativeAttempted).toHaveBeenCalledTimes(1);
    expect(f.order).toEqual(["prepare", "verify", "run.verification", "provenance", "run.lifecycle"]);
    expect(f.events.at(-1)).toMatchObject({ payload: { phase: "completed" } }); f.runner.dispose();
  });
  it.each(["design", "implementation"] as const)("keeps %s failed-verifier lifecycle semantics explicit", async stage => {
    const f = fixture(stage); f.evidence.outcome = "failed"; f.evidence.reason = "controlled failure";
    expect(await f.runner.run()).toBeUndefined(); expect(f.options.beforeCompleted).not.toHaveBeenCalled();
    expect(f.events.at(-1)).toMatchObject({ payload: { phase: stage === "design" ? "completed" : "failed" } });
    f.runner.dispose();
  });
  it("does not borrow original author closure after an uncertain final verifier", async () => {
    const f = fixture(); vi.mocked(f.options.verify).mockRejectedValue(Error("final verifier closure unknown"));
    const error = await f.runner.run().catch(error => error);
    expect(await f.runner.failure(error)).toMatchObject({ outcome: "uncertain", closed: false });
    expect(native.closed).toHaveBeenCalledTimes(1); expect(f.adapter.stop).not.toHaveBeenCalled(); expect(f.events).toEqual([]);
    f.runner.dispose();
  });
  it("reports a final precondition failure as closed before starting a verifier", async () => {
    const f = fixture(); vi.mocked(f.options.prepareFinal).mockImplementation(() => { throw Error("pinned design changed"); });
    const error = await f.runner.run().catch(error => error);
    expect(await f.runner.failure(error)).toMatchObject({ outcome: "failed", closed: true });
    expect(f.options.verify).not.toHaveBeenCalled(); expect(f.events).toEqual([expect.objectContaining({ payload: { phase: "failed", reason: "pinned design changed" } })]);
    f.runner.dispose();
  });
  it("retains uncertain event delivery and never publishes completed provenance", async () => {
    const f = fixture(); vi.mocked(f.options.emit).mockRejectedValue(Error("receipt lost"));
    const error = await f.runner.run().catch(error => error);
    expect(await f.runner.failure(error)).toMatchObject({ outcome: "uncertain", closed: false });
    expect(f.options.beforeCompleted).not.toHaveBeenCalled(); expect(f.options.emit).toHaveBeenCalledTimes(1); f.runner.dispose();
  });
  it("requires successful provenance binding before the completed event", async () => {
    const f = fixture(); vi.mocked(f.options.beforeCompleted!).mockImplementation(() => { throw Error("original final binding rejected"); });
    const error = await f.runner.run().catch(error => error);
    expect(await f.runner.failure(error)).toMatchObject({ outcome: "failed", closed: true });
    expect(f.events.map(event => event.type)).toEqual(["run.verification", "run.lifecycle"]);
    expect(f.events.at(-1)).toMatchObject({ payload: { phase: "failed" } }); f.runner.dispose();
  });
  it("cannot report author closure when start never returned an original handle", async () => {
    const f = fixture(); vi.mocked(f.adapter.start).mockRejectedValue(Error("native start unresolved"));
    const error = await f.runner.run().catch(error => error);
    expect(await f.runner.failure(error)).toMatchObject({ outcome: "uncertain", closed: false });
    expect(native.closed).not.toHaveBeenCalled(); f.runner.dispose();
  });
  it("requires committed transport support and preserves exact run event ordering", async () => {
    const sent: unknown[] = [], current = vi.fn(), start = { run_id: "run", workspace: { root: "C:\\controlled" } } as never;
    const transport = { acknowledgesRunEvents: true as const, subscribe: () => () => {}, send: vi.fn(async (message: NodeToServerMessage) => { sent.push(message); }) };
    expect(() => createImportedAuthorEmitter({ nodeId: "node", transport: { ...transport, acknowledgesRunEvents: false }, start, current })).toThrow(/committed/);
    const emit = createImportedAuthorEmitter({ nodeId: "node", transport, start, current });
    await emit({ type: "run.lifecycle", payload: { phase: "started", reason: null } });
    await emit({ type: "run.lifecycle", payload: { phase: "completed", reason: null } });
    expect(sent).toEqual([expect.objectContaining({ run_id: "run", sequence: 0 }), expect.objectContaining({ run_id: "run", sequence: 1 })]);
    expect(current).toHaveBeenCalledTimes(4);
  });
});
