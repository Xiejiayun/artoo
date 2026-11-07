import { createHash } from "node:crypto";
import { canonicalProductSourceTransferValueV1 as canonical, importedExecutionReviewRequestDigestV1, importedExecutionRepairRequestDigestV1,
  type ImportedExecutionReviewControlV1, type ImportedExecutionReviewResultV1, type ImportedExecutionRepairControlV1,
  type ImportedExecutionRepairResultV1, type ImportedImplementationSourceV1 } from "@artoo/domain";
import { importedExecutionReviewCommandSchema, importedExecutionReviewStopSchema, importedExecutionReviewStatusSchema, importedExecutionReviewReceiptSchema,
  importedExecutionRepairCommandSchema, importedExecutionRepairStopSchema, importedExecutionRepairStatusSchema, importedExecutionRepairReceiptSchema,
  type ImportedExecutionReviewCommand, type ImportedExecutionRepairCommand, type NodeSideTransport, type RuntimeAdapter, type ServerToNodeMessage } from "@artoo/protocol";
import { reserveImportedExecutionReview, runImportedExecutionReview, persistImportedExecutionReviewResult, readCompletedImportedExecutionReview,
  reserveImportedExecutionRepair, runImportedExecutionRepair, persistImportedExecutionRepairResult, failUnstartedImportedExecutionRepair,
  readCompletedVerifiedImportedExecutionRepair, type PreparedImportedExecutionReview, type PreparedImportedExecutionRepair, type PreparedProductSourceRuntime } from "./product-source-runtime.js";
