import { createHash } from "node:crypto";
import { canonicalProductSourceTransferValueV1 as canonical, importedDesignContinuationRequestDigestV1, importedDesignReviewRequestDigestV1,
  type ImportedDesignReviewControlV1, type ImportedDesignReviewResultV1 } from "@artoo/domain";
import { importedDesignReviewCommandSchema, importedDesignReviewStopSchema, importedDesignReviewStatusSchema, importedDesignReviewReceiptSchema,
  type ImportedDesignReviewCommand, type NodeSideTransport, type RuntimeAdapter, type ServerToNodeMessage } from "@artoo/protocol";
import { reserveImportedDesignReview, runImportedDesignReview, persistImportedDesignReviewResult,
  readCompletedAcceptedImportedDesignReview,
  type PreparedImportedDesignReview, type PreparedProductSourceRuntime } from "./product-source-runtime.js";
import type { createImportedDesignContinuationClient } from "./imported-design-continuation.js";

const sha = (bytes: string | Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
/** A separate current-session controller consumes H3 completion, never its writer permit. */
export function createImportedDesignReviewClient(options: { nodeId: string; runtime: PreparedProductSourceRuntime;
  designs: ReturnType<typeof createImportedDesignContinuationClient>; transport: NodeSideTransport;
  resolveAdapter: (runtime: string) => RuntimeAdapter | undefined; isCurrent: () => boolean }) {
  type Slot = { control: ImportedDesignReviewControlV1; permit: PreparedImportedDesignReview; action: "start" | "stop";
    controller: AbortController; work?: Promise<void>; result?: ImportedDesignReviewResultV1; persisted?: boolean; acknowledged?: string };
  const slots = new Map<string, Slot>(); let invalidated = false;
  const current = () => { if (invalidated || !options.isCurrent()) throw Error("H4 session invalidated"); };
  const same = (slot: Slot, control: ImportedDesignReviewControlV1) => {
    if (canonical(slot.control) !== canonical(control)) throw Error("H4 control differs from its original request");
  };
  async function ack(commandId: string, slot: Slot) { current(); await options.transport.send({ kind: "product.source.design-review.ack.v1",
    node_id: options.nodeId, command_id: commandId, status: "accepted", payload: slot.control }); }
  async function emit(commandId: string, slot: Slot) { if (!slot.persisted || !slot.result) return; current();
    await options.transport.send({ kind: "product.source.design-review.result.v1", node_id: options.nodeId, command_id: commandId, payload: slot.result }); }
  async function start(command: ImportedDesignReviewCommand) {
    const request = command.payload, control: ImportedDesignReviewControlV1 = { version: 1, review_id: request.review_id,
      request_digest: importedDesignReviewRequestDigestV1(request, sha) };
    if (command.deadline_at && Date.parse(command.deadline_at) <= Date.now()) throw Error("H4 command deadline expired");
    if (request.continuation_request.review_request.operation.intent.request.byte_request.destination.node_id !== options.nodeId) throw Error("H4 is assigned to another node");
    const prior = slots.get(control.review_id);
    if (prior) { same(prior, control); await ack(command.id, prior); await prior.work; await emit(command.id, prior); return; }
    current();
    const original = options.designs.readCompletedVerifiedDesign(request.continuation_request.continuation_id,
      importedDesignContinuationRequestDigestV1(request.continuation_request, sha));
    if (canonical(original) !== canonical(request.continuation_result)) throw Error("H4 request differs from the original completed local design");
    const adapter = options.resolveAdapter(request.review_start.runtime); if (!adapter) throw Error("H4 reviewer runtime is not configured");
    const permit = reserveImportedDesignReview(options.runtime, control, "start");
    const slot: Slot = { control, permit, action: "start", controller: new AbortController() }; slots.set(control.review_id, slot);
    slot.work = (async () => {
      try {
        await ack(command.id, slot); current(); slot.controller.signal.throwIfAborted();
        slot.result = await runImportedDesignReview(options.runtime, permit, original, request, adapter, slot.controller.signal, current);
      } catch (error) { slot.result = { ...control, execution_authorized: false, outcome: "uncertain", closed: false,
        reason: (error instanceof Error ? error.message : "H4 execution unavailable").slice(0, 2000) || "H4 execution unavailable" }; }
      persistImportedDesignReviewResult(options.runtime, permit, slot.result); slot.persisted = true;
    })();
    await slot.work; if (!invalidated && options.isCurrent()) await emit(command.id, slot);
  }
  return {
    async handle(input: ServerToNodeMessage): Promise<boolean> {
      if (!input.type.startsWith("product.source.design-review.")) return false; current();
      if (input.type === "product.source.design-review.v1") { await start(importedDesignReviewCommandSchema.parse(input)); return true; }
      if (input.type === "product.source.design-review.receipt.v1") {
        const receipt = importedDesignReviewReceiptSchema.parse(input), slot = slots.get(receipt.payload.review_id);
        if (!slot) throw Error("Original H4 result is unavailable"); same(slot, receipt.payload);
        if (!slot.persisted || !slot.result || receipt.result_digest !== sha(canonical(slot.result))) throw Error("H4 receipt differs from its persisted result");
        slot.acknowledged = receipt.status === "accepted" ? receipt.result_digest : undefined; return true;
      }
      const command = input.type === "product.source.design-review.stop.v1" ? importedDesignReviewStopSchema.parse(input) : importedDesignReviewStatusSchema.parse(input);
      let slot = slots.get(command.payload.review_id); if (slot) same(slot, command.payload);
      if (input.type === "product.source.design-review.status.v1") {
        if (!slot) throw Error("Original H4 owner is unavailable; recovery required");
        await ack(command.id, slot); await slot.work; await emit(command.id, slot); return true;
      }
      if (!slot) {
        const permit = reserveImportedDesignReview(options.runtime, command.payload, "stop");
        slot = { control: command.payload, permit, action: "stop", controller: new AbortController() }; slots.set(command.payload.review_id, slot);
        slot.result = { ...command.payload, execution_authorized: false, outcome: "cancelled_before_start", closed: true, reason: "Original H4 stop preceded admission" };
        persistImportedDesignReviewResult(options.runtime, permit, slot.result); slot.persisted = true;
      }
      slot.controller.abort(); await slot.work; await ack(command.id, slot); await emit(command.id, slot); return true;
    },
    invalidate() { invalidated = true; for (const slot of slots.values()) slot.controller.abort(); },
    readCompletedAcceptedDesignReview(reviewId: string, requestDigest: string): ImportedDesignReviewResultV1 {
      current(); const slot = slots.get(reviewId);
      if (!slot?.persisted || !slot.result || slot.control.request_digest !== requestDigest
        || slot.acknowledged !== sha(canonical(slot.result))) throw Error("H5 requires original persisted H4 and its current-session accepted receipt");
      readCompletedAcceptedImportedDesignReview(options.runtime, slot.result); return slot.result;
    },
    async settled() { await Promise.all([...slots.values()].map(slot => slot.work)); },
  };
}
