import { createHash } from "node:crypto";
import { canonicalProductSourceTransferValueV1 as canonical, importedValidationRequestDigestV1, importedValidationReviewRequestDigestV1,
  type ImportedValidationControlV1, type ImportedValidationRequestV1, type ImportedValidationResultV1, type ImportedValidationSourceV1,
  type ImportedValidationReviewControlV1, type ImportedValidationReviewResultV1, type ProductReleaseRequest } from "@artoo/domain";
import { importedValidationCommandSchema, importedValidationStopSchema, importedValidationStatusSchema, importedValidationReceiptSchema,
  importedValidationReviewCommandSchema, importedValidationReviewStopSchema, importedValidationReviewStatusSchema, importedValidationReviewReceiptSchema,
  type ImportedValidationCommand, type ImportedValidationReviewCommand, type ServerToNodeMessage, type NodeSideTransport, type RuntimeAdapter } from "@artoo/protocol";
import { reserveImportedValidation, runImportedValidation, failUnstartedImportedValidation, persistImportedValidationResult, readCompletedImportedValidation,
  reserveImportedValidationReview, runImportedValidationReview, persistImportedValidationReviewResult, readCompletedImportedValidationReview,
  prepareImportedValidationRelease, type PreparedImportedValidation, type PreparedImportedValidationReview, type PreparedProductSourceRuntime } from "./product-source-runtime.js";
