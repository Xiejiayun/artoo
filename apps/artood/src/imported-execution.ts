import { createHash } from "node:crypto";
import { canonicalProductSourceTransferValueV1 as canonical, importedExecutionRequestDigestV1, importedDesignReviewRequestDigestV1,
  type ImportedExecutionControlV1, type ImportedExecutionResultV1 } from "@artoo/domain";
import { importedExecutionCommandSchema, importedExecutionStopSchema, importedExecutionStatusSchema, importedExecutionReceiptSchema,
  type ImportedExecutionCommand, type NodeSideTransport, type RuntimeAdapter, type ServerToNodeMessage } from "@artoo/protocol";
import { reserveImportedExecution, runImportedExecution, persistImportedExecutionResult, failUnstartedImportedExecution,
  readCompletedVerifiedImportedExecution, type PreparedImportedExecution, type PreparedProductSourceRuntime } from "./product-source-runtime.js";
import { createImportedAuthorEmitter } from "./imported-author-execution.js";
import type { createImportedDesignReviewClient } from "./imported-design-review.js";
import type { ArtifactUploader } from "./artifact-upload.js";
const sha = (bytes: string | Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** Versioned admission adapter over the shared author runner; never an ordinary run.start exception. */
export function createImportedExecutionClient(options: { nodeId: string; runtime: PreparedProductSourceRuntime;
  reviews: ReturnType<typeof createImportedDesignReviewClient>; transport: NodeSideTransport;
  resolveAdapter: (runtime: string) => RuntimeAdapter | undefined; isCurrent: () => boolean; uploadArtifact?: ArtifactUploader }) {
  if (options.transport.acknowledgesRunEvents !== true) throw Error("H5 requires committed ordinary run-event receipts");
  type Slot = { control: ImportedExecutionControlV1; permit: PreparedImportedExecution; controller: AbortController;
    work?: Promise<void>; result?: ImportedExecutionResultV1; persisted?: boolean; acknowledged?: string };
  const slots = new Map<string, Slot>(); let invalidated = false;
  const current = () => { if (invalidated || !options.isCurrent()) throw Error("H5 session invalidated"); };
  const same = (slot: Slot, control: ImportedExecutionControlV1) => { if (canonical(slot.control) !== canonical(control)) throw Error("H5 control changed its exact request or run"); };
  const ack = async (id: string, slot: Slot) => { current(); await options.transport.send({ kind: "product.source.execution.ack.v1", node_id: options.nodeId,
    command_id: id, status: "accepted", payload: slot.control }); };
  const emit = async (id: string, slot: Slot) => { if (!slot.persisted || !slot.result) return; current();
    await options.transport.send({ kind: "product.source.execution.result.v1", node_id: options.nodeId, command_id: id, payload: slot.result }); };
  async function start(command: ImportedExecutionCommand) {
    const request = command.payload, start = request.run_start;
    const control: ImportedExecutionControlV1 = { version: 1, execution_id: request.execution_id, request_digest: importedExecutionRequestDigestV1(request, sha), run_id: start.run_id };
    if (command.deadline_at && Date.parse(command.deadline_at) <= Date.now()) throw Error("H5 command deadline expired");
    if (request.review_request.continuation_request.review_request.operation.intent.request.byte_request.destination.node_id !== options.nodeId) throw Error("H5 belongs to another node");
    const prior = slots.get(control.execution_id);
    if (prior) { same(prior, control); await ack(command.id, prior); await prior.work; await emit(command.id, prior); return; }
    current();
    const original = options.reviews.readCompletedAcceptedDesignReview(request.review_request.review_id, importedDesignReviewRequestDigestV1(request.review_request, sha));
    if (canonical(original) !== canonical(request.review_result)) throw Error("H5 differs from its original accepted H4");
    const adapter = options.resolveAdapter(start.runtime); if (!adapter) throw Error("H5 author runtime is not configured");
    const permit = reserveImportedExecution(options.runtime, control, "start"), slot: Slot = { control, permit, controller: new AbortController() };
    slots.set(control.execution_id, slot);
    slot.work = (async () => {
      let entered = false;
      const emitRun = createImportedAuthorEmitter({ nodeId: options.nodeId, transport: options.transport, start, current, uploadArtifact: options.uploadArtifact });
      try { await ack(command.id, slot); current(); entered = true;
        slot.result = await runImportedExecution(options.runtime, permit, original, request, adapter, slot.controller.signal, current, emitRun);
      } catch (error) {
        slot.result = !entered ? await failUnstartedImportedExecution(options.runtime, permit, error, emitRun)
          : { ...control, outcome: "uncertain", closed: false, reason: (error instanceof Error ? error.message : "H5 execution unavailable").slice(0, 2000) || "H5 execution unavailable" };
      }
      persistImportedExecutionResult(options.runtime, permit, slot.result); slot.persisted = true;
    })();
    await slot.work; if (!invalidated && options.isCurrent()) await emit(command.id, slot);
  }
  return {
    async handle(input: ServerToNodeMessage): Promise<boolean> {
      if (!input.type.startsWith("product.source.execution.")) return false; current();
      if (input.type === "product.source.execution.v1") { await start(importedExecutionCommandSchema.parse(input)); return true; }
      if (input.type === "product.source.execution.receipt.v1") {
        const receipt = importedExecutionReceiptSchema.parse(input), slot = slots.get(receipt.payload.execution_id);
        if (!slot) throw Error("Original H5 result is unavailable"); same(slot, receipt.payload);
        if (!slot.persisted || !slot.result || sha(canonical(slot.result)) !== receipt.result_digest) throw Error("H5 receipt differs from the persisted result");
        slot.acknowledged = receipt.status === "accepted" ? receipt.result_digest : undefined; return true;
      }
      const command = input.type === "product.source.execution.stop.v1" ? importedExecutionStopSchema.parse(input) : importedExecutionStatusSchema.parse(input);
      let slot = slots.get(command.payload.execution_id); if (slot) same(slot, command.payload);
      if (input.type === "product.source.execution.status.v1") {
        if (!slot) throw Error("Original H5 owner is unavailable; recovery required"); await ack(command.id, slot); await slot.work; await emit(command.id, slot); return true;
      }
      if (!slot) {
        const permit = reserveImportedExecution(options.runtime, command.payload, "stop");
        slot = { control: command.payload, permit, controller: new AbortController(), result: { ...command.payload, outcome: "cancelled_before_start", closed: true } };
        slots.set(command.payload.execution_id, slot); persistImportedExecutionResult(options.runtime, permit, slot.result!); slot.persisted = true;
      }
      slot.controller.abort(); await slot.work; await ack(command.id, slot); await emit(command.id, slot); return true;
    },
    invalidate() { invalidated = true; for (const slot of slots.values()) slot.controller.abort(); },
    readCompletedVerifiedExecution(executionId: string, requestDigest: string): ImportedExecutionResultV1 {
      current(); const slot = slots.get(executionId);
      if (!slot?.persisted || !slot.result || slot.control.request_digest !== requestDigest
        || slot.acknowledged !== sha(canonical(slot.result))) throw Error("H6 requires original H5 and its current-session accepted result receipt");
      readCompletedVerifiedImportedExecution(options.runtime, slot.result); return slot.result;
    },
    /** Receipt liveness only; current subject and original closure remain runtime-owned. */
    assertCompletedExecutionReceipt(executionId: string, requestDigest: string, original: ImportedExecutionResultV1): void {
      current(); const slot = slots.get(executionId);
      if (!slot?.persisted || slot.result !== original || slot.control.request_digest !== requestDigest
        || slot.acknowledged !== sha(canonical(original))) throw Error("Original H5 receipt is no longer accepted in this session");
    },
    async settled() { await Promise.all([...slots.values()].map(slot => slot.work)); },
  };
}
