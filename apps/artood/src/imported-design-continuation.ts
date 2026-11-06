import { createHash } from "node:crypto";
import { canonicalProductSourceTransferValueV1 as canonical, importedDesignContinuationRequestDigestV1,
  importedProductReviewRequestDigestV1, type ImportedDesignContinuationControlV1, type ImportedDesignContinuationResultV1 } from "@artoo/domain";
import { importedDesignContinuationCommandSchema, importedDesignContinuationStopSchema, importedDesignContinuationStatusSchema,
  importedDesignContinuationReceiptSchema, type ImportedDesignContinuationCommand, type NodeSideTransport,
  type RuntimeAdapter, type ServerToNodeMessage } from "@artoo/protocol";
import { reserveImportedDesignContinuation, runImportedDesignContinuation, persistImportedDesignContinuationResult, failUnstartedImportedDesignContinuation,
  readCompletedVerifiedImportedDesign,
  type PreparedImportedDesignContinuation, type PreparedProductSourceRuntime } from "./product-source-runtime.js";
import type { createImportedProductReviewClient } from "./imported-product-review.js";
import type { ArtifactUploader } from "./artifact-upload.js";
import { createImportedAuthorEmitter } from "./imported-author-execution.js";

const sha = (value: string | Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

/** Dedicated ordered execution. Status and serialized receipts can only replay facts. */
export function createImportedDesignContinuationClient(options: {
  nodeId: string; runtime: PreparedProductSourceRuntime; reviews: ReturnType<typeof createImportedProductReviewClient>;
  resolveAdapter: (runtime: string) => RuntimeAdapter | undefined; transport: NodeSideTransport; isCurrent: () => boolean;
  uploadArtifact?: ArtifactUploader;
}) {
  if (options.transport.acknowledgesRunEvents !== true) throw Error("Imported design requires committed ordinary run-event receipts");
  type Slot = { control: ImportedDesignContinuationControlV1; permit: PreparedImportedDesignContinuation; action: "start" | "stop";
    controller: AbortController; work?: Promise<void>; result?: ImportedDesignContinuationResultV1; persisted?: boolean; acknowledged?: string };
  const slots = new Map<string, Slot>(); let invalidated = false;
  const current = () => { if (invalidated || !options.isCurrent()) throw Error("Imported-design session invalidated"); };
  const same = (slot: Slot, control: ImportedDesignContinuationControlV1) => {
    if (canonical(slot.control) !== canonical(control)) throw Error("Imported-design control differs from the exact continuation/request/run");
  };
  async function ack(commandId: string, slot: Slot) { current(); await options.transport.send({ kind: "product.source.design.ack.v1",
    node_id: options.nodeId, command_id: commandId, status: "accepted", payload: slot.control }); }
  async function emit(commandId: string, slot: Slot) { if (!slot.persisted || !slot.result) return; current();
    await options.transport.send({ kind: "product.source.design.result.v1", node_id: options.nodeId, command_id: commandId, payload: slot.result }); }
  async function start(command: ImportedDesignContinuationCommand) {
    const request = command.payload, start = request.run_start;
    const control: ImportedDesignContinuationControlV1 = { version: 1, continuation_id: request.continuation_id,
      request_digest: importedDesignContinuationRequestDigestV1(request, sha), run_id: start.run_id };
    if (command.deadline_at && Date.parse(command.deadline_at) <= Date.now()) throw Error("Imported-design command deadline expired");
    if (request.review_request.operation.intent.request.byte_request.destination.node_id !== options.nodeId) throw Error("Imported design is assigned to another node");
    const prior = slots.get(control.continuation_id);
    if (prior) { same(prior, control); await ack(command.id, prior); await prior.work; await emit(command.id, prior); return; }
    current();
    const permit = reserveImportedDesignContinuation(options.runtime, control, "start");
    const slot: Slot = { control, permit, action: "start", controller: new AbortController() }; slots.set(control.continuation_id, slot);
    slot.work = (async () => {
      let enteredRuntime = false;
      const emitRun = createImportedAuthorEmitter({ nodeId: options.nodeId, transport: options.transport, start, current, uploadArtifact: options.uploadArtifact });
      try {
        await ack(command.id, slot); current();
        const original = options.reviews.readCompletedAccepted(request.review_request.review_id, importedProductReviewRequestDigestV1(request.review_request, sha));
        if (canonical(original) !== canonical(request.review_result)) throw Error("Imported design differs from the original accepted local review");
        const adapter = options.resolveAdapter(start.runtime); if (!adapter) throw Error("Imported-design runtime is not configured");
        enteredRuntime = true;
        slot.result = await runImportedDesignContinuation(options.runtime, permit, original, request, adapter, slot.controller.signal, current, emitRun);
      } catch (error) {
        slot.result = !enteredRuntime ? await failUnstartedImportedDesignContinuation(options.runtime, permit, error, emitRun)
          : { ...control, outcome: "uncertain", closed: false,
            reason: (error instanceof Error ? error.message : "Imported-design execution unavailable").slice(0, 2000) || "Imported-design execution unavailable" };
      }
      persistImportedDesignContinuationResult(options.runtime, permit, slot.result); slot.persisted = true;
    })();
    await slot.work; if (!invalidated && options.isCurrent()) await emit(command.id, slot);
  }
  return {
    async handle(input: ServerToNodeMessage): Promise<boolean> {
      if (!input.type.startsWith("product.source.design.")) return false; current();
      if (input.type === "product.source.design.v1") { await start(importedDesignContinuationCommandSchema.parse(input)); return true; }
      if (input.type === "product.source.design.receipt.v1") {
        const receipt = importedDesignContinuationReceiptSchema.parse(input), slot = slots.get(receipt.payload.continuation_id);
        if (!slot) throw Error("Original imported-design result is unavailable"); same(slot, receipt.payload);
        if (!slot.persisted || !slot.result || sha(canonical(slot.result)) !== receipt.result_digest) throw Error("Imported-design receipt differs from its persisted result");
        slot.acknowledged = receipt.status === "accepted" ? receipt.result_digest : undefined; return true;
      }
      const command = input.type === "product.source.design.stop.v1" ? importedDesignContinuationStopSchema.parse(input) : importedDesignContinuationStatusSchema.parse(input);
      let slot = slots.get(command.payload.continuation_id); if (slot) same(slot, command.payload);
      if (input.type === "product.source.design.status.v1") {
        if (!slot) throw Error("Original imported-design owner is unavailable; recovery required");
        await ack(command.id, slot); await slot.work; await emit(command.id, slot); return true;
      }
      if (!slot) {
        const permit = reserveImportedDesignContinuation(options.runtime, command.payload, "stop");
        slot = { control: command.payload, permit, action: "stop", controller: new AbortController() }; slots.set(command.payload.continuation_id, slot);
        slot.result = { ...command.payload, outcome: "cancelled_before_start", closed: true };
        persistImportedDesignContinuationResult(options.runtime, permit, slot.result); slot.persisted = true;
      }
      slot.controller.abort(); await slot.work; await ack(command.id, slot); await emit(command.id, slot); return true;
    },
    invalidate() { invalidated = true; for (const slot of slots.values()) slot.controller.abort(); },
    readCompletedVerifiedDesign(continuationId: string, requestDigest: string): ImportedDesignContinuationResultV1 {
      current(); const slot = slots.get(continuationId);
      if (!slot?.persisted || !slot.result || slot.control.request_digest !== requestDigest
        || slot.acknowledged !== sha(canonical(slot.result))) throw Error("Original H3 design and current-session accepted result receipt are required");
      readCompletedVerifiedImportedDesign(options.runtime, slot.result); return slot.result;
    },
    async settled() { await Promise.all([...slots.values()].map(slot => slot.work)); },
  };
}
