// Real review controller; native ownership and reviewer execution are controlled.
// These tests do not establish native-process, live-provider or product acceptance.
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalProductSourceTransferValueV1 as canonical, importedProductReviewRequestDigestV1 } from "@artoo/domain";
import type { ImportedProductReviewCommand, ImportedProductReviewReceipt, ImportedProductReviewStatus,
  NodeToServerMessage, ServerToNodeMessage } from "@artoo/protocol";
import { createSourceCommandInflight } from "./source-command-inflight.js";
import { importedDesignRequestFixture } from "./test-fixtures/imported-design-request.js";

const native = vi.hoisted(() => ({ reserve: vi.fn(() => ({})), run: vi.fn(), persist: vi.fn(), completed: vi.fn() }));
vi.mock("./product-source-runtime.js", () => ({ reserveImportedProductReview: native.reserve, runImportedProductReview: native.run,
  persistImportedProductReviewResult: native.persist, readCompletedImportedProductReview: native.completed }));
import { createImportedProductReviewClient } from "./imported-product-review.js";

const sha = (value: string | Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const otherDigest = `sha256:${"f".repeat(64)}`;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
function fixture() {
  const design = importedDesignRequestFixture().request, request = design.review_request;
  const command: ImportedProductReviewCommand = { kind: "command", id: "review-delivery", type: "product.source.review.v1",
    idempotency_key: "review:start", payload: request };
  const control = { version: 1 as const, review_id: request.review_id, request_digest: importedProductReviewRequestDigestV1(request, sha) };
  const sent: NodeToServerMessage[] = [], transport = { send: vi.fn(async (message: NodeToServerMessage) => { sent.push(message); }), subscribe: () => () => {} };
  const current = vi.fn(() => true), original = vi.fn(() => request.result);
  const client = createImportedProductReviewClient({ nodeId: request.operation.intent.request.byte_request.destination.node_id,
    runtime: {} as never, sourceOperations: { readCompletedVerified: original } as never, transport, isCurrent: current,
    resolveAdapter: () => ({ runtimeId: request.review_start.runtime }) as never });
  native.run.mockResolvedValue(design.review_result);
  const guard = createSourceCommandInflight(), originalScope = { runtime: {}, session: {} }, readScope = vi.fn(() => originalScope);
  const work = vi.fn(async (message: ServerToNodeMessage) => { await client.handle(message); });
  const dispatch = (message: ServerToNodeMessage) => guard.run(message, readScope, work) ?? work(message);
  const status = (id = "review-status"): ImportedProductReviewStatus => ({ kind: "command", id, type: "product.source.review.status.v1",
    idempotency_key: "review:status", payload: control });
  const receipt = (id = command.id): ImportedProductReviewReceipt => {
    const result = sent.findLast(message => message.kind === "product.source.review.result.v1" && message.command_id === id);
    if (result?.kind !== "product.source.review.result.v1") throw Error("Actual review controller result is required");
    return { kind: "command", id, type: "product.source.review.receipt.v1", idempotency_key: `receipt:${id}`,
      status: "accepted", payload: control, result_digest: sha(canonical(result.payload)) };
  };
  const stop = (): ServerToNodeMessage => ({ ...status("review-stop"), type: "product.source.review.stop.v1" });
  return { command, control, status, receipt, stop, dispatch, guard, work, current, original, readScope, originalScope, transport, sent, client };
}
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); });

