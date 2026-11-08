// Real seven-family controllers; native execution/ownership and predecessor accessors are controlled.
// These regression fixtures establish no native, provider or product qualification.
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalProductSourceTransferValueV1 as canonical, importedDesignContinuationRequestDigestV1,
  importedDesignReviewRequestDigestV1, importedExecutionRequestDigestV1, importedExecutionReviewRequestDigestV1,
  importedExecutionRepairRequestDigestV1, importedValidationRequestDigestV1, importedValidationReviewRequestDigestV1 } from "@artoo/domain";
import type { NodeToServerMessage, ServerToNodeMessage } from "@artoo/protocol";
import { createSourceCommandInflight } from "./source-command-inflight.js";
import { importedDesignRequestFixture } from "./test-fixtures/imported-design-request.js";
import { importedDesignReviewRequestFixture } from "./test-fixtures/imported-design-review-request.js";
import { importedExecutionRequestFixture } from "./test-fixtures/imported-execution-request.js";
import { importedExecutionReviewRequestFixture, controlledImplementationRepairResult } from "./test-fixtures/imported-execution-review-request.js";
import { importedValidationRequestFixture, controlledValidationResult, controlledValidationSource,
  validationReviewFixture, controlledValidationReviewResult } from "./test-fixtures/imported-validation-request.js";

const native = vi.hoisted(() => {
  const mocks = () => ({ reserve: vi.fn(), run: vi.fn(), persist: vi.fn(), read: vi.fn(), fail: vi.fn() });
  return { design: mocks(), "design-review": mocks(), execution: mocks(), "execution-review": mocks(),
    "execution-repair": mocks(), validation: mocks(), "validation-review": mocks() };
});
vi.mock("./product-source-runtime.js", () => ({
  reserveImportedDesignContinuation: native.design.reserve, runImportedDesignContinuation: native.design.run,
  persistImportedDesignContinuationResult: native.design.persist, failUnstartedImportedDesignContinuation: native.design.fail,
  readCompletedVerifiedImportedDesign: native.design.read,
  reserveImportedDesignReview: native["design-review"].reserve, runImportedDesignReview: native["design-review"].run,
  persistImportedDesignReviewResult: native["design-review"].persist, readCompletedAcceptedImportedDesignReview: native["design-review"].read,
  reserveImportedExecution: native.execution.reserve, runImportedExecution: native.execution.run,
  persistImportedExecutionResult: native.execution.persist, failUnstartedImportedExecution: native.execution.fail,
  readCompletedVerifiedImportedExecution: native.execution.read,
  reserveImportedExecutionReview: native["execution-review"].reserve, runImportedExecutionReview: native["execution-review"].run,
  persistImportedExecutionReviewResult: native["execution-review"].persist, readCompletedImportedExecutionReview: native["execution-review"].read,
  reserveImportedExecutionRepair: native["execution-repair"].reserve, runImportedExecutionRepair: native["execution-repair"].run,
  persistImportedExecutionRepairResult: native["execution-repair"].persist, readCompletedVerifiedImportedExecutionRepair: native["execution-repair"].read,
  failUnstartedImportedExecutionRepair: native["execution-repair"].fail,
  reserveImportedValidation: native.validation.reserve, runImportedValidation: native.validation.run,
  persistImportedValidationResult: native.validation.persist, readCompletedImportedValidation: native.validation.read,
  failUnstartedImportedValidation: native.validation.fail,
  reserveImportedValidationReview: native["validation-review"].reserve, runImportedValidationReview: native["validation-review"].run,
  persistImportedValidationReviewResult: native["validation-review"].persist, readCompletedImportedValidationReview: native["validation-review"].read,
  prepareImportedValidationRelease: vi.fn(),
}));
import { createImportedDesignContinuationClient } from "./imported-design-continuation.js";
import { createImportedDesignReviewClient } from "./imported-design-review.js";
import { createImportedExecutionClient } from "./imported-execution.js";
import { createImportedExecutionReviewClient } from "./imported-execution-review.js";
import { createImportedValidationClient } from "./imported-validation.js";

