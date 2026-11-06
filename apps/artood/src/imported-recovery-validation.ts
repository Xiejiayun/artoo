import { createHash } from "node:crypto";
import { canonicalProductSourceTransferValueV1 as canonical, importedRecoveryValidationRequestDigestV1, importedRecoveryValidationReviewRequestDigestV1,
  type ImportedRecoveryValidationControlV1, type ImportedRecoveryValidationRequestV1, type ImportedRecoveryValidationResultV1, type ImportedRecoveryValidationSourceV1,
  type ImportedRecoveryValidationReviewControlV1, type ImportedRecoveryValidationReviewResultV1, type ProductReleaseRequest } from "@artoo/domain";
import { importedRecoveryValidationCommandSchema, importedRecoveryValidationStopSchema, importedRecoveryValidationStatusSchema, importedRecoveryValidationReceiptSchema,
  importedRecoveryValidationReviewCommandSchema, importedRecoveryValidationReviewStopSchema, importedRecoveryValidationReviewStatusSchema, importedRecoveryValidationReviewReceiptSchema,
  type ImportedRecoveryValidationCommand, type ImportedRecoveryValidationReviewCommand, type ServerToNodeMessage, type NodeSideTransport, type RuntimeAdapter } from "@artoo/protocol";
import { reserveImportedRecoveryValidation, runImportedRecoveryValidation, failUnstartedImportedRecoveryValidation, persistImportedRecoveryValidationResult, readCompletedImportedRecoveryValidation,
  reserveImportedRecoveryValidationReview, runImportedRecoveryValidationReview, persistImportedRecoveryValidationReviewResult, readCompletedImportedRecoveryValidationReview,
  prepareRecoveryValidationRelease, type PreparedImportedRecoveryValidation, type PreparedImportedRecoveryValidationReview, type PreparedWindowsSourceRecoveryRuntime } from "./windows-source-recovery.js";
