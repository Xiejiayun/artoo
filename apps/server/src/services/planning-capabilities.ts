import { AutonomousPlanningRequestV1Schema, GoalPlanningCapabilitySnapshotSchema,
  APPLICATION_VERIFICATION_FEATURE_V1,
  type ContextPack, type GoalPlanningCapabilitySnapshot, type VerificationCapabilities } from "@artoo/domain";
import { isDeepStrictEqual } from "node:util";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";

export interface PlanningCapabilityOwner {
  computerId: string | null;
  workspaceRoot: string | null;
  verificationProfileId: string;
  releaseProfileId?: string | null;
  executionMode: string;
  planningCapabilitySnapshot: unknown;
  appDelivery?: unknown;
}

/** SQL NULL is historical absence. An invalid versioned value never becomes absence. */
export function persistedPlanningSnapshot(owner: PlanningCapabilityOwner, projectId: string): GoalPlanningCapabilitySnapshot | null {
  if (owner.planningCapabilitySnapshot === null) return null;
  const parsed = GoalPlanningCapabilitySnapshotSchema.safeParse(owner.planningCapabilitySnapshot);
  if (!parsed.success) throw AppError.conflict("The stored planning capability snapshot is invalid");
  const snapshot = parsed.data;
  if (!isDeepStrictEqual(snapshot.app_delivery ?? null, owner.appDelivery ?? null)) throw AppError.conflict("The original application planning authorization changed");
  if (snapshot.computer_id !== owner.computerId || snapshot.workspace_root !== owner.workspaceRoot
    || snapshot.project_id !== projectId || snapshot.verification_profile_id !== owner.verificationProfileId) {
    throw AppError.conflict("The fixed planning capability target changed");
  }
  if (snapshot.release && (snapshot.release.capabilities.binding.release_profile_id !== owner.releaseProfileId
    || snapshot.release.capabilities.binding.project_id !== projectId
    || snapshot.release.capabilities.binding.workspace_root !== owner.workspaceRoot
    || snapshot.release.capabilities.binding.verification_profile_id !== owner.verificationProfileId
    || snapshot.release.capabilities.binding.verification_profile_digest !== snapshot.capabilities?.profile_digest)) {
    throw AppError.conflict("The fixed planning release target changed");
  }
  if (snapshot.capabilities?.measurement_plan_policy?.version === 2 && owner.releaseProfileId && !snapshot.release) {
    throw AppError.conflict("The fixed planning release capability snapshot is missing");
  }
  return snapshot;
}

export function assertPlanningTargetAvailable(ctx: ServerContext, owner: PlanningCapabilityOwner, projectId: string): void {
  if (owner.appDelivery != null && (!owner.computerId
    || ctx.supportsExecutionFeature?.(owner.computerId, APPLICATION_VERIFICATION_FEATURE_V1) !== true)) {
    throw AppError.conflict("The fixed planning target does not support application development verification");
  }
  if (!owner.computerId || !owner.workspaceRoot
    || ctx.supportsExecutionFeature?.(owner.computerId, "run-verification.v1") !== true
    || (owner.executionMode === "agent_team" && ctx.supportsExecutionFeature?.(owner.computerId, "product-stage-verification.v1") !== true)
    || ctx.supportsVerificationProfile?.(owner.computerId, owner.verificationProfileId, projectId, owner.workspaceRoot) !== true) {
    throw AppError.conflict("The fixed planning target no longer advertises its verification profile, project and workspace");
  }
}

