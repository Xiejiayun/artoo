import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalProductSourceTransferValueV1 as canonical, ProductSourceOperationV1Schema, productSourceOperationDigestV1,
  type ProductSourceTransferReceiptV1 } from "@artoo/domain";
import type { NodeToServerMessage, ProductSourceOperationCommand, ProductSourceOperationReceipt,
  ProductSourceOperationStatus, ServerToNodeMessage } from "@artoo/protocol";
import { createSourceCommandInflight } from "./source-command-inflight.js";

const native = vi.hoisted(() => ({ reserve: vi.fn(() => ({})), persist: vi.fn() }));
vi.mock("./product-source-runtime.js", () => ({ reserveProductSourceOperation: native.reserve, persistProductSourceOperationResult: native.persist,
  importProductSourceSemanticTransfer: vi.fn(), verifyProductSourceSemanticTransfer: vi.fn(), readCompletedProductSourceAdmission: vi.fn() }));
import { createProductSourceOperationClient } from "./product-source-operations.js";

const data = JSON.parse(readFileSync(new URL("../../../packages/domain/test-fixtures/product-source-operation.json", import.meta.url), "utf8"));
const sha = (value: string | Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const otherDigest = `sha256:${"f".repeat(64)}`;
const deferred = () => { let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
function fixture() {
  const payload = ProductSourceOperationV1Schema.parse({ version: 1, operation_id: "operation", kind: "upload", request_digest: data.fresh.request_digest,
    intent: { version: 1, request: data.admission.request, next_task_id: "next-design", destination_start: data.admission.run_start } });
  const command: ProductSourceOperationCommand = { kind: "command", id: "delivery", type: "product.source.operation.v1", idempotency_key: "operation:start", payload };
  const uploadReceipt: ProductSourceTransferReceiptV1 = { version: 1, transfer_id: payload.intent.request.byte_request.transfer_id,
    request_digest: payload.request_digest, capsule_digest: payload.intent.request.byte_request.source.capsule_digest, status: "available", execution_authorized: false };
  const sent: NodeToServerMessage[] = [], transport = { send: vi.fn(async (message: NodeToServerMessage) => { sent.push(message); }), subscribe: () => () => {} };
  const upload = vi.fn(async () => uploadReceipt), current = vi.fn(() => true);
  const client = createProductSourceOperationClient({ nodeId: payload.intent.request.byte_request.source.node_id, runtime: {} as never,
    client: { upload, download: vi.fn() }, isCurrent: current, transport });
  const guard = createSourceCommandInflight(), originalScope = { runtime: {}, session: {} }, readScope = vi.fn(() => originalScope);
  const work = vi.fn(async (message: ServerToNodeMessage) => { await client.handle(message); });
  const dispatch = (message: ServerToNodeMessage) => guard.run(message, readScope, work) ?? work(message);
  const control = { version: 1 as const, operation_id: payload.operation_id, payload_digest: productSourceOperationDigestV1(payload, sha), request_digest: payload.request_digest };
  const receipt = (id = command.id): ProductSourceOperationReceipt => {
    const result = sent.findLast(message => message.kind === "product.source.operation.result.v1" && message.command_id === id);
    if (!result || result.kind !== "product.source.operation.result.v1") throw Error("Actual controller result is required");
    // The existing server omits the optional request digest from H2 receipts.
    return { kind: "command", id, type: "product.source.operation.receipt.v1", idempotency_key: `receipt:${id}`, status: "accepted",
      payload: { version: 1, operation_id: result.payload.operation_id, payload_digest: result.payload.payload_digest }, result_digest: sha(canonical(result.payload)) };
  };
  const status = (id = "status"): ProductSourceOperationStatus => ({ kind: "command", id, type: "product.source.operation.status.v1", idempotency_key: "operation:status", payload: control });
  return { command, control, status, receipt, dispatch, guard, work, current, readScope, originalScope, transport, sent, upload, client };
}
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); });

