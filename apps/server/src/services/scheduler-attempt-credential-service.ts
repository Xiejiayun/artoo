import { randomBytes, randomUUID } from "node:crypto";
import { appendEvent, schedulerAttemptCredentials, schedulerExecutionLeases, schedulerStartGrants } from "@artoo/db";
import {
  SchedulerAttemptCredentialV1Schema,
  SchedulerExecutionLeaseBindingV1Schema,
  SchedulerStartGrantV1Schema,
  type SchedulerAttemptCredentialV1,
  type SchedulerExecutionLeaseV1,
} from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, eq, isNull, sql } from "drizzle-orm";
import { schedulerRolloutEnabled } from "../config/scheduler-rollout.js";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { constantTimeEqualHex, sha256Hex } from "./device-credential.js";
import type { SchedulerExecutionClaimInput } from "./scheduler-execution-claim-service.js";
import { withCurrentSchedulerExecutionLease } from "./scheduler-execution-lease-service.js";

const c = schedulerAttemptCredentials;
const l = schedulerExecutionLeases;
const g = schedulerStartGrants;

function requireRollout(ctx: ServerContext, projectId: string) {
  if (
    !schedulerRolloutEnabled(ctx.schedulerRollout, "attempt_credentials", {
      organizationId: ctx.organizationId,
      projectId,
    })
  )
    throw AppError.conflict("Scheduler attempt credentials are disabled");
}

function hashCredential(credential: SchedulerAttemptCredentialV1, leaseId: string) {
  return sha256Hex(JSON.stringify([credential.scope, credential.credential_id, leaseId, credential.secret]));
}

function rethrowContention(error: unknown): never {
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  if ((cause as { code?: string } | null)?.code === "55P03")
    throw AppError.conflict("Scheduler attempt credential is changing; retry the complete operation");
  throw error;
}

async function audit(
  ctx: ServerContext,
  tx: DrizzleDb,
  lease: SchedulerExecutionLeaseV1,
  credentialId: string,
  operation: "issued" | "renewed",
) {
  await appendEvent(
    tx,
    buildEvent(ctx, {
      type: `scheduler.attempt_credential.${operation}`,
      actorType: "system",
      actorId: "scheduler",
      correlationId: lease.binding.request_id,
      projectId: lease.binding.project_id,
      taskId: lease.binding.task_id,
      runId: lease.binding.run_id,
      // Neither raw credential nor hash belongs in the replayable event stream.
      payload: {
        version: 1,
        credential_id: credentialId,
        binding: lease.binding,
        observed_at: ctx.clock.nowIso(),
        expires_at: lease.expires_at,
      },
    }),
  );
}

async function assertCurrent(ctx: ServerContext, tx: DrizzleDb, credentialId: string) {
  const now = ctx.clock.nowIso();
  const [current] = await tx
    .select({ id: c.id })
    .from(c)
    .where(
      and(
        eq(c.id, credentialId),
        isNull(c.revokedAt),
        sql`${c.observedAt} <= ${now}::timestamptz AND ${c.expiresAt} > ${now}::timestamptz`,
      ),
    );
  if (!current) throw AppError.conflict("Scheduler attempt credential is expired, revoked or its clock regressed");
}

export type SchedulerAttemptCredentialAcquisition =
  | { status: "issued"; credential: SchedulerAttemptCredentialV1; lease: SchedulerExecutionLeaseV1 }
  | { status: "retained"; lease: SchedulerExecutionLeaseV1 };

/** Trusted paired-channel kernel only. It never renews a start permit or starts
 * a process. Return plaintext exactly once; response loss cannot recover it.
 * Transport must keep the secret outside ordinary commands, logs and adapters. */
