// Real NodeClient dispatch and H2/H3 controllers; native ownership, upload and transport are controlled.
// These tests do not establish native-process, live-provider or product-publication acceptance.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProductSourceOperationV1Schema, canonicalProductSourceTransferValueV1 as canonical,
  productSourceOperationDigestV1, importedDesignContinuationRequestDigestV1, type ProductSourceTransferReceiptV1 } from "@artoo/domain";
import type { ImportedDesignContinuationCommand, ImportedProductReviewCommand, NodeSideTransport, NodeToServerMessage, ProductSourceOperationCommand, RuntimeAdapter, ServerToNodeMessage } from "@artoo/protocol";
import { createNodeClient } from "./node-client.js";
import * as recoveryClient from "./source-recovery-client.js";
import * as recovery from "./windows-source-recovery.js";
import * as source from "./product-source-runtime.js";
import * as operations from "./product-source-operations.js";
import * as designs from "./imported-design-continuation.js";
import * as reviews from "./imported-product-review.js";
import * as publication from "./product-release.js";
import { importedDesignRequestFixture } from "./test-fixtures/imported-design-request.js";
import type { SourceCommandDiagnostic } from "./source-command-diagnostics.js";

const data = JSON.parse(readFileSync(new URL("../../../packages/domain/test-fixtures/product-source-operation.json", import.meta.url), "utf8"));
const sha = (value: string | Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const cleanups: (() => Promise<void>)[] = [];
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function waitFor(check: () => boolean) { await vi.waitFor(() => expect(check()).toBe(true), { timeout: 5000, interval: 5 }); }
beforeEach(() => { Object.defineProperty(process, "platform", { ...platform, value: "win32" }); });
afterEach(async () => {
  try { for (const cleanup of cleanups.splice(0)) await cleanup(); }
  finally { vi.restoreAllMocks(); Object.defineProperty(process, "platform", platform); }
});

function fixture(options: { holdAudit?: boolean; holdResult?: boolean; failResultOnce?: boolean; replay?: boolean; clean?: boolean;
  repeatDuringAck?: number; design?: boolean; review?: boolean } = {}) {
  let session: object | undefined = {};
  const originalSession = session, runtime = {} as recovery.PreparedWindowsSourceRecoveryRuntime, sourceRuntime = {} as source.PreparedProductSourceRuntime;
  let active = true, receive!: (message: ServerToNodeMessage) => void;
  const audit = deferred(), uploadEntered = deferred(), uploadDone = deferred(), resultEntered = deferred(), resultSend = deferred();
  const designEntered = deferred(), designDone = deferred();
  if (!options.holdAudit) audit.resolve(); if (!options.holdResult) resultSend.resolve();
  const sent: NodeToServerMessage[] = [], sendAttempts: NodeToServerMessage[] = [];
  const diagnostics: SourceCommandDiagnostic[] = [];
  let failedResult = false, injected = false, admissionsAtUpload = 0, designSignal: AbortSignal | undefined;
  const transport: NodeSideTransport = { acknowledgesRunEvents: true, async send(message) {
    sendAttempts.push(message);
    // The production WebSocket adapter resolves send immediately. Inject a synchronous
    // replay burst at that boundary, before the original ACK continuation can reach upload.
    if (message.kind === "product.source.operation.ack.v1" && !injected && options.repeatDuringAck) {
      injected = true; for (let index = 0; index < options.repeatDuringAck; index++) receive(structuredClone(command));
    }
    if (message.kind === "product.source.operation.result.v1" || message.kind === "product.source.design.result.v1") {
      resultEntered.resolve(); await resultSend.promise;
      if (options.failResultOnce && !failedResult) { failedResult = true; throw Error("Controlled original result send failure"); }
    }
    sent.push(message);
  }, subscribe(handler) { receive = handler; return () => {}; } };
  const handle = vi.fn(async (message: ServerToNodeMessage) => {
    if (message.type === "product.source.operation.v1") await audit.promise;
    return false;
  });
  const readRuntime = vi.fn(() => { if (session !== originalSession) throw Error("Controlled original session invalidated"); return runtime; });
  const controller = { handle, readRuntime, isActive: () => active, allowsOrdinary: () => active,
    invalidate() { active = false; }, settled: async () => {} };
  const createRecovery = vi.spyOn(recoveryClient, "createProductSourceRecoveryClient")
    .mockReturnValue(controller as unknown as ReturnType<typeof recoveryClient.createProductSourceRecoveryClient>);
  const operation = vi.spyOn(recovery, "withWindowsSourceRecoveryOperation").mockImplementation((_runtime, _descriptor, work) => work());
  vi.spyOn(recovery, "readWindowsRecoverySourceRuntime").mockReturnValue(sourceRuntime);
  vi.spyOn(source, "assertProductSourceRuntimeConfiguration").mockImplementation(() => {});
  const reserve = vi.spyOn(source, "reserveProductSourceOperation").mockReturnValue({} as never);
  const persist = vi.spyOn(source, "persistProductSourceOperationResult").mockImplementation(() => {});
  const reserveDesign = vi.spyOn(source, "reserveImportedDesignContinuation").mockReturnValue({} as never);
  const persistDesign = vi.spyOn(source, "persistImportedDesignContinuationResult").mockImplementation(() => {});
  const designRequest = options.design || options.review ? importedDesignRequestFixture().request : undefined;
  const reviewCommand: ImportedProductReviewCommand | undefined = options.review && designRequest ? { kind: "command", id: "review-start",
    type: "product.source.review.v1", idempotency_key: "review:start", payload: designRequest.review_request } : undefined;
  const reserveReview = vi.spyOn(source, "reserveImportedProductReview").mockReturnValue({} as never);
  const persistReview = vi.spyOn(source, "persistImportedProductReviewResult").mockImplementation(() => {});
  const runReview = vi.spyOn(source, "runImportedProductReview").mockImplementation(async () => {
    if (!designRequest) throw Error("Missing controlled review fixture"); return designRequest.review_result;
  });
  vi.spyOn(source, "readCompletedImportedProductReview").mockImplementation(() => {
    if (!designRequest) throw Error("Missing controlled review fixture"); return designRequest.review_request;
  });
  const designControl = designRequest ? { version: 1 as const, continuation_id: designRequest.continuation_id,
    request_digest: importedDesignContinuationRequestDigestV1(designRequest, sha), run_id: designRequest.run_start.run_id } : undefined;
  const designCommand: ImportedDesignContinuationCommand | undefined = designRequest ? { kind: "command", id: "design-start",
    type: "product.source.design.v1", idempotency_key: "design:start", payload: designRequest } : undefined;
  const designResult = designControl ? { ...designControl, outcome: "finished" as const, closed: true as const } : undefined;
  const runDesign = vi.spyOn(source, "runImportedDesignContinuation").mockImplementation(async (_runtime, _permit, _review, _request, _adapter, signal) => {
    designSignal = signal; designEntered.resolve();
    await new Promise<void>((resolve, reject) => {
      const aborted = () => reject(Error("Controlled design abort")); signal.addEventListener("abort", aborted, { once: true });
      void designDone.promise.then(() => { signal.removeEventListener("abort", aborted); resolve(); });
    });
    if (!designResult) throw Error("Missing controlled design fixture"); return designResult;
  });
  vi.spyOn(source, "readCompletedVerifiedImportedDesign").mockReturnValue({} as never);
  const publisher = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}), requestStop: vi.fn(), getHealthReports: () => [],
    assertWorkspaceBoundary: vi.fn() };
  vi.spyOn(publication, "createProductReleaseExecutor").mockReturnValue(publisher as unknown as ReturnType<typeof publication.createProductReleaseExecutor>);
  const actualOperations = operations.createProductSourceOperationClient, actualDesigns = designs.createImportedDesignContinuationClient;
  const actualReviews = reviews.createImportedProductReviewClient;
  let sourceController!: ReturnType<typeof actualOperations>, designController!: ReturnType<typeof actualDesigns>, reviewController!: ReturnType<typeof actualReviews>;
  vi.spyOn(operations, "createProductSourceOperationClient").mockImplementation(args => {
    sourceController = actualOperations(args); vi.spyOn(sourceController, "handle");
    if (options.review && designRequest) {
      const verified = designRequest.review_request.result;
      if (verified.outcome !== "verified") throw Error("Review fixture requires the original verified source result");
      vi.spyOn(sourceController, "readCompletedVerified").mockReturnValue(verified);
    }
    return sourceController;
  });
  vi.spyOn(designs, "createImportedDesignContinuationClient").mockImplementation(args => {
    designController = actualDesigns(args); vi.spyOn(designController, "handle"); return designController;
  });
  vi.spyOn(reviews, "createImportedProductReviewClient").mockImplementation(args => {
    const original = reviewController = actualReviews(args); vi.spyOn(original, "handle");
    // H3's preceding accepted-review authority is a controlled boundary; the H3 controller remains real.
    if (designRequest && !options.review) vi.spyOn(original, "readCompletedAccepted").mockReturnValue(designRequest.review_result);
    return original;
  });
  const payload = ProductSourceOperationV1Schema.parse({ version: 1, operation_id: "source-operation", kind: "upload",
    request_digest: data.fresh.request_digest, intent: { version: 1, request: data.admission.request, next_task_id: "next-design", destination_start: data.admission.run_start } });
  const command: ProductSourceOperationCommand = { kind: "command", id: "delivery", type: "product.source.operation.v1", idempotency_key: "operation:start", payload };
  const receipt: ProductSourceTransferReceiptV1 = { version: 1, transfer_id: payload.intent.request.byte_request.transfer_id,
    request_digest: payload.request_digest, capsule_digest: payload.intent.request.byte_request.source.capsule_digest, status: "available", execution_authorized: false };
  const upload = vi.fn(async (_runtime: unknown, _request: unknown, signal?: AbortSignal) => {
    admissionsAtUpload = readRuntime.mock.calls.length; uploadEntered.resolve();
    await new Promise<void>((resolve, reject) => {
      const aborted = () => reject(Error("Controlled upload abort"));
      signal?.addEventListener("abort", aborted, { once: true });
      void uploadDone.promise.then(() => { signal?.removeEventListener("abort", aborted); resolve(); });
    });
    return receipt;
  });
  const adapter: RuntimeAdapter = { runtimeId: "fixture", start: vi.fn(async () => { throw Error("Unexpected model execution"); }),
    async *streamEvents() {}, async stop() {}, async collectArtifacts() { return []; } };
  const client = createNodeClient({ nodeId: designRequest?.review_request.operation.intent.request.byte_request.destination.node_id
    ?? payload.intent.request.byte_request.source.node_id, adapter, transport, sourceCommandDiagnostic: value => diagnostics.push(value),
    productSourceRecovery: { configuration: {} as never, features: [], isCurrent: () => active && session === originalSession, activate: () => sourceRuntime,
      ...(options.clean ? { cleanLifecycle: {} as never } : {}), ...(options.replay === false ? {} : { replaySession: () => session }) },
    productSourceOperations: { client: { upload, download: vi.fn() }, isCurrent: () => active && session === originalSession, importedReview: true, importedDesign: true } });
  client.start(); createRecovery.mock.calls[0]![0].activate(runtime); operation.mockClear();
  cleanups.push(async () => { audit.resolve(); uploadDone.resolve(); designDone.resolve(); resultSend.resolve(); await client.stop(true); });
  const control = { version: 1 as const, operation_id: payload.operation_id, payload_digest: productSourceOperationDigestV1(payload, sha), request_digest: payload.request_digest };
  return { receive, command, control, handle, readRuntime, operation, upload, reserve, persist, reserveDesign, persistDesign,
    sourceController, designController, sent, sendAttempts, diagnostics, audit, uploadEntered, uploadDone, resultEntered, resultSend,
    designCommand, designControl, designResult, runDesign, designEntered, designDone, reviewCommand, reviewController, reserveReview, persistReview, runReview,
    changeSession(next: object | undefined) { session = next; },
    get admissionsAtUpload() { return admissionsAtUpload; }, get designSignal() { return designSignal; } };
}

