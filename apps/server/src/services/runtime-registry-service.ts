import { agentRuntimes, computers } from "@artoo/db";
import type { AgentRuntime } from "@artoo/domain";
import type { RuntimeStatus } from "@artoo/protocol";
import { and, eq, notInArray } from "drizzle-orm";

import type { ServerContext } from "../context.js";
import { mapAgentRuntime } from "../mappers.js";
import { AppError } from "../errors.js";

/**
 * Persist the complete runtime snapshot advertised in a node heartbeat.
 * Upserts one row per `(computer_id, runtime)` (the table's unique key), stamping
 * `last_seen_at` with the SERVER clock (heartbeats carry no timestamp). Capabilities
 * are normalized to a stable `string[]`. `version` stays nullable/non-gating.
 * A required, empty runtimes array means none are currently present. Omitted
 * runtime rows become missing while retaining their last observation metadata.
 * Released registry-mode daemons already enumerate their entire adapter registry
 * in each heartbeat; this reconciles that existing snapshot, not a new delta API.
 *
 * `computerId` is the session-resolved computer id (node.hello's node_id under the
 * current seeded-node mapping). Throws on db error; the WS lifecycle wraps the call
 * best-effort so a transient db failure never tears down the node connection.
 */
export async function recordHeartbeatRuntimes(
  ctx: ServerContext,
  computerId: string,
  runtimes: readonly RuntimeStatus[],
): Promise<void> {
  const now = ctx.clock.nowIso();
  await ctx.db.transaction(async (tx) => {
    // Serialize snapshots for this authorized computer, including its first
    // advertisement when there are no runtime rows to lock yet.
    const [computer] = await tx.select({ id: computers.id }).from(computers).where(and(
      eq(computers.id, computerId), eq(computers.organizationId, ctx.organizationId),
    )).for("update");
    if (!computer) throw AppError.notFound("computer not found");
    const names = runtimes.map((runtime) => runtime.runtime);
    await tx.update(agentRuntimes).set({ status: "missing" }).where(and(
      eq(agentRuntimes.organizationId, ctx.organizationId), eq(agentRuntimes.computerId, computerId),
      names.length ? notInArray(agentRuntimes.runtime, names) : undefined,
    ));
    for (const rt of runtimes) {
      const capabilities = Array.isArray(rt.capabilities) ? [...rt.capabilities] : [];
      await tx
        .insert(agentRuntimes)
        .values({
          id: ctx.idGen.generate("runtime"),
          organizationId: ctx.organizationId,
          computerId,
          runtime: rt.runtime,
          version: rt.version ?? null,
          status: rt.status,
          capabilities,
          lastSeenAt: now,
          metadata: {},
        })
        .onConflictDoUpdate({
          target: [agentRuntimes.computerId, agentRuntimes.runtime],
          setWhere: eq(agentRuntimes.organizationId, ctx.organizationId),
          set: {
            status: rt.status,
            version: rt.version ?? null,
            capabilities,
            lastSeenAt: now,
          },
        });
    }
  });
}

/**
 * GET /api/v1/computers/:id/runtimes — the runtimes a computer last advertised,
 * with status + last_seen_at so a consumer (#15 Part 3 scheduler) can filter out
 * stale/disabled runtimes and match capabilities.
 */
export async function listComputerRuntimes(
  ctx: ServerContext,
  computerId: string,
): Promise<AgentRuntime[]> {
  const rows = await ctx.db.db
    .select()
    .from(agentRuntimes)
    .where(
      and(
        eq(agentRuntimes.organizationId, ctx.organizationId),
        eq(agentRuntimes.computerId, computerId),
      ),
    );
  return rows.map(mapAgentRuntime);
}
