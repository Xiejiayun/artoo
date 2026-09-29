import { agentRuntimes, computers, runs } from "@artoo/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { ServerContext } from "../context.js";
import { mapAgentRuntime } from "../mappers.js";

/** A live control client is never evidence that an execution daemon is online. */
export async function listDaemons(ctx: ServerContext, isLive: (computerId: string) => boolean, reconnecting: (computerId: string) => boolean) {
  const [nodes, runtimes, active] = await Promise.all([
    ctx.db.db.select().from(computers).where(eq(computers.organizationId, ctx.organizationId)).orderBy(asc(computers.displayName)),
    ctx.db.db.select().from(agentRuntimes).where(eq(agentRuntimes.organizationId, ctx.organizationId)),
    ctx.db.db.select({ computerId: runs.computerId }).from(runs).where(and(eq(runs.organizationId, ctx.organizationId), inArray(runs.status, ["queued", "starting", "running", "paused", "awaiting_input"]))),
  ]);
  return nodes.map((node) => {
    const connected = isLive(node.id);
    const last = node.lastHeartbeatAt === null ? NaN : Date.parse(node.lastHeartbeatAt);
    const age = Number.isFinite(last) ? Math.max(0, ctx.clock.now().getTime() - last) : null;
    const status = node.status === "disabled" ? "disabled" : connected ? (age !== null && age <= 30000 ? "online" : "stale") : reconnecting(node.id) ? "reconnecting" : "offline";
    return { computer_id: node.id, display_name: node.displayName, status, connected,
      last_heartbeat_at: Number.isFinite(last) ? new Date(last).toISOString() : null, heartbeat_age_ms: age,
      active_runs: active.filter((run) => run.computerId === node.id).length,
      runtimes: runtimes.filter((runtime) => runtime.computerId === node.id).map(mapAgentRuntime) };
  });
}
