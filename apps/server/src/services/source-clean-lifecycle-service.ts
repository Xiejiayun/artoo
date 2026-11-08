import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { and, eq, isNotNull } from "drizzle-orm";
import { appendEvent, computers, goals, goalImportedExecutionReviews, nodeRecoveryRegistrations, runs, tasks, sourceCleanOperationSettlements,
  sourceWorkspaceLineages as lineages, sourceCleanStops as stops, sourceCleanGenerations as generations } from "@artoo/db";
import { SourceSupervisorLaunchV1Schema, SourceLifecycleRegistrationV1Schema, SourceCleanStopIntentV1Schema,
  SourceCleanStopReceiptV1Schema, SourceCleanRestartGrantV1Schema, SourceCleanRestartReceiptV1Schema,
  SourceCleanRestartCheckpointV1Schema, inspectSourceCleanClosureV1, inspectSourceCleanCheckpointV1,
  sourceCleanDigestV1, RunStatusSchema, canonicalProductSourceTransferValueV1 as canonical,
  type SourceSupervisorLaunchV1, type SourceLifecycleRegistrationV1, type SourceCleanRestartGrantV1,
  type SourceCleanStopIntentV1 } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { assertSourceLifecyclePayloadReplyFitsV1, SOURCE_LIFECYCLE_REPLY_MAX_BYTES_V1 } from "@artoo/protocol";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { importedDesignSha as sha } from "./imported-design-completion-service.js";
import { assertImportedImplementationCredential as credential } from "./imported-execution-service.js";
import type { AuthenticatedTransferNode } from "./product-source-transfer-service.js";
import { automationWorkspacesOverlap } from "./automation-workspace.js";
import { readSourceCleanOrigin, sourceCleanOperations, assertSourceCleanWorkspaceReservation, assertSourceCleanCurrentProfiles } from "./source-clean-origin-service.js";
import { readCleanValidationRoot } from "./clean-validation-origin-service.js";
import { transitionRun, transitionTask } from "./transition-service.js";
import { releaseRunLeases } from "./lease-service.js";

const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);
const hash = (value: unknown) => sourceCleanDigestV1(value, sha);
function replyFits(type: "node.source-clean-stop.prepared.v1" | "node.source-clean-restart.claimed.v1", payload: unknown, budget: number) {
  try { assertSourceLifecyclePayloadReplyFitsV1(type, payload, budget); }
  catch { throw AppError.conflict("Clean lifecycle response exceeds its bounded transport or retained reply budget"); }
}
type Lineage = typeof lineages.$inferSelect;
type Observer = { id: string; challenge: string; identity: AuthenticatedTransferNode; isOpen: () => boolean;
  launch?: SourceSupervisorLaunchV1; registration?: SourceLifecycleRegistrationV1;
  lineageId?: string; grant?: SourceCleanRestartGrantV1; intent?: SourceCleanStopIntentV1 };

/** GoalRunner takes its goal lock before credential/computer locks. Lifecycle
 * transactions follow that ordering even when their parent outlives the daemon. */
async function goalLock(ctx: ServerContext, tx: DrizzleDb, goalId: string) {
  const [goal] = await tx.select().from(goals).where(and(eq(goals.id, goalId), eq(goals.organizationId, ctx.organizationId))).for("update");
  if (!goal) throw AppError.conflict("Original clean lifecycle goal is missing");
}

async function computerLock(ctx: ServerContext, tx: DrizzleDb, computerId: string) {
  const [computer] = await tx.select().from(computers).where(and(eq(computers.id, computerId), eq(computers.organizationId, ctx.organizationId))).for("update");
  if (!computer || !["windows", "win32"].includes(computer.os)) throw AppError.conflict("Clean restart requires its native Windows computer");
}
async function lineageLock(ctx: ServerContext, tx: DrizzleDb, identity: AuthenticatedTransferNode, id: string): Promise<Lineage> {
  await computerLock(ctx, tx, identity.computerId);
  const [lineage] = await tx.select().from(lineages).where(and(eq(lineages.id, id), eq(lineages.organizationId, ctx.organizationId))).for("update");
  if (!lineage || lineage.computerId !== identity.computerId || lineage.deviceId !== identity.deviceId)
    throw AppError.permissionDenied("Clean lifecycle belongs to another paired physical workspace");
  return lineage;
}
async function moveLineage(tx: DrizzleDb, row: Lineage, state: string, now: string,
  successor?: { id: string; registrationId: string }) {
  const changed = await tx.update(lineages).set({ state, revision: row.revision + 1, updatedAt: now,
    ...(successor ? { currentGenerationId: successor.id, currentRegistrationId: successor.registrationId } : {}) })
    .where(and(eq(lineages.id, row.id), eq(lineages.revision, row.revision), eq(lineages.state, row.state))).returning();
  if (changed.length !== 1) throw AppError.conflict("Clean lifecycle lost its exact lineage revision");
  return changed[0]!;
}
async function grantOrigin(ctx: ServerContext, tx: DrizzleDb, identity: AuthenticatedTransferNode, grant: SourceCleanRestartGrantV1) {
  const [stop] = await tx.select().from(stops).where(and(eq(stops.id, grant.predecessor.stop_id), eq(stops.organizationId, ctx.organizationId)));
  if (!stop || !same(stop.receipt, grant.predecessor)) throw AppError.conflict("Clean restart lost its exact committed predecessor");
  const intent = SourceCleanStopIntentV1Schema.parse(stop.intent);
  const root = await readSourceCleanOrigin(ctx, tx, grant.origin.review_id, identity, intent.registration);
  if (!same(root.origin, grant.origin)) throw AppError.conflict("Clean restart accepted origin changed");
  return { root, intent, stop };
}

