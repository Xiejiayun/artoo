import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SchedulerClaimSession } from "./scheduler-claim-channel.js";
import { createSchedulerClaimLoop } from "./scheduler-claim-loop.js";

// Scheduling/control doubles only; no process or journal authority is supplied.
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});
function fixture() {
  const controller = new AbortController();
  const session = {
    nodeId: "node",
    namespace: randomUUID(),
    sessionId: randomUUID(),
    generation: 1,
    helloNonce: randomUUID(),
  };
  const common = {
    version: 1 as const,
    node_id: session.nodeId,
    session_id: session.sessionId,
    exchange_id: randomUUID(),
  };
  const idle = { ...common, status: "idle" as const, retry_after_ms: 250 };
  const claimed = { ...common, status: "claimed" as const, task_id: "task", request_id: "request", run_id: "run" };
  const poll = vi.fn<SchedulerClaimSession["poll"]>().mockResolvedValue(idle);
  const channel: SchedulerClaimSession = { session, signal: controller.signal, poll };
  return { controller, channel, common, idle, claimed, poll };
}
it("waits for physical startup only and then polls for concurrent work", async () => {
  const f = fixture();
  f.poll.mockResolvedValueOnce(f.claimed);
  let started!: () => void;
  const start = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        started = resolve;
      }),
  );
  const loop = createSchedulerClaimLoop({ channel: f.channel, assertCurrent() {}, start });
  await vi.advanceTimersByTimeAsync(0);
  expect(start).toHaveBeenCalledWith({ taskId: "task", requestId: "request", runId: "run" });
  expect(f.poll).toHaveBeenCalledTimes(1);
  started();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.poll).toHaveBeenCalledTimes(2);
  loop.stop();
  await loop.done;
  expect(vi.getTimerCount()).toBe(0);
});
it("bounds idle polling and cancels its wait immediately with the original session", async () => {
  const f = fixture(),
    loop = createSchedulerClaimLoop({ channel: f.channel, assertCurrent() {}, start: vi.fn(async () => {}) });
  await vi.advanceTimersByTimeAsync(1999);
  expect(f.poll).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.poll).toHaveBeenCalledTimes(2);
  f.controller.abort(new Error("original generation lost"));
  await loop.done;
  await vi.advanceTimersByTimeAsync(30000);
  expect(f.poll).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});
it("surfaces admission failure and never loops the same failed permission into a retry", async () => {
  const f = fixture();
  f.poll.mockResolvedValue(f.claimed);
  const start = vi.fn(async () => {
    throw new Error("original one-use admission retained");
  });
  const loop = createSchedulerClaimLoop({ channel: f.channel, assertCurrent() {}, start });
  await expect(loop.done).rejects.toThrow("one-use admission retained");
  expect(start).toHaveBeenCalledTimes(1);
  expect(f.poll).toHaveBeenCalledTimes(1);
});
