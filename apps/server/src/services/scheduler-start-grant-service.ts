import { randomUUID } from "node:crypto";
import { appendEvent, schedulerStartGrants } from "@artoo/db";
import {
  SchedulerStartGrantV1Schema,
  SchedulerStartReadyV1Schema,
  type SchedulerStartReadyV1,
  type SchedulerStartGrantV1,
} from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, eq } from "drizzle-orm";
import { auditDigestV1 } from "../audit-signature.js";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import type { SchedulerExecutionClaimInput } from "./scheduler-execution-claim-service.js";
import { buildSchedulerStartProposalFromPrepared } from "./scheduler-start-proposal-service.js";
import { withRevalidatedSchedulerPreparedStart } from "./scheduler-start-revalidation-service.js";

/** The negotiated paired channel authenticates the original consumed claim
 * independently. Nodes must enforce their private
 * preparation capability and conservative monotonic deadline before spawning. */
export function grantSchedulerStart(
  ctx: ServerContext,
  input: SchedulerExecutionClaimInput,
  ready: SchedulerStartReadyV1,
) {
  return ctx.db.db.transaction((tx) => grantSchedulerStartInTransaction(ctx, tx, input, ready), {
    isolationLevel: "read committed",
  });
}

export function grantSchedulerStartInTransaction(
  ctx: ServerContext,
  tx: DrizzleDb,
  input: SchedulerExecutionClaimInput,
  raw: SchedulerStartReadyV1,
) {
  const parsed = SchedulerStartReadyV1Schema.safeParse(raw);
  if (!parsed.success) throw AppError.validation("Invalid scheduler node-ready binding");
  const ready = parsed.data;
  return withRevalidatedSchedulerPreparedStart(ctx, tx, input, async (prepared, credentialExpiresAt) => {
    const proposal = await buildSchedulerStartProposalFromPrepared(ctx, tx, prepared);
    if (
      ready.request_id !== prepared.request_id ||
      ready.run_id !== prepared.run_id ||
      ready.proposal_digest !== proposal.proposal_digest
    )
      throw AppError.conflict("Scheduler node-ready proposal does not match the original prepared assignment");
    const [existing] = await tx
      .select()
      .from(schedulerStartGrants)
      .where(
        and(
          eq(schedulerStartGrants.requestId, prepared.request_id),
          eq(schedulerStartGrants.organizationId, ctx.organizationId),
        ),
      );
    let grant: SchedulerStartGrantV1;
    if (existing) {
      const saved = SchedulerStartGrantV1Schema.safeParse(existing.snapshot);
      if (
        !saved.success ||
        auditDigestV1(saved.data) !== existing.snapshotDigest ||
        saved.data.grant_id !== existing.grantId ||
        saved.data.run_id !== existing.runId ||
        saved.data.journal_namespace !== existing.journalNamespace ||
        saved.data.node_attempt_id !== existing.nodeAttemptId ||
        Date.parse(saved.data.issued_at) !== Date.parse(existing.issuedAt) ||
        Date.parse(saved.data.expires_at) !== Date.parse(existing.expiresAt)
      )
        throw AppError.conflict("Scheduler start grant integrity changed");
      grant = saved.data;
      if (Object.entries(ready).some(([key, value]) => grant[key as keyof typeof grant] !== value))
        throw AppError.conflict("A scheduling request cannot authorize another node attempt or ready exchange");
    } else {
      const issued = Date.parse(ctx.clock.nowIso());
      const expires = Math.min(
        issued + 5000,
        credentialExpiresAt === null ? Infinity : Date.parse(credentialExpiresAt),
      );
      grant = SchedulerStartGrantV1Schema.parse({
        ...ready,
        scope: "scheduler-start.once.v1",
        grant_id: randomUUID(),
        organization_id: prepared.organization_id,
        project_id: prepared.project_id,
        task_id: prepared.task_id,
        actor_user_id: prepared.actor_user_id,
        agent_instance_id: prepared.agent_instance_id,
        computer_id: prepared.computer_id,
        device_id: prepared.device_id,
        session_id: prepared.session_id,
        issued_at: new Date(issued).toISOString(),
        expires_at: new Date(expires).toISOString(),
      });
      await tx.insert(schedulerStartGrants).values({
        requestId: grant.request_id,
        runId: grant.run_id,
        organizationId: grant.organization_id,
        journalNamespace: grant.journal_namespace,
        nodeAttemptId: grant.node_attempt_id,
        grantId: grant.grant_id,
        snapshot: grant,
        snapshotDigest: auditDigestV1(grant),
        issuedAt: grant.issued_at,
        expiresAt: grant.expires_at,
      });
      await appendEvent(
        tx,
        buildEvent(ctx, {
          type: "scheduler.start_grant.created",
          actorType: "system",
          actorId: "scheduler",
          correlationId: grant.request_id,
          projectId: grant.project_id,
          taskId: grant.task_id,
          runId: grant.run_id,
          payload: {
            version: 1,
            grant_id: grant.grant_id,
            actor_user_id: grant.actor_user_id,
            node_attempt_id: grant.node_attempt_id,
            journal_namespace: grant.journal_namespace,
            proposal_digest: grant.proposal_digest,
            expires_at: grant.expires_at,
          },
        }),
      );
    }
    // Include all awaited writes in both expiry checks. Replays never move the
    // original deadline; final credential/session validation follows in owner.
    const now = Date.parse(ctx.clock.nowIso());
    const remaining = Math.floor(
      Math.min(
        Date.parse(grant.expires_at),
        credentialExpiresAt === null ? Infinity : Date.parse(credentialExpiresAt),
      ) - now,
    );
    if (!Number.isFinite(remaining) || remaining <= 0 || now < Date.parse(grant.issued_at))
      throw AppError.conflict("Scheduler start grant has expired or its clock continuity is unknown");
    return Object.freeze({ version: 1 as const, grant: Object.freeze(grant), remaining_ms: remaining });
  });
}
