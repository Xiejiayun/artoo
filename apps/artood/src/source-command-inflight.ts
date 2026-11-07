import { createHash } from "node:crypto";
import { canonicalProductSourceTransferValueV1 as canonical } from "@artoo/domain";
import { productSourceOperationCommandSchema, productSourceOperationStatusSchema, productSourceOperationReceiptSchema,
  importedProductReviewCommandSchema, importedProductReviewStatusSchema,
  importedDesignContinuationCommandSchema, importedDesignContinuationStatusSchema,
  importedDesignReviewCommandSchema, importedDesignReviewStatusSchema,
  importedExecutionCommandSchema, importedExecutionStatusSchema,
  importedExecutionReviewCommandSchema, importedExecutionReviewStatusSchema,
  importedExecutionRepairCommandSchema, importedExecutionRepairStatusSchema,
  importedValidationCommandSchema, importedValidationStatusSchema,
  importedValidationReviewCommandSchema, importedValidationReviewStatusSchema,
  type ServerToNodeMessage } from "@artoo/protocol";
import type { SourceStartScope } from "./source-start-replay.js";

// Only ordinary H2-H7 starts/status participate in in-flight coalescing. H2 may
// additionally discard old deliveries after its original controller has accepted
// the server's committed-result receipt. Stop/recovery/clean/release/run.start
// retain their original handlers; this helper never replays a result or an ACK.
const schemas = new Map<string, { parse(input: unknown): unknown }>([
  ["product.source.operation.v1", productSourceOperationCommandSchema],
  ["product.source.operation.status.v1", productSourceOperationStatusSchema],
  ["product.source.review.v1", importedProductReviewCommandSchema],
  ["product.source.review.status.v1", importedProductReviewStatusSchema],
  ["product.source.design.v1", importedDesignContinuationCommandSchema],
  ["product.source.design.status.v1", importedDesignContinuationStatusSchema],
  ["product.source.design-review.v1", importedDesignReviewCommandSchema],
  ["product.source.design-review.status.v1", importedDesignReviewStatusSchema],
  ["product.source.execution.v1", importedExecutionCommandSchema],
  ["product.source.execution.status.v1", importedExecutionStatusSchema],
  ["product.source.execution-review.v1", importedExecutionReviewCommandSchema],
  ["product.source.execution-review.status.v1", importedExecutionReviewStatusSchema],
  ["product.source.execution-repair.v1", importedExecutionRepairCommandSchema],
  ["product.source.execution-repair.status.v1", importedExecutionRepairStatusSchema],
  ["product.source.validation.v1", importedValidationCommandSchema],
  ["product.source.validation.status.v1", importedValidationStatusSchema],
  ["product.source.validation-review.v1", importedValidationReviewCommandSchema],
  ["product.source.validation-review.status.v1", importedValidationReviewStatusSchema],
]);
const freeze = (value: object): void => {
  for (const child of Object.values(value)) if (child && typeof child === "object") freeze(child);
  Object.freeze(value);
};

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
interface OperationDelivery {
  operationId: string; payloadDigest: string; requestDigest?: string; epoch: object;
  completed: boolean; receiptDigest?: string;
  receiptPending?: { digest: string };
}
interface Delivery { digest: string; runtime: object; session: object; operation?: OperationDelivery }

