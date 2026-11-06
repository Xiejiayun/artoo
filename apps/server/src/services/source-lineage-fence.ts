import { computers, sourceWorkspaceLineages } from "@artoo/db";
import { and, eq } from "drizzle-orm";
import type { DrizzleDb } from "@artoo/storage";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { automationWorkspacesOverlap } from "./automation-workspace.js";

/** Use in the actual dispatch transaction after existing goal/credential/agent
 * admission. The shared computer lock serializes it against prepareStop. Stop,
 * status, results and closure receipts deliberately do not call this start gate. */
export async function assertSourceLineageDispatch(ctx: ServerContext, tx: DrizzleDb, computerId: string, workspaceRoot?: string | null) {
  const [computer] = await tx.select({ id: computers.id }).from(computers).where(and(eq(computers.id, computerId),
    eq(computers.organizationId, ctx.organizationId))).for("update");
  if (!computer) throw AppError.conflict("Execution computer disappeared before its source-lineage admission");
  const rows = await tx.select().from(sourceWorkspaceLineages).where(and(eq(sourceWorkspaceLineages.organizationId, ctx.organizationId),
    eq(sourceWorkspaceLineages.computerId, computerId)));
  for (const row of rows) {
    if (["closing", "closed", "reserved"].includes(row.state))
      throw AppError.conflict("The native executor has a retained clean-stop or restart reservation");
    if (row.state === "recovery" && (!workspaceRoot || automationWorkspacesOverlap(row.workspaceRoot, workspaceRoot, "windows")))
      throw AppError.conflict("The restarted workspace requires its dedicated fresh validation admission");
  }
}
