import { goalAutomations, runs, computers, goalResearchDestinationSlots } from "@artoo/db";
import { ProductSourceRoutingV1Schema, type ProductSourceExportV2, type ProductSourceDestinationMappingV1 } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, eq, inArray, notInArray, or } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import type { ServerContext } from "../context.js";
import { automationWorkspacesOverlap } from "./automation-workspace.js";
import { unconfirmedDisconnectRunIds, unsettledStandaloneExecutions } from "./execution-state.js";

const SOURCE_FEATURES = ["product-source-transfer.v2", "product-source-transfer.measurement-v2.v1", "product-source-operations.v1"];
const DESTINATION_FEATURES = [...SOURCE_FEATURES, "imported-product-review.v1", "imported-design-continuation.v1",
  "imported-design-review.v1", "imported-execution.v1", "imported-execution-review.v1", "imported-validation.v1", "product-release.acceptance.v1"];
export type ProductHandoffRoutingContext = Pick<ServerContext, "getProductSourceRouting" | "getPairedNodeSession"
  | "supportsExecutionFeature" | "getReleaseCapabilities" | "getVerificationCapabilities">;
export function routing(ctx: ProductHandoffRoutingContext, nodeId: string) {
  const parsed = ProductSourceRoutingV1Schema.safeParse(ctx.getProductSourceRouting?.(nodeId));
  return ctx.getPairedNodeSession?.(nodeId) && parsed.success ? parsed.data : undefined;
}

/** Configuration selection is not evidence that an author or verifier ran. */
export function automaticSourceAvailable(ctx: ProductHandoffRoutingContext, nodeId: string, projectId: string,
  workspaceRoot: string, verifierId: string, releaseId: string): boolean {
  const source = routing(ctx, nodeId);
  if (!source || !SOURCE_FEATURES.every(feature => ctx.supportsExecutionFeature?.(nodeId, feature) === true)) return false;
  const release = ctx.getReleaseCapabilities?.(nodeId, releaseId, projectId, workspaceRoot, verifierId);
  return !!release && source.source_exports.some(candidate => isDeepStrictEqual(candidate, release));
}

export function mappedCapabilities(ctx: ProductHandoffRoutingContext, nodeId: string, mapping: ProductSourceDestinationMappingV1,
  source: Pick<ProductSourceExportV2, "source_capabilities" | "measurement_v2">) {
  const release = mapping.destination_release, scope = release.binding;
  if (!isDeepStrictEqual(mapping.source_release, source.measurement_v2?.source_release)
    || !DESTINATION_FEATURES.every(feature => ctx.supportsExecutionFeature?.(nodeId, feature) === true)
    || !isDeepStrictEqual(ctx.getReleaseCapabilities?.(nodeId, scope.release_profile_id, scope.project_id,
      scope.workspace_root, scope.verification_profile_id), release)) return undefined;
  const capabilities = ctx.getVerificationCapabilities?.(nodeId, scope.verification_profile_id, scope.project_id, scope.workspace_root);
  if (!capabilities || capabilities.profile_digest !== scope.verification_profile_digest
    || !isDeepStrictEqual(capabilities.measurement_plan_policy, source.source_capabilities.measurement_plan_policy)
    || mapping.command_pairs.length !== source.source_capabilities.checks.length
    || mapping.command_pairs.length !== capabilities.checks.length
    || mapping.command_pairs.some(pair => {
      const from = source.source_capabilities.checks.find(check => check.command_id === pair.source_command_id);
      const to = capabilities.checks.find(check => check.command_id === pair.destination_command_id);
      return !from || !to || from.contract_digest !== to.contract_digest;
    })) return undefined;
  return capabilities;
}

export async function vacant(ctx: ServerContext, tx: DrizzleDb, computer: typeof computers.$inferSelect, workspace: string, goalId: string,
  ownHandoffOperationIds: readonly string[] = [], ownDestinationSlotId?: string) {
  const uncertain = await unconfirmedDisconnectRunIds(ctx, tx, { computerId: computer.id });
  const ordinary = await tx.select().from(runs).where(and(eq(runs.organizationId, ctx.organizationId), eq(runs.computerId, computer.id),
    or(notInArray(runs.status, ["completed", "failed", "cancelled"]), uncertain.length ? inArray(runs.id, uncertain) : undefined)));
  const reservations = await tx.select().from(goalAutomations).where(and(eq(goalAutomations.organizationId, ctx.organizationId),
    eq(goalAutomations.computerId, computer.id), inArray(goalAutomations.status, ["planning", "executing", "waiting"])));
  const destinationSlots = await tx.select().from(goalResearchDestinationSlots).where(and(eq(goalResearchDestinationSlots.organizationId, ctx.organizationId),
    eq(goalResearchDestinationSlots.computerId, computer.id)));
  return !ordinary.some(run => !run.workspaceRoot || automationWorkspacesOverlap(run.workspaceRoot, workspace, computer.os))
    && !destinationSlots.some(slot => slot.id !== ownDestinationSlotId && automationWorkspacesOverlap(slot.workspaceRoot, workspace, computer.os))
    && !reservations.some(row => row.goalId !== goalId && row.workspaceRoot && automationWorkspacesOverlap(row.workspaceRoot, workspace, computer.os))
    && !(await unsettledStandaloneExecutions(ctx, tx, { computerId: computer.id }))
      .some(operation => !(operation.kind === "handoff" && ownHandoffOperationIds.includes(operation.id))
        && automationWorkspacesOverlap(operation.workspaceRoot, workspace, computer.os));
}
