import { schedulerExecutionRequests } from "@artoo/db";
import type { DrizzleDb } from "@artoo/storage";
import { and, eq } from "drizzle-orm";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";

/** Ordinary events and command ACKs carry neither the scheduler attempt nor its
 * journal namespace. They cannot settle that attempt or prove physical absence.
 * Consumption creates its Run atomically and is immutable, so an ordinary Run
 * cannot become a scheduler Run during an awaited external stop. */
export async function assertOrdinaryRunControl(ctx: ServerContext, db: DrizzleDb, runId: string): Promise<void> {
  const [consumed] = await db
    .select({ id: schedulerExecutionRequests.id })
    .from(schedulerExecutionRequests)
    .where(
      and(
        eq(schedulerExecutionRequests.organizationId, ctx.organizationId),
        eq(schedulerExecutionRequests.consumedRunId, runId),
        eq(schedulerExecutionRequests.state, "consumed"),
      ),
    )
    .limit(1);
  if (consumed) throw AppError.conflict("Scheduler Run control requires its scoped node-owned attempt protocol");
}