describe("completed H3 review deliveries with the real controller and mocked native ownership", () => {
  it.each(["start", "status"] as const)("yields a completed %s backlog for its final receipt without repeating native admission", async control => {
    vi.useFakeTimers();
    const f = fixture(); await f.dispatch(f.command);
    const command = control === "start" ? f.command : f.status();
    if (control === "status") await f.dispatch(command);
    const checks = f.current.mock.calls.length, frames = f.sent.length, replay = f.dispatch(command);
    for (let index = 0; index < 256; index++) await f.dispatch(structuredClone(command));
    expect(f.current).toHaveBeenCalledTimes(checks);
    expect(vi.getTimerCount()).toBe(1);
    await f.dispatch(f.receipt(command.id));
    const acceptedChecks = f.current.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10); await replay;
    await f.dispatch(command); await f.dispatch(f.receipt(command.id));
    expect(f.current).toHaveBeenCalledTimes(acceptedChecks); expect(f.sent).toHaveLength(frames);
    expect(native.run).toHaveBeenCalledTimes(1); expect(native.reserve).toHaveBeenCalledTimes(1); expect(native.persist).toHaveBeenCalledTimes(1);
  });

  it("discards sequential old starts and exact receipts only after original controller acceptance", async () => {
    const f = fixture(); await f.dispatch(f.command); const receipt = f.receipt(); await f.dispatch(receipt);
    const checks = f.current.mock.calls.length, frames = f.sent.length;
    for (let index = 0; index < 32; index++) { await f.dispatch(structuredClone(f.command)); await f.dispatch(structuredClone(receipt)); }
    expect(f.current).toHaveBeenCalledTimes(checks); expect(f.sent).toHaveLength(frames);
    expect(native.run).toHaveBeenCalledTimes(1); expect(native.persist).toHaveBeenCalledTimes(1);
  });

  it("replays the original result after the bounded delay when the committed receipt is lost", async () => {
    vi.useFakeTimers();
    const f = fixture(); await f.dispatch(f.command); const checks = f.current.mock.calls.length, replay = f.dispatch(f.command);
    await vi.advanceTimersByTimeAsync(9); expect(f.current).toHaveBeenCalledTimes(checks);
    await vi.advanceTimersByTimeAsync(1); await replay;
    expect(f.sent.filter(message => message.kind === "product.source.review.result.v1")).toHaveLength(2);
    expect(native.run).toHaveBeenCalledTimes(1); expect(native.persist).toHaveBeenCalledTimes(1);
  });

  it.each(["invalidated", "missing-session", "changed-session", "changed-runtime"] as const)
    ("fences %s before delayed replay can enter the original controller", async change => {
      vi.useFakeTimers();
      const f = fixture(); await f.dispatch(f.command); const checks = f.current.mock.calls.length;
      const replay = f.dispatch(f.command).then(() => undefined, error => error);
      if (change === "invalidated") f.guard.invalidate();
      else if (change === "missing-session") f.readScope.mockReturnValue(undefined as never);
      else f.readScope.mockReturnValue({ ...f.originalScope, [change === "changed-session" ? "session" : "runtime"]: {} });
      await vi.advanceTimersByTimeAsync(10);
      expect(await replay).toBeInstanceOf(Error); expect(f.current).toHaveBeenCalledTimes(checks);
      expect(f.sent.filter(message => message.kind === "product.source.review.result.v1")).toHaveLength(1);
    });

  it.each(["payload", "envelope", "deadline", "unknown-field", "runtime", "session", "missing"] as const)
    ("rejects a confirmed delivery's changed %s without another controller admission", async change => {
      const f = fixture(); await f.dispatch(f.command); const receipt = f.receipt(); await f.dispatch(receipt);
      const checks = f.current.mock.calls.length, command = structuredClone(f.command);
      if (change === "payload") command.payload.review_start.context_pack.payload!.task.description = "changed";
      if (change === "envelope") command.idempotency_key = "changed";
      if (change === "deadline") command.deadline_at = "2099-01-01T00:00:00Z";
      if (change === "unknown-field") Object.assign(command.payload.review_start.context_pack.payload!.task, { unsupported_authority: true });
      if (change === "runtime" || change === "session") f.readScope.mockReturnValue({ ...f.originalScope, [change]: {} });
      if (change === "missing") f.readScope.mockReturnValue(undefined as never);
      expect(() => f.dispatch(command)).toThrow(); expect(f.current).toHaveBeenCalledTimes(checks);
      if (["runtime", "session", "missing"].includes(change)) expect(() => f.dispatch(receipt)).toThrow("authenticated runtime/session");
    });

  it.each(["result", "review", "request", "unknown-field"] as const)("cannot suppress replay using an invalid %s receipt", async change => {
    const f = fixture(); await f.dispatch(f.command); const receipt = f.receipt();
    if (change === "result") receipt.result_digest = otherDigest;
    if (change === "review") receipt.payload.review_id = "other-review";
    if (change === "request") receipt.payload.request_digest = otherDigest;
    if (change === "unknown-field") Object.assign(receipt, { unsupported_authority: true });
    await expect(f.dispatch(receipt)).rejects.toThrow();
    const checks = f.current.mock.calls.length; await f.dispatch(f.command);
    expect(f.current.mock.calls.length).toBeGreaterThan(checks); expect(native.run).toHaveBeenCalledTimes(1);
  });

  it("never binds another family's receipt to the retained review delivery", async () => {
    const f = fixture(); await f.dispatch(f.command);
    await f.dispatch({ kind: "command", id: f.command.id, type: "product.source.operation.receipt.v1", idempotency_key: "operation:receipt",
      status: "accepted", payload: { version: 1, operation_id: f.control.review_id, payload_digest: f.control.request_digest }, result_digest: otherDigest });
    const checks = f.current.mock.calls.length; await f.dispatch(f.command);
    expect(f.current.mock.calls.length).toBeGreaterThan(checks); expect(native.run).toHaveBeenCalledTimes(1);
  });

  it.each(["stop", "rejected-receipt"] as const)("keeps %s immediate and prevents pending receipts from restoring suppression", async control => {
    vi.useFakeTimers();
    const f = fixture(); await f.dispatch(f.command); const receipt = f.receipt(), gate = deferred();
    f.work.mockImplementation(async message => { await f.client.handle(message); if (message.type === "product.source.review.receipt.v1" && message.status === "accepted") await gate.promise; });
    const replay = f.dispatch(f.command), pendingReceipt = f.dispatch(receipt);
    let settled = false; void pendingReceipt.then(() => { settled = true; });
    await Promise.resolve(); const checks = f.current.mock.calls.length;
    for (let index = 0; index < 64; index++) await f.dispatch(structuredClone(receipt));
    expect(settled).toBe(false); expect(f.current).toHaveBeenCalledTimes(checks);
    expect(() => f.dispatch({ ...receipt, idempotency_key: "changed" })).toThrow("complete envelope");
    await f.dispatch(control === "stop" ? f.stop() : { ...receipt, id: "rejection-delivery", status: "rejected" });
    expect(f.current.mock.calls.length).toBeGreaterThan(checks);
    gate.resolve(); await pendingReceipt;
    const afterControl = f.current.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10); await replay;
    expect(f.current.mock.calls.length).toBeGreaterThan(afterControl);
    const afterReplay = f.current.mock.calls.length; await f.dispatch(f.command);
    expect(f.current.mock.calls.length).toBeGreaterThan(afterReplay); expect(native.run).toHaveBeenCalledTimes(1);
  });

  it.each(["success", "failure"] as const)("accepts an early original receipt without deadlock but requires original dispatch %s", async outcome => {
    const f = fixture(), gate = deferred(), failure = Error("Controlled original result send failure");
    let accepted: ImportedProductReviewReceipt | undefined;
    f.transport.send.mockImplementation(async message => {
      f.sent.push(message);
      if (message.kind === "product.source.review.result.v1" && !accepted) {
        accepted = f.receipt(); await f.dispatch(accepted); await gate.promise;
        if (outcome === "failure") throw failure;
      }
    });
    const running = f.dispatch(f.command).then(() => undefined, error => error);
    await vi.waitFor(() => expect(accepted).toBeDefined()); gate.resolve();
    expect(await running).toBe(outcome === "failure" ? failure : undefined);
    const checks = f.current.mock.calls.length; await f.dispatch(f.command);
    if (outcome === "success") expect(f.current).toHaveBeenCalledTimes(checks);
    else expect(f.current.mock.calls.length).toBeGreaterThan(checks);
    expect(native.run).toHaveBeenCalledTimes(1); expect(native.persist).toHaveBeenCalledTimes(1);
  });

  it("preserves deadline checks and first-attempt receipt validation failures", async () => {
    vi.useFakeTimers();
    const f = fixture(); f.command.deadline_at = new Date(Date.now() + 5).toISOString(); await f.dispatch(f.command);
    await expect(f.dispatch({ ...f.receipt(), result_digest: otherDigest })).rejects.toThrow("differs from original result");
    const replay = f.dispatch(f.command).then(() => undefined, error => error);
    // Failed receipt validation drops cached metadata: this retry reaches the original controller immediately.
    expect(vi.getTimerCount()).toBe(0); await replay;
    const delayed = f.dispatch(f.command).then(() => undefined, error => error);
    await vi.advanceTimersByTimeAsync(10); expect(await delayed).toMatchObject({ message: "Imported review command deadline expired" });
    expect(native.run).toHaveBeenCalledTimes(1);
  });
});
