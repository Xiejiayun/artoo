import { validateProductDevelopmentHandoff, type ContextPack, type ProductResearchReport, type ProductDesign,
  type ProductValidationReport, type VerificationObservation } from "@artoo/domain";

/** A local validation author must be able to measure an honest unfinished report.
 * Scope comes from the node's invocation, never from product files or verifier stdout.
 * Imported continuations, reviews and final checks retain their acceptance rules. */
export function validateWebAcceptanceHandoff(context: ContextPack, research: ProductResearchReport, design: ProductDesign,
  validation: ProductValidationReport | undefined, scope: VerificationObservation["scope"]): string[] {
  const authorPreview = scope === "preview" && context.product_development?.stage === "validation"
    && !context.review_subject && !context.imported_review_subject && !context.transferred_product_input
    && !context.product_design_revision && !context.imported_execution && !context.imported_execution_repair
    && !context.imported_validation && !context.imported_recovery_validation && !context.imported_clean_validation
    && !context.imported_design_review_subject && !context.imported_execution_review_subject
    && !context.imported_validation_review_subject && !context.imported_recovery_validation_review_subject
    && !context.imported_clean_validation_review_subject;
  return validateProductDevelopmentHandoff(research, design, validation, authorPreview ? "preview" : "final");
}
