// Delivery bookkeeping only; the publisher remains the sole receipt/cancel/execution owner.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProductReleaseCommand, ServerToNodeMessage } from "@artoo/protocol";
import { createSourceCommandInflight } from "./source-command-inflight.js";

const digest = `sha256:${"a".repeat(64)}`;
const command = (): ProductReleaseCommand => ({ kind: "command", id: "release:release", idempotency_key: "release:release", type: "product.release",
  deadline_at: "2099-01-01T00:00:00Z", payload: { version: 1, release_id: "release", goal_id: "goal", project_id: "project", run_id: "run",
    release_profile_id: "site", verification_request_id: "verify", verification_profile_id: "default", verification_profile_digest: digest, subject_digest: digest } });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
afterEach(() => { vi.useRealTimers(); });

describe("ordinary publication delivery without a committed-result receipt protocol", () => {
  it("coalesces a live burst and repeatedly returns completed retries to the original publisher after one bounded yield", async () => {
    vi.useFakeTimers(); const guard = createSourceCommandInflight(), scope = { runtime: {}, session: {} }, gate = deferred(), release = command();
    const work = vi.fn(async (_input: ServerToNodeMessage) => { await gate.promise; });
    const first = guard.run(release, () => scope, work)!;
    for (let i = 0; i < 128; i++) await guard.run(structuredClone(release), () => scope, work);
    expect(work).toHaveBeenCalledTimes(1); gate.resolve(); await first;
    for (let round = 0; round < 3; round++) {
      const replay = guard.run(release, () => scope, work)!;
      for (let i = 0; i < 128; i++) await guard.run(structuredClone(release), () => scope, work);
      expect(work).toHaveBeenCalledTimes(round + 1); expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(9); expect(work).toHaveBeenCalledTimes(round + 1);
      await vi.advanceTimersByTimeAsync(1); await replay; expect(work).toHaveBeenCalledTimes(round + 2);
    }
    for (const [actual] of work.mock.calls) {
      expect(actual).toEqual(release); expect(actual).toMatchObject({ deadline_at: release.deadline_at }); expect(Object.isFrozen(actual)).toBe(true);
    }
    // No claim is made that the existing publisher enforces this optional envelope deadline.
  });

  it("does not turn a health acknowledgement into publication-result acceptance", async () => {
    vi.useFakeTimers(); const guard = createSourceCommandInflight(), scope = { runtime: {}, session: {} }, work = vi.fn(async (_input: ServerToNodeMessage) => {});
    const release = command(); await guard.run(release, () => scope, work);
    expect(guard.run({ kind: "command", id: "health", type: "product.release.health.ack", idempotency_key: "health", payload: { event_id: "health", release_id: release.payload.release_id, sequence: 1, status: "accepted" } }, () => scope, work)).toBeUndefined();
    const replay = guard.run(release, () => scope, work)!;
    await vi.advanceTimersByTimeAsync(10); await replay; expect(work).toHaveBeenCalledTimes(2);
  });

  it.each(["payload", "envelope", "deadline", "unknown-field"] as const)("rejects changed %s without caching or dispatching a publication response", async change => {
    const guard = createSourceCommandInflight(), scope = { runtime: {}, session: {} }, work = vi.fn(async (_input: ServerToNodeMessage) => {}), release = command();
    await guard.run(release, () => scope, work); const changed = structuredClone(release);
    if (change === "payload") changed.payload.subject_digest = `sha256:${"b".repeat(64)}`;
    if (change === "envelope") changed.idempotency_key = "changed";
    if (change === "deadline") changed.deadline_at = "2099-02-01T00:00:00Z";
    if (change === "unknown-field") Object.assign(changed.payload, { remote_publication_authority: true });
    expect(() => guard.run(changed, () => scope, work)).toThrow(); expect(work).toHaveBeenCalledTimes(1);
  });

  it.each(["runtime", "session", "missing", "invalidated"] as const)("fences %s before a delayed publication replay enters the original owner", async change => {
    vi.useFakeTimers(); const guard = createSourceCommandInflight(), scope = { runtime: {}, session: {} }, readScope = vi.fn(() => scope);
    const work = vi.fn(async (_input: ServerToNodeMessage) => {}), release = command(); await guard.run(release, readScope, work);
    const replay = guard.run(release, readScope, work)!.then(() => undefined, error => error);
    if (change === "invalidated") guard.invalidate(); else readScope.mockReturnValue(change === "missing" ? undefined as never : { ...scope, [change]: {} });
    await vi.advanceTimersByTimeAsync(10); expect(await replay).toBeInstanceOf(Error); expect(work).toHaveBeenCalledTimes(1);
  });

  it("dispatches Cancel immediately and lets the original publisher process old starts after the invalidated epoch", async () => {
    vi.useFakeTimers(); const guard = createSourceCommandInflight(), scope = { runtime: {}, session: {} }, work = vi.fn(async (_input: ServerToNodeMessage) => {});
    const dispatch = (input: ServerToNodeMessage) => guard.run(input, () => scope, work) ?? work(input), release = command();
    await dispatch(release); const replay = dispatch(release);
    const cancel: ServerToNodeMessage = { ...release, id: "cancel", type: "product.release.cancel" }; await dispatch(cancel);
    expect(work.mock.calls.map(([input]) => input.type)).toEqual(["product.release", "product.release.cancel"]);
    await vi.advanceTimersByTimeAsync(10); await replay;
    expect(work).toHaveBeenLastCalledWith(release);
    // The old delayed completion cannot restore its pre-Cancel optimization epoch.
    await dispatch(release); expect(work).toHaveBeenCalledTimes(4);
  });

  it("does not retain successful-completion metadata after a failed original or delayed dispatch", async () => {
    vi.useFakeTimers(); const guard = createSourceCommandInflight(), scope = { runtime: {}, session: {} }, release = command();
    const work = vi.fn(async (_input: ServerToNodeMessage) => {}).mockRejectedValueOnce(Error("original failed"));
    await expect(guard.run(release, () => scope, work)).rejects.toThrow("original failed");
    await guard.run(release, () => scope, work); expect(vi.getTimerCount()).toBe(0);
    work.mockRejectedValueOnce(Error("replay failed"));
    const replay = guard.run(release, () => scope, work)!.then(() => undefined, error => error);
    await vi.advanceTimersByTimeAsync(10); expect(await replay).toMatchObject({ message: "replay failed" });
    await guard.run(release, () => scope, work); expect(work).toHaveBeenCalledTimes(4); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["imported_recovery", "imported_clean"] as const)("leaves %s publication and Cancel on their original admission path", origin => {
    const guard = createSourceCommandInflight(), readScope = vi.fn(() => { throw Error("No ordinary scope read expected"); }), work = vi.fn(async () => {});
    const release = command(); Object.assign(release.payload, { [origin]: {} }); // Original controller/parser owns this excluded payload.
    expect(guard.run(release, readScope, work)).toBeUndefined();
    expect(guard.run({ ...release, type: "product.release.cancel" }, readScope, work)).toBeUndefined();
    expect(readScope).not.toHaveBeenCalled(); expect(work).not.toHaveBeenCalled();
  });

  it("leaves fresh publication without ordinary source-session authority on the original handler", () => {
    const guard = createSourceCommandInflight(), work = vi.fn(async () => {});
    expect(guard.run(command(), () => undefined, work)).toBeUndefined(); expect(work).not.toHaveBeenCalled();
  });
});