describe("completed H2 replay yields to queued transport receipts", () => {
  it.each(["start", "status"] as const)("coalesces a completed %s backlog during one bounded replay delay without losing an unacknowledged result", async control => {
    vi.useFakeTimers();
    const f = fixture(); await f.dispatch(f.command);
    const command = control === "start" ? f.command : f.status();
    if (control === "status") await f.dispatch(command);
    const results = f.sent.filter(message => message.kind === "product.source.operation.result.v1").length;
    const checks = f.current.mock.calls.length, replay = f.dispatch(command);
    for (let index = 0; index < 256; index++) await f.dispatch(structuredClone(command));
    expect(f.current).toHaveBeenCalledTimes(checks);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(9); expect(f.current).toHaveBeenCalledTimes(checks);
    await vi.advanceTimersByTimeAsync(1); await replay;
    expect(f.sent.filter(message => message.kind === "product.source.operation.result.v1")).toHaveLength(results + 1);
    expect(f.upload).toHaveBeenCalledTimes(1); expect(native.reserve).toHaveBeenCalledTimes(1); expect(native.persist).toHaveBeenCalledTimes(1);
  });

  it("processes an authentic committed receipt during the delay and skips only the now-redundant replay", async () => {
    vi.useFakeTimers();
    const f = fixture(); await f.dispatch(f.command); const receipt = f.receipt();
    const replay = f.dispatch(f.command);
    await f.dispatch(receipt);
    const checks = f.current.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10); await replay;
    await f.dispatch(f.command); await f.dispatch(receipt);
    expect(f.current).toHaveBeenCalledTimes(checks);
    expect(f.sent.filter(message => message.kind === "product.source.operation.result.v1")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["invalidated", "missing-session", "changed-session", "changed-runtime"] as const)("rechecks %s before delayed replay can call the controller", async change => {
    vi.useFakeTimers();
    const f = fixture(); await f.dispatch(f.command); const checks = f.current.mock.calls.length;
    const replay = f.dispatch(f.command).then(() => undefined, error => error);
    if (change === "invalidated") f.guard.invalidate();
    else if (change === "missing-session") f.readScope.mockReturnValue(undefined as never);
    else f.readScope.mockReturnValue({ ...f.originalScope, [change === "changed-session" ? "session" : "runtime"]: {} });
    await vi.advanceTimersByTimeAsync(10);
    expect(await replay).toBeInstanceOf(Error);
    expect(f.current).toHaveBeenCalledTimes(checks);
    expect(f.sent.filter(message => message.kind === "product.source.operation.result.v1")).toHaveLength(1);
  });

  it("preserves the original command deadline while yielding a completed replay", async () => {
    vi.useFakeTimers();
    const f = fixture(); f.command.deadline_at = new Date(Date.now() + 5).toISOString();
    await f.dispatch(f.command);
    const replay = f.dispatch(f.command).then(() => undefined, error => error);
    await vi.advanceTimersByTimeAsync(10);
    expect(await replay).toMatchObject({ message: "Operation command deadline expired before admission" });
    expect(f.upload).toHaveBeenCalledTimes(1);
    expect(f.sent.filter(message => message.kind === "product.source.operation.result.v1")).toHaveLength(1);
  });

  it("does not wait for a receipt handler that is still pending when the replay delay ends", async () => {
    vi.useFakeTimers();
    const f = fixture(); await f.dispatch(f.command); const gate = deferred(), receipt = f.receipt();
    f.work.mockImplementation(async message => {
      if (message.type === "product.source.operation.receipt.v1") await gate.promise;
      await f.client.handle(message);
    });
    const replay = f.dispatch(f.command), pendingReceipt = f.dispatch(receipt);
    let replayed = false; void replay.then(() => { replayed = true; });
    await vi.advanceTimersByTimeAsync(10);
    expect(replayed).toBe(true);
    expect(f.sent.filter(message => message.kind === "product.source.operation.result.v1")).toHaveLength(2);
    gate.resolve(); await pendingReceipt; await replay;
    const checks = f.current.mock.calls.length; await f.dispatch(f.command);
    expect(f.current).toHaveBeenCalledTimes(checks);
  });

  it.each(["stop", "rejected-receipt"] as const)("keeps %s on its original handler and cannot restore old receipt suppression during a delayed replay", async control => {
    vi.useFakeTimers();
    const f = fixture(); await f.dispatch(f.command); const receipt = f.receipt();
    const replay = f.dispatch(f.command); await f.dispatch(receipt);
    if (control === "stop") await f.dispatch({ ...f.status("stop"), type: "product.source.operation.stop.v1" });
    else await f.dispatch({ ...receipt, status: "rejected" });
    const checks = f.current.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10); await replay;
    expect(f.current.mock.calls.length).toBeGreaterThan(checks);
    const replayedChecks = f.current.mock.calls.length;
    await f.dispatch(f.command); // Old epoch must not repopulate the completed map.
    expect(f.current.mock.calls.length).toBeGreaterThan(replayedChecks);
    expect(f.upload).toHaveBeenCalledTimes(1); expect(native.reserve).toHaveBeenCalledTimes(1);
  });

  it("keeps replay available after invalid receipt validation and rejects a changed envelope without replacing its pending timer", async () => {
    vi.useFakeTimers();
    const f = fixture(); await f.dispatch(f.command); const replay = f.dispatch(f.command);
    expect(() => f.dispatch({ ...f.command, idempotency_key: "changed" })).toThrow("complete envelope");
    await expect(f.dispatch({ ...f.receipt(), result_digest: otherDigest })).rejects.toThrow("differs from original result");
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(10); await replay;
    expect(f.sent.filter(message => message.kind === "product.source.operation.result.v1")).toHaveLength(2);
  });

  it("leaves first attempts, failed sends and unrelated H3 work immediate", async () => {
    vi.useFakeTimers();
    const f = fixture(), failure = Error("Controlled original result send failure");
    f.transport.send.mockImplementationOnce(async () => { throw failure; });
    // ACK failure is retained as uncertain by the real controller; reject the
    // result write as well so the complete initial dispatch actually fails.
    f.transport.send.mockRejectedValueOnce(failure);
    await expect(f.dispatch(f.command)).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
    await f.dispatch(f.command); expect(vi.getTimerCount()).toBe(0);
    const review: ServerToNodeMessage = { kind: "command", id: "review-status", type: "product.source.review.status.v1",
      idempotency_key: "review:status", payload: { version: 1, review_id: "review", request_digest: otherDigest } };
    const work = vi.fn(async () => {});
    await f.guard.run(review, f.readScope, work); await f.guard.run(review, f.readScope, work);
    expect(work).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });
});