import { createImportedAuthorEmitter } from "./imported-author-execution.js";
import type { createImportedExecutionClient } from "./imported-execution.js";
import type { ArtifactUploader } from "./artifact-upload.js";
const sha = (bytes: string | Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const hash = (value: unknown) => sha(canonical(value));

/** Two concrete continuation operations share local slots, never a generic remote authority registry. */
export function createImportedExecutionReviewClient(options: { nodeId: string; runtime: PreparedProductSourceRuntime;
  executions: ReturnType<typeof createImportedExecutionClient>; transport: NodeSideTransport; resolveAdapter: (runtime: string) => RuntimeAdapter | undefined;
  isCurrent: () => boolean; uploadArtifact?: ArtifactUploader }) {
  if (options.transport.acknowledgesRunEvents !== true) throw Error("H6 and repair require committed ordinary run-event receipts");
  type ReviewSlot = { control: ImportedExecutionReviewControlV1; permit: PreparedImportedExecutionReview; controller: AbortController;
    work?: Promise<void>; result?: ImportedExecutionReviewResultV1; persisted?: boolean; acknowledged?: string; delivered?: boolean };
  type RepairSlot = { control: ImportedExecutionRepairControlV1; permit: PreparedImportedExecutionRepair; controller: AbortController;
    work?: Promise<void>; result?: ImportedExecutionRepairResultV1; persisted?: boolean; acknowledged?: string; delivered?: boolean };
  const reviews = new Map<string, ReviewSlot>(), repairs = new Map<string, RepairSlot>(); let invalidated = false;
  const current = () => { if (invalidated || !options.isCurrent()) throw Error("Implementation review session invalidated"); };
  const same = (slot: ReviewSlot | RepairSlot, control: ImportedExecutionReviewControlV1 | ImportedExecutionRepairControlV1) => {
    if (canonical(slot.control) !== canonical(control)) throw Error("Implementation control changed its exact request or run");
  };
  const ackReview = async (id: string, slot: ReviewSlot) => { current(); await options.transport.send({ kind: "product.source.execution-review.ack.v1",
    node_id: options.nodeId, command_id: id, payload: slot.control, status: "accepted" }); };
  const ackRepair = async (id: string, slot: RepairSlot) => { current(); await options.transport.send({ kind: "product.source.execution-repair.ack.v1",
    node_id: options.nodeId, command_id: id, payload: slot.control, status: "accepted" }); };
  const emitReview = async (id: string, slot: ReviewSlot) => {
    if (!slot.persisted || !slot.result) return; current();
    await options.transport.send({ kind: "product.source.execution-review.result.v1", node_id: options.nodeId, command_id: id, payload: slot.result }); current();
    if (!slot.delivered && slot.result.outcome === "reviewed") readCompletedImportedExecutionReview(options.runtime, slot.result);
    slot.delivered = true;
  };
  const emitRepair = async (id: string, slot: RepairSlot) => {
    if (!slot.persisted || !slot.result) return; current();
    await options.transport.send({ kind: "product.source.execution-repair.result.v1", node_id: options.nodeId, command_id: id, payload: slot.result }); current();
    if (!slot.delivered && slot.result.outcome === "finished" && slot.result.verified_repair) readCompletedVerifiedImportedExecutionRepair(options.runtime, slot.result);
    slot.delivered = true;
  };
  function originalSource(source: ImportedImplementationSourceV1) {
    current();
    if (source.kind === "execution") {
      const result = options.executions.readCompletedVerifiedExecution(source.operation_id, source.request_digest);
      if (hash(result) !== source.result_digest) throw Error("H6 source result digest differs from its original H5 object");
      return result;
    }
    const slot = repairs.get(source.operation_id);
    if (!slot?.persisted || !slot.result || slot.control.request_digest !== source.request_digest
      || slot.acknowledged !== hash(slot.result) || source.result_digest !== hash(slot.result)) throw Error("H6 requires original repair and its current-session accepted receipt");
    readCompletedVerifiedImportedExecutionRepair(options.runtime, slot.result); return slot.result;
  }
  function originalReview(reviewId: string, requestDigest: string, resultDigest: string) {
    current(); const slot = reviews.get(reviewId);
    if (!slot?.persisted || !slot.result || slot.control.request_digest !== requestDigest || hash(slot.result) !== resultDigest
      || slot.acknowledged !== resultDigest) throw Error("Repair requires original H6 and its current-session accepted receipt");
    readCompletedImportedExecutionReview(options.runtime, slot.result);
    if (slot.result.outcome !== "reviewed" || slot.result.verdict.outcome !== "rejected") throw Error("Repair requires a completed rejected H6 verdict");
    return slot.result;
  }
  function assertSourceReceipt(source: ImportedImplementationSourceV1, original: ReturnType<typeof originalSource>) {
    current();
    if (source.kind === "execution") {
      if (!("execution_id" in original)) throw Error("Original H5 source object changed");
      options.executions.assertCompletedExecutionReceipt(source.operation_id, source.request_digest, original);
    } else {
      const slot = repairs.get(source.operation_id);
      if (!slot?.persisted || slot.result !== original || slot.control.request_digest !== source.request_digest
        || slot.acknowledged !== source.result_digest || hash(original) !== source.result_digest)
        throw Error("Original repair receipt is no longer accepted in this session");
    }
  }
  function assertReviewReceipt(reviewId: string, requestDigest: string, resultDigest: string, original: ImportedExecutionReviewResultV1) {
    current(); const slot = reviews.get(reviewId);
    if (!slot?.persisted || slot.result !== original || slot.control.request_digest !== requestDigest
      || slot.acknowledged !== resultDigest || hash(original) !== resultDigest)
      throw Error("Original H6 receipt is no longer accepted in this session");
  }
  function node(execution: ImportedExecutionReviewCommand["payload"]["execution_request"]) {
    if (execution.review_request.continuation_request.review_request.operation.intent.request.byte_request.destination.node_id !== options.nodeId)
      throw Error("Implementation continuation belongs to another node");
  }
  async function startReview(command: ImportedExecutionReviewCommand) {
    const request = command.payload, control: ImportedExecutionReviewControlV1 = { version: 1, review_id: request.review_id, request_digest: importedExecutionReviewRequestDigestV1(request, sha) };
    if (command.deadline_at && Date.parse(command.deadline_at) <= Date.now()) throw Error("H6 command deadline expired"); node(request.execution_request);
    const prior = reviews.get(control.review_id); if (prior) { same(prior, control); await ackReview(command.id, prior); await prior.work; await emitReview(command.id, prior); return; }
    const original = originalSource(request.source), adapter = options.resolveAdapter(request.review_start.runtime);
    if (!adapter) throw Error("H6 reviewer runtime is not configured"); current();
    const permit = reserveImportedExecutionReview(options.runtime, control, "start"), slot: ReviewSlot = { control, permit, controller: new AbortController() };
    reviews.set(control.review_id, slot);
    slot.work = (async () => {
      try { await ackReview(command.id, slot); current();
        if (originalSource(request.source) !== original) throw Error("Original implementation source changed during command acknowledgement");
        slot.result = await runImportedExecutionReview(options.runtime, permit, original, request, adapter, slot.controller.signal,
          () => assertSourceReceipt(request.source, original));
      } catch (error) { slot.result = { ...control, execution_authorized: false, outcome: "uncertain", closed: false,
        reason: (error instanceof Error ? error.message : "H6 review unavailable").slice(0, 2000) || "H6 review unavailable" }; }
      persistImportedExecutionReviewResult(options.runtime, permit, slot.result); slot.persisted = true;
    })();
    await slot.work; if (!invalidated && options.isCurrent()) await emitReview(command.id, slot);
  }
  async function startRepair(command: ImportedExecutionRepairCommand) {
    const request = command.payload, start = request.run_start, control: ImportedExecutionRepairControlV1 = { version: 1, repair_id: request.repair_id,
      request_digest: importedExecutionRepairRequestDigestV1(request, sha), run_id: start.run_id };
    if (command.deadline_at && Date.parse(command.deadline_at) <= Date.now()) throw Error("Repair command deadline expired"); node(request.execution_request);
    const prior = repairs.get(control.repair_id); if (prior) { same(prior, control); await ackRepair(command.id, prior); await prior.work; await emitRepair(command.id, prior); return; }
    const original = originalReview(request.review_id, request.review_request_digest, request.review_result_digest), adapter = options.resolveAdapter(start.runtime);
    if (!adapter) throw Error("Repair writer runtime is not configured"); current();
    const permit = reserveImportedExecutionRepair(options.runtime, control, "start"), slot: RepairSlot = { control, permit, controller: new AbortController() };
    repairs.set(control.repair_id, slot);
    slot.work = (async () => {
      let entered = false;
      const emit = createImportedAuthorEmitter({ nodeId: options.nodeId, transport: options.transport, start, current, uploadArtifact: options.uploadArtifact });
      try { await ackRepair(command.id, slot); current();
        if (originalReview(request.review_id, request.review_request_digest, request.review_result_digest) !== original)
          throw Error("Original rejected H6 changed during command acknowledgement");
        entered = true;
        slot.result = await runImportedExecutionRepair(options.runtime, permit, original, request, adapter, slot.controller.signal,
          () => assertReviewReceipt(request.review_id, request.review_request_digest, request.review_result_digest, original), emit);
      } catch (error) { slot.result = !entered ? await failUnstartedImportedExecutionRepair(options.runtime, permit, error, emit)
        : { ...control, outcome: "uncertain", closed: false, reason: (error instanceof Error ? error.message : "Repair unavailable").slice(0, 2000) || "Repair unavailable" }; }
      persistImportedExecutionRepairResult(options.runtime, permit, slot.result); slot.persisted = true;
    })();
    await slot.work; if (!invalidated && options.isCurrent()) await emitRepair(command.id, slot);
  }
  return {
    readCompletedAcceptedReview(reviewId: string, requestDigest: string, resultDigest: string) {
      current(); const slot = reviews.get(reviewId);
      if (!slot?.persisted || !slot.result || slot.control.request_digest !== requestDigest
        || slot.acknowledged !== resultDigest || hash(slot.result) !== resultDigest)
        throw Error("Validation requires the original accepted H6 receipt in this session");
      readCompletedImportedExecutionReview(options.runtime, slot.result);
      if (slot.result.outcome !== "reviewed" || slot.result.verdict.outcome !== "accepted") throw Error("Validation requires accepted H6");
      return slot.result;
    },
    assertCompletedAcceptedReviewReceipt(reviewId: string, requestDigest: string, resultDigest: string, original: ImportedExecutionReviewResultV1) {
      assertReviewReceipt(reviewId, requestDigest, resultDigest, original);
      if (original.outcome !== "reviewed" || original.verdict.outcome !== "accepted") throw Error("Original accepted H6 verdict changed");
    },
    async handle(input: ServerToNodeMessage): Promise<boolean> {
      const review = input.type.startsWith("product.source.execution-review."), repair = input.type.startsWith("product.source.execution-repair.");
      if (!review && !repair) return false; current();
      if (input.type === "product.source.execution-review.v1") { await startReview(importedExecutionReviewCommandSchema.parse(input)); return true; }
      if (input.type === "product.source.execution-repair.v1") { await startRepair(importedExecutionRepairCommandSchema.parse(input)); return true; }
      if (input.type === "product.source.execution-review.receipt.v1") {
        const receipt = importedExecutionReviewReceiptSchema.parse(input), slot = reviews.get(receipt.payload.review_id);
        if (!slot) throw Error("Original H6 result is unavailable"); same(slot, receipt.payload);
        if (!slot.persisted || !slot.result || hash(slot.result) !== receipt.result_digest) throw Error("H6 receipt differs from its persisted result");
        if (receipt.status === "accepted" && slot.acknowledged !== receipt.result_digest && slot.result.outcome === "reviewed") readCompletedImportedExecutionReview(options.runtime, slot.result);
        slot.acknowledged = receipt.status === "accepted" ? receipt.result_digest : undefined; return true;
      }
      if (input.type === "product.source.execution-repair.receipt.v1") {
        const receipt = importedExecutionRepairReceiptSchema.parse(input), slot = repairs.get(receipt.payload.repair_id);
        if (!slot) throw Error("Original repair result is unavailable"); same(slot, receipt.payload);
        if (!slot.persisted || !slot.result || hash(slot.result) !== receipt.result_digest) throw Error("Repair receipt differs from its persisted result");
        if (receipt.status === "accepted" && slot.acknowledged !== receipt.result_digest && slot.result.outcome === "finished" && slot.result.verified_repair)
          readCompletedVerifiedImportedExecutionRepair(options.runtime, slot.result);
        slot.acknowledged = receipt.status === "accepted" ? receipt.result_digest : undefined; return true;
      }
      if (review) {
        const command = input.type === "product.source.execution-review.stop.v1" ? importedExecutionReviewStopSchema.parse(input) : importedExecutionReviewStatusSchema.parse(input);
        let slot = reviews.get(command.payload.review_id); if (slot) same(slot, command.payload);
        if (input.type === "product.source.execution-review.status.v1") {
          if (!slot) throw Error("Original H6 owner is unavailable; recovery required"); await ackReview(command.id, slot); await slot.work; await emitReview(command.id, slot); return true;
        }
        if (!slot) { const permit = reserveImportedExecutionReview(options.runtime, command.payload, "stop");
          slot = { control: command.payload, permit, controller: new AbortController(), result: { ...command.payload, execution_authorized: false,
            outcome: "cancelled_before_start", closed: true, reason: "Cancelled before H6 admission" } }; reviews.set(command.payload.review_id, slot);
          persistImportedExecutionReviewResult(options.runtime, permit, slot.result!); slot.persisted = true; }
        slot.controller.abort(); await slot.work; await ackReview(command.id, slot); await emitReview(command.id, slot); return true;
      }
      const command = input.type === "product.source.execution-repair.stop.v1" ? importedExecutionRepairStopSchema.parse(input) : importedExecutionRepairStatusSchema.parse(input);
      let slot = repairs.get(command.payload.repair_id); if (slot) same(slot, command.payload);
      if (input.type === "product.source.execution-repair.status.v1") {
        if (!slot) throw Error("Original repair owner is unavailable; recovery required"); await ackRepair(command.id, slot); await slot.work; await emitRepair(command.id, slot); return true;
      }
      if (!slot) { const permit = reserveImportedExecutionRepair(options.runtime, command.payload, "stop");
        slot = { control: command.payload, permit, controller: new AbortController(), result: { ...command.payload, outcome: "cancelled_before_start", closed: true } };
        repairs.set(command.payload.repair_id, slot); persistImportedExecutionRepairResult(options.runtime, permit, slot.result!); slot.persisted = true; }
      slot.controller.abort(); await slot.work; await ackRepair(command.id, slot); await emitRepair(command.id, slot); return true;
    },
    invalidate() { invalidated = true; for (const slot of [...reviews.values(), ...repairs.values()]) slot.controller.abort(); },
    async settled() { await Promise.all([...reviews.values(), ...repairs.values()].map(slot => slot.work)); },
  };
}
