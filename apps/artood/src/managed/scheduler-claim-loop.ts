import type { SchedulerClaimSession } from "./scheduler-claim-channel.js";

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = (cause?: unknown) => { clearTimeout(timer); signal.removeEventListener("abort", abort); if (cause) reject(cause); else resolve(); };
    const abort = () => finish(signal.reason ?? new Error("Scheduler claim loop stopped"));
    const timer = setTimeout(() => finish(), milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}
/** Claim polling never owns a producer or a renewal lane. start() resolves at
 * physical startup so subsequent work may execute concurrently on this node. */
export function createSchedulerClaimLoop(options: {
  channel: SchedulerClaimSession;
  assertCurrent(): void;
  start(input: { taskId: string; requestId: string; runId: string }): Promise<void>;
}) {
  const local = new AbortController(), signal = AbortSignal.any([local.signal, options.channel.signal]);
  const done = (async () => {
    let lastClaim: string | undefined;
    try {
      for (;;) {
        signal.throwIfAborted(); options.assertCurrent();
        const claim = await options.channel.poll();
        signal.throwIfAborted(); options.assertCurrent();
        if (claim.status === "rejected") throw new Error("Scheduler claim was rejected by the authenticated server");
        if (claim.status === "idle") { await delay(Math.max(2000, Math.min(30000, claim.retry_after_ms)), signal); continue; }
        const key = `${claim.task_id}\0${claim.request_id}\0${claim.run_id}`;
        await options.start({ taskId: claim.task_id, requestId: claim.request_id, runId: claim.run_id });
        signal.throwIfAborted(); options.assertCurrent();
        // A duplicated claim after a lost response joins the original start;
        // it must not create either a second writer or a hot polling loop.
        if (key === lastClaim) await delay(2000, signal);
        lastClaim = key;
      }
    } catch (error) { if (!signal.aborted) throw error; }
  })();
  void done.catch(() => {});
  return { done, stop() { local.abort(new Error("Scheduler claim loop stopped")); } };
}
