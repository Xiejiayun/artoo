import { agentRuntimes } from "@artoo/db";
import type { AgentRuntime } from "@artoo/domain";
import type { RuntimeStatus } from "@artoo/protocol";
import { and, eq } from "drizzle-orm";

import type { ServerContext } from "../context.js";
import { mapAgentRuntime } from "../mappers.js";

/**
 * Persist the runtime capabilities advertised in a node heartbeat (#15 Part 2).
 * Upserts one row per `(computer_id, runtime)` (the table's unique key), stamping
 * `last_seen_at` with the SERVER clock (heartbeats carry no timestamp). Capabilities
 * are normalized to a stable `string[]`. `version` stays nullable/non-gating.
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
  for (const rt of runtimes) {
    const capabilities = Array.isArray(rt.capabilities) ? [...rt.capabilities] : [];
    await ctx.db.db
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
        set: {
          status: rt.status,
          version: rt.version ?? null,
          capabilities,
          lastSeenAt: now,
        },
      });
  }
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
