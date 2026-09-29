import { computers, runs } from "@artoo/db";
import { and, eq, inArray } from "drizzle-orm";

import type { ServerContext } from "../context.js";
import type { GraceWindowManager } from "../ws/grace-window.js";

/**
 * Rebuild interrupted execution state before accepting client/node connections.
 * The durable run, rather than a checkpoint or lease, is the recovery record.
 * Restart gives nodes one bounded reconnect window; expiry records uncertainty,
 * never process exit. Reconnection only probes existing processes (run.resume),
 * and never replays run.start or creates another execution.
 *
 * Call exactly once before listen. Tests that deliberately seed an online mock
 * computer may retain that fixture with resetPresence:false.
 */
export async function recoverInterruptedRuns(
  ctx: ServerContext,
  graceWindow: GraceWindowManager,
  options: { resetPresence?: boolean } = {},
): Promise<{ computers: number; runs: number }> {
  const interrupted = await ctx.db.transaction(async (tx) => {
    if (options.resetPresence !== false) {
      await tx.update(computers).set({ status: "offline" })
        .where(eq(computers.organizationId, ctx.organizationId));
    }
    return tx.select({ id: runs.id, computerId: runs.computerId }).from(runs).where(and(
      eq(runs.organizationId, ctx.organizationId), inArray(runs.status, ["queued", "starting", "running", "paused", "awaiting_input"]),
    ));
  });
  const byComputer = new Map<string, string[]>();
  for (const run of interrupted) {
    const ids = byComputer.get(run.computerId) ?? [];
    ids.push(run.id);
    byComputer.set(run.computerId, ids);
  }
  for (const [computerId, ids] of byComputer) graceWindow.arm(computerId, ids);
  return { computers: byComputer.size, runs: interrupted.length };
}
