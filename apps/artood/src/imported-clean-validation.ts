import { createHash } from "node:crypto";
import { canonicalProductSourceTransferValueV1 as canonical, importedCleanValidationRequestDigestV1, importedCleanValidationReviewRequestDigestV1,
  type ImportedCleanValidationControlV1, type ImportedCleanValidationRequestV1, type ImportedCleanValidationResultV1, type ImportedCleanValidationSourceV1,
  type ImportedCleanValidationReviewControlV1, type ImportedCleanValidationReviewResultV1, type ProductReleaseRequest } from "@artoo/domain";
import { importedCleanValidationCommandSchema, importedCleanValidationStopSchema, importedCleanValidationStatusSchema, importedCleanValidationReceiptSchema,
  importedCleanValidationReviewCommandSchema, importedCleanValidationReviewStopSchema, importedCleanValidationReviewStatusSchema, importedCleanValidationReviewReceiptSchema,
  type ImportedCleanValidationCommand, type ImportedCleanValidationReviewCommand, type ServerToNodeMessage, type NodeSideTransport, type RuntimeAdapter } from "@artoo/protocol";
import { reserveImportedCleanValidation, runImportedCleanValidation, failUnstartedImportedCleanValidation, persistImportedCleanValidationResult, readCompletedImportedCleanValidation,
  reserveImportedCleanValidationReview, runImportedCleanValidationReview, persistImportedCleanValidationReviewResult, readCompletedImportedCleanValidationReview,
  prepareCleanValidationRelease, type PreparedImportedCleanValidation, type PreparedImportedCleanValidationReview, type PreparedWindowsCleanValidationRuntime } from "./windows-clean-validation-runtime.js";