/** One registry per Server process. Only an authenticated original observer
 * connection can own an entry. Disconnect removes it permanently; database JSON
 * and a new connection cannot recreate a prepared but uncommitted observation. */
export function createSourceLifecycleRegistry(ctx: ServerContext) {
  const live = new Map<string, Observer>();
  function current(observer: Observer) {
    if (live.get(observer.id) !== observer || !observer.isOpen()) throw AppError.permissionDenied("Original source lifecycle observer is no longer live");
  }
  async function qualify(tx: DrizzleDb, observer: Observer) { current(observer); await credential(ctx, tx, observer.identity); current(observer); }
  function challenge(observer: Observer, supplied: string) {
    current(observer);
    if (!/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(observer.challenge, "hex"), Buffer.from(supplied, "hex")))
      throw AppError.permissionDenied("Source lifecycle challenge belongs to its original parent connection");
  }
  function currentSession(identity: AuthenticatedTransferNode, sessionId: string) {
    if (!same(ctx.getPairedNodeSession?.(identity.computerId), { ...identity, sessionId }))
      throw AppError.permissionDenied("Clean lifecycle daemon requires its exact current paired session");
  }

  async function registerDaemon(identity: AuthenticatedTransferNode, sessionId: string, input: unknown) {
    const value = SourceLifecycleRegistrationV1Schema.parse(input), observer = live.get(value.launch.observer_id);
    if (!observer || !same(observer.identity, identity) || !observer.launch || !same(observer.launch, value.launch))
      throw AppError.permissionDenied("Daemon registration has no independently bound original launcher");
    const registration = value.registration, binding = registration.binding;
    if (registration.epoch.session_id !== sessionId || binding.node_id !== identity.computerId || binding.device_id !== identity.deviceId)
      throw AppError.permissionDenied("Clean lifecycle registration changed its paired daemon identity");
    currentSession(identity, sessionId);
    const lineageId = await ctx.db.transaction(async tx => {
      // The origin reader locks its goal and both paired credentials in the
      // shared sorted order before the destination computer/workspace fence.
      const successor = observer.grant ? await grantOrigin(ctx, tx, identity, observer.grant) : undefined;
      await qualify(tx, observer); currentSession(identity, sessionId); await computerLock(ctx, tx, identity.computerId);
      const [stored] = await tx.select().from(nodeRecoveryRegistrations).where(and(eq(nodeRecoveryRegistrations.id, registration.registration_id),
        eq(nodeRecoveryRegistrations.organizationId, ctx.organizationId)));
      if (!stored || !same(stored.registration, registration) || stored.tokenLookup !== identity.tokenLookup || stored.registrationDigest !== hash(registration))
        throw AppError.conflict("Clean lifecycle requires the daemon's already committed original Guardian registration");
      if (observer.registration) {
        if (!same(observer.registration, value) || !observer.lineageId) throw AppError.conflict("Original lifecycle registration is immutable");
        return observer.lineageId;
      }
      const existing = await tx.select().from(lineages).where(and(eq(lineages.organizationId, ctx.organizationId), eq(lineages.computerId, identity.computerId))).for("update");
      let id: string;
      if (!observer.grant) {
        if (value.successor_grant_digest !== undefined || binding.store_identity_digest !== value.launch.stable.genesis_store_identity_digest
          || registration.epoch.generation !== 0 || existing.some(row => row.workspaceIdentityDigest === binding.workspace_identity_digest
            || automationWorkspacesOverlap(row.workspaceRoot, binding.workspace_root, "windows")))
          throw AppError.conflict("A new store cannot bypass any retained physical workspace lineage");
        id = randomUUID(); const now = ctx.clock.nowIso();
        await tx.insert(lineages).values({ id, organizationId: ctx.organizationId, computerId: identity.computerId, deviceId: identity.deviceId,
          workspaceRoot: binding.workspace_root, workspaceIdentityDigest: binding.workspace_identity_digest, stable: value.launch.stable,
          stableDigest: hash(value.launch.stable), initialRegistration: value, currentRegistrationId: registration.registration_id,
          currentGenerationId: randomUUID(), revision: 0, state: "active", createdAt: now, updatedAt: now });
      } else {
        const grant = observer.grant, lineage = existing.find(row => row.id === grant.lineage_id);
        const [generation] = await tx.select().from(generations).where(and(eq(generations.id, grant.generation_id), eq(generations.organizationId, ctx.organizationId))).for("update");
        const [stop] = generation ? await tx.select().from(stops).where(eq(stops.id, generation.predecessorStopId)) : [];
        if (!lineage || !generation || !stop || lineage.state !== "reserved" || generation.claimantObserverId !== observer.id
          || generation.grantDigest !== hash(grant) || value.successor_grant_digest !== generation.grantDigest
          || !same(grant.stable, value.launch.stable) || !same(generation.grant, grant) || !same(stop.receipt, grant.predecessor))
          throw AppError.conflict("Fresh daemon does not own its exact retained successor reservation");
        const root = successor!.root;
        assertSourceCleanCurrentProfiles(ctx, root, true);
        if (!same(root.origin, grant.origin)) throw AppError.conflict("Clean restart accepted origin changed before registration");
        await assertSourceCleanWorkspaceReservation(ctx, tx, root, identity.computerId, lineage.workspaceRoot);
        const history = await tx.select().from(generations).where(and(eq(generations.lineageId, lineage.id), isNotNull(generations.lifecycleRegistration)));
        const prior = [SourceLifecycleRegistrationV1Schema.parse(lineage.initialRegistration),
          ...history.map(row => SourceLifecycleRegistrationV1Schema.parse(row.lifecycleRegistration))];
        if (registration.epoch.generation !== 0 || prior.some(old => old.registration.binding.store_identity_digest === binding.store_identity_digest
          || old.registration.binding.guardian_instance_id === binding.guardian_instance_id || old.registration.epoch.epoch_id === registration.epoch.epoch_id
          || old.registration.epoch.session_id === sessionId || same(old.launch.supervisor, value.launch.supervisor)))
          throw AppError.conflict("Clean restart must bootstrap a genuinely distinct store, Guardian, Supervisor, epoch and paired session");
        if (generation.lifecycleRegistration) {
          if (!same(generation.lifecycleRegistration, value)) throw AppError.conflict("Claimed successor cannot change its daemon registration");
        } else await tx.update(generations).set({ registrationId: registration.registration_id, lifecycleRegistration: value, registeredAt: ctx.clock.nowIso() })
          .where(eq(generations.id, generation.id));
        id = lineage.id;
      }
      await qualify(tx, observer); currentSession(identity, sessionId);
      if (successor) assertSourceCleanCurrentProfiles(ctx, successor.root, true);
      return id;
    });
    // Publish live registration only after the transaction commits.
    current(observer); observer.registration = value; observer.lineageId = lineageId;
    return { version: 1 as const, observer_id: observer.id, lineage_id: lineageId, registration_id: registration.registration_id,
      registration_digest: hash(value), ...(observer.grant ? { generation_id: observer.grant.generation_id, restart_grant: observer.grant } : {}) };
  }

  async function checkpoint(identity: AuthenticatedTransferNode, sessionId: string, input: unknown) {
    const parsed = SourceCleanRestartCheckpointV1Schema.parse(input), observer = live.get(parsed.lifecycle_registration.launch.observer_id);
    if (!observer?.grant || !observer.registration || !same(observer.identity, identity) || !same(observer.registration, parsed.lifecycle_registration))
      throw AppError.permissionDenied("Clean checkpoint has no original fresh claimant and registered daemon");
    const value = inspectSourceCleanCheckpointV1(observer.grant, parsed, sha); currentSession(identity, sessionId);
    return ctx.db.transaction(async tx => {
      const origin = await grantOrigin(ctx, tx, identity, observer.grant!);
      await qualify(tx, observer); currentSession(identity, sessionId);
      const lineage = await lineageLock(ctx, tx, identity, value.lineage_id);
      const [generation] = await tx.select().from(generations).where(and(eq(generations.id, value.generation_id), eq(generations.organizationId, ctx.organizationId))).for("update");
      if (!generation || generation.grantDigest !== value.grant_digest || !same(generation.lifecycleRegistration, observer.registration)
        || generation.claimantObserverId !== observer.id) throw AppError.conflict("Clean checkpoint changed its reserved generation");
      if (generation.checkpoint) {
        const stillReserved = lineage.state === "reserved" && lineage.currentGenerationId === observer.grant!.predecessor_generation_id;
        const stillCurrent = lineage.state === "recovery" && lineage.currentGenerationId === generation.id && lineage.currentRegistrationId === generation.registrationId;
        const receipt = SourceCleanRestartReceiptV1Schema.parse(generation.receipt);
        if (!same(generation.checkpoint, value) || generation.checkpointDigest !== hash(value) || !stillReserved && !stillCurrent
          || receipt.registration_id !== generation.registrationId || receipt.session_id !== sessionId)
          throw AppError.conflict("Clean checkpoint is immutable and may replay only for its current original generation");
        return receipt;
      }
      if (lineage.state !== "reserved" || lineage.currentGenerationId !== observer.grant!.predecessor_generation_id)
        throw AppError.conflict("Clean checkpoint changed its reserved predecessor generation");
      if (generation.predecessorStopId !== origin.stop.id) throw AppError.conflict("Clean checkpoint predecessor was lost");
      const root = origin.root;
      assertSourceCleanCurrentProfiles(ctx, root, true);
      if (!same(root.origin, observer.grant!.origin)) throw AppError.conflict("Clean checkpoint accepted source changed");
      await assertSourceCleanWorkspaceReservation(ctx, tx, root, identity.computerId, lineage.workspaceRoot);
      const event = await appendEvent(tx, buildEvent(ctx, { type: "node.source-clean-restart.checkpointed", actorType: "system", actorId: "source_lifecycle",
        goalId: root.goal.id, projectId: root.implementation.projectId, correlationId: generation.id,
        payload: { generation_id: generation.id, lineage_id: lineage.id, checkpoint_digest: hash(value), source_state: "unverified", publication_authorized: false } }));
      const receipt = SourceCleanRestartReceiptV1Schema.parse({ version: 1, lineage_id: lineage.id, generation_id: generation.id,
        grant_digest: generation.grantDigest, checkpoint_digest: hash(value), registration_id: observer.registration!.registration.registration_id,
        session_id: sessionId, committed_event_id: event.id, source_state: "unverified" });
      await tx.update(generations).set({ checkpoint: value, checkpointDigest: hash(value), receipt, checkpointedAt: ctx.clock.nowIso() }).where(eq(generations.id, generation.id));
      await qualify(tx, observer); currentSession(identity, sessionId); assertSourceCleanCurrentProfiles(ctx, root, true); return receipt;
    });
  }

  return {
    registerDaemon, checkpoint,
    open(identityInput: AuthenticatedTransferNode, isOpen: () => boolean) {
      const identity = Object.freeze({ ...identityInput }), observer: Observer = { id: randomUUID(), challenge: randomBytes(32).toString("hex"), identity, isOpen };
      live.set(observer.id, observer);
      return {
        hello: Object.freeze({ version: 1 as const, observer_id: observer.id, challenge: observer.challenge }),
        close() { live.delete(observer.id); },
        async bindLaunch(secret: string, input: unknown) {
          challenge(observer, secret); const value = SourceSupervisorLaunchV1Schema.parse(input);
          if (value.observer_id !== observer.id || value.stable.node_id !== identity.computerId || value.stable.device_id !== identity.deviceId
            || observer.launch && !same(observer.launch, value) || observer.grant && !same(observer.grant.stable, value.stable))
            throw AppError.conflict("Original parent launch binding is immutable");
          await ctx.db.transaction(tx => qualify(tx, observer)); current(observer); observer.launch = value;
          return { version: 1 as const, observer_id: observer.id, launch_digest: hash(value) };
        },
        /** Read-only eligibility for the original parent's bounded wait. A true
         * result grants no stop authority: prepareStop rechecks and freezes in
         * its original transaction after this observation has returned. */
        async isReadyForPlannedStop(secret: string): Promise<boolean> {
          challenge(observer, secret);
          if (!observer.registration || !observer.lineageId || !observer.launch || observer.grant || observer.intent)
            throw AppError.conflict("Planned clean stop requires its original registered initial generation");
          return ctx.db.transaction(async tx => {
            await qualify(tx, observer); currentSession(identity, observer.registration!.registration.epoch.session_id);
            // No goal/lineage update locks are taken while polling. The real
            // prepare transaction preserves the existing goal-first lock order.
            const [lineage] = await tx.select().from(lineages).where(and(eq(lineages.id, observer.lineageId!), eq(lineages.organizationId, ctx.organizationId)));
            if (!lineage || lineage.computerId !== identity.computerId || lineage.deviceId !== identity.deviceId
              || lineage.state !== "active" || lineage.currentRegistrationId !== observer.registration!.registration.registration_id
              || !same(lineage.initialRegistration, observer.registration))
              throw AppError.conflict("Planned clean stop lost its exact active initial lineage");
            const origins = await tx.select({ review: goalImportedExecutionReviews }).from(goalImportedExecutionReviews)
              .innerJoin(goals, eq(goals.id, goalImportedExecutionReviews.goalId))
              .where(and(eq(goalImportedExecutionReviews.organizationId, ctx.organizationId), eq(goalImportedExecutionReviews.computerId, identity.computerId),
                eq(goalImportedExecutionReviews.workspaceRoot, observer.registration!.registration.binding.workspace_root), isNotNull(goalImportedExecutionReviews.acceptedAt), eq(goals.status, "running")));
            if (origins.length > 1) throw AppError.conflict("Planned clean stop has ambiguous accepted H6 product origins");
            await qualify(tx, observer); currentSession(identity, observer.registration!.registration.epoch.session_id);
            return origins.length === 1;
          });
        },
        async prepareStop(secret: string, replyByteBudget = SOURCE_LIFECYCLE_REPLY_MAX_BYTES_V1) {
          challenge(observer, secret);
          if (!observer.registration || !observer.lineageId || !observer.launch) throw AppError.conflict("Clean stop requires independently bound parent and daemon registration");
          const value = await ctx.db.transaction(async tx => {
            const origins = await tx.select({ review: goalImportedExecutionReviews }).from(goalImportedExecutionReviews)
              .innerJoin(goals, eq(goals.id, goalImportedExecutionReviews.goalId))
              .where(and(eq(goalImportedExecutionReviews.organizationId, ctx.organizationId), eq(goalImportedExecutionReviews.computerId, identity.computerId),
                eq(goalImportedExecutionReviews.workspaceRoot, observer.registration!.registration.binding.workspace_root), isNotNull(goalImportedExecutionReviews.acceptedAt), eq(goals.status, "running")));
            if (origins.length !== 1) throw AppError.conflict("Clean stop requires one current independently accepted H6 product origin");
            const root = await readSourceCleanOrigin(ctx, tx, origins[0]!.review.id, identity, observer.registration!.registration);
            await qualify(tx, observer); currentSession(identity, observer.registration!.registration.epoch.session_id);
            const lineage = await lineageLock(ctx, tx, identity, observer.lineageId!);
            const [existing] = await tx.select().from(stops).where(and(eq(stops.lineageId, lineage.id), eq(stops.generationId, lineage.currentGenerationId)));
            if (existing) {
              if (existing.observerId !== observer.id || existing.registrationId !== observer.registration!.registration.registration_id || existing.closedAt)
                throw AppError.conflict("The native generation already belongs to another completed or pending clean stop");
              const intent = SourceCleanStopIntentV1Schema.parse(existing.intent);
              replyFits("node.source-clean-stop.prepared.v1", intent, replyByteBudget); return intent;
            }
            if (lineage.state !== "active" || lineage.currentRegistrationId !== observer.registration!.registration.registration_id)
              throw AppError.conflict("This clean-stop milestone requires the initial accepted-H6 native generation");
            assertSourceCleanCurrentProfiles(ctx, root, true);
            await assertSourceCleanWorkspaceReservation(ctx, tx, root, identity.computerId, lineage.workspaceRoot);
            const operations = await sourceCleanOperations(ctx, tx, root, observer.registration!.registration), stopId = randomUUID();
            const event = await appendEvent(tx, buildEvent(ctx, { type: "node.source-clean-stop.prepared", actorType: "system", actorId: "source_lifecycle",
              goalId: root.goal.id, projectId: root.implementation.projectId, correlationId: stopId,
              payload: { stop_id: stopId, observer_id: observer.id, lineage_id: lineage.id, actor_user_id: root.h6.actorUserId, publication_authorized: false } }));
            const intent = SourceCleanStopIntentV1Schema.parse({ version: 1, stop_id: stopId, lineage_id: lineage.id, generation_id: lineage.currentGenerationId,
              revision: lineage.revision, launch: observer.launch, registration: observer.registration!.registration, origin: root.origin, goal_id: root.goal.id, plan_id: root.plan.id,
              authorization: { event_id: event.id, actor_user_id: root.h6.actorUserId, consent_id: root.h6.consentId, policy_version: root.h6.policyVersion }, operations });
            replyFits("node.source-clean-stop.prepared.v1", intent, replyByteBudget);
            const now = ctx.clock.nowIso();
            await tx.insert(stops).values({ id: stopId, lineageId: lineage.id, organizationId: ctx.organizationId, generationId: lineage.currentGenerationId,
              observerId: observer.id, registrationId: lineage.currentRegistrationId, intentDigest: hash(intent), intent, createdAt: now });
            await moveLineage(tx, lineage, "closing", now); await qualify(tx, observer); currentSession(identity, observer.registration!.registration.epoch.session_id);
            assertSourceCleanCurrentProfiles(ctx, root, true);
            return intent;
          });
          current(observer); observer.intent = value; return value;
        },
        async commitStop(secret: string, input: unknown) {
          challenge(observer, secret);
          if (!observer.intent) throw AppError.conflict("Original observer has no prepared clean-stop intent");
          const value = inspectSourceCleanClosureV1(observer.intent, input, sha);
          return ctx.db.transaction(async tx => {
            // Deliberately do not require the now-stopped daemon session. The
            // original parent connection plus still-valid paired credential is
            // the sole admission to this exact already-prepared stop.
            await goalLock(ctx, tx, observer.intent!.goal_id);
            await qualify(tx, observer); const lineage = await lineageLock(ctx, tx, identity, observer.intent!.lineage_id);
            const [stop] = await tx.select().from(stops).where(and(eq(stops.id, value.stop_id), eq(stops.organizationId, ctx.organizationId))).for("update");
            if (!stop || stop.observerId !== observer.id || stop.intentDigest !== hash(observer.intent) || !same(stop.intent, observer.intent))
              throw AppError.conflict("Original clean closure no longer matches its prepared intent");
            if (stop.closure) {
              if (stop.closureDigest !== hash(value) || !same(stop.closure, value)) throw AppError.conflict("Clean stop cannot replace its original closure");
              return SourceCleanStopReceiptV1Schema.parse(stop.receipt);
            }
            if (lineage.state !== "closing" || lineage.currentGenerationId !== stop.generationId || lineage.currentRegistrationId !== stop.registrationId)
              throw AppError.conflict("Clean closure lost its original retained physical occupancy");
            const event = await appendEvent(tx, buildEvent(ctx, { type: "node.source-clean-stop.committed", actorType: "system", actorId: "source_lifecycle",
              goalId: observer.intent!.goal_id, correlationId: stop.id,
              payload: { stop_id: stop.id, observer_id: observer.id, intent_digest: stop.intentDigest, closure_digest: hash(value), publication_authorized: false } }));
            const receipt = SourceCleanStopReceiptV1Schema.parse({ version: 1, stop_id: stop.id, lineage_id: lineage.id, generation_id: stop.generationId,
              intent_digest: stop.intentDigest, closure_digest: hash(value), committed_event_id: event.id });
            const now = ctx.clock.nowIso();
            await tx.update(stops).set({ closure: value, closureDigest: hash(value), receipt, closedAt: now }).where(eq(stops.id, stop.id));
            await moveLineage(tx, lineage, "closed", now); await qualify(tx, observer); return receipt;
          });
        },
        async claimRestart(secret: string, stopId: string, replyByteBudget = SOURCE_LIFECYCLE_REPLY_MAX_BYTES_V1) {
          challenge(observer, secret);
          if (observer.registration || observer.intent || observer.launch) throw AppError.conflict("A successor must reserve its new store before native launch");
          const grant = await ctx.db.transaction(async tx => {
            current(observer);
            const [stop] = await tx.select().from(stops).where(and(eq(stops.id, stopId), eq(stops.organizationId, ctx.organizationId)));
            if (!stop?.closure || !stop.receipt) throw AppError.conflict("A new launcher cannot claim an unobserved or uncommitted native stop");
            const intent = SourceCleanStopIntentV1Schema.parse(stop.intent);
            const root = await readSourceCleanOrigin(ctx, tx, intent.origin.review_id, identity, intent.registration);
            await qualify(tx, observer);
            const lineage = await lineageLock(ctx, tx, identity, stop.lineageId);
            const [existing] = await tx.select().from(generations).where(eq(generations.predecessorStopId, stop.id)).for("update");
            if (existing) {
              if (existing.claimantObserverId !== observer.id || !observer.grant || !same(existing.grant, observer.grant))
                throw AppError.conflict("The closure already has a retained successor; timeout or a new connection cannot replace it");
              const grant = SourceCleanRestartGrantV1Schema.parse(existing.grant);
              replyFits("node.source-clean-restart.claimed.v1", grant, replyByteBudget); return grant;
            }
            if (lineage.state !== "closed" || lineage.currentGenerationId !== stop.generationId || lineage.currentRegistrationId !== stop.registrationId)
              throw AppError.conflict("Clean restart no longer owns its predecessor lineage");
            assertSourceCleanCurrentProfiles(ctx, root, false);
            if (!same(root.origin, intent.origin) || root.goal.id !== intent.goal_id || root.plan.id !== intent.plan_id
              || !same(await sourceCleanOperations(ctx, tx, root, intent.registration), intent.operations))
              throw AppError.conflict("Clean restart goal, accepted source or complete operation set changed");
            await assertSourceCleanWorkspaceReservation(ctx, tx, root, identity.computerId, lineage.workspaceRoot);
            const generationId = randomUUID(), event = await appendEvent(tx, buildEvent(ctx, { type: "node.source-clean-restart.claimed", actorType: "system", actorId: "source_lifecycle",
              goalId: root.goal.id, projectId: root.implementation.projectId, correlationId: generationId,
              payload: { generation_id: generationId, lineage_id: lineage.id, stop_id: stop.id, observer_id: observer.id, actor_user_id: root.h6.actorUserId,
                source_state: "unverified", publication_authorized: false } }));
            const value = SourceCleanRestartGrantV1Schema.parse({ version: 1, lineage_id: lineage.id, predecessor_generation_id: stop.generationId,
              generation_id: generationId, claimant_observer_id: observer.id, revision: lineage.revision + 1, stable: lineage.stable,
              predecessor: stop.receipt, predecessor_history_digest: inspectSourceCleanClosureV1(intent, stop.closure, sha).retained_history_digest,
              origin: root.origin, goal_id: root.goal.id, plan_id: root.plan.id,
              authorization: { event_id: event.id, actor_user_id: root.h6.actorUserId, consent_id: root.h6.consentId, policy_version: root.h6.policyVersion }, scope: "unverified-h7-recovery" });
            replyFits("node.source-clean-restart.claimed.v1", value, replyByteBudget);
            const now = ctx.clock.nowIso();
            await tx.insert(generations).values({ id: generationId, lineageId: lineage.id, organizationId: ctx.organizationId, predecessorStopId: stop.id,
              claimantObserverId: observer.id, grantDigest: hash(value), grant: value, createdAt: now });
            await moveLineage(tx, lineage, "reserved", now); await qualify(tx, observer); assertSourceCleanCurrentProfiles(ctx, root, false); return value;
          });
          current(observer); observer.grant = grant; return grant;
        },
      };
    },
    close() { live.clear(); },
  };
}
export type SourceLifecycleRegistry = ReturnType<typeof createSourceLifecycleRegistry>;