export async function acquireSchedulerAttemptCredential(
  ctx: ServerContext,
  input: SchedulerExecutionClaimInput,
  raw: unknown,
): Promise<SchedulerAttemptCredentialAcquisition> {
  const parsed = SchedulerStartGrantV1Schema.safeParse(raw);
  if (!parsed.success) throw AppError.validation("Invalid scheduler start grant binding");
  const grant = parsed.data;
  requireRollout(ctx, grant.project_id);
  return ctx.db.db.transaction(
    async (tx) => {
      const [found] = await tx
        .select({ binding: l.binding })
        .from(l)
        .innerJoin(g, eq(g.requestId, l.requestId))
        .where(
          and(
            eq(l.organizationId, ctx.organizationId),
            eq(l.requestId, grant.request_id),
            eq(g.grantId, grant.grant_id),
            sql`${g.snapshot} = ${JSON.stringify(grant)}::jsonb`,
          ),
        );
      if (!found) throw AppError.conflict("Scheduler attempt credential requires its exact persisted start grant");
      return withCurrentSchedulerExecutionLease(ctx, tx, input, found.binding, async ({ lease }) => {
        requireRollout(ctx, lease.binding.project_id);
        const [existing] = await tx
          .select({ id: c.id })
          .from(c)
          .where(eq(c.leaseId, lease.binding.lease_id))
          .for("update", { noWait: true })
          .catch(rethrowContention);
        if (existing) {
          await assertCurrent(ctx, tx, existing.id);
          return { status: "retained" as const, lease };
        }
        const credential = SchedulerAttemptCredentialV1Schema.parse({
          version: 1,
          scope: "scheduler.attempt-renew.v1",
          credential_id: randomUUID(),
          secret: randomBytes(32).toString("base64url"),
        });
        const now = ctx.clock.nowIso();
        await tx.insert(c).values({
          id: credential.credential_id,
          leaseId: lease.binding.lease_id,
          secretHash: hashCredential(credential, lease.binding.lease_id),
          createdAt: now,
          observedAt: now,
          expiresAt: lease.expires_at,
        });
        await audit(ctx, tx, lease, credential.credential_id, "issued");
        await assertCurrent(ctx, tx, credential.credential_id);
        return { status: "issued" as const, credential: Object.freeze(credential), lease };
      });
    },
    { isolationLevel: "read committed" },
  );
}

/** Both the original paired identity and the independent attempt secret must
 * succeed. Lock order stays Task/Run -> lease -> credential. Both expiries and
 * both audit records commit together, with no Task/Run/process transition. */
export async function renewSchedulerAttemptCredential(
  ctx: ServerContext,
  input: SchedulerExecutionClaimInput,
  rawBinding: unknown,
  rawCredential: unknown,
) {
  const parsed = SchedulerAttemptCredentialV1Schema.safeParse(rawCredential),
    parsedBinding = SchedulerExecutionLeaseBindingV1Schema.safeParse(rawBinding);
  if (!parsed.success || !parsedBinding.success) throw AppError.validation("Invalid scheduler renewal binding");
  const credential = parsed.data,
    binding = parsedBinding.data;
  requireRollout(ctx, binding.project_id);
  return ctx.db.db.transaction(
    (tx) =>
      withCurrentSchedulerExecutionLease(ctx, tx, input, binding, async (current) => {
        requireRollout(ctx, binding.project_id);
        const [stored] = await tx
          .select({ hash: c.secretHash })
          .from(c)
          .where(and(eq(c.id, credential.credential_id), eq(c.leaseId, binding.lease_id)))
          .for("update", { noWait: true })
          .catch(rethrowContention);
        if (!stored || !constantTimeEqualHex(hashCredential(credential, binding.lease_id), stored.hash))
          throw AppError.permissionDenied("Scheduler attempt credential is not valid for this attempt");
        await assertCurrent(ctx, tx, credential.credential_id);
        const lease = await current.renew();
        await tx
          .update(c)
          .set({ observedAt: lease.observed_at, expiresAt: lease.expires_at })
          .where(eq(c.id, credential.credential_id));
        await audit(ctx, tx, lease, credential.credential_id, "renewed");
        await assertCurrent(ctx, tx, credential.credential_id);
        return lease;
      }),
    { isolationLevel: "read committed" },
  );
}