/** These bounded same-session delivery facts grant no execution or result-replay authority. */
export function createSourceCommandInflight() {
  const pending = new Map<string, Delivery>(), completed = new Map<string, Delivery>();
  let receiptEpoch = {};
  let invalidated = false;
  const forgetCompleted = () => { receiptEpoch = {}; completed.clear(); };
  const remember = (id: string, entry: Delivery) => {
    if (invalidated || entry.operation?.epoch !== receiptEpoch) return;
    completed.delete(id); completed.set(id, entry);
    // Eviction drops an optimization, never a live operation or ownership fence.
    if (completed.size > 1024) completed.delete(completed.keys().next().value!);
  };
  return {
    run(input: ServerToNodeMessage, readScope: () => SourceStartScope | undefined,
      work: (command: ServerToNodeMessage) => Promise<void>): Promise<void> | undefined {
      if (input.type === "product.source.operation.stop.v1") { forgetCompleted(); return undefined; }
      if (input.type === "product.source.operation.receipt.v1") {
        // A rejection on any delivery may revoke a preceding acceptance. Do not
        // let a still-pending receipt repopulate the optimization across it/Stop.
        if (input.status === "rejected") { forgetCompleted(); return undefined; }
        const entry = pending.get(input.id) ?? completed.get(input.id), operation = entry?.operation;
        if (invalidated || !entry || !operation || operation.epoch !== receiptEpoch) return undefined;
        const parsed = productSourceOperationReceiptSchema.safeParse(input);
        if (!parsed.success || canonical(parsed.data) !== canonical(input)) return undefined;
        const receipt = parsed.data;
        if (receipt.payload.operation_id !== operation.operationId || receipt.payload.payload_digest !== operation.payloadDigest
          || receipt.payload.request_digest && operation.requestDigest && receipt.payload.request_digest !== operation.requestDigest) return undefined;
        const scope = readScope();
        if (!scope || scope.runtime !== entry.runtime || scope.session !== entry.session)
          throw Error("Source operation receipt lost its original authenticated runtime/session");
        const receiptDigest = hash(canonical(receipt));
        if (operation.completed && operation.receiptDigest === receiptDigest) return Promise.resolve();
        if (operation.receiptPending) {
          if (operation.receiptPending.digest !== receiptDigest) throw Error("Pending source operation receipt changed its complete envelope");
          return Promise.resolve();
        }
        const receiptPending = { digest: receiptDigest }; operation.receiptPending = receiptPending;
        operation.receiptDigest = undefined;
        freeze(receipt);
        return (async () => {
          try {
            // Only the real controller can validate the original local result.
            // An early receipt cannot suppress starts until their work succeeds.
            await work(receipt);
            if (!invalidated && operation.epoch === receiptEpoch
              && (pending.get(input.id) === entry || completed.get(input.id) === entry)) operation.receiptDigest = receiptDigest;
          } catch (error) {
            operation.receiptDigest = undefined;
            if (completed.get(input.id) === entry) completed.delete(input.id);
            throw error;
          } finally {
            if (operation.receiptPending === receiptPending) operation.receiptPending = undefined;
          }
        })();
      }
      const schema = schemas.get(input.type);
      if (!schema) return undefined;
      if (invalidated) throw Error("Source command delivery admission is stopping");
      const active = pending.get(input.id), previous = active ?? completed.get(input.id), scope = readScope();
      if (!scope) {
        if (previous) throw Error("Pending source command lost its original authenticated runtime/session");
        // A fresh delivery without ordinary-session authority retains original admission/rejection.
        return undefined;
      }
      const command = schema.parse(input) as ServerToNodeMessage, serialized = canonical(input);
      if (canonical(command) !== serialized) throw Error("Source command contains fields outside its complete supported schema");
      const digest = hash(serialized);
      if (previous) {
        if (previous.digest !== digest || previous.runtime !== scope.runtime || previous.session !== scope.session)
          throw Error("Pending source command changed its complete envelope, runtime or authenticated session");
        // Do not await the original work: each transport frame is separately tracked
        // by NodeClient, and joining would retain an unbounded number of waiters.
        if (active || previous.operation?.receiptDigest) return Promise.resolve();
      }
      // Bound delivery bookkeeping without evicting live work or changing execution limits.
      if (pending.size >= 1024) throw Error("Source command in-flight delivery capacity reached");
      const entry: Delivery = previous ?? { digest, runtime: scope.runtime, session: scope.session,
        ...(command.type === "product.source.operation.v1" ? { operation: { operationId: command.payload.operation_id,
          payloadDigest: `sha256:${hash(canonical(command.payload))}`, requestDigest: command.payload.request_digest,
          epoch: receiptEpoch, completed: false } }
          : command.type === "product.source.operation.status.v1" ? { operation: { operationId: command.payload.operation_id,
            payloadDigest: command.payload.payload_digest, requestDigest: command.payload.request_digest, epoch: receiptEpoch, completed: false } } : {}) };
      completed.delete(command.id);
      if (entry.operation) entry.operation.completed = false;
      freeze(command); pending.set(command.id, entry);
      return (async () => {
        try {
          await work(command);
          if (entry.operation) { entry.operation.completed = true; remember(command.id, entry); }
        }
        finally { if (pending.get(command.id) === entry) pending.delete(command.id); }
      })();
    },
    // Keep original entries until their work actually settles; invalidation is not closure.
    invalidate(): void { invalidated = true; forgetCompleted(); },
  };
}
