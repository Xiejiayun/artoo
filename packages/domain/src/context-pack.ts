/**
 * ContextPack schema (design.md §6.11, codex Round 14 — FROZEN).
 *
 * v0.1-core fills only the static fields. v0.1-complete (Memory/Skill/Lease) may
 * only ADD optional, versioned fields — it must never break adapter injection of
 * the shape below.
 */
import { z } from "zod";

import { ActorSchema } from "./events.js";
import { ProductDevelopmentContextSchema } from "./product-development.js";
import { DevelopmentStageSchema } from "./product-development.js";
import { ReviewVerificationContextSchema } from "./verification-observation.js";
import { VerificationCapabilitiesContextSchema } from "./verification-capabilities.js";
import { ReleaseCapabilitiesV1Schema } from "./release-capabilities.js";
import { ImportedProductReviewSubjectV1Schema } from "./imported-product-review-context.js";
import { TransferredProductInputV1Schema } from "./transferred-product-input.js";
import { ProductDesignRevisionContextV1Schema } from "./product-design-revision.js";
import { ImportedDesignReviewSubjectV1Schema } from "./imported-design-review-context.js";
import { ImportedExecutionContextV1Schema } from "./imported-execution-context.js";
import { ImportedExecutionReviewSubjectV1Schema, ImportedExecutionRepairContextV1Schema } from "./imported-implementation-context.js";
import { ImportedValidationContextV1Schema, ImportedValidationReviewSubjectV1Schema } from "./imported-validation-context.js";
import { ImportedRecoveryValidationContextV1Schema, ImportedRecoveryValidationReviewSubjectV1Schema } from "./source-recovery-context.js";
import { ImportedCleanValidationContextV1Schema, ImportedCleanValidationReviewSubjectV1Schema } from "./clean-validation-context.js";

export const ContextPackSchema = z.object({
  imported_clean_validation: ImportedCleanValidationContextV1Schema.optional(),
  imported_clean_validation_review_subject: ImportedCleanValidationReviewSubjectV1Schema.optional(),
  imported_recovery_validation: ImportedRecoveryValidationContextV1Schema.optional(),
  imported_recovery_validation_review_subject: ImportedRecoveryValidationReviewSubjectV1Schema.optional(),
  imported_validation: ImportedValidationContextV1Schema.optional(),
  imported_validation_review_subject: ImportedValidationReviewSubjectV1Schema.optional(),
  imported_execution_review_subject: ImportedExecutionReviewSubjectV1Schema.optional(),
  imported_execution_repair: ImportedExecutionRepairContextV1Schema.optional(),
  imported_execution: ImportedExecutionContextV1Schema.optional(),
  imported_design_review_subject: ImportedDesignReviewSubjectV1Schema.optional(),
  product_design_revision: ProductDesignRevisionContextV1Schema.optional(),
  transferred_product_input: TransferredProductInputV1Schema.optional(),
  imported_review_subject: ImportedProductReviewSubjectV1Schema.optional(),
  verification_capabilities: VerificationCapabilitiesContextSchema.optional(),
  release_capabilities: ReleaseCapabilitiesV1Schema.optional(),
  review_subject: z.object({
    version: z.literal(1), task_id: z.string().min(1), run_id: z.string().min(1), evidence_id: z.string().min(1),
    subject_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/), development_stage: DevelopmentStageSchema.optional(),
    verification: ReviewVerificationContextSchema.optional(),
  }).superRefine((subject, ctx) => {
    if (subject.development_stage && subject.verification?.checks.some((check) => check.observation
      && check.observation.stage !== subject.development_stage)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["verification"], message: "Review observations must match the bound development stage" });
    }
  }).optional(),
  product_development: ProductDevelopmentContextSchema.optional(),
  goal_context: z.object({
    version: z.literal(1),
    goal_id: z.string().min(1),
    objective: z.string(),
    acceptance_criteria: z.array(z.string()),
    plan: z.object({ id: z.string().min(1), version: z.number().int().positive(), rationale: z.string(), spec_ref: z.string().nullable() }).nullable(),
  }).optional(),
  // References are evidence, not instructions or permission to access another
  // workspace. Artifact bodies remain behind the authenticated content API.
  dependency_context: z.object({
    version: z.literal(1),
    truncated: z.boolean(),
    entries: z.array(z.object({
      task_id: z.string().min(1), title: z.string(), dependency_type: z.string(), status: z.string(),
      acceptance_criteria: z.array(z.string()),
      run_id: z.string().nullable(), workspace_root: z.string().nullable(),
      artifacts_truncated: z.boolean(),
      artifacts: z.array(z.object({
        id: z.string().min(1), type: z.string(), run_id: z.string().min(1),
        checksum: z.string().nullable(), content_path: z.string(),
      })).max(100),
    })).max(100),
  }).optional(),
  conversation: z.object({
    room_id: z.string(), turn_id: z.string(), current_request: z.string(),
    thread_root_id: z.string().nullable().optional(),
    messages: z.array(z.object({ id: z.string(), role: z.enum(["user", "assistant"]), body: z.string(), actor_id: z.string().optional() })),
    history_truncated: z.boolean(),
  }).optional(),
  review_feedback: z.object({
    version: z.literal(1),
    entries: z.array(z.object({
      event_id: z.string().min(1),
      position: z.number().refine(Number.isInteger, "Expected an integer").positive(),
      task_id: z.string().min(1),
      actor: ActorSchema,
      occurred_at: z.string().min(1),
      comment: z.string().refine((value) => value.trim().length > 0),
      artifact_ids: z.array(z.string().min(1)).nullable().optional(),
    })).min(1),
  }).optional(),
  task: z.object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    acceptance_criteria: z.array(z.string()),
  }),
  project: z.object({
    id: z.string(),
    name: z.string(),
    default_workspace: z.string().nullable(),
  }),
  workspace: z.object({
    root: z.string(),
    file_scope: z.array(z.string()),
  }),
  policy: z.object({
    execution_mode: z.literal("discussion").optional(),
    filesystem_write_scope: z.array(z.string()),
    requires_approval: z.array(z.string()),
  }),
  memory: z.object({
    task_summary: z.string().nullable(),
    project_notes: z.array(z.string()),
  }),
  artifacts: z.object({
    expected: z.array(z.string()),
  }),
});

export type ContextPack = z.infer<typeof ContextPackSchema>;