import { createImportedAuthorEmitter } from "./imported-author-execution.js";
import type { PreparedRecoveredWorkspace } from "./windows-source-recovery.js";
import type { ArtifactUploader } from "./artifact-upload.js";
import type { PreparedProductReleaseRetry } from "./product-release.js";
const sha = (value: string | Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const hash = (value: unknown) => sha(canonical(value));
const reason = (error: unknown) => (error instanceof Error ? error.message : "Validation unavailable").slice(0, 2000) || "Validation unavailable";

/** Session slots retain original node objects. Wire projections never reconstruct completed owners. */
export function createImportedRecoveryValidationClient(options: { nodeId: string; runtime: PreparedWindowsSourceRecoveryRuntime;
  recovery: { readAccepted(request: ImportedRecoveryValidationRequestV1): PreparedRecoveredWorkspace; assertAccepted(request: ImportedRecoveryValidationRequestV1, original: PreparedRecoveredWorkspace): void }; transport: NodeSideTransport;
  resolveAdapter: (runtime: string) => RuntimeAdapter | undefined; isCurrent: () => boolean; uploadArtifact?: ArtifactUploader }) {
  if (options.transport.acknowledgesRunEvents !== true) throw Error("Validation requires committed run-event receipts");
  type AuthorSlot = { control: ImportedRecoveryValidationControlV1; permit: PreparedImportedRecoveryValidation; controller: AbortController;
    work?: Promise<void>; result?: ImportedRecoveryValidationResultV1; persisted?: boolean; delivered?: boolean; acknowledged?: string };
  type ReviewSlot = { control: ImportedRecoveryValidationReviewControlV1; permit: PreparedImportedRecoveryValidationReview; controller: AbortController;
    work?: Promise<void>; result?: ImportedRecoveryValidationReviewResultV1; persisted?: boolean; delivered?: boolean; acknowledged?: string };
  const authors = new Map<string, AuthorSlot>(), reviews = new Map<string, ReviewSlot>(); let invalidated = false;
  const current = () => { if (invalidated || !options.isCurrent()) throw Error("Validation session invalidated"); };
  const same = (slot: AuthorSlot | ReviewSlot, control: ImportedRecoveryValidationControlV1 | ImportedRecoveryValidationReviewControlV1) => {
    if (canonical(slot.control) !== canonical(control)) throw Error("Validation control changed its exact request or run");
  };
  const reusable = (result: ImportedRecoveryValidationResultV1) => result.outcome === "finished" || result.outcome === "failed" && !!result.closed_failure;
  const ackAuthor = async (id: string, slot: AuthorSlot) => { current(); await options.transport.send({ kind: "product.source.recovery-validation.ack.v1",
    node_id: options.nodeId, command_id: id, payload: slot.control, status: "accepted" }); };
  const ackReview = async (id: string, slot: ReviewSlot) => { current(); await options.transport.send({ kind: "product.source.recovery-validation-review.ack.v1",
    node_id: options.nodeId, command_id: id, payload: slot.control, status: "accepted" }); };
  const emitAuthor = async (id: string, slot: AuthorSlot) => {
    if (!slot.persisted || !slot.result) return; current();
    await options.transport.send({ kind: "product.source.recovery-validation.result.v1", node_id: options.nodeId, command_id: id, payload: slot.result }); current();
    if (!slot.delivered && reusable(slot.result)) readCompletedImportedRecoveryValidation(options.runtime, slot.result);
    slot.delivered = true;
  };
  const emitReview = async (id: string, slot: ReviewSlot) => {
    if (!slot.persisted || !slot.result) return; current();
    await options.transport.send({ kind: "product.source.recovery-validation-review.result.v1", node_id: options.nodeId, command_id: id, payload: slot.result }); current();
    if (!slot.delivered && slot.result.closed && (slot.result.outcome === "reviewed" || slot.result.outcome === "failed")) readCompletedImportedRecoveryValidationReview(options.runtime, slot.result);
    slot.delivered = true;
  };
  function originalAuthor(source: ImportedRecoveryValidationSourceV1) {
    current(); const slot = authors.get(source.validation_id);
    if (!slot?.persisted || !slot.result || slot.control.request_digest !== source.request_digest || slot.acknowledged !== source.result_digest
      || hash(slot.result) !== source.result_digest) throw Error("Validation source requires its original accepted author receipt");
    const actual = readCompletedImportedRecoveryValidation(options.runtime, slot.result);
    if (canonical(actual) !== canonical(source)) throw Error("Validation source differs from its original node projection"); return slot.result;
  }
  function assertAuthorReceipt(source: ImportedRecoveryValidationSourceV1, original: ImportedRecoveryValidationResultV1) {
    current(); const slot = authors.get(source.validation_id);
    if (!slot?.persisted || slot.result !== original || slot.control.request_digest !== source.request_digest
      || slot.acknowledged !== source.result_digest || hash(original) !== source.result_digest) throw Error("Original validation author receipt is no longer accepted");
  }
  function originalReview(reviewId: string, requestDigest: string, resultDigest: string) {
    current(); const slot = reviews.get(reviewId);
    if (!slot?.persisted || !slot.result || slot.control.request_digest !== requestDigest || slot.acknowledged !== resultDigest || hash(slot.result) !== resultDigest)
      throw Error("Validation continuation requires its original accepted review result receipt");
    readCompletedImportedRecoveryValidationReview(options.runtime, slot.result); return slot.result;
  }
  function assertReviewReceipt(reviewId: string, requestDigest: string, resultDigest: string, original: ImportedRecoveryValidationReviewResultV1) {
    current(); const slot = reviews.get(reviewId);
    if (!slot?.persisted || slot.result !== original || slot.control.request_digest !== requestDigest || slot.acknowledged !== resultDigest || hash(original) !== resultDigest)
      throw Error("Original validation review receipt is no longer accepted");
  }
  function predecessor(request: ImportedRecoveryValidationRequestV1) {
    if (request.kind === "initial") {
      const original = options.recovery.readAccepted(request);
      return { original, assertReceipt: () => { current(); options.recovery.assertAccepted(request, original); } };
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
  function node(request: ImportedRecoveryValidationRequestV1 | ImportedRecoveryValidationReviewCommand["payload"]) {
    if (request.origin.execution_request.review_request.continuation_request.review_request.operation.intent.request.byte_request.destination.node_id !== options.nodeId)
      throw Error("Validation belongs to a different destination node");
  }
  async function startAuthor(command: ImportedRecoveryValidationCommand) {
    const request = command.payload, start = request.run_start, control: ImportedRecoveryValidationControlV1 = { version: 1, validation_id: request.validation_id,
      request_digest: importedRecoveryValidationRequestDigestV1(request, sha), run_id: start.run_id };
    if (command.deadline_at && Date.parse(command.deadline_at) <= Date.now()) throw Error("Validation command deadline expired"); node(request);
    const prior = authors.get(control.validation_id); if (prior) { same(prior, control); await ackAuthor(command.id, prior); await prior.work; await emitAuthor(command.id, prior); return; }
    const previous = predecessor(request), adapter = options.resolveAdapter(start.runtime);
    if (!adapter) throw Error("Validation writer runtime is not configured"); current();
    const permit = reserveImportedRecoveryValidation(options.runtime, control, "start"), slot: AuthorSlot = { control, permit, controller: new AbortController() };
    authors.set(control.validation_id, slot);
    slot.work = (async () => {
      let entered = false;
      const emit = createImportedAuthorEmitter({ nodeId: options.nodeId, transport: options.transport, start, current, uploadArtifact: options.uploadArtifact });
      try {
        await ackAuthor(command.id, slot); current();
        if (predecessor(request).original !== previous.original) throw Error("Validation predecessor changed during acknowledgement");
        entered = true; slot.result = await runImportedRecoveryValidation(options.runtime, permit, previous.original, request, adapter, slot.controller.signal, previous.assertReceipt, emit);
      } catch (error) { slot.result = !entered ? await failUnstartedImportedRecoveryValidation(options.runtime, permit, error, emit)
        : { ...control, outcome: "uncertain", closed: false, reason: reason(error) }; }
      persistImportedRecoveryValidationResult(options.runtime, permit, slot.result); slot.persisted = true;
    })();
    await slot.work; if (!invalidated && options.isCurrent()) await emitAuthor(command.id, slot);
  }
  async function startReview(command: ImportedRecoveryValidationReviewCommand) {
    const request = command.payload, control: ImportedRecoveryValidationReviewControlV1 = { version: 1, review_id: request.review_id,
      request_digest: importedRecoveryValidationReviewRequestDigestV1(request, sha) };
    if (command.deadline_at && Date.parse(command.deadline_at) <= Date.now()) throw Error("Validation review deadline expired"); node(request);
    const prior = reviews.get(control.review_id); if (prior) { same(prior, control); await ackReview(command.id, prior); await prior.work; await emitReview(command.id, prior); return; }
    const original = originalAuthor(request.source), retry = request.retry_of;
    const retryOriginal = retry ? originalReview(retry.review_id, retry.request_digest, retry.result_digest) : undefined;
    const adapter = options.resolveAdapter(request.review_start.runtime); if (!adapter) throw Error("Validation reviewer runtime is not configured"); current();
    const permit = reserveImportedRecoveryValidationReview(options.runtime, control, "start"), slot: ReviewSlot = { control, permit, controller: new AbortController() };
    reviews.set(control.review_id, slot);
    const assertReceipt = () => { assertAuthorReceipt(request.source, original); if (retry && retryOriginal) assertReviewReceipt(retry.review_id, retry.request_digest, retry.result_digest, retryOriginal); };
    slot.work = (async () => {
      try { await ackReview(command.id, slot); current();
        if (originalAuthor(request.source) !== original || retry && originalReview(retry.review_id, retry.request_digest, retry.result_digest) !== retryOriginal)
          throw Error("Validation review source changed during acknowledgement");
        slot.result = await runImportedRecoveryValidationReview(options.runtime, permit, original, request, adapter, slot.controller.signal, assertReceipt, retryOriginal);
      } catch (error) { slot.result = { ...control, execution_authorized: false, outcome: "uncertain", closed: false, reason: reason(error) }; }
      persistImportedRecoveryValidationReviewResult(options.runtime, permit, slot.result); slot.persisted = true;
    })();
    await slot.work; if (!invalidated && options.isCurrent()) await emitReview(command.id, slot);
  }
  return {
    prepareRelease(request: ProductReleaseRequest, retry?: PreparedProductReleaseRetry) {
      const origin = request.imported_recovery; if (!origin) throw Error("Imported publication origin is required");
      const original = originalReview(origin.review_id, origin.review_request_digest, origin.review_result_digest);
      if (original.outcome !== "reviewed" || original.verdict.outcome !== "accepted") throw Error("Publication requires the accepted complete product verdict");
      return prepareRecoveryValidationRelease(options.runtime, original, request,
        () => assertReviewReceipt(origin.review_id, origin.review_request_digest, origin.review_result_digest, original), retry);
    },
    async handle(input: ServerToNodeMessage): Promise<boolean> {
      const author = input.type.startsWith("product.source.recovery-validation."), review = input.type.startsWith("product.source.recovery-validation-review.");
      if (!author && !review) return false; current();
      if (input.type === "product.source.recovery-validation.v1") { await startAuthor(importedRecoveryValidationCommandSchema.parse(input)); return true; }
      if (input.type === "product.source.recovery-validation-review.v1") { await startReview(importedRecoveryValidationReviewCommandSchema.parse(input)); return true; }
      if (input.type === "product.source.recovery-validation.receipt.v1") {
        const receipt = importedRecoveryValidationReceiptSchema.parse(input), slot = authors.get(receipt.payload.validation_id);
        if (!slot) throw Error("Original validation result is unavailable"); same(slot, receipt.payload);
        if (!slot.persisted || !slot.result || hash(slot.result) !== receipt.result_digest) throw Error("Validation receipt changed its persisted result");
        if (receipt.status === "accepted" && slot.acknowledged !== receipt.result_digest && reusable(slot.result)) readCompletedImportedRecoveryValidation(options.runtime, slot.result);
        slot.acknowledged = receipt.status === "accepted" ? receipt.result_digest : undefined; return true;
      }
      if (input.type === "product.source.recovery-validation-review.receipt.v1") {
        const receipt = importedRecoveryValidationReviewReceiptSchema.parse(input), slot = reviews.get(receipt.payload.review_id);
        if (!slot) throw Error("Original validation review is unavailable"); same(slot, receipt.payload);
        if (!slot.persisted || !slot.result || hash(slot.result) !== receipt.result_digest) throw Error("Validation review receipt changed its persisted result");
        if (receipt.status === "accepted" && slot.acknowledged !== receipt.result_digest && slot.result.closed
          && (slot.result.outcome === "reviewed" || slot.result.outcome === "failed")) readCompletedImportedRecoveryValidationReview(options.runtime, slot.result);
        slot.acknowledged = receipt.status === "accepted" ? receipt.result_digest : undefined; return true;
      }
      if (author) {
        const command = input.type === "product.source.recovery-validation.stop.v1" ? importedRecoveryValidationStopSchema.parse(input) : importedRecoveryValidationStatusSchema.parse(input);
        let slot = authors.get(command.payload.validation_id); if (slot) same(slot, command.payload);
        if (input.type === "product.source.recovery-validation.status.v1") {
          if (!slot) throw Error("Original validation owner is unavailable; recovery required"); await ackAuthor(command.id, slot); await slot.work; await emitAuthor(command.id, slot); return true;
        }
        if (!slot) { const permit = reserveImportedRecoveryValidation(options.runtime, command.payload, "stop"); slot = { control: command.payload, permit, controller: new AbortController(),
          result: { ...command.payload, outcome: "cancelled_before_start", closed: true } }; authors.set(command.payload.validation_id, slot);
          persistImportedRecoveryValidationResult(options.runtime, permit, slot.result!); slot.persisted = true; }
        slot.controller.abort(); await slot.work; await ackAuthor(command.id, slot); await emitAuthor(command.id, slot); return true;
      }
      const command = input.type === "product.source.recovery-validation-review.stop.v1" ? importedRecoveryValidationReviewStopSchema.parse(input) : importedRecoveryValidationReviewStatusSchema.parse(input);
      let slot = reviews.get(command.payload.review_id); if (slot) same(slot, command.payload);
      if (input.type === "product.source.recovery-validation-review.status.v1") {
        if (!slot) throw Error("Original validation review owner is unavailable; recovery required"); await ackReview(command.id, slot); await slot.work; await emitReview(command.id, slot); return true;
      }
      if (!slot) { const permit = reserveImportedRecoveryValidationReview(options.runtime, command.payload, "stop"); slot = { control: command.payload, permit, controller: new AbortController(),
        result: { ...command.payload, execution_authorized: false, outcome: "cancelled_before_start", closed: true, reason: "Cancelled before validation review admission" } };
        reviews.set(command.payload.review_id, slot); persistImportedRecoveryValidationReviewResult(options.runtime, permit, slot.result!); slot.persisted = true; }
      slot.controller.abort(); await slot.work; await ackReview(command.id, slot); await emitReview(command.id, slot); return true;
    },
    invalidate() { invalidated = true; for (const slot of [...authors.values(), ...reviews.values()]) slot.controller.abort(); },
    async settled() { await Promise.all([...authors.values(), ...reviews.values()].map(slot => slot.work)); },
  };
}
