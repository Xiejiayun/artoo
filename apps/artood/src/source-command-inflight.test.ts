import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { productSourceOperationCommandSchema, type ProductSourceOperationStatus, type ServerToNodeMessage } from "@artoo/protocol";
import { createSourceCommandInflight } from "./source-command-inflight.js";

const digest = `sha256:${"a".repeat(64)}`, changedDigest = `sha256:${"b".repeat(64)}`;
const deferred = () => { let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const scope = () => ({ runtime: {}, session: {} });
const families = [
  ["operation", { version: 1, operation_id: "operation", payload_digest: digest, request_digest: digest }],
  ["review", { version: 1, review_id: "review", request_digest: digest }],
  ["design", { version: 1, continuation_id: "design", run_id: "run", request_digest: digest }],
  ["design-review", { version: 1, review_id: "review", request_digest: digest }],
  ["execution", { version: 1, execution_id: "execution", run_id: "run", request_digest: digest }],
  ["execution-review", { version: 1, review_id: "review", request_digest: digest }],
  ["execution-repair", { version: 1, repair_id: "repair", run_id: "run", request_digest: digest }],
  ["validation", { version: 1, validation_id: "validation", run_id: "run", request_digest: digest }],
  ["validation-review", { version: 1, review_id: "review", request_digest: digest }],
] as const;
const status = (id = "delivery"): ProductSourceOperationStatus => ({ kind: "command", id, type: "product.source.operation.status.v1",
  idempotency_key: "operation:status", payload: { version: 1, operation_id: "operation", payload_digest: digest, request_digest: digest } });

describe("bounded ordinary source in-flight deliveries", () => {
  it.each(families)("coalesces exact %s status immediately without waiting for or caching original work", async (family, payload) => {
    const guard = createSourceCommandInflight(), originalScope = scope(), gate = deferred(), work = vi.fn((_command: ServerToNodeMessage) => gate.promise);
    const command = { kind: "command", id: "delivery", type: `product.source.${family}.status.v1`, idempotency_key: "status", payload } as ServerToNodeMessage;
    const original = guard.run(command, () => originalScope, work)!;
    let originalSettled = false; void original.then(() => { originalSettled = true; });
    for (let index = 0; index < 256; index++) await expect(guard.run(structuredClone(command), () => originalScope, work)).resolves.toBeUndefined();
    expect(originalSettled).toBe(false); expect(work).toHaveBeenCalledTimes(1);
    gate.resolve(); await original;
    await guard.run(command, () => originalScope, work); expect(work).toHaveBeenCalledTimes(2);
  });

  it.each(families)("requires the complete strict %s start schema before registering an eligible delivery", family => {
    const guard = createSourceCommandInflight(), originalScope = scope(), work = vi.fn(async () => {});
    const malformed = { kind: "command", id: "delivery", type: `product.source.${family}.v1`, idempotency_key: "start", payload: {} } as ServerToNodeMessage;
    expect(() => guard.run(malformed, () => originalScope, work)).toThrow(); expect(work).not.toHaveBeenCalled();
  });

  it("uses canonical full envelopes while dispatching an immutable parsed snapshot", async () => {
    const guard = createSourceCommandInflight(), originalScope = scope(), gate = deferred(), work = vi.fn((_command: ServerToNodeMessage) => gate.promise);
    const command = status(), saved = structuredClone(command), original = guard.run(command, () => originalScope, work)!;
    const reordered = Object.fromEntries(Object.entries(saved).reverse()) as ServerToNodeMessage;
    reordered.payload = Object.fromEntries(Object.entries(saved.payload).reverse()) as typeof reordered.payload;
    await guard.run(reordered, () => originalScope, work);
    expect(work).toHaveBeenCalledTimes(1); expect(work.mock.calls[0]![0]).not.toBe(command);
    expect(Object.isFrozen(work.mock.calls[0]![0])).toBe(true); expect(Object.isFrozen(work.mock.calls[0]![0].payload)).toBe(true);
    Object.assign(command.payload, { request_digest: changedDigest });
    expect(() => guard.run(command, () => originalScope, work)).toThrow("complete envelope");
    expect(work.mock.calls[0]![0].payload).toEqual(saved.payload);
    await guard.run(saved, () => originalScope, work); expect(work).toHaveBeenCalledTimes(1);
    gate.resolve(); await original;
  });

  it("rejects unknown nested fields on fresh admission even when the protocol parser strips them", async () => {
    const data = JSON.parse(readFileSync(new URL("../../../packages/domain/test-fixtures/product-source-operation.json", import.meta.url), "utf8"));
    const command = productSourceOperationCommandSchema.parse({ kind: "command", id: "fresh-start", type: "product.source.operation.v1", idempotency_key: "start",
      payload: { version: 1, operation_id: "operation", kind: "upload", request_digest: data.fresh.request_digest,
        intent: { version: 1, request: data.admission.request, next_task_id: "next-design", destination_start: data.admission.run_start } } });
    const changed = structuredClone(command);
    Object.assign(changed.payload.intent.destination_start.context_pack.payload!.task, { unsupported_authority: true });
    const parsed = productSourceOperationCommandSchema.parse(changed);
    expect(parsed.payload.intent.destination_start.context_pack.payload!.task).not.toHaveProperty("unsupported_authority");
    const guard = createSourceCommandInflight(), originalScope = scope(), work = vi.fn(async () => {});
    expect(() => guard.run(changed, () => originalScope, work)).toThrow("complete supported schema");
    expect(work).not.toHaveBeenCalled();
    await guard.run(command, () => originalScope, work); expect(work).toHaveBeenCalledTimes(1);
  });

  it.each(["payload", "type", "deadline", "idempotency", "unknown-envelope", "unknown-payload", "runtime", "session"] as const)
    ("rejects a pending ID's changed %s without replacing or joining its original entry", async variant => {
      const guard = createSourceCommandInflight(), originalScope = scope(), gate = deferred(), work = vi.fn(() => gate.promise);
      const command = status(), original = guard.run(command, () => originalScope, work)!;
      let changed: ServerToNodeMessage = structuredClone(command), nextScope = originalScope;
      if (variant === "payload") Object.assign(changed.payload, { request_digest: changedDigest });
      if (variant === "type") changed = { ...changed, type: "product.source.review.status.v1", payload: { version: 1, review_id: "review", request_digest: digest } } as ServerToNodeMessage;
      if (variant === "deadline") Object.assign(changed, { deadline_at: "2099-01-01T00:00:00Z" });
      if (variant === "idempotency") Object.assign(changed, { idempotency_key: "changed" });
      if (variant === "unknown-envelope") Object.assign(changed, { unsupported_authority: true });
      if (variant === "unknown-payload") Object.assign(changed.payload, { unsupported_authority: true });
      if (variant === "runtime") nextScope = { ...originalScope, runtime: {} };
      if (variant === "session") nextScope = { ...originalScope, session: {} };
      expect(() => guard.run(changed, () => nextScope, work)).toThrow();
      await guard.run(command, () => originalScope, work); expect(work).toHaveBeenCalledTimes(1);
      gate.resolve(); await original;
    });

  it("rejects a pending delivery when scope disappears while keeping fresh missing-scope admission on the original path", async () => {
    const guard = createSourceCommandInflight(), originalScope = scope(), gate = deferred(), work = vi.fn(() => gate.promise);
    const command = status(), original = guard.run(command, () => originalScope, work)!;
    expect(() => guard.run(command, () => undefined, work)).toThrow("lost its original");
    expect(guard.run(status("fresh-delivery"), () => undefined, work)).toBeUndefined(); expect(work).toHaveBeenCalledTimes(1);
    await guard.run(command, () => originalScope, work); expect(work).toHaveBeenCalledTimes(1);
    gate.resolve(); await original;
  });

  it.each(["resolve", "reject"] as const)("retains the entry until the original work really %ss and preserves its outcome", async outcome => {
    const guard = createSourceCommandInflight(), originalScope = scope(), gate = deferred(), work = vi.fn(() => gate.promise), failure = Error("original failure");
    const command = status(), original = guard.run(command, () => originalScope, work)!;
    const observed = original.then(() => undefined, error => error);
    await guard.run(command, () => originalScope, work); expect(work).toHaveBeenCalledTimes(1);
    if (outcome === "reject") gate.reject(failure); else gate.resolve();
    expect(await observed).toBe(outcome === "reject" ? failure : undefined);
    const retry = vi.fn(async () => {}); await guard.run(command, () => originalScope, retry); expect(retry).toHaveBeenCalledTimes(1);
  });

  it("preserves a synchronous dispatch failure and permits later dispatch after actual settlement", async () => {
    const guard = createSourceCommandInflight(), originalScope = scope(), failure = Error("synchronous dispatch failure");
    await expect(guard.run(status(), () => originalScope, () => { throw failure; })).rejects.toBe(failure);
    const work = vi.fn(async () => {}); await guard.run(status(), () => originalScope, work); expect(work).toHaveBeenCalledTimes(1);
  });

  it("bounds 1024 live entries without eviction, new authority, extra waiters or blocking Stop/receipts", async () => {
    const guard = createSourceCommandInflight(), originalScope = scope(), gate = deferred(), work = vi.fn(() => gate.promise);
    const originals = Array.from({ length: 1024 }, (_, index) => guard.run(status(`delivery-${index}`), () => originalScope, work)!);
    expect(() => guard.run(status("overflow"), () => originalScope, work)).toThrow("capacity");
    await guard.run(status("delivery-0"), () => originalScope, work); expect(work).toHaveBeenCalledTimes(1024);
    const unusedScope = vi.fn(() => originalScope);
    for (const type of ["product.source.operation.stop.v1", "product.source.operation.receipt.v1"] as const)
      expect(guard.run({ ...status("delivery-0"), type } as ServerToNodeMessage, unusedScope, work)).toBeUndefined();
    expect(unusedScope).not.toHaveBeenCalled(); expect(work).toHaveBeenCalledTimes(1024);
    gate.resolve(); await Promise.all(originals);
    await guard.run(status("overflow"), () => originalScope, work); expect(work).toHaveBeenCalledTimes(1025);
  });

  it("does not inspect scope or intercept controls outside the explicit ordinary start/status allowlist", () => {
    const guard = createSourceCommandInflight(), readScope = vi.fn(() => { throw Error("No scope read expected"); }), work = vi.fn(async () => {});
    const excluded = ["run.start", "run.stop", "product.release", "product.release.cancel", "node.session.ready", "unknown.type",
      "product.source.recovery.register.v1", "product.source.recovery-validation.v1", "product.source.recovery-validation.status.v1",
      "product.source.recovery-validation-review.v1", "product.source.recovery-validation-review.status.v1",
      "product.source.clean-validation.v1", "product.source.clean-validation.status.v1",
      "product.source.clean-validation-review.v1", "product.source.clean-validation-review.status.v1",
      ...families.flatMap(([family]) => [`product.source.${family}.stop.v1`, `product.source.${family}.receipt.v1`])];
    for (const type of excluded) expect(guard.run({ ...status(), type } as ServerToNodeMessage, readScope, work)).toBeUndefined();
    expect(readScope).not.toHaveBeenCalled(); expect(work).not.toHaveBeenCalled();
  });

  it("fences new eligible delivery admission on invalidation while original work remains pending", async () => {
    const guard = createSourceCommandInflight(), originalScope = scope(), gate = deferred(), work = vi.fn(() => gate.promise);
    const original = guard.run(status(), () => originalScope, work)!; let settled = false;
    void original.then(() => { settled = true; }); guard.invalidate();
    expect(() => guard.run(status(), () => originalScope, work)).toThrow("stopping");
    expect(() => guard.run(status("new"), () => originalScope, work)).toThrow("stopping");
    expect(settled).toBe(false); expect(work).toHaveBeenCalledTimes(1);
    gate.resolve(); await original; expect(settled).toBe(true);
  });
});
