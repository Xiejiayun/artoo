import {
  applicationPublications,
  goalCleanValidations,
  goalCleanValidationReviews,
  goalImportedDesignContinuations,
  goalImportedDesignReviews,
  goalImportedExecutions,
  goalImportedExecutionReviews,
  goalImportedExecutionRepairs,
  goalImportedProductReviews,
  goalImportedValidations,
  goalImportedValidationReviews,
  goalProductHandoffOperations,
  goalProductHandoffs,
  goalSourceRecoveries,
  goalRecoveryValidations,
  goalRecoveryValidationReviews,
  productReleases,
  runs,
} from "@artoo/db";
import { and, eq } from "drizzle-orm";

import type { ArtifactStorageOptions } from "./content-addressed-blob.js";
import type { ServerContext } from "./context.js";
import { AppError } from "./errors.js";
import type { NodeRegistry } from "./ws/node-registry.js";

/** Resolve dispatch and capability queries through the current node binding. */
export function wireNodeDispatch(
  ctx: ServerContext,
  nodeRegistry: NodeRegistry,
  options: ArtifactStorageOptions,
  artifactStore: ServerContext["artifactStore"],
): void {
  ctx.getPairedNodeSession = (computerId) => nodeRegistry.get(computerId)?.getPairedNodeSession?.();
  ctx.getApplicationPublicationCapabilities = (computerId, profileId, projectId) =>
    nodeRegistry.get(computerId)?.getApplicationPublicationCapabilities?.(profileId, projectId);
  ctx.onApplicationPublicationQueued ??= async (publicationId, control) => {
    const [publication] = await ctx.db.db
      .select()
      .from(applicationPublications)
      .where(
        and(
          eq(applicationPublications.id, publicationId),
          eq(applicationPublications.organizationId, ctx.organizationId),
        ),
      );
    const binding = publication && nodeRegistry.get(publication.computerId);
    if (!binding?.dispatchApplicationPublication)
      throw AppError.conflict("Original application publication node is unavailable");
    await binding.dispatchApplicationPublication(publicationId, control);
  };
  ctx.redeliverImportedSourceReceipt = async (computerId, family, id) => {
    const binding = nodeRegistry.get(computerId);
    if (!binding?.redeliverCommittedSourceReceipt)
      throw AppError.conflict("Original source receipt node is unavailable");
    await binding.redeliverCommittedSourceReceipt(family, id);
  };
  ctx.getProductSourceRouting = (computerId) => nodeRegistry.get(computerId)?.getProductSourceRouting?.();
  // Resolve every query through the current binding; never cache by computer.
  ctx.supportsExecutionFeature = (computerId, feature) =>
    nodeRegistry.get(computerId)?.supportsExecutionFeature(feature) ?? false;
  ctx.supportsVerificationProfile = (computerId, profileId, projectId, workspaceRoot) =>
    nodeRegistry.get(computerId)?.supportsVerificationProfile(profileId, projectId, workspaceRoot) ?? false;
  ctx.getVerificationWorkspace = (computerId, profileId, projectId, workspaceRoot) =>
    nodeRegistry.get(computerId)?.getVerificationWorkspace(profileId, projectId, workspaceRoot);
  ctx.getOwnedResultProfile = (computerId, profileId, templateId, projectId) =>
    nodeRegistry.get(computerId)?.getOwnedResultProfile?.(profileId, templateId, projectId);
  ctx.getVerificationCapabilities = (computerId, profileId, projectId, workspaceRoot) =>
    nodeRegistry.get(computerId)?.getVerificationCapabilities?.(profileId, projectId, workspaceRoot);
  ctx.supportsReleaseProfile = (computerId, profileId, projectId, workspaceRoot, verifierId) =>
    nodeRegistry.get(computerId)?.supportsReleaseProfile?.(profileId, projectId, workspaceRoot, verifierId) ?? false;
  ctx.getReleaseCapabilities = (computerId, profileId, projectId, workspaceRoot, verifierId) =>
    nodeRegistry.get(computerId)?.getReleaseCapabilities?.(profileId, projectId, workspaceRoot, verifierId);
  ctx.onProductReleaseQueued ??= async (releaseId) => {
    const [release] = await ctx.db.db.select().from(productReleases).where(eq(productReleases.id, releaseId));
    if (release) await nodeRegistry.get(release.computerId)?.dispatchProductRelease?.(releaseId);
  };
  ctx.onProductReleaseCancel ??= async (releaseId) => {
    const [release] = await ctx.db.db.select().from(productReleases).where(eq(productReleases.id, releaseId));
    const binding = release && nodeRegistry.get(release.computerId);
    if (!binding?.dispatchProductReleaseCancel)
      throw AppError.conflict("Publication node is offline; cancellation cannot be confirmed");
    await binding.dispatchProductReleaseCancel(releaseId);
  };
  ctx.onImportedProductReviewQueued ??= async (reviewId, control) => {
    const [review] = await ctx.db.db
      .select()
      .from(goalImportedProductReviews)
      .where(
        and(
          eq(goalImportedProductReviews.id, reviewId),
          eq(goalImportedProductReviews.organizationId, ctx.organizationId),
        ),
      );
    const binding = review && nodeRegistry.get(review.computerId);
    if (!binding?.dispatchImportedProductReview) throw AppError.conflict("Destination review node is unavailable");
    await binding.dispatchImportedProductReview(reviewId, control);
  };
  ctx.productSourceArtifactDir = options.artifactDir;
  ctx.artifactStore = artifactStore;
  ctx.onImportedExecutionReviewQueued ??= async (reviewId, control) => {
    const [row] = await ctx.db.db
      .select()
      .from(goalImportedExecutionReviews)
      .where(
        and(
          eq(goalImportedExecutionReviews.id, reviewId),
          eq(goalImportedExecutionReviews.organizationId, ctx.organizationId),
        ),
      );
    const binding = row && nodeRegistry.get(row.computerId);
    if (!binding?.dispatchImportedExecutionReview) throw AppError.conflict("H6 review destination node is unavailable");
    await binding.dispatchImportedExecutionReview(reviewId, control);
  };
  ctx.onImportedExecutionRepairQueued ??= async (repairId, control) => {
    const [row] = await ctx.db.db
      .select()
      .from(goalImportedExecutionRepairs)
      .where(
        and(
          eq(goalImportedExecutionRepairs.id, repairId),
          eq(goalImportedExecutionRepairs.organizationId, ctx.organizationId),
        ),
      );
    const binding = row && nodeRegistry.get(row.computerId);
    if (!binding?.dispatchImportedExecutionRepair) throw AppError.conflict("H6 repair destination node is unavailable");
    await binding.dispatchImportedExecutionRepair(repairId, control);
  };
  ctx.onImportedExecutionQueued ??= async (executionId, control) => {
    const [row] = await ctx.db.db
      .select()
      .from(goalImportedExecutions)
      .where(
        and(eq(goalImportedExecutions.id, executionId), eq(goalImportedExecutions.organizationId, ctx.organizationId)),
      );
    const binding = row && nodeRegistry.get(row.computerId);
    if (!binding?.dispatchImportedExecution) throw AppError.conflict("H5 destination node is unavailable");
    await binding.dispatchImportedExecution(executionId, control);
  };
  ctx.onImportedValidationQueued ??= async (validationId, control) => {
    const [row] = await ctx.db.db
      .select()
      .from(goalImportedValidations)
      .where(
        and(
          eq(goalImportedValidations.id, validationId),
          eq(goalImportedValidations.organizationId, ctx.organizationId),
        ),
      );
    const binding = row && nodeRegistry.get(row.computerId);
    if (!binding?.dispatchImportedValidation) throw AppError.conflict("H7 validation destination node is unavailable");
    await binding.dispatchImportedValidation(validationId, control);
  };
  ctx.onSourceRecoveryQueued ??= async (recoveryId, control) => {
    const [row] = await ctx.db.db
      .select()
      .from(goalSourceRecoveries)
      .where(and(eq(goalSourceRecoveries.id, recoveryId), eq(goalSourceRecoveries.organizationId, ctx.organizationId)));
    const binding = row && nodeRegistry.get(row.computerId);
    if (!binding?.dispatchSourceRecovery) throw AppError.conflict("Recovery destination node is unavailable");
    await binding.dispatchSourceRecovery(recoveryId, control);
  };
  ctx.onRecoveryValidationQueued ??= async (validationId, control) => {
    const [row] = await ctx.db.db
      .select()
      .from(goalRecoveryValidations)
      .where(
        and(
          eq(goalRecoveryValidations.id, validationId),
          eq(goalRecoveryValidations.organizationId, ctx.organizationId),
        ),
      );
    const binding = row && nodeRegistry.get(row.computerId);
    if (!binding?.dispatchRecoveryValidation)
      throw AppError.conflict("Recovery validation destination node is unavailable");
    await binding.dispatchRecoveryValidation(validationId, control);
  };
  ctx.onRecoveryValidationReviewQueued ??= async (reviewId, control) => {
    const [row] = await ctx.db.db
      .select()
      .from(goalRecoveryValidationReviews)
      .where(
        and(
          eq(goalRecoveryValidationReviews.id, reviewId),
          eq(goalRecoveryValidationReviews.organizationId, ctx.organizationId),
        ),
      );
    const binding = row && nodeRegistry.get(row.computerId);
    if (!binding?.dispatchRecoveryValidationReview)
      throw AppError.conflict("Recovery independent reviewer node is unavailable");
    await binding.dispatchRecoveryValidationReview(reviewId, control);
  };
  ctx.onCleanValidationQueued ??= async (validationId, control) => {
    const [row] = await ctx.db.db
      .select()
      .from(goalCleanValidations)
      .where(
        and(eq(goalCleanValidations.id, validationId), eq(goalCleanValidations.organizationId, ctx.organizationId)),
      );
    const binding = row && nodeRegistry.get(row.computerId);
    if (!binding?.dispatchCleanValidation)
      throw AppError.conflict("Recovery validation destination node is unavailable");
    await binding.dispatchCleanValidation(validationId, control);
  };
  ctx.onCleanValidationReviewQueued ??= async (reviewId, control) => {
    const [row] = await ctx.db.db
      .select()
      .from(goalCleanValidationReviews)
      .where(
        and(
          eq(goalCleanValidationReviews.id, reviewId),
          eq(goalCleanValidationReviews.organizationId, ctx.organizationId),
        ),
      );
    const binding = row && nodeRegistry.get(row.computerId);
    if (!binding?.dispatchCleanValidationReview)
      throw AppError.conflict("Recovery independent reviewer node is unavailable");
    await binding.dispatchCleanValidationReview(reviewId, control);
  };
  ctx.onImportedValidationReviewQueued ??= async (reviewId, control) => {
    const [row] = await ctx.db.db
      .select()
      .from(goalImportedValidationReviews)
      .where(
        and(
          eq(goalImportedValidationReviews.id, reviewId),
          eq(goalImportedValidationReviews.organizationId, ctx.organizationId),
        ),
      );
    const binding = row && nodeRegistry.get(row.computerId);
    if (!binding?.dispatchImportedValidationReview)
      throw AppError.conflict("H7 final-product review destination node is unavailable");
    await binding.dispatchImportedValidationReview(reviewId, control);
  };
  ctx.onImportedDesignReviewQueued ??= async (reviewId, control) => {
    const [row] = await ctx.db.db
      .select()
      .from(goalImportedDesignReviews)
      .where(
        and(
          eq(goalImportedDesignReviews.id, reviewId),
          eq(goalImportedDesignReviews.organizationId, ctx.organizationId),
        ),
      );
    const binding = row && nodeRegistry.get(row.computerId);
    if (!binding?.dispatchImportedDesignReview) throw AppError.conflict("H4 destination review node is unavailable");
    await binding.dispatchImportedDesignReview(reviewId, control);
  };
  ctx.onImportedDesignContinuationQueued ??= async (continuationId, control) => {
    const [row] = await ctx.db.db
      .select()
      .from(goalImportedDesignContinuations)
      .where(
        and(
          eq(goalImportedDesignContinuations.id, continuationId),
          eq(goalImportedDesignContinuations.organizationId, ctx.organizationId),
        ),
      );
    const binding = row && nodeRegistry.get(row.computerId);
    if (!binding?.dispatchImportedDesignContinuation) throw AppError.conflict("Imported design node is unavailable");
    await binding.dispatchImportedDesignContinuation(continuationId, control);
  };
  ctx.onProductSourceOperationQueued ??= async (operationId, control) => {
    const [row] = await ctx.db.db
      .select({ computerId: goalProductHandoffOperations.computerId })
      .from(goalProductHandoffOperations)
      .innerJoin(goalProductHandoffs, eq(goalProductHandoffs.id, goalProductHandoffOperations.handoffId))
      .where(
        and(
          eq(goalProductHandoffOperations.id, operationId),
          eq(goalProductHandoffs.organizationId, ctx.organizationId),
        ),
      );
    const binding = row && nodeRegistry.get(row.computerId);
    if (!binding?.dispatchProductSourceOperation) throw AppError.conflict("Source operation node is unavailable");
    await binding.dispatchProductSourceOperation(operationId, control);
  };
}

export function wireRunDispatch(ctx: ServerContext, nodeRegistry: NodeRegistry): void {
  // Route a queued run's run.start to the node that owns its computer. Tests may
  // pre-set onRunQueued (in-process binding) — only install the registry route
  // when one isn't already provided.
  ctx.onRunQueued ??= async (runId: string): Promise<void> => {
    const run = (await ctx.db.db.select().from(runs).where(eq(runs.id, runId)))[0];
    if (run === undefined) {
      return;
    }
    await nodeRegistry.get(run.computerId)?.dispatchRunStart(runId);
  };
}
