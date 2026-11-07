import { createHash } from "node:crypto";
import { canonicalProductSourceTransferValueV1 as canonical } from "@artoo/domain";
import { productSourceOperationCommandSchema, productSourceOperationStatusSchema,
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

// Only ordinary H2-H7 starts/status participate. Receipts reuse their start's ID;
// they and Stop/recovery/clean/release/run.start must retain their original paths.
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

/** Suppress only identical deliveries already in flight; this grants no execution or result-replay authority. */
export function createSourceCommandInflight() {
  const pending = new Map<string, { digest: string; runtime: object; session: object }>();
  let invalidated = false;
  return {
    run(input: ServerToNodeMessage, readScope: () => SourceStartScope | undefined,
      work: (command: ServerToNodeMessage) => Promise<void>): Promise<void> | undefined {
      const schema = schemas.get(input.type);
      if (!schema) return undefined;
      if (invalidated) throw Error("Source command delivery admission is stopping");
      const previous = pending.get(input.id), scope = readScope();
      if (!scope) {
        if (previous) throw Error("Pending source command lost its original authenticated runtime/session");
        // A fresh delivery without ordinary-session authority retains original admission/rejection.
        return undefined;
      }
      const command = schema.parse(input) as ServerToNodeMessage, serialized = canonical(input);
      if (canonical(command) !== serialized) throw Error("Source command contains fields outside its complete supported schema");
      const digest = createHash("sha256").update(serialized).digest("hex");
      if (previous) {
        if (previous.digest !== digest || previous.runtime !== scope.runtime || previous.session !== scope.session)
          throw Error("Pending source command changed its complete envelope, runtime or authenticated session");
        // Do not await the original work: each transport frame is separately tracked
        // by NodeClient, and joining would retain an unbounded number of waiters.
        return Promise.resolve();
      }
      // Bound delivery bookkeeping without evicting live work or changing execution limits.
      if (pending.size >= 1024) throw Error("Source command in-flight delivery capacity reached");
      const entry = { digest, runtime: scope.runtime, session: scope.session };
      freeze(command); pending.set(command.id, entry);
      return (async () => {
        try { await work(command); }
        finally { if (pending.get(command.id) === entry) pending.delete(command.id); }
      })();
    },
    // Keep original entries until their work actually settles; invalidation is not closure.
    invalidate(): void { invalidated = true; },
  };
}
