import type { DrizzleDb } from "@artoo/storage";
import { is, sql } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";

/** A project can use organization-wide Agents, instances and installed skills. */
export function schedulerConfigurationFenceEnabled(ctx: ServerContext): boolean {
  const workspace = ctx.schedulerRollout?.workspaces[ctx.organizationId];
  return (
    workspace?.flags?.daemon_claim === true ||
    Object.values(workspace?.projects ?? {}).some((project) => project.daemon_claim === true)
  );
}

/**
 * Configuration writers and future executing admission must share this fence,
 * including first inserts into an Agent pool. Never wait while holding owner
 * locks: contention requires retrying the complete authorized transaction.
 * This does not fence Task inputs, consent, node identity or local profiles.
 */
export async function lockSchedulerConfiguration(ctx: ServerContext, tx: DrizzleDb): Promise<boolean> {
  if (!schedulerConfigurationFenceEnabled(ctx)) return false;
  if (!is(tx, PgTransaction))
    throw AppError.conflict("Scheduling configuration requires a database transaction", {
      reason: "scheduler_configuration_transaction",
    });
  const result = await tx.execute(
    sql`SELECT pg_try_advisory_xact_lock(1095914314, hashtext(${ctx.organizationId})) AS acquired`,
  );
  if (result.rows[0]?.acquired !== true)
    throw AppError.conflict("Scheduling configuration is busy; retry the complete operation", {
      reason: "scheduler_configuration_busy",
    });
  const isolation = await tx.execute(sql`SHOW transaction_isolation`);
  if (isolation.rows[0]?.transaction_isolation !== "read committed")
    throw AppError.conflict("Scheduling configuration requires read committed isolation", {
      reason: "scheduler_configuration_transaction",
    });
  return true;
}
