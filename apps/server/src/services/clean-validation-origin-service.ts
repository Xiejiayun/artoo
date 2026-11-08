import { computers, eventLog, nodeRecoveryRegistrations, sourceCleanGenerations, sourceCleanOperationSettlements,
  sourceCleanStops, sourceWorkspaceLineages } from "@artoo/db";
import { SourceCleanRestartGrantV1Schema, SourceCleanStopIntentV1Schema, SourceLifecycleRegistrationV1Schema,
  inspectSourceCleanClosureV1, inspectSourceCleanValidationOriginV1, sourceCleanValidationOriginDigestV1,
  canonicalProductSourceTransferValueV1 as canonical } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, eq } from "drizzle-orm";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { importedDesignSha as sha, importedDesignHash as hash } from "./imported-design-completion-service.js";
import { readImportedValidationOrigin } from "./imported-validation-source-service.js";
import { readSourceCleanOrigin, assertSourceCleanCurrentProfiles } from "./source-clean-origin-service.js";

/** Historical H6 acceptance supplies immutable inputs only. A committed fresh
 * store/registration/checkpoint, complete old-operation settlement and current
 * paired session establish the independent clean-validation admission. */
export async function readCleanValidationRoot(ctx: ServerContext, tx: DrizzleDb, generationId: string, options: { live?: boolean } = {}) {
  const [generation] = await tx.select().from(sourceCleanGenerations).where(and(eq(sourceCleanGenerations.id, generationId), eq(sourceCleanGenerations.organizationId, ctx.organizationId)));
  if (!generation?.settledAt || !generation.settlementEventId || !generation.lifecycleRegistration || !generation.registrationId
    || !generation.checkpoint || !generation.receipt || !generation.registeredAt || !generation.checkpointedAt)
    throw AppError.conflict("Clean validation requires a separately committed fresh checkpoint and GoalRunner settlement");
  const grant = SourceCleanRestartGrantV1Schema.parse(generation.grant);
  const restart = inspectSourceCleanValidationOriginV1({ version: 1, kind: "clean-restart.v1", generation_id: generation.id,
    lineage_id: generation.lineageId, grant, checkpoint: generation.checkpoint, receipt: generation.receipt,
    settlement_event_id: generation.settlementEventId }, sha);
  const lifecycle = SourceLifecycleRegistrationV1Schema.parse(generation.lifecycleRegistration);
  const [stop] = await tx.select().from(sourceCleanStops).where(and(eq(sourceCleanStops.id, generation.predecessorStopId), eq(sourceCleanStops.organizationId, ctx.organizationId)));
  const [registered] = await tx.select().from(nodeRecoveryRegistrations).where(and(eq(nodeRecoveryRegistrations.id, generation.registrationId), eq(nodeRecoveryRegistrations.organizationId, ctx.organizationId)));
  const [lineage] = await tx.select().from(sourceWorkspaceLineages).where(and(eq(sourceWorkspaceLineages.id, generation.lineageId), eq(sourceWorkspaceLineages.organizationId, ctx.organizationId)));
  const [settled] = await tx.select().from(eventLog).where(and(eq(eventLog.id, generation.settlementEventId), eq(eventLog.organizationId, ctx.organizationId)));
  const [committed] = await tx.select().from(eventLog).where(and(eq(eventLog.id, restart.receipt.committed_event_id), eq(eventLog.organizationId, ctx.organizationId)));
  const operations = await tx.select().from(sourceCleanOperationSettlements).where(and(eq(sourceCleanOperationSettlements.generationId, generation.id), eq(sourceCleanOperationSettlements.organizationId, ctx.organizationId)));
  if (!stop || !registered || !lineage || !settled || !committed || !stop.closure || !stop.receipt
    || generation.grantDigest !== hash(grant) || generation.checkpointDigest !== hash(restart.checkpoint)
    || canonical(lifecycle) !== canonical(restart.checkpoint.lifecycle_registration)
    || registered.registrationDigest !== hash(lifecycle.registration) || canonical(registered.registration) !== canonical(lifecycle.registration)
    || registered.computerId !== grant.stable.node_id || registered.deviceId !== grant.stable.device_id
    || registered.sessionId !== restart.receipt.session_id || registered.id !== restart.receipt.registration_id
    || canonical(stop.receipt) !== canonical(grant.predecessor) || stop.closureDigest !== hash(stop.closure)
    || canonical(lineage.stable) !== canonical(grant.stable) || lineage.workspaceIdentityDigest !== grant.stable.workspace_identity_digest)
    throw AppError.conflict("Clean validation lost its exact immutable new generation, checkpoint or predecessor closure");
  const intent = SourceCleanStopIntentV1Schema.parse(stop.intent), closure = inspectSourceCleanClosureV1(intent, stop.closure, sha);
  const event = settled.payload as Record<string, unknown>, committedEvent = committed.payload as Record<string, unknown>;
  if (closure.retained_history_digest !== grant.predecessor_history_digest || stop.intentDigest !== hash(intent)
    || intent.goal_id !== grant.goal_id || intent.plan_id !== grant.plan_id || canonical(intent.origin) !== canonical(grant.origin)
    || settled.type !== "goal.source-clean-restart.settled" || settled.actorType !== "system" || settled.actorId !== "goal_runner" || settled.goalId !== grant.goal_id
    || event.generation_id !== generation.id || event.checkpoint_digest !== generation.checkpointDigest || event.actor_user_id !== grant.authorization.actor_user_id
    || event.source_state !== "unverified" || event.publication_authorized !== false
    || committed.type !== "node.source-clean-restart.checkpointed" || committed.actorType !== "system" || committed.actorId !== "source_lifecycle"
    || committed.goalId !== grant.goal_id || committedEvent.generation_id !== generation.id || committedEvent.lineage_id !== lineage.id
    || committedEvent.checkpoint_digest !== generation.checkpointDigest || committedEvent.source_state !== "unverified" || committedEvent.publication_authorized !== false
    || operations.length !== intent.operations.length || intent.operations.some(ref => !operations.some(operation => operation.kind === ref.kind
      && operation.operationId === ref.operation_id && operation.requestDigest === ref.request_digest && operation.runId === (ref.run_id ?? null)
      && operation.eventId === settled.id && operation.goalId === grant.goal_id && operation.computerId === registered.computerId)))
    throw AppError.conflict("Clean validation requires exact full old-operation settlement and the original user's unverified lineage");
  const destination = { computerId: registered.computerId, deviceId: registered.deviceId, tokenLookup: registered.tokenLookup, sessionId: registered.sessionId };
  const root = options.live ? await readSourceCleanOrigin(ctx, tx, grant.origin.review_id, destination, intent.registration)
    : await readImportedValidationOrigin(ctx, tx, grant.origin.review_id);
  if (canonical(root.origin) !== canonical(grant.origin) || root.goal.id !== grant.goal_id || root.plan.id !== grant.plan_id
    || root.h6.actorUserId !== grant.authorization.actor_user_id || root.h6.consentId !== grant.authorization.consent_id || root.h6.policyVersion !== grant.authorization.policy_version)
    throw AppError.conflict("Clean validation changed its accepted H6 origin or initiating authorization");
  if (options.live) {
    if (canonical(ctx.getPairedNodeSession?.(registered.computerId)) !== canonical(destination)
      || lineage.state !== "recovery" || lineage.currentGenerationId !== generation.id || lineage.currentRegistrationId !== registered.id)
      throw AppError.conflict("Clean validation cannot revive a new process or superseded physical lineage");
    assertSourceCleanCurrentProfiles(ctx, root, true);
  }
  return { ...root, sessionBindings: { source: root.sessionBindings.source, destination }, cleanGeneration: generation,
    restart, restartDigest: sourceCleanValidationOriginDigestV1(restart, sha), registration: registered, lineage };
}
export type CleanValidationRoot = Awaited<ReturnType<typeof readCleanValidationRoot>>;