/** One synchronous authenticated getter, immediately beside the exact advertisement check. */
export function capturePlanningSnapshot(ctx: ServerContext, owner: PlanningCapabilityOwner, projectId: string): GoalPlanningCapabilitySnapshot {
  assertPlanningTargetAvailable(ctx, owner, projectId);
  const capabilities = ctx.getVerificationCapabilities?.(owner.computerId!, owner.verificationProfileId, projectId, owner.workspaceRoot!);
  if (capabilities?.measurement_plan_policy && ctx.supportsExecutionFeature?.(owner.computerId!, `measurement-plan.v${capabilities.measurement_plan_policy.version}`) !== true) {
    throw AppError.conflict("The fixed planning target cannot enforce its measurement-plan policy");
  }
  const release = capabilities?.measurement_plan_policy?.version === 2 && owner.releaseProfileId
    ? ctx.getReleaseCapabilities?.(owner.computerId!, owner.releaseProfileId, projectId, owner.workspaceRoot!, owner.verificationProfileId) : undefined;
  if (capabilities?.measurement_plan_policy?.version === 2 && owner.releaseProfileId
    && (!release || ctx.supportsExecutionFeature?.(owner.computerId!, "product-release.acceptance.v1") !== true
      || ctx.supportsReleaseProfile?.(owner.computerId!, owner.releaseProfileId, projectId, owner.workspaceRoot!, owner.verificationProfileId) !== true
      || release.binding.release_profile_id !== owner.releaseProfileId || release.binding.project_id !== projectId
      || release.binding.workspace_root !== owner.workspaceRoot || release.binding.verification_profile_id !== owner.verificationProfileId
      || release.binding.verification_profile_digest !== capabilities.profile_digest)) {
    throw AppError.conflict("The fixed planning target cannot enforce the selected publication acceptance contract");
  }
  return GoalPlanningCapabilitySnapshotSchema.parse({ version: 1, computer_id: owner.computerId, project_id: projectId,
    workspace_root: owner.workspaceRoot, verification_profile_id: owner.verificationProfileId, capabilities: capabilities ?? null,
    ...(owner.appDelivery != null ? { app_delivery: owner.appDelivery } : {}),
    ...(release ? { release: { version: 1, capabilities: release } } : {}) });
}

/** Reuse the execution boundary's selected value; never read a second, possibly different snapshot. */
export function assertSelectedPlanningCapabilities(owner: PlanningCapabilityOwner, projectId: string, capabilities: VerificationCapabilities | undefined): void {
  const snapshot = persistedPlanningSnapshot(owner, projectId);
  if (snapshot && !isDeepStrictEqual(snapshot.capabilities, capabilities ?? null)) {
    throw AppError.conflict("Verification capabilities differ from the fixed planning capability snapshot");
  }
}

export function recheckPlanningSnapshot(ctx: ServerContext, owner: PlanningCapabilityOwner, projectId: string): void {
  const snapshot = persistedPlanningSnapshot(owner, projectId);
  if (snapshot && !isDeepStrictEqual(snapshot, capturePlanningSnapshot(ctx, owner, projectId))) {
    throw AppError.conflict("Verification capabilities differ from the fixed planning capability snapshot");
  }
}

export function planningRequest(request: string, snapshot: GoalPlanningCapabilitySnapshot | null): string {
  return JSON.stringify(AutonomousPlanningRequestV1Schema.parse({ version: 1, kind: "autonomous-planning", request,
    planning_capability_snapshot: snapshot }));
}

export function assertPlanningContext(context: ContextPack, request: string, snapshot: GoalPlanningCapabilitySnapshot | null): void {
  const noExecutionAuthority = context.policy.execution_mode === "discussion" && context.policy.filesystem_write_scope.length === 0
    && context.verification_capabilities === undefined && context.release_capabilities === undefined
    && context.product_development === undefined && context.review_subject === undefined;
  // Only an already-persisted historical request may retain its exact legacy
  // text. Parse failure itself never authorizes a fallback for new snapshots.
  if (snapshot === null && context.conversation?.current_request === request && noExecutionAuthority) return;
  let raw: unknown;
  try { raw = JSON.parse(context.conversation?.current_request ?? ""); } catch { /* Rejected by the strict parser below. */ }
  const parsed = AutonomousPlanningRequestV1Schema.safeParse(raw);
  if (!parsed.success || parsed.data.request !== request || !isDeepStrictEqual(parsed.data.planning_capability_snapshot, snapshot)
    || !noExecutionAuthority) {
    throw AppError.conflict("Autonomous planning context does not preserve its original request and capability snapshot");
  }
}