import { createImportedAuthorEmitter } from "./imported-author-execution.js";
import type { PreparedCleanDaemonCheckpoint } from "./windows-clean-daemon-client.js";
import type { ArtifactUploader } from "./artifact-upload.js";
import type { PreparedProductReleaseRetry } from "./product-release.js";
const sha = (value: string | Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const hash = (value: unknown) => sha(canonical(value));
const reason = (error: unknown) => (error instanceof Error ? error.message : "Validation unavailable").slice(0, 2000) || "Validation unavailable";

/** Session slots retain original node objects. Wire projections never reconstruct completed owners. */
export function createImportedCleanValidationClient(options: { nodeId: string; runtime: PreparedWindowsCleanValidationRuntime;
  clean: { readAccepted(request: ImportedCleanValidationRequestV1): PreparedCleanDaemonCheckpoint; assertAccepted(request: ImportedCleanValidationRequestV1, original: PreparedCleanDaemonCheckpoint): void }; transport: NodeSideTransport;
  resolveAdapter: (runtime: string) => RuntimeAdapter | undefined; isCurrent: () => boolean; uploadArtifact?: ArtifactUploader }) {
  if (options.transport.acknowledgesRunEvents !== true) throw Error("Validation requires committed run-event receipts");
  type AuthorSlot = { control: ImportedCleanValidationControlV1; permit: PreparedImportedCleanValidation; controller: AbortController;
    work?: Promise<void>; result?: ImportedCleanValidationResultV1; persisted?: boolean; delivered?: boolean; acknowledged?: string };
  type ReviewSlot = { control: ImportedCleanValidationReviewControlV1; permit: PreparedImportedCleanValidationReview; controller: AbortController;
    work?: Promise<void>; result?: ImportedCleanValidationReviewResultV1; persisted?: boolean; delivered?: boolean; acknowledged?: string };
  const authors = new Map<string, AuthorSlot>(), reviews = new Map<string, ReviewSlot>(); let invalidated = false;
  const current = () => { if (invalidated || !options.isCurrent()) throw Error("Validation session invalidated"); };
  const same = (slot: AuthorSlot | ReviewSlot, control: ImportedCleanValidationControlV1 | ImportedCleanValidationReviewControlV1) => {
    if (canonical(slot.control) !== canonical(control)) throw Error("Validation control changed its exact request or run");
  };
  const reusable = (result: ImportedCleanValidationResultV1) => result.outcome === "finished" || result.outcome === "failed" && !!result.closed_failure;
  const ackAuthor = async (id: string, slot: AuthorSlot) => { current(); await options.transport.send({ kind: "product.source.clean-validation.ack.v1",
    node_id: options.nodeId, command_id: id, payload: slot.control, status: "accepted" }); };
  const ackReview = async (id: string, slot: ReviewSlot) => { current(); await options.transport.send({ kind: "product.source.clean-validation-review.ack.v1",
    node_id: options.nodeId, command_id: id, payload: slot.control, status: "accepted" }); };
  const emitAuthor = async (id: string, slot: AuthorSlot) => {
    if (!slot.persisted || !slot.result) return; current();
    await options.transport.send({ kind: "product.source.clean-validation.result.v1", node_id: options.nodeId, command_id: id, payload: slot.result }); current();
    if (!slot.delivered && reusable(slot.result)) readCompletedImportedCleanValidation(options.runtime, slot.result);
    slot.delivered = true;
  };
  const emitReview = async (id: string, slot: ReviewSlot) => {
    if (!slot.persisted || !slot.result) return; current();
    await options.transport.send({ kind: "product.source.clean-validation-review.result.v1", node_id: options.nodeId, command_id: id, payload: slot.result }); current();
    if (!slot.delivered && slot.result.closed && (slot.result.outcome === "reviewed" || slot.result.outcome === "failed")) readCompletedImportedCleanValidationReview(options.runtime, slot.result);
    slot.delivered = true;
  };
  function originalAuthor(source: ImportedCleanValidationSourceV1) {
    current(); const slot = authors.get(source.validation_id);
    if (!slot?.persisted || !slot.result || slot.control.request_digest !== source.request_digest || slot.acknowledged !== source.result_digest
      || hash(slot.result) !== source.result_digest) throw Error("Validation source requires its original accepted author receipt");
    const actual = readCompletedImportedCleanValidation(options.runtime, slot.result);
    if (canonical(actual) !== canonical(source)) throw Error("Validation source differs from its original node projection"); return slot.result;
  }
  function assertAuthorReceipt(source: ImportedCleanValidationSourceV1, original: ImportedCleanValidationResultV1) {
    current(); const slot = authors.get(source.validation_id);
    if (!slot?.persisted || slot.result !== original || slot.control.request_digest !== source.request_digest
      || slot.acknowledged !== source.result_digest || hash(original) !== source.result_digest) throw Error("Original validation author receipt is no longer accepted");
  }
  function originalReview(reviewId: string, requestDigest: string, resultDigest: string) {
    current(); const slot = reviews.get(reviewId);
    if (!slot?.persisted || !slot.result || slot.control.request_digest !== requestDigest || slot.acknowledged !== resultDigest || hash(slot.result) !== resultDigest)
      throw Error("Validation continuation requires its original accepted review result receipt");
    readCompletedImportedCleanValidationReview(options.runtime, slot.result); return slot.result;
  }
  function assertReviewReceipt(reviewId: string, requestDigest: string, resultDigest: string, original: ImportedCleanValidationReviewResultV1) {
    current(); const slot = reviews.get(reviewId);
    if (!slot?.persisted || slot.result !== original || slot.control.request_digest !== requestDigest || slot.acknowledged !== resultDigest || hash(original) !== resultDigest)
      throw Error("Original validation review receipt is no longer accepted");
  }
  function predecessor(request: ImportedCleanValidationRequestV1) {
    if (request.kind === "initial") {
      const original = options.clean.readAccepted(request);
      return { original, assertReceipt: () => { current(); options.clean.assertAccepted(request, original); } };
    }
    if (!request.previous_source || !request.predecessor) throw Error("Recovery validation repair requires its exact previous source");
    const source = request.previous_source;
    if (request.predecessor.kind === "failure") {
      const original = originalAuthor(source);
      if (original.outcome !== "failed" || !original.closed_failure) throw Error("Generic author failure cannot authorize validation repair");
      return { original, assertReceipt: () => assertAuthorReceipt(source, original) };
    }
    const reference = request.predecessor, original = originalReview(reference.review_id, reference.request_digest, reference.result_digest);
    if (original.outcome !== "reviewed" || original.verdict.outcome !== "rejected") throw Error("Validation repair requires a rejected complete product review");
    return { original, assertReceipt: () => assertReviewReceipt(reference.review_id, reference.request_digest, reference.result_digest, original) };
  }
  function node(request: ImportedCleanValidationRequestV1 | ImportedCleanValidationReviewCommand["payload"]) {
    if (request.origin.execution_request.review_request.continuation_request.review_request.operation.intent.request.byte_request.destination.node_id !== options.nodeId)
      throw Error("Validation belongs to a different destination node");
  }
  async function startAuthor(command: ImportedCleanValidationCommand) {
    const request = command.payload, start = request.run_start, control: ImportedCleanValidationControlV1 = { version: 1, validation_id: request.validation_id,
      request_digest: importedCleanValidationRequestDigestV1(request, sha), run_id: start.run_id };
    if (command.deadline_at && Date.parse(command.deadline_at) <= Date.now()) throw Error("Validation command deadline expired"); node(request);
    const prior = authors.get(control.validation_id); if (prior) { same(prior, control); await ackAuthor(command.id, prior); await prior.work; await emitAuthor(command.id, prior); return; }
    const previous = predecessor(request), adapter = options.resolveAdapter(start.runtime);
    if (!adapter) throw Error("Validation writer runtime is not configured"); current();
    const permit = reserveImportedCleanValidation(options.runtime, control, "start"), slot: AuthorSlot = { control, permit, controller: new AbortController() };
    authors.set(control.validation_id, slot);
    slot.work = (async () => {
      let entered = false;
      const emit = createImportedAuthorEmitter({ nodeId: options.nodeId, transport: options.transport, start, current, uploadArtifact: options.uploadArtifact });
      try {
        await ackAuthor(command.id, slot); current();
        if (predecessor(request).original !== previous.original) throw Error("Validation predecessor changed during acknowledgement");
        entered = true; slot.result = await runImportedCleanValidation(options.runtime, permit, previous.original, request, adapter, slot.controller.signal, previous.assertReceipt, emit);
      } catch (error) { slot.result = !entered ? await failUnstartedImportedCleanValidation(options.runtime, permit, error, emit)
        : { ...control, outcome: "uncertain", closed: false, reason: reason(error) }; }
      persistImportedCleanValidationResult(options.runtime, permit, slot.result); slot.persisted = true;
    })();
    await slot.work; if (!invalidated && options.isCurrent()) await emitAuthor(command.id, slot);
  }
  async function startReview(command: ImportedCleanValidationReviewCommand) {
    const request = command.payload, control: ImportedCleanValidationReviewControlV1 = { version: 1, review_id: request.review_id,
      request_digest: importedCleanValidationReviewRequestDigestV1(request, sha) };
    if (command.deadline_at && Date.parse(command.deadline_at) <= Date.now()) throw Error("Validation review deadline expired"); node(request);
    const prior = reviews.get(control.review_id); if (prior) { same(prior, control); await ackReview(command.id, prior); await prior.work; await emitReview(command.id, prior); return; }
    const original = originalAuthor(request.source), retry = request.retry_of;
    const retryOriginal = retry ? originalReview(retry.review_id, retry.request_digest, retry.result_digest) : undefined;
    const adapter = options.resolveAdapter(request.review_start.runtime); if (!adapter) throw Error("Validation reviewer runtime is not configured"); current();
    const permit = reserveImportedCleanValidationReview(options.runtime, control, "start"), slot: ReviewSlot = { control, permit, controller: new AbortController() };
    reviews.set(control.review_id, slot);
    const assertReceipt = () => { assertAuthorReceipt(request.source, original); if (retry && retryOriginal) assertReviewReceipt(retry.review_id, retry.request_digest, retry.result_digest, retryOriginal); };
    slot.work = (async () => {
      try { await ackReview(command.id, slot); current();
        if (originalAuthor(request.source) !== original || retry && originalReview(retry.review_id, retry.request_digest, retry.result_digest) !== retryOriginal)
          throw Error("Validation review source changed during acknowledgement");
        slot.result = await runImportedCleanValidationReview(options.runtime, permit, original, request, adapter, slot.controller.signal, assertReceipt, retryOriginal);
      } catch (error) { slot.result = { ...control, execution_authorized: false, outcome: "uncertain", closed: false, reason: reason(error) }; }
      persistImportedCleanValidationReviewResult(options.runtime, permit, slot.result); slot.persisted = true;
    })();
    await slot.work; if (!invalidated && options.isCurrent()) await emitReview(command.id, slot);
  }
  return {
    prepareRelease(request: ProductReleaseRequest, retry?: PreparedProductReleaseRetry) {
      const origin = request.imported_clean; if (!origin) throw Error("Imported publication origin is required");
      const original = originalReview(origin.review_id, origin.review_request_digest, origin.review_result_digest);
      if (original.outcome !== "reviewed" || original.verdict.outcome !== "accepted") throw Error("Publication requires the accepted complete product verdict");
      return prepareCleanValidationRelease(options.runtime, original, request,
        () => assertReviewReceipt(origin.review_id, origin.review_request_digest, origin.review_result_digest, original), retry);
    },
    async handle(input: ServerToNodeMessage): Promise<boolean> {
      const author = input.type.startsWith("product.source.clean-validation."), review = input.type.startsWith("product.source.clean-validation-review.");
      if (!author && !review) return false; current();
      if (input.type === "product.source.clean-validation.v1") { await startAuthor(importedCleanValidationCommandSchema.parse(input)); return true; }
      if (input.type === "product.source.clean-validation-review.v1") { await startReview(importedCleanValidationReviewCommandSchema.parse(input)); return true; }
      if (input.type === "product.source.clean-validation.receipt.v1") {
        const receipt = importedCleanValidationReceiptSchema.parse(input), slot = authors.get(receipt.payload.validation_id);
        if (!slot) throw Error("Original validation result is unavailable"); same(slot, receipt.payload);
        if (!slot.persisted || !slot.result || hash(slot.result) !== receipt.result_digest) throw Error("Validation receipt changed its persisted result");
        if (receipt.status === "accepted" && slot.acknowledged !== receipt.result_digest && reusable(slot.result)) readCompletedImportedCleanValidation(options.runtime, slot.result);
        slot.acknowledged = receipt.status === "accepted" ? receipt.result_digest : undefined; return true;
      }
      if (input.type === "product.source.clean-validation-review.receipt.v1") {
        const receipt = importedCleanValidationReviewReceiptSchema.parse(input), slot = reviews.get(receipt.payload.review_id);
        if (!slot) throw Error("Original validation review is unavailable"); same(slot, receipt.payload);
        if (!slot.persisted || !slot.result || hash(slot.result) !== receipt.result_digest) throw Error("Validation review receipt changed its persisted result");
        if (receipt.status === "accepted" && slot.acknowledged !== receipt.result_digest && slot.result.closed
          && (slot.result.outcome === "reviewed" || slot.result.outcome === "failed")) readCompletedImportedCleanValidationReview(options.runtime, slot.result);
        slot.acknowledged = receipt.status === "accepted" ? receipt.result_digest : undefined; return true;
      }
      if (author) {
        const command = input.type === "product.source.clean-validation.stop.v1" ? importedCleanValidationStopSchema.parse(input) : importedCleanValidationStatusSchema.parse(input);
        let slot = authors.get(command.payload.validation_id); if (slot) same(slot, command.payload);
        if (input.type === "product.source.clean-validation.status.v1") {
          if (!slot) throw Error("Original validation owner is unavailable; recovery required"); await ackAuthor(command.id, slot); await slot.work; await emitAuthor(command.id, slot); return true;
        }
        if (!slot) { const permit = reserveImportedCleanValidation(options.runtime, command.payload, "stop"); slot = { control: command.payload, permit, controller: new AbortController(),
          result: { ...command.payload, outcome: "cancelled_before_start", closed: true } }; authors.set(command.payload.validation_id, slot);
          persistImportedCleanValidationResult(options.runtime, permit, slot.result!); slot.persisted = true; }
        slot.controller.abort(); await slot.work; await ackAuthor(command.id, slot); await emitAuthor(command.id, slot); return true;
      }
      const command = input.type === "product.source.clean-validation-review.stop.v1" ? importedCleanValidationReviewStopSchema.parse(input) : importedCleanValidationReviewStatusSchema.parse(input);
      let slot = reviews.get(command.payload.review_id); if (slot) same(slot, command.payload);
      if (input.type === "product.source.clean-validation-review.status.v1") {
        if (!slot) throw Error("Original validation review owner is unavailable; recovery required"); await ackReview(command.id, slot); await slot.work; await emitReview(command.id, slot); return true;
      }
      if (!slot) { const permit = reserveImportedCleanValidationReview(options.runtime, command.payload, "stop"); slot = { control: command.payload, permit, controller: new AbortController(),
        result: { ...command.payload, execution_authorized: false, outcome: "cancelled_before_start", closed: true, reason: "Cancelled before validation review admission" } };
        reviews.set(command.payload.review_id, slot); persistImportedCleanValidationReviewResult(options.runtime, permit, slot.result!); slot.persisted = true; }
      slot.controller.abort(); await slot.work; await ackReview(command.id, slot); await emitReview(command.id, slot); return true;
    },
    invalidate() { invalidated = true; for (const slot of [...authors.values(), ...reviews.values()]) slot.controller.abort(); },
    async settled() { await Promise.all([...authors.values(), ...reviews.values()].map(slot => slot.work)); },
  };
}