describe("ordinary source delivery coalescing before NodeClient audit", () => {
  it("records a rejected runtime boundary previously swallowed by tracking, without sending ACK or leaking the error", async () => {
    const f = fixture(); f.readRuntime.mockImplementation(() => { throw Error("private provider credential and local path"); });
    f.receive(f.command); await tick();
    expect(f.diagnostics.at(-1)).toMatchObject({ command_type: f.command.type, command_id_digest: sha(f.command.id),
      phase: "runtime", status: "failed", error_code: "source_command_stage_failed" });
    expect(JSON.stringify(f.diagnostics)).not.toContain("private provider");
    expect(f.sent).toHaveLength(0); expect(f.reserve).not.toHaveBeenCalled(); expect(f.upload).not.toHaveBeenCalled();
    const count = f.diagnostics.length;
    f.receive(f.command); await tick(); expect(f.diagnostics).toHaveLength(count);
    // Diagnostics do not suppress a retry or alter the real rejection path.
    expect(f.readRuntime).toHaveBeenCalledTimes(2);
  });
  it("does not repeat expensive admission between the original accepted ACK and its upload continuation", async () => {
    const f = fixture({ repeatDuringAck: 256 }); f.receive(f.command); await f.uploadEntered.promise;
    expect(f.admissionsAtUpload).toBe(1); expect(f.handle).toHaveBeenCalledTimes(1); expect(f.upload).toHaveBeenCalledTimes(1);
    f.uploadDone.resolve(); await waitFor(() => f.sent.some(message => message.kind === "product.source.operation.result.v1"));
    expect(f.persist).toHaveBeenCalledTimes(1);
    expect(f.sent.filter(message => message.kind === "product.source.operation.result.v1")).toHaveLength(1);
  });

  it("coalesces a synchronous duplicate burst before admission and still advances the original upload", async () => {
    const f = fixture({ holdAudit: true });
    for (let index = 0; index < 256; index++) f.receive(structuredClone(f.command));
    expect(f.handle).toHaveBeenCalledTimes(1); expect(f.readRuntime).not.toHaveBeenCalled();
    f.audit.resolve(); await f.uploadEntered.promise;
    expect(f.readRuntime).toHaveBeenCalledTimes(1); expect(f.operation).toHaveBeenCalledTimes(1);
    expect(f.reserve).toHaveBeenCalledTimes(1); expect(f.upload).toHaveBeenCalledTimes(1);
    f.uploadDone.resolve(); await waitFor(() => f.sent.some(message => message.kind === "product.source.operation.result.v1"));
    expect(f.persist).toHaveBeenCalledTimes(1);
    expect(f.sent.filter(message => message.kind === "product.source.operation.ack.v1")).toHaveLength(1);
    expect(f.sent.filter(message => message.kind === "product.source.operation.result.v1")).toHaveLength(1);
  });

  it("dispatches status and Stop independently while the original upload is pending", async () => {
    const f = fixture(); f.receive(f.command); await f.uploadEntered.promise;
    f.receive({ kind: "command", id: "status", idempotency_key: "status", type: "product.source.operation.status.v1", payload: f.control });
    await waitFor(() => f.sent.some(message => message.kind === "product.source.operation.ack.v1" && message.command_id === "status"));
    expect(f.handle).toHaveBeenCalledTimes(2);
    f.receive({ kind: "command", id: "stop", idempotency_key: "stop", type: "product.source.operation.stop.v1", payload: f.control });
    await waitFor(() => f.sent.some(message => message.kind === "product.source.operation.ack.v1" && message.command_id === "stop"));
    expect(f.handle).toHaveBeenCalledTimes(3); expect(f.upload).toHaveBeenCalledTimes(1);
    expect(f.persist).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ outcome: "uncertain", closed: false }));
  });

  it("keeps the original send pending while accepting its receipt with the same command ID", async () => {
    const f = fixture({ holdResult: true }); f.receive(f.command); await f.uploadEntered.promise;
    f.uploadDone.resolve(); await f.resultEntered.promise;
    for (let index = 0; index < 128; index++) f.receive(structuredClone(f.command));
    await tick(); expect(f.handle).toHaveBeenCalledTimes(1);
    const result = f.sendAttempts.find(message => message.kind === "product.source.operation.result.v1");
    if (result?.kind !== "product.source.operation.result.v1") throw Error("Missing controlled result send");
    f.receive({ kind: "command", id: f.command.id, idempotency_key: `receipt:${f.command.id}`, type: "product.source.operation.receipt.v1",
      payload: f.control, status: "accepted", result_digest: sha(canonical(result.payload)) });
    await waitFor(() => vi.mocked(f.sourceController.handle).mock.calls.some(([message]) => message.type === "product.source.operation.receipt.v1"));
    await expect(vi.mocked(f.sourceController.handle).mock.results.at(-1)!.value).resolves.toBe(true);
    expect(f.readRuntime).toHaveBeenCalledTimes(2);
    expect(f.sent.filter(message => message.kind === "product.source.operation.result.v1")).toHaveLength(0);
    f.resultSend.resolve(); await tick();
    f.receive(f.command); await tick();
    // Both original work and the server's receipt have now completed. An old
    // delivery carries no new work and needs no repeated physical audit/response.
    expect(f.sent.filter(message => message.kind === "product.source.operation.result.v1")).toHaveLength(1);
    expect(f.readRuntime).toHaveBeenCalledTimes(2); expect(f.upload).toHaveBeenCalledTimes(1);
  });

  it("drains completed H2 deliveries across separate event-loop turns only after the actual controller accepts the receipt", async () => {
    const f = fixture(); f.receive(f.command); await f.uploadEntered.promise; f.uploadDone.resolve();
    await waitFor(() => f.sent.some(message => message.kind === "product.source.operation.result.v1")); await tick();
    // Before a committed receipt, resend still reaches the real persisted-result handler.
    f.receive(f.command); await waitFor(() => f.sent.filter(message => message.kind === "product.source.operation.result.v1").length === 2); await tick();
    const result = f.sent.find(message => message.kind === "product.source.operation.result.v1");
    if (result?.kind !== "product.source.operation.result.v1") throw Error("Missing controlled result");
    const receipt: ServerToNodeMessage = { kind: "command", id: f.command.id, idempotency_key: `receipt:${f.command.id}`,
      type: "product.source.operation.receipt.v1", payload: f.control, status: "accepted", result_digest: sha(canonical(result.payload)) };
    f.receive(receipt); await waitFor(() => f.readRuntime.mock.calls.length === 3); await tick();
    for (let index = 0; index < 32; index++) {
      await tick(); f.receive(structuredClone(f.command)); await tick(); f.receive(structuredClone(receipt));
    }
    await tick(); expect(f.readRuntime).toHaveBeenCalledTimes(3);
    expect(f.sent.filter(message => message.kind === "product.source.operation.result.v1")).toHaveLength(2);
    expect(f.reserve).toHaveBeenCalledTimes(1); expect(f.upload).toHaveBeenCalledTimes(1);
    // Stop always reaches the original controller and invalidates the suppression.
    f.receive({ kind: "command", id: "stop", idempotency_key: "stop", type: "product.source.operation.stop.v1", payload: f.control });
    await waitFor(() => f.sent.some(message => message.kind === "product.source.operation.ack.v1" && message.command_id === "stop"));
    await tick(); f.receive(f.command); await waitFor(() => f.readRuntime.mock.calls.length === 5);
    expect(f.upload).toHaveBeenCalledTimes(1);
  });

  it("drains old H3 starts and receipts before native audits while the real design and Stop handlers still advance", async () => {
    const f = fixture({ review: true }); f.receive(f.reviewCommand!);
    await waitFor(() => f.sent.some(message => message.kind === "product.source.review.result.v1")); await tick();
    const result = f.sent.find(message => message.kind === "product.source.review.result.v1");
    if (result?.kind !== "product.source.review.result.v1") throw Error("Missing original controlled review result");
    const control = { version: 1 as const, review_id: result.payload.review_id, request_digest: result.payload.request_digest };
    const receipt: ServerToNodeMessage = { kind: "command", id: f.reviewCommand!.id, type: "product.source.review.receipt.v1",
      idempotency_key: `receipt:${f.reviewCommand!.id}`, payload: control, status: "accepted", result_digest: sha(canonical(result.payload)) };
    f.receive(receipt);
    await waitFor(() => vi.mocked(f.reviewController.handle).mock.calls.some(([message]) => message.type === "product.source.review.receipt.v1"));
    await expect(vi.mocked(f.reviewController.handle).mock.results.at(-1)!.value).resolves.toBe(true); await tick();
    const audits = f.readRuntime.mock.calls.length, frames = f.sent.length;
    for (let index = 0; index < 32; index++) {
      f.receive(structuredClone(f.reviewCommand!)); await tick(); f.receive(structuredClone(receipt)); await tick();
    }
    expect(f.readRuntime).toHaveBeenCalledTimes(audits); expect(f.sent).toHaveLength(frames);
    expect(f.runReview).toHaveBeenCalledTimes(1); expect(f.reserveReview).toHaveBeenCalledTimes(1); expect(f.persistReview).toHaveBeenCalledTimes(1);
    f.receive(f.designCommand!); await f.designEntered.promise;
    expect(f.runDesign).toHaveBeenCalledTimes(1); expect(f.readRuntime).toHaveBeenCalledTimes(audits + 1);
    for (let index = 0; index < 64; index++) f.receive(structuredClone(f.reviewCommand!));
    f.receive({ kind: "command", id: "design-stop", type: "product.source.design.stop.v1", idempotency_key: "design:stop", payload: f.designControl! });
    await waitFor(() => f.designSignal?.aborted === true);
    await waitFor(() => f.sent.some(message => message.kind === "product.source.design.result.v1" && message.command_id === "design-stop"));
    expect(f.readRuntime).toHaveBeenCalledTimes(audits + 2); expect(f.runReview).toHaveBeenCalledTimes(1);
    f.receive({ kind: "command", id: "review-stop", type: "product.source.review.stop.v1", idempotency_key: "review:stop", payload: control });
    await waitFor(() => f.sent.some(message => message.kind === "product.source.review.result.v1" && message.command_id === "review-stop"));
    expect(f.readRuntime).toHaveBeenCalledTimes(audits + 3);
    f.receive(f.reviewCommand!); await waitFor(() => f.readRuntime.mock.calls.length === audits + 4);
    expect(f.runReview).toHaveBeenCalledTimes(1);
  });

  it("lets the real controller replay a persisted result after the original send rejects without uploading again", async () => {
    const f = fixture({ failResultOnce: true }); f.receive(f.command); await f.uploadEntered.promise; f.uploadDone.resolve();
    await f.resultEntered.promise; await tick();
    await expect(vi.mocked(f.sourceController.handle).mock.results[0]!.value).rejects.toThrow("Controlled original result send failure");
    f.receive(f.command); await waitFor(() => f.sent.some(message => message.kind === "product.source.operation.result.v1"));
    expect(f.handle).toHaveBeenCalledTimes(2); expect(f.readRuntime).toHaveBeenCalledTimes(2);
    expect(f.reserve).toHaveBeenCalledTimes(1); expect(f.upload).toHaveBeenCalledTimes(1); expect(f.persist).toHaveBeenCalledTimes(1);
  });

  it("coalesces H3 status through the real design controller without caching its completed result", async () => {
    const f = fixture({ holdResult: true });
    const control = { version: 1 as const, continuation_id: "design", run_id: "design-run", request_digest: `sha256:${"a".repeat(64)}` };
    f.receive({ kind: "command", id: "design-stop", idempotency_key: "stop", type: "product.source.design.stop.v1", payload: control });
    await f.resultEntered.promise; f.handle.mockClear(); f.readRuntime.mockClear();
    const status: ServerToNodeMessage = { kind: "command", id: "design-status", idempotency_key: "status", type: "product.source.design.status.v1", payload: control };
    for (let index = 0; index < 128; index++) f.receive(structuredClone(status));
    await tick(); expect(f.handle).toHaveBeenCalledTimes(1); expect(f.readRuntime).toHaveBeenCalledTimes(1);
    expect(f.reserveDesign).toHaveBeenCalledTimes(1); expect(f.persistDesign).toHaveBeenCalledTimes(1);
    f.resultSend.resolve(); await waitFor(() => f.sent.filter(message => message.kind === "product.source.design.result.v1").length === 2);
    await tick(); f.receive(status);
    await waitFor(() => f.sent.filter(message => message.kind === "product.source.design.result.v1").length === 3);
    expect(f.readRuntime).toHaveBeenCalledTimes(2); expect(f.persistDesign).toHaveBeenCalledTimes(1);
  });

  it("coalesces H3 start and status separately while Stop reaches the original author's AbortSignal", async () => {
    const f = fixture({ design: true }); f.receive(f.designCommand!); await f.designEntered.promise;
    for (let index = 0; index < 64; index++) f.receive(structuredClone(f.designCommand!));
    const status: ServerToNodeMessage = { kind: "command", id: "design-status", idempotency_key: "status", type: "product.source.design.status.v1", payload: f.designControl! };
    for (let index = 0; index < 64; index++) f.receive(structuredClone(status));
    await waitFor(() => f.sent.some(message => message.kind === "product.source.design.ack.v1" && message.command_id === "design-status"));
    expect(f.readRuntime).toHaveBeenCalledTimes(2); expect(f.runDesign).toHaveBeenCalledTimes(1);
    f.receive({ kind: "command", id: "design-stop", idempotency_key: "stop", type: "product.source.design.stop.v1", payload: f.designControl! });
    await waitFor(() => f.designSignal?.aborted === true);
    await waitFor(() => f.sent.some(message => message.kind === "product.source.design.result.v1" && message.command_id === "design-stop"));
    expect(f.readRuntime).toHaveBeenCalledTimes(3); expect(f.runDesign).toHaveBeenCalledTimes(1);
    expect(f.persistDesign).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ outcome: "uncertain", closed: false }));
  });

  it("records a legal H3 receipt with the original start ID before its result send settles", async () => {
    const f = fixture({ design: true, holdResult: true }); f.receive(f.designCommand!); await f.designEntered.promise;
    f.designDone.resolve(); await f.resultEntered.promise;
    expect(() => f.designController.readCompletedVerifiedDesign(f.designControl!.continuation_id, f.designControl!.request_digest)).toThrow("accepted result receipt");
    f.receive({ kind: "command", id: f.designCommand!.id, idempotency_key: `receipt:${f.designCommand!.id}`, type: "product.source.design.receipt.v1",
      payload: f.designControl!, status: "accepted", result_digest: sha(canonical(f.designResult)) });
    await vi.waitFor(() => expect(f.designController.readCompletedVerifiedDesign(f.designControl!.continuation_id, f.designControl!.request_digest)).toBe(f.designResult));
    expect(f.sent.some(message => message.kind === "product.source.design.result.v1")).toBe(false);
    f.resultSend.resolve(); await tick(); f.receive(f.designCommand!);
    await waitFor(() => f.sent.filter(message => message.kind === "product.source.design.result.v1").length === 2);
    expect(f.runDesign).toHaveBeenCalledTimes(1); expect(f.persistDesign).toHaveBeenCalledTimes(1);
  });

  it.each(["no-session", "clean-lifecycle"])("keeps %s clients on the original dispatch path", async variant => {
    const f = fixture({ holdAudit: true, replay: variant !== "no-session", clean: variant === "clean-lifecycle" });
    f.receive(f.command); f.receive(structuredClone(f.command));
    expect(f.handle).toHaveBeenCalledTimes(2); f.audit.resolve(); await f.uploadEntered.promise;
    expect(f.readRuntime).toHaveBeenCalledTimes(2); f.uploadDone.resolve();
    await waitFor(() => f.sent.filter(message => message.kind === "product.source.operation.result.v1").length === 2);
    expect(f.upload).toHaveBeenCalledTimes(1);
  });

  it.each(["changed", "missing"])("does not coalesce or grant execution after the current session is %s", async variant => {
    const f = fixture(); f.receive(f.command); await f.uploadEntered.promise;
    f.changeSession(variant === "changed" ? {} : undefined); f.receive(structuredClone(f.command)); await tick();
    // Neither replacing nor losing the authenticated identity may repeat this pending delivery's audit.
    expect(f.handle).toHaveBeenCalledTimes(1);
    expect(f.readRuntime).toHaveBeenCalledTimes(1);
    expect(f.sourceController.handle).toHaveBeenCalledTimes(1); expect(f.upload).toHaveBeenCalledTimes(1);
    f.uploadDone.resolve(); await expect(vi.mocked(f.sourceController.handle).mock.results[0]!.value).resolves.toBe(true);
    expect(f.sent.some(message => message.kind === "product.source.operation.result.v1")).toBe(false);
  });
});