/** Called only by GoalRunner after the exact checkpoint receipt committed. The
 * resulting state stays unverified and retains an ordinary-workspace fence. */
export async function settleSourceCleanGeneration(ctx: ServerContext, tx: DrizzleDb, generationId: string) {
  const [initial] = await tx.select().from(generations).where(and(eq(generations.id, generationId), eq(generations.organizationId, ctx.organizationId)));
  if (!initial) throw AppError.notFound("Clean restart generation not found");
  const grant = SourceCleanRestartGrantV1Schema.parse(initial.grant);
  if (ctx.automationActor?.id !== "goal_runner" || ctx.actorUserId !== grant.authorization.actor_user_id)
    throw AppError.permissionDenied("Only the initiating user's GoalRunner can transfer a clean workspace lineage");
  const current = ctx.getPairedNodeSession?.(grant.stable.node_id);
  if (!current) throw AppError.conflict("Clean restart has no current fresh paired session");
  const origin = await grantOrigin(ctx, tx, current, grant);
  await credential(ctx, tx, current);
  const lineage = await lineageLock(ctx, tx, current, grant.lineage_id);
  const [generation] = await tx.select().from(generations).where(eq(generations.id, generationId)).for("update");
  if (!generation || !generation.checkpoint || !generation.receipt || !generation.lifecycleRegistration || !generation.registrationId)
    throw AppError.conflict("Clean restart settlement waits for the committed fresh unverified checkpoint");
  const checkpoint = inspectSourceCleanCheckpointV1(grant, generation.checkpoint, sha), receipt = SourceCleanRestartReceiptV1Schema.parse(generation.receipt);
  const registered = SourceLifecycleRegistrationV1Schema.parse(generation.lifecycleRegistration);
  if (hash(grant) !== generation.grantDigest || hash(checkpoint) !== generation.checkpointDigest || receipt.checkpoint_digest !== generation.checkpointDigest
    || !same(checkpoint.lifecycle_registration, registered) || receipt.session_id !== current.sessionId || registered.registration.epoch.session_id !== current.sessionId
    || current.deviceId !== registered.registration.binding.device_id || receipt.registration_id !== generation.registrationId)
    throw AppError.conflict("Clean settlement checkpoint, receipt or current session changed");
  const [stop] = await tx.select().from(stops).where(eq(stops.id, generation.predecessorStopId));
  if (!stop || !same(stop.receipt, grant.predecessor)) throw AppError.conflict("Clean settlement predecessor receipt changed");
  const intent = SourceCleanStopIntentV1Schema.parse(stop.intent), root = origin.root;
  assertSourceCleanCurrentProfiles(ctx, root, true);
  if (!same(root.origin, grant.origin) || !generation.settledAt && !same(await sourceCleanOperations(ctx, tx, root, intent.registration), intent.operations))
    throw AppError.conflict("Clean settlement accepted source or old dispatched operations changed");
  await assertSourceCleanWorkspaceReservation(ctx, tx, root, current.computerId, lineage.workspaceRoot);
  if (generation.settledAt) {
    if (lineage.state !== "recovery" || lineage.currentGenerationId !== generation.id || lineage.currentRegistrationId !== generation.registrationId)
      throw AppError.conflict("Settled clean generation no longer owns its physical lineage");
    await readCleanValidationRoot(ctx, tx, generation.id, { live: true });
    return { generation, checkpoint, grant, root, operations: intent.operations };
  }
  if (lineage.state !== "reserved" || lineage.currentGenerationId !== grant.predecessor_generation_id)
    throw AppError.conflict("Clean settlement lost its predecessor reservation");
  const now = ctx.clock.nowIso(), event = await appendEvent(tx, buildEvent(ctx, { type: "goal.source-clean-restart.settled", actorType: "system", actorId: "goal_runner",
    goalId: root.goal.id, projectId: root.implementation.projectId, correlationId: generation.id,
    payload: { generation_id: generation.id, checkpoint_digest: generation.checkpointDigest, actor_user_id: root.h6.actorUserId,
      source_state: "unverified", publication_authorized: false } }));
  for (const operation of intent.operations) {
    await tx.insert(sourceCleanOperationSettlements).values({ id: ctx.idGen.generate("clean_settlement"), generationId: generation.id,
      organizationId: ctx.organizationId, goalId: root.goal.id, computerId: current.computerId, kind: operation.kind,
      operationId: operation.operation_id, requestDigest: operation.request_digest, runId: operation.run_id ?? null, eventId: event.id, createdAt: now });
    if (operation.kind !== "validation") continue;
    const [run] = await tx.select().from(runs).where(and(eq(runs.id, operation.run_id!), eq(runs.organizationId, ctx.organizationId))).for("update");
    if (!run) throw AppError.conflict("Clean restart lost its original dispatched author's actual run");
    if (!["completed", "failed", "cancelled"].includes(run.status)) {
      const status = RunStatusSchema.parse(run.status);
      const changed = await transitionRun(tx, ctx, { runId: run.id, from: status,
        trigger: status === "queued" ? "cancel" : status === "starting" ? "start_failed" : "run_failed",
        patch: { endedAt: now, failureReason: "daemon_disconnect" } });
      if (!changed.changed) throw AppError.conflict("Clean closure could not settle the actual original author lifecycle");
      const [task] = await tx.select().from(tasks).where(and(eq(tasks.id, run.taskId), eq(tasks.organizationId, ctx.organizationId)));
      if (task?.status === "assigned") await transitionTask(tx, ctx, { taskId: task.id, from: "assigned", trigger: "assign_failed_retryable", now });
      if (task?.status === "running" || task?.status === "awaiting_approval")
        await transitionTask(tx, ctx, { taskId: task.id, from: task.status, trigger: "run_failed", now });
    }
    await releaseRunLeases(ctx, tx, run.id);
    await appendEvent(tx, buildEvent(ctx, { type: "run.reconciled", actorType: "system", actorId: "goal_runner", correlationId: generation.id,
      goalId: root.goal.id, taskId: run.taskId, runId: run.id, payload: { clean_generation_id: generation.id,
        checkpoint_digest: generation.checkpointDigest, process_exit_confirmed: true, source_state: "unverified" } }));
  }
  const [updated] = await tx.update(generations).set({ settledAt: now, settlementEventId: event.id }).where(eq(generations.id, generation.id)).returning();
  await moveLineage(tx, lineage, "recovery", now, { id: generation.id, registrationId: generation.registrationId });
  return { generation: updated!, checkpoint, grant, root, operations: intent.operations };
}