const families = ["design", "design-review", "execution", "execution-review", "execution-repair", "validation", "validation-review"] as const;
type Family = typeof families[number];
type Start = Extract<ServerToNodeMessage, { type: `product.source.${Family}.v1` }>;
type Status = Extract<ServerToNodeMessage, { type: `product.source.${Family}.status.v1` }>;
type Receipt = Extract<ServerToNodeMessage, { type: `product.source.${Family}.receipt.v1` }>;
const sha = (value: string | Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const changedDigest = sha("changed");
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
beforeEach(() => { vi.resetAllMocks(); for (const mock of Object.values(native)) mock.reserve.mockReturnValue({}); });
afterEach(() => { vi.useRealTimers(); });

async function fixture(family: Family) {
  const sent: NodeToServerMessage[] = [], current = vi.fn(() => true);
  const transport = { acknowledgesRunEvents: true, subscribe: () => () => {},
    send: vi.fn(async (message: NodeToServerMessage) => { sent.push(message); }) };
  const common = { runtime: {} as never, transport, isCurrent: current, resolveAdapter: () => ({ runtimeId: "fixture" }) as never };
  let command: Start, control: Status["payload"], result: unknown;
  let client: { handle(input: ServerToNodeMessage): Promise<boolean>; invalidate(): void };
  const envelope = { kind: "command" as const, id: "target-start", idempotency_key: "target:start" };
  switch (family) {
    case "design": {
      const { request } = importedDesignRequestFixture();
      control = { version: 1, continuation_id: request.continuation_id, request_digest: importedDesignContinuationRequestDigestV1(request, sha), run_id: request.run_start.run_id };
      result = { ...control, outcome: "finished", closed: true };
      command = { ...envelope, type: "product.source.design.v1", payload: request };
      client = createImportedDesignContinuationClient({ ...common, nodeId: request.review_request.operation.intent.request.byte_request.destination.node_id,
        reviews: { readCompletedAccepted: vi.fn(() => request.review_result) } as never }); break;
    }
    case "design-review": {
      const f = importedDesignReviewRequestFixture(), request = f.request;
      control = { version: 1, review_id: request.review_id, request_digest: importedDesignReviewRequestDigestV1(request, sha) };
      result = f.result; command = { ...envelope, type: "product.source.design-review.v1", payload: request };
      client = createImportedDesignReviewClient({ ...common, nodeId: request.continuation_request.review_request.operation.intent.request.byte_request.destination.node_id,
        designs: { readCompletedVerifiedDesign: vi.fn(() => request.continuation_result) } as never }); break;
    }
    case "execution": {
      const { request } = importedExecutionRequestFixture();
      control = { version: 1, execution_id: request.execution_id, request_digest: importedExecutionRequestDigestV1(request, sha), run_id: request.run_start.run_id };
      result = { ...control, outcome: "finished", closed: true };
      command = { ...envelope, type: "product.source.execution.v1", payload: request };
      client = createImportedExecutionClient({ ...common, nodeId: request.review_request.continuation_request.review_request.operation.intent.request.byte_request.destination.node_id,
        reviews: { readCompletedAcceptedDesignReview: vi.fn(() => request.review_result) } as never }); break;
    }
    case "execution-review":
    case "execution-repair": {
      const f = importedExecutionReviewRequestFixture(), reviewControl = { version: 1 as const, review_id: f.request.review_id,
        request_digest: importedExecutionReviewRequestDigestV1(f.request, sha) };
      client = createImportedExecutionReviewClient({ ...common, nodeId: f.request.execution_request.review_request.continuation_request.review_request.operation.intent.request.byte_request.destination.node_id,
        executions: { readCompletedVerifiedExecution: vi.fn(() => f.original), assertCompletedExecutionReceipt: vi.fn() } as never });
      native["execution-review"].run.mockResolvedValue(f.result); native["execution-review"].read.mockReturnValue(f.request);
      if (family === "execution-review") {
        control = reviewControl; result = f.result; command = { ...envelope, type: "product.source.execution-review.v1", payload: f.request };
      } else {
        await client.handle({ ...envelope, id: "seed-review", type: "product.source.execution-review.v1", payload: f.request });
        await client.handle({ ...envelope, id: "seed-review", type: "product.source.execution-review.receipt.v1", payload: reviewControl, status: "accepted", result_digest: sha(canonical(f.result)) });
        control = { version: 1, repair_id: f.repair.repair_id, request_digest: importedExecutionRepairRequestDigestV1(f.repair, sha), run_id: f.repair.run_start.run_id };
        result = controlledImplementationRepairResult(f.repair); command = { ...envelope, type: "product.source.execution-repair.v1", payload: f.repair };
      }
      break;
    }
    case "validation":
    case "validation-review": {
      const f = importedValidationRequestFixture(), authorResult = controlledValidationResult(f.request), source = controlledValidationSource(f.request, authorResult);
      const authorControl = { version: 1 as const, validation_id: f.request.validation_id, request_digest: importedValidationRequestDigestV1(f.request, sha), run_id: f.request.run_start.run_id };
      client = createImportedValidationClient({ ...common, nodeId: f.request.origin.execution_request.review_request.continuation_request.review_request.operation.intent.request.byte_request.destination.node_id,
        implementations: { readCompletedAcceptedReview: vi.fn(() => f.accepted), assertCompletedAcceptedReviewReceipt: vi.fn() } as never });
      native.validation.run.mockResolvedValue(authorResult); native.validation.read.mockReturnValue(source);
      if (family === "validation") {
        control = authorControl; result = authorResult; command = { ...envelope, type: "product.source.validation.v1", payload: f.request };
      } else {
        await client.handle({ ...envelope, id: "seed-author", type: "product.source.validation.v1", payload: f.request });
        await client.handle({ ...envelope, id: "seed-author", type: "product.source.validation.receipt.v1", payload: authorControl, status: "accepted", result_digest: sha(canonical(authorResult)) });
        const request = validationReviewFixture(f.request, source);
        control = { version: 1, review_id: request.review_id, request_digest: importedValidationReviewRequestDigestV1(request, sha) };
        result = controlledValidationReviewResult(request); command = { ...envelope, type: "product.source.validation-review.v1", payload: request };
        native["validation-review"].read.mockReturnValue(request);
      }
      break;
    }
  }
  native[family].run.mockResolvedValue(result);
  const originalScope = { runtime: {}, session: {} }, readScope = vi.fn(() => originalScope), guard = createSourceCommandInflight();
  const work = vi.fn(async (message: ServerToNodeMessage) => { if (!await client.handle(message)) throw Error("No original controller handled this fixture"); });
  const dispatch = (message: ServerToNodeMessage) => guard.run(message, readScope, work) ?? work(message);
  const status = (id = "target-status") => ({ ...envelope, id, type: `product.source.${family}.status.v1`, payload: control }) as Status;
  const receipt = (id = command.id): Receipt => {
    const frame = sent.findLast(message => message.kind === `product.source.${family}.result.v1` && "command_id" in message && message.command_id === id);
    if (!frame || !("payload" in frame)) throw Error("Actual original controller result required");
    return { ...envelope, id, idempotency_key: `receipt:${id}`, type: `product.source.${family}.receipt.v1`, payload: control,
      status: "accepted", result_digest: sha(canonical(frame.payload)) } as Receipt;
  };
  const stop = () => ({ ...status("target-stop"), type: `product.source.${family}.stop.v1` }) as ServerToNodeMessage;
  const resultFrames = () => sent.filter(message => message.kind === `product.source.${family}.result.v1`);
  return { family, command, control, result, client, current, transport, sent, work, dispatch, status, receipt, stop, resultFrames,
    guard, readScope, originalScope, native: native[family] };
}

describe.each(families)("completed %s deliveries retain actual controller receipt validation", family => {
  it.each(["start", "status"] as const)("yields the completed %s backlog and still replays after its exact accepted receipt", async kind => {
    vi.useFakeTimers(); const f = await fixture(family); await f.dispatch(f.command);
    const command = kind === "start" ? f.command : f.status(); if (kind === "status") await f.dispatch(command);
    const frames = f.resultFrames().length, checks = f.current.mock.calls.length, replay = f.dispatch(command);
    for (let i = 0; i < 128; i++) await f.dispatch(structuredClone(command));
    expect(f.current).toHaveBeenCalledTimes(checks); expect(vi.getTimerCount()).toBe(1);
    const receipt = f.receipt(command.id); await f.dispatch(receipt);
    const acceptedChecks = f.current.mock.calls.length;
    for (let i = 0; i < 16; i++) await f.dispatch(structuredClone(receipt));
    expect(f.current).toHaveBeenCalledTimes(acceptedChecks);
    await vi.advanceTimersByTimeAsync(10); await replay;
    expect(f.current.mock.calls.length).toBeGreaterThan(acceptedChecks); expect(f.resultFrames()).toHaveLength(frames + 1);
    for (let round = 0; round < 2; round++) {
      const checks = f.current.mock.calls.length, next = f.dispatch(structuredClone(command));
      for (let i = 0; i < 128; i++) await f.dispatch(structuredClone(command));
      await f.dispatch(structuredClone(receipt));
      expect(f.current).toHaveBeenCalledTimes(checks); expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(10); await next;
      expect(f.resultFrames()).toHaveLength(frames + round + 2);
    }
    expect(f.native.run).toHaveBeenCalledTimes(1); expect(f.native.reserve).toHaveBeenCalledTimes(1); expect(f.native.persist).toHaveBeenCalledTimes(1);
  });

  it("replays the original result after 10ms when its receipt is absent", async () => {
    vi.useFakeTimers(); const f = await fixture(family); await f.dispatch(f.command); const checks = f.current.mock.calls.length;
    const replay = f.dispatch(f.command); await vi.advanceTimersByTimeAsync(9); expect(f.current).toHaveBeenCalledTimes(checks);
    await vi.advanceTimersByTimeAsync(1); await replay;
    expect(f.resultFrames()).toHaveLength(2); expect(f.native.run).toHaveBeenCalledTimes(1); expect(f.native.persist).toHaveBeenCalledTimes(1);
  });

  it("keeps same-command result replay available after accepted delivery when the server still needs its marker", async () => {
    // This models the retransmission needed after server marker rollback; no
    // server transaction or automatic server compensation is exercised here.
    vi.useFakeTimers(); const f = await fixture(family); await f.dispatch(f.command);
    const original = structuredClone(f.resultFrames()[0]); await f.dispatch(f.receipt());
    const replay = f.dispatch(structuredClone(f.command));
    expect(f.resultFrames()).toHaveLength(1); expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(10); await replay;
    expect(f.resultFrames()).toEqual([original, original]);
    expect(f.native.run).toHaveBeenCalledTimes(1); expect(f.native.persist).toHaveBeenCalledTimes(1);
  });

  it.each(["result", "identity", "request", "unknown-field"] as const)("never caches an invalid %s receipt", async change => {
    const f = await fixture(family); await f.dispatch(f.command); const receipt = f.receipt();
    if (change === "result") receipt.result_digest = changedDigest;
    if (change === "request") receipt.payload.request_digest = changedDigest;
    if (change === "identity") {
      const field = Object.keys(receipt.payload).find(key => key.endsWith("_id") && key !== "run_id")!;
      Object.assign(receipt.payload, { [field]: "different-owner" });
    }
    if (change === "unknown-field") Object.assign(receipt, { unsupported_authority: true });
    await expect(f.dispatch(receipt)).rejects.toThrow();
    const checks = f.current.mock.calls.length; await f.dispatch(f.command);
    expect(f.current.mock.calls.length).toBeGreaterThan(checks); expect(f.native.run).toHaveBeenCalledTimes(1);
  });

  it.each(["envelope", "deadline", "unknown-payload-field"] as const)("rejects changed %s on a receipt-confirmed start", async change => {
    const f = await fixture(family); await f.dispatch(f.command); await f.dispatch(f.receipt());
    const command = structuredClone(f.command), checks = f.current.mock.calls.length;
    if (change === "envelope") command.idempotency_key = "different";
    if (change === "deadline") command.deadline_at = "2099-01-01T00:00:00Z";
    if (change === "unknown-payload-field") Object.assign(command.payload, { unsupported_authority: true });
    expect(() => f.dispatch(command)).toThrow(); expect(f.current).toHaveBeenCalledTimes(checks);
  });

  it.each(["runtime", "session", "missing"] as const)("rechecks %s after actual receipt validation before remembering it", async change => {
    const f = await fixture(family); await f.dispatch(f.command);
    f.work.mockImplementation(async message => {
      if (!await f.client.handle(message)) throw Error("No original controller");
      if (message.type.endsWith(".receipt.v1")) f.readScope.mockReturnValue(change === "missing" ? undefined as never : { ...f.originalScope, [change]: {} });
    });
    await expect(f.dispatch(f.receipt())).rejects.toThrow("during validation");
    f.readScope.mockReturnValue(f.originalScope); const checks = f.current.mock.calls.length;
    await f.dispatch(f.command); expect(f.current.mock.calls.length).toBeGreaterThan(checks);
  });

  it.each(["stop", "rejected-receipt"] as const)("keeps %s immediate and prevents a pending receipt restoring its old epoch", async control => {
    vi.useFakeTimers(); const f = await fixture(family); await f.dispatch(f.command); const gate = deferred(), receipt = f.receipt();
    let receiptEntered = false;
    const pending: Promise<void>[] = [];
    const observe = (promise: Promise<void>) => {
      let state: "pending" | "fulfilled" | "rejected" = "pending";
      pending.push(promise);
      void promise.then(() => { state = "fulfilled"; }, () => { state = "rejected"; });
      return () => state;
    };
    f.work.mockImplementation(async message => {
      if (!await f.client.handle(message)) throw Error("No original controller");
      if (message.type === receipt.type && "status" in message && message.status === "accepted") { receiptEntered = true; await gate.promise; }
    });
    try {
      const replay = f.dispatch(f.command); observe(replay);
      const pendingReceipt = f.dispatch(receipt), receiptState = observe(pendingReceipt);
      // Flush only current work. Do not advance the existing 10ms replay timer
      // or await a duplicate that old code may route into the closed gate.
      await vi.advanceTimersByTimeAsync(0);
      expect(receiptEntered).toBe(true); expect(receiptState()).toBe("pending");
      const checks = f.current.mock.calls.length;
      for (let i = 0; i < 32; i++) {
        const duplicateState = observe(f.dispatch(structuredClone(receipt)));
        await vi.advanceTimersByTimeAsync(0);
        expect(duplicateState(), `duplicate receipt ${i} must complete while original validation is held`).toBe("fulfilled");
      }
      expect(f.current).toHaveBeenCalledTimes(checks);
      const controlState = observe(f.dispatch(control === "stop" ? f.stop() : { ...receipt, id: "rejection", status: "rejected" }));
      await vi.advanceTimersByTimeAsync(0); expect(controlState()).toBe("fulfilled");
      gate.resolve(); await pendingReceipt; const afterControl = f.current.mock.calls.length;
      await vi.advanceTimersByTimeAsync(10); await replay;
      expect(f.current.mock.calls.length).toBeGreaterThan(afterControl); expect(f.native.run).toHaveBeenCalledTimes(1);
    } finally {
      gate.resolve();
      await vi.advanceTimersByTimeAsync(10);
      await Promise.allSettled(pending);
    }
  });

  it.each(["success", "send-failure"] as const)("preserves original dispatch %s and later replay after an early receipt", async outcome => {
    const f = await fixture(family), gate = deferred(), failure = Error("Controlled original result send failure");
    let accepted: Receipt | undefined;
    f.transport.send.mockImplementation(async message => {
      f.sent.push(message);
      if (message.kind === `product.source.${family}.result.v1` && !accepted) {
        accepted = f.receipt(); await f.dispatch(accepted); await gate.promise;
        if (outcome === "send-failure") throw failure;
      }
    });
    const running = f.dispatch(f.command).then(() => undefined, error => error);
    try {
      await vi.waitFor(() => expect(accepted).toBeDefined()); gate.resolve();
      expect(await running).toBe(outcome === "success" ? undefined : failure);
      const checks = f.current.mock.calls.length; await f.dispatch(f.command);
      expect(f.current.mock.calls.length).toBeGreaterThan(checks);
      expect(f.native.run).toHaveBeenCalledTimes(1); expect(f.native.persist).toHaveBeenCalledTimes(1);
    } finally { gate.resolve(); await running; }
  });
});

it.each(["design-review", "execution-review", "validation-review"] as const)("does not treat a different review family as the exact %s receipt", async family => {
  const f = await fixture(family); await f.dispatch(f.command); const receipt = f.receipt();
  const otherFamily = family === "design-review" ? "execution-review" : "design-review";
  const other = { ...receipt, type: `product.source.${otherFamily}.receipt.v1` } as Receipt;
  const calls = f.work.mock.calls.length;
  expect(f.guard.run(other, f.readScope, f.work)).toBeUndefined();
  expect(f.work).toHaveBeenCalledTimes(calls);
  const checks = f.current.mock.calls.length; await f.dispatch(f.command);
  expect(f.current.mock.calls.length).toBeGreaterThan(checks);
});

it.each(["design", "execution", "execution-repair", "validation"] as const)("binds %s receipts to their exact author run", async family => {
  const f = await fixture(family); await f.dispatch(f.command); const receipt = f.receipt();
  Object.assign(receipt.payload, { run_id: "different-run" }); await expect(f.dispatch(receipt)).rejects.toThrow();
  const checks = f.current.mock.calls.length; await f.dispatch(f.command);
  expect(f.current.mock.calls.length).toBeGreaterThan(checks); expect(f.native.run).toHaveBeenCalledTimes(1);
});

describe.each(["execution-review", "execution-repair", "validation", "validation-review"] as const)("%s retains post-send/native receipt checks", family => {
  it("does not cache a receipt when its original native result read rejects", async () => {
    const f = await fixture(family); await f.dispatch(f.command); const calls = f.native.read.mock.calls.length;
    f.native.read.mockImplementationOnce(() => { throw Error("Controlled native receipt rejection"); });
    await expect(f.dispatch(f.receipt())).rejects.toThrow("native receipt rejection");
    expect(f.native.read).toHaveBeenCalledTimes(calls + 1);
    const checks = f.current.mock.calls.length; await f.dispatch(f.command);
    expect(f.current.mock.calls.length).toBeGreaterThan(checks);
  });

  it("does not treat an early accepted receipt as successful completion of the later native post-send read", async () => {
    const f = await fixture(family); let accepted = false;
    f.transport.send.mockImplementation(async message => {
      f.sent.push(message);
      if (message.kind === `product.source.${family}.result.v1` && !accepted) {
        accepted = true; await f.dispatch(f.receipt());
        f.native.read.mockImplementationOnce(() => { throw Error("Controlled native post-send failure"); });
      }
    });
    await expect(f.dispatch(f.command)).rejects.toThrow("native post-send failure");
    const checks = f.current.mock.calls.length; await f.dispatch(f.command);
    expect(f.current.mock.calls.length).toBeGreaterThan(checks); expect(f.native.run).toHaveBeenCalledTimes(1);
  });
});