/** Called only after full clean source/actor/profile admission and participant
 * locks. The executor lock remains held through the actual dedicated send.
 * This is not a generic bypass flag for ordinary run.start or old H9 work. */
export async function assertCleanValidationDispatch(ctx: ServerContext, tx: DrizzleDb, root: CleanValidationRoot) {
  const [computer] = await tx.select().from(computers).where(and(eq(computers.id, root.registration.computerId), eq(computers.organizationId, ctx.organizationId))).for("update");
  if (!computer || computer.status !== "online" || !["windows", "win32"].includes(computer.os)) throw AppError.conflict("Clean execution computer is unavailable");
  const lineages = await tx.select().from(sourceWorkspaceLineages).where(and(eq(sourceWorkspaceLineages.computerId, computer.id), eq(sourceWorkspaceLineages.organizationId, ctx.organizationId))).for("update");
  const own = lineages.find(row => row.id === root.lineage.id);
  if (lineages.some(row => ["closing", "closed", "reserved"].includes(row.state)) || !own || own.state !== "recovery"
    || own.currentGenerationId !== root.cleanGeneration.id || own.currentRegistrationId !== root.registration.id
    || own.stableDigest !== root.lineage.stableDigest || own.workspaceIdentityDigest !== root.lineage.workspaceIdentityDigest
    || canonical(ctx.getPairedNodeSession?.(computer.id)) !== canonical(root.sessionBindings.destination))
    throw AppError.conflict("Clean dedicated dispatch lost its current settled generation or executor reservation");
  assertSourceCleanCurrentProfiles(ctx, root, true);
}