describe("completed H2 delivery suppression with the real operation controller and mocked native ownership", () => {
  it("discards sequential old starts/status and exact receipts only after controller-validated server receipts", async () => {
    const f = fixture(); await f.dispatch(f.command); const receipt = f.receipt(); await f.dispatch(receipt);
    await f.dispatch(f.status()); const statusReceipt = f.receipt("status"); await f.dispatch(statusReceipt);
    const checks = f.current.mock.calls.length, frames = f.sent.length;
    for (let index = 0; index < 64; index++) {
      await f.dispatch(structuredClone(f.command)); await f.dispatch(structuredClone(receipt));
      await f.dispatch(structuredClone(f.status())); await f.dispatch(structuredClone(statusReceipt));
    }
    expect(f.current).toHaveBeenCalledTimes(checks); expect(f.sent).toHaveLength(frames);
    expect(f.upload).toHaveBeenCalledTimes(1); expect(native.persist).toHaveBeenCalledTimes(1);
    await f.dispatch({ ...f.command, id: "new-delivery" });
    expect(f.current.mock.calls.length).toBeGreaterThan(checks); expect(f.sent.at(-1)).toMatchObject({ command_id: "new-delivery" });
  });

  it("keeps replaying a successfully sent result when the committed receipt is lost", async () => {
    const f = fixture(); await f.dispatch(f.command); const checks = f.current.mock.calls.length;
    await f.dispatch(f.command); expect(f.current.mock.calls.length).toBeGreaterThan(checks);
    expect(f.sent.filter(message => message.kind === "product.source.operation.result.v1")).toHaveLength(2);
    expect(f.upload).toHaveBeenCalledTimes(1);
  });

  it("suppresses accepted uncertain-result deliveries without inventing closure or preventing the real Stop handler", async () => {
    const f = fixture(); f.upload.mockRejectedValueOnce(Error("Controlled upload failure"));
    await f.dispatch(f.command);
    const original = f.sent.findLast(message => message.kind === "product.source.operation.result.v1");
    if (!original || original.kind !== "product.source.operation.result.v1") throw Error("Original uncertain result is required");
    expect(original.payload).toMatchObject({ outcome: "uncertain", closed: false });
    const receipt = f.receipt(); await f.dispatch(receipt);
    const status = f.status(); await f.dispatch(status); const statusReceipt = f.receipt(status.id); await f.dispatch(statusReceipt);
    const checks = f.current.mock.calls.length, frames = f.sent.length;
    for (let index = 0; index < 8; index++) {
      await f.dispatch(f.command); await f.dispatch(receipt); await f.dispatch(status); await f.dispatch(statusReceipt);
    }
    expect(f.current).toHaveBeenCalledTimes(checks); expect(f.sent).toHaveLength(frames);
    expect(native.reserve).toHaveBeenCalledTimes(1); expect(native.persist).toHaveBeenCalledTimes(1); expect(f.upload).toHaveBeenCalledTimes(1);
    await f.dispatch({ kind: "command", id: "stop", type: "product.source.operation.stop.v1", idempotency_key: "stop", payload: f.control });
    expect(f.current.mock.calls.length).toBeGreaterThan(checks);
    expect(f.sent).toContainEqual(expect.objectContaining({ kind: "product.source.operation.ack.v1", command_id: "stop", status: "accepted" }));
    const stopped = f.sent.at(-1);
    expect(stopped).toMatchObject({ kind: "product.source.operation.result.v1", command_id: "stop", payload: { outcome: "uncertain", closed: false } });
    if (stopped?.kind !== "product.source.operation.result.v1") throw Error("Stop must emit the original result");
    expect(stopped.payload).toBe(original.payload);
    const afterStop = f.current.mock.calls.length; await f.dispatch(f.command);
    expect(f.current.mock.calls.length).toBeGreaterThan(afterStop);
    expect(native.reserve).toHaveBeenCalledTimes(1); expect(native.persist).toHaveBeenCalledTimes(1); expect(f.upload).toHaveBeenCalledTimes(1);
    expect(f.sent.filter(message => message.kind === "product.source.operation.result.v1").every(message => message.payload === original.payload)).toBe(true);
    expect(original.payload).toMatchObject({ outcome: "uncertain", closed: false });
  });

  it("cannot convert an unknown, mismatched or invalid result receipt into suppression", async () => {
    const f = fixture(), early: ProductSourceOperationReceipt = { kind: "command", id: f.command.id, type: "product.source.operation.receipt.v1",
      idempotency_key: "receipt:delivery", status: "accepted", payload: f.control, result_digest: otherDigest };
    await expect(f.dispatch(early)).rejects.toThrow("receipt differs");
    await f.dispatch(f.command); const valid = f.receipt();
    for (const changed of [{ ...valid, result_digest: otherDigest }, { ...valid, payload: { ...valid.payload, operation_id: "other" } },
      { ...valid, payload: { ...valid.payload, request_digest: otherDigest } }]) {
      await expect(f.dispatch(changed)).rejects.toThrow("receipt differs");
      const checks = f.current.mock.calls.length; await f.dispatch(f.command); expect(f.current.mock.calls.length).toBeGreaterThan(checks);
    }
    await f.dispatch(valid); const checks = f.current.mock.calls.length; await f.dispatch(f.command); expect(f.current).toHaveBeenCalledTimes(checks);
  });

  it("does not bind another operation's valid receipt to this delivery ID", async () => {
    const f = fixture(); await f.dispatch(f.command);
    await f.dispatch({ ...f.command, id: "other-delivery", payload: { ...f.command.payload, operation_id: "other-operation" } });
    await f.dispatch({ ...f.receipt("other-delivery"), id: f.command.id });
    const checks = f.current.mock.calls.length; await f.dispatch(f.command); expect(f.current.mock.calls.length).toBeGreaterThan(checks);
  });

  it.each(["runtime", "session", "missing", "payload", "envelope"] as const)("rejects a confirmed delivery's changed %s", async variant => {
    const f = fixture(); await f.dispatch(f.command); const receipt = f.receipt(); await f.dispatch(receipt);
    const checks = f.current.mock.calls.length, changed = structuredClone(f.command);
    if (variant === "runtime") f.readScope.mockReturnValue({ ...f.originalScope, runtime: {} });
    if (variant === "session") f.readScope.mockReturnValue({ ...f.originalScope, session: {} });
    if (variant === "missing") f.readScope.mockReturnValue(undefined as never);
    if (variant === "payload") changed.payload.intent.next_task_id = "changed";
    if (variant === "envelope") changed.idempotency_key = "changed";
    expect(() => f.dispatch(changed)).toThrow(); expect(f.current).toHaveBeenCalledTimes(checks);
    if (["runtime", "session", "missing"].includes(variant)) expect(() => f.dispatch(receipt)).toThrow("authenticated runtime/session");
  });

  it("lets Stop and a rejection on another delivery invalidate every completed optimization", async () => {
    const f = fixture(); await f.dispatch(f.command); await f.dispatch(f.receipt());
    let checks = f.current.mock.calls.length;
    await f.dispatch({ ...f.receipt(), id: "rejection-delivery", status: "rejected" }); await f.dispatch(f.command);
    expect(f.current.mock.calls.length).toBeGreaterThan(checks);
    await f.dispatch(f.receipt()); checks = f.current.mock.calls.length;
    await f.dispatch({ kind: "command", id: "stop", type: "product.source.operation.stop.v1", idempotency_key: "stop", payload: f.control });
    expect(f.sent.at(-1)).toMatchObject({ command_id: "stop" });
    const afterStop = f.current.mock.calls.length; expect(afterStop).toBeGreaterThan(checks);
    await f.dispatch(f.command); expect(f.current.mock.calls.length).toBeGreaterThan(afterStop); expect(f.upload).toHaveBeenCalledTimes(1);
  });

  it.each(["success", "failure"] as const)("handles a reentrant early receipt without deadlock and requires original work %s", async outcome => {
    const f = fixture(), gate = deferred(), failure = Error("Original result send failed after its early receipt");
    let accepted: ProductSourceOperationReceipt | undefined;
    f.transport.send.mockImplementation(async message => {
      f.sent.push(message);
      if (message.kind === "product.source.operation.result.v1" && !accepted) {
        accepted = f.receipt(); await f.dispatch(accepted); await gate.promise;
        if (outcome === "failure") throw failure;
      }
    });
    const running = f.dispatch(f.command), observed = running.then(() => undefined, error => error);
    await vi.waitFor(() => expect(accepted).toBeDefined());
    gate.resolve(); expect(await observed).toBe(outcome === "failure" ? failure : undefined);
    const checks = f.current.mock.calls.length; await f.dispatch(f.command);
    if (outcome === "success") expect(f.current).toHaveBeenCalledTimes(checks);
    else expect(f.current.mock.calls.length).toBeGreaterThan(checks);
    expect(f.upload).toHaveBeenCalledTimes(1);
  });

  it("coalesces a pending exact receipt without adding waiters and never re-confirms it across Stop", async () => {
    const f = fixture(); await f.dispatch(f.command); const receipt = f.receipt(), gate = deferred();
    f.work.mockImplementation(async message => { await f.client.handle(message); if (message.type === "product.source.operation.receipt.v1") await gate.promise; });
    const pending = f.dispatch(receipt); let settled = false; void pending.then(() => { settled = true; });
    const checks = f.current.mock.calls.length;
    for (let index = 0; index < 64; index++) await f.dispatch(receipt);
    expect(settled).toBe(false); expect(f.current).toHaveBeenCalledTimes(checks);
    expect(() => f.dispatch({ ...receipt, idempotency_key: "changed" })).toThrow("complete envelope");
    await f.dispatch({ kind: "command", id: "stop", type: "product.source.operation.stop.v1", idempotency_key: "stop", payload: f.control });
    gate.resolve(); await pending;
    const afterStop = f.current.mock.calls.length; await f.dispatch(f.command); expect(f.current.mock.calls.length).toBeGreaterThan(afterStop);
  });

  it("retains no completed suppression when receipt validation itself fails", async () => {
    const f = fixture(); await f.dispatch(f.command); const receipt = f.receipt(), failure = Error("Original receipt validation failed");
    f.work.mockImplementationOnce(async () => { throw failure; });
    await expect(f.dispatch(receipt)).rejects.toBe(failure);
    const checks = f.current.mock.calls.length; await f.dispatch(f.command); expect(f.current.mock.calls.length).toBeGreaterThan(checks);
  });

  it("bounds completed metadata without evicting live work or treating eviction as a new authority", async () => {
    const guard = createSourceCommandInflight(), originalScope = { runtime: {}, session: {} }, work = vi.fn(async (_command: ServerToNodeMessage) => {});
    const f = fixture(), gate = deferred(), active = f.status("still-active");
    const pending = guard.run(active, () => originalScope, () => gate.promise)!;
    for (let index = 0; index < 1025; index++) {
      const command = f.status(`delivery-${index}`);
      await guard.run(command, () => originalScope, work);
      await guard.run({ kind: "command", id: command.id, type: "product.source.operation.receipt.v1", idempotency_key: `receipt:${command.id}`,
        status: "accepted", payload: command.payload, result_digest: otherDigest }, () => originalScope, work);
    }
    const count = work.mock.calls.length;
    await guard.run(f.status("delivery-1024"), () => originalScope, work); expect(work).toHaveBeenCalledTimes(count);
    await guard.run(f.status("delivery-0"), () => originalScope, work); expect(work).toHaveBeenCalledTimes(count + 1);
    await guard.run(active, () => originalScope, work); expect(work).toHaveBeenCalledTimes(count + 1);
    gate.resolve(); await pending;
  });
});