import { createImportedAuthorEmitter } from "./imported-author-execution.js";
import type { createImportedExecutionReviewClient } from "./imported-execution-review.js";
import type { ArtifactUploader } from "./artifact-upload.js";
import type { PreparedProductReleaseRetry } from "./product-release.js";
const sha = (value: string | Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const hash = (value: unknown) => sha(canonical(value));
const reason = (error: unknown) => (error instanceof Error ? error.message : "Validation unavailable").slice(0, 2000) || "Validation unavailable";

/** Session slots retain original node objects. Wire projections never reconstruct completed owners. */
export function createImportedValidationClient(options: { nodeId: string; runtime: PreparedProductSourceRuntime;
  implementations: ReturnType<typeof createImportedExecutionReviewClient>; transport: NodeSideTransport;
  resolveAdapter: (runtime: string) => RuntimeAdapter | undefined; isCurrent: () => boolean; uploadArtifact?: ArtifactUploader }) {
  if (options.transport.acknowledgesRunEvents !== true) throw Error("Validation requires committed run-event receipts");
  type AuthorSlot = { control: ImportedValidationControlV1; permit: PreparedImportedValidation; controller: AbortController;
    work?: Promise<void>; result?: ImportedValidationResultV1; persisted?: boolean; delivered?: boolean; acknowledged?: string };
  type ReviewSlot = { control: ImportedValidationReviewControlV1; permit: PreparedImportedValidationReview; controller: AbortController;
    work?: Promise<void>; result?: ImportedValidationReviewResultV1; persisted?: boolean; delivered?: boolean; acknowledged?: string };
  const authors = new Map<string, AuthorSlot>(), reviews = new Map<string, ReviewSlot>(); let invalidated = false;
  const current = () => { if (invalidated || !options.isCurrent()) throw Error("Validation session invalidated"); };
  const same = (slot: AuthorSlot | ReviewSlot, control: ImportedValidationControlV1 | ImportedValidationReviewControlV1) => {
    if (canonical(slot.control) !== canonical(control)) throw Error("Validation control changed its exact request or run");
  };
  const reusable = (result: ImportedValidationResultV1) => result.outcome === "finished" || result.outcome === "failed" && !!result.closed_failure;
  const ackAuthor = async (id: string, slot: AuthorSlot) => { current(); await options.transport.send({ kind: "product.source.validation.ack.v1",
    node_id: options.nodeId, command_id: id, payload: slot.control, status: "accepted" }); };
  const ackReview = async (id: string, slot: ReviewSlot) => { current(); await options.transport.send({ kind: "product.source.validation-review.ack.v1",
    node_id: options.nodeId, command_id: id, payload: slot.control, status: "accepted" }); };
  const emitAuthor = async (id: string, slot: AuthorSlot) => {
    if (!slot.persisted || !slot.result) return; current();
    await options.transport.send({ kind: "product.source.validation.result.v1", node_id: options.nodeId, command_id: id, payload: slot.result }); current();
    if (!slot.delivered && reusable(slot.result)) readCompletedImportedValidation(options.runtime, slot.result);
    slot.delivered = true;
  };
  const emitReview = async (id: string, slot: ReviewSlot) => {
    if (!slot.persisted || !slot.result) return; current();
    await options.transport.send({ kind: "product.source.validation-review.result.v1", node_id: options.nodeId, command_id: id, payload: slot.result }); current();
    if (!slot.delivered && slot.result.closed && (slot.result.outcome === "reviewed" || slot.result.outcome === "failed")) readCompletedImportedValidationReview(options.runtime, slot.result);
    slot.delivered = true;
  };
  function originalAuthor(source: ImportedValidationSourceV1) {
    current(); const slot = authors.get(source.validation_id);
    if (!slot?.persisted || !slot.result || slot.control.request_digest !== source.request_digest || slot.acknowledged !== source.result_digest
      || hash(slot.result) !== source.result_digest) throw Error("Validation source requires its original accepted author receipt");
    const actual = readCompletedImportedValidation(options.runtime, slot.result);
    if (canonical(actual) !== canonical(source)) throw Error("Validation source differs from its original node projection"); return slot.result;
  }
  function assertAuthorReceipt(source: ImportedValidationSourceV1, original: ImportedValidationResultV1) {
    current(); const slot = authors.get(source.validation_id);
    if (!slot?.persisted || slot.result !== original || slot.control.request_digest !== source.request_digest
      || slot.acknowledged !== source.result_digest || hash(original) !== source.result_digest) throw Error("Original validation author receipt is no longer accepted");
  }
  function originalReview(reviewId: string, requestDigest: string, resultDigest: string) {
    current(); const slot = reviews.get(reviewId);
    if (!slot?.persisted || !slot.result || slot.control.request_digest !== requestDigest || slot.acknowledged !== resultDigest || hash(slot.result) !== resultDigest)
      throw Error("Validation continuation requires its original accepted review result receipt");
    readCompletedImportedValidationReview(options.runtime, slot.result); return slot.result;
  }
  function assertReviewReceipt(reviewId: string, requestDigest: string, resultDigest: string, original: ImportedValidationReviewResultV1) {
    current(); const slot = reviews.get(reviewId);
    if (!slot?.persisted || slot.result !== original || slot.control.request_digest !== requestDigest || slot.acknowledged !== resultDigest || hash(original) !== resultDigest)
      throw Error("Original validation review receipt is no longer accepted");
  }
  function predecessor(request: ImportedValidationRequestV1) {
    if (request.kind === "initial") {
      const origin = request.origin, original = options.implementations.readCompletedAcceptedReview(origin.review_id, origin.request_digest, origin.result_digest);
      return { original, assertReceipt: () => { current(); options.implementations.assertCompletedAcceptedReviewReceipt(origin.review_id, origin.request_digest, origin.result_digest, original); } };
    }
    if (request.source.kind !== "validation" || !request.predecessor) throw Error("Validation repair requires its exact H7 source");
    const source = request.source;
    if (request.predecessor.kind === "failure") {
      const original = originalAuthor(source);
      if (original.outcome !== "failed" || !original.closed_failure) throw Error("Generic author failure cannot authorize validation repair");
      return { original, assertReceipt: () => assertAuthorReceipt(source, original) };
    }
    const reference = request.predecessor.review, original = originalReview(reference.review_id, reference.request_digest, reference.result_digest);
    if (original.outcome !== "reviewed" || original.verdict.outcome !== "rejected") throw Error("Validation repair requires a rejected complete product review");
    return { original, assertReceipt: () => assertReviewReceipt(reference.review_id, reference.request_digest, reference.result_digest, original) };
  }
  function node(request: ImportedValidationRequestV1 | ImportedValidationReviewCommand["payload"]) {
    if (request.origin.execution_request.review_request.continuation_request.review_request.operation.intent.request.byte_request.destination.node_id !== options.nodeId)
      throw Error("Validation belongs to a different destination node");
  }
  async function startAuthor(command: ImportedValidationCommand) {
    const request = command.payload, start = request.run_start, control: ImportedValidationControlV1 = { version: 1, validation_id: request.validation_id,
      request_digest: importedValidationRequestDigestV1(request, sha), run_id: start.run_id };
    if (command.deadline_at && Date.parse(command.deadline_at) <= Date.now()) throw Error("Validation command deadline expired"); node(request);
    const prior = authors.get(control.validation_id); if (prior) { same(prior, control); await ackAuthor(command.id, prior); await prior.work; await emitAuthor(command.id, prior); return; }
    const previous = predecessor(request), adapter = options.resolveAdapter(start.runtime);
    if (!adapter) throw Error("Validation writer runtime is not configured"); current();
    const permit = reserveImportedValidation(options.runtime, control, "start"), slot: AuthorSlot = { control, permit, controller: new AbortController() };
    authors.set(control.validation_id, slot);
    slot.work = (async () => {
      let entered = false;
      const emit = createImportedAuthorEmitter({ nodeId: options.nodeId, transport: options.transport, start, current, uploadArtifact: options.uploadArtifact });
      try {
        await ackAuthor(command.id, slot); current();
        if (predecessor(request).original !== previous.original) throw Error("Validation predecessor changed during acknowledgement");
        entered = true; slot.result = await runImportedValidation(options.runtime, permit, previous.original, request, adapter, slot.controller.signal, previous.assertReceipt, emit);
      } catch (error) { slot.result = !entered ? await failUnstartedImportedValidation(options.runtime, permit, error, emit)
        : { ...control, outcome: "uncertain", closed: false, reason: reason(error) }; }
      persistImportedValidationResult(options.runtime, permit, slot.result); slot.persisted = true;
    })();
    await slot.work; if (!invalidated && options.isCurrent()) await emitAuthor(command.id, slot);
  }
  async function startReview(command: ImportedValidationReviewCommand) {
    const request = command.payload, control: ImportedValidationReviewControlV1 = { version: 1, review_id: request.review_id,
      request_digest: importedValidationReviewRequestDigestV1(request, sha) };
    if (command.deadline_at && Date.parse(command.deadline_at) <= Date.now()) throw Error("Validation review deadline expired"); node(request);
    const prior = reviews.get(control.review_id); if (prior) { same(prior, control); await ackReview(command.id, prior); await prior.work; await emitReview(command.id, prior); return; }
    const original = originalAuthor(request.source), retry = request.retry_of;
    const retryOriginal = retry ? originalReview(retry.review_id, retry.request_digest, retry.result_digest) : undefined;
    const adapter = options.resolveAdapter(request.review_start.runtime); if (!adapter) throw Error("Validation reviewer runtime is not configured"); current();
    const permit = reserveImportedValidationReview(options.runtime, control, "start"), slot: ReviewSlot = { control, permit, controller: new AbortController() };
    reviews.set(control.review_id, slot);
    const assertReceipt = () => { assertAuthorReceipt(request.source, original); if (retry && retryOriginal) assertReviewReceipt(retry.review_id, retry.request_digest, retry.result_digest, retryOriginal); };
    slot.work = (async () => {
      try { await ackReview(command.id, slot); current();
        if (originalAuthor(request.source) !== original || retry && originalReview(retry.review_id, retry.request_digest, retry.result_digest) !== retryOriginal)
          throw Error("Validation review source changed during acknowledgement");
        slot.result = await runImportedValidationReview(options.runtime, permit, original, request, adapter, slot.controller.signal, assertReceipt, retryOriginal);
      } catch (error) { slot.result = { ...control, execution_authorized: false, outcome: "uncertain", closed: false, reason: reason(error) }; }
      persistImportedValidationReviewResult(options.runtime, permit, slot.result); slot.persisted = true;
    })();
    await slot.work; if (!invalidated && options.isCurrent()) await emitReview(command.id, slot);
  }
  return {
    prepareRelease(request: ProductReleaseRequest, retry?: PreparedProductReleaseRetry) {
      const origin = request.imported_validation; if (!origin) throw Error("Imported publication origin is required");
      const original = originalReview(origin.review_id, origin.review_request_digest, origin.review_result_digest);
      if (original.outcome !== "reviewed" || original.verdict.outcome !== "accepted") throw Error("Publication requires the accepted complete product verdict");
      return prepareImportedValidationRelease(options.runtime, original, request,
        () => assertReviewReceipt(origin.review_id, origin.review_request_digest, origin.review_result_digest, original), retry);
    },
    async handle(input: ServerToNodeMessage): Promise<boolean> {
      const author = input.type.startsWith("product.source.validation."), review = input.type.startsWith("product.source.validation-review.");
      if (!author && !review) return false; current();
      if (input.type === "product.source.validation.v1") { await startAuthor(importedValidationCommandSchema.parse(input)); return true; }
      if (input.type === "product.source.validation-review.v1") { await startReview(importedValidationReviewCommandSchema.parse(input)); return true; }
      if (input.type === "product.source.validation.receipt.v1") {
        const receipt = importedValidationReceiptSchema.parse(input), slot = authors.get(receipt.payload.validation_id);
        if (!slot) throw Error("Original validation result is unavailable"); same(slot, receipt.payload);
        if (!slot.persisted || !slot.result || hash(slot.result) !== receipt.result_digest) throw Error("Validation receipt changed its persisted result");
        if (receipt.status === "accepted" && slot.acknowledged !== receipt.result_digest && reusable(slot.result)) readCompletedImportedValidation(options.runtime, slot.result);
        slot.acknowledged = receipt.status === "accepted" ? receipt.result_digest : undefined; return true;
      }
      if (input.type === "product.source.validation-review.receipt.v1") {
        const receipt = importedValidationReviewReceiptSchema.parse(input), slot = reviews.get(receipt.payload.review_id);
        if (!slot) throw Error("Original validation review is unavailable"); same(slot, receipt.payload);
        if (!slot.persisted || !slot.result || hash(slot.result) !== receipt.result_digest) throw Error("Validation review receipt changed its persisted result");
        if (receipt.status === "accepted" && slot.acknowledged !== receipt.result_digest && slot.result.closed
          && (slot.result.outcome === "reviewed" || slot.result.outcome === "failed")) readCompletedImportedValidationReview(options.runtime, slot.result);
        slot.acknowledged = receipt.status === "accepted" ? receipt.result_digest : undefined; return true;
      }
      if (author) {
        const command = input.type === "product.source.validation.stop.v1" ? importedValidationStopSchema.parse(input) : importedValidationStatusSchema.parse(input);
        let slot = authors.get(command.payload.validation_id); if (slot) same(slot, command.payload);
        if (input.type === "product.source.validation.status.v1") {
          if (!slot) throw Error("Original validation owner is unavailable; recovery required"); await ackAuthor(command.id, slot); await slot.work; await emitAuthor(command.id, slot); return true;
        }
        if (!slot) { const permit = reserveImportedValidation(options.runtime, command.payload, "stop"); slot = { control: command.payload, permit, controller: new AbortController(),
          result: { ...command.payload, outcome: "cancelled_before_start", closed: true } }; authors.set(command.payload.validation_id, slot);
          persistImportedValidationResult(options.runtime, permit, slot.result!); slot.persisted = true; }
        slot.controller.abort(); await slot.work; await ackAuthor(command.id, slot); await emitAuthor(command.id, slot); return true;
      }
      const command = input.type === "product.source.validation-review.stop.v1" ? importedValidationReviewStopSchema.parse(input) : importedValidationReviewStatusSchema.parse(input);
      let slot = reviews.get(command.payload.review_id); if (slot) same(slot, command.payload);
      if (input.type === "product.source.validation-review.status.v1") {
        if (!slot) throw Error("Original validation review owner is unavailable; recovery required"); await ackReview(command.id, slot); await slot.work; await emitReview(command.id, slot); return true;
      }
      if (!slot) { const permit = reserveImportedValidationReview(options.runtime, command.payload, "stop"); slot = { control: command.payload, permit, controller: new AbortController(),
        result: { ...command.payload, execution_authorized: false, outcome: "cancelled_before_start", closed: true, reason: "Cancelled before validation review admission" } };
        reviews.set(command.payload.review_id, slot); persistImportedValidationReviewResult(options.runtime, permit, slot.result!); slot.persisted = true; }
      slot.controller.abort(); await slot.work; await ackReview(command.id, slot); await emitReview(command.id, slot); return true;
    },
    invalidate() { invalidated = true; for (const slot of [...authors.values(), ...reviews.values()]) slot.controller.abort(); },
    async settled() { await Promise.all([...authors.values(), ...reviews.values()].map(slot => slot.work)); },
  };
}
