import { lockSchedulerCapacity, schedulerCapacityEnabled } from "./scheduler-capacity-service.js";
import { agentInstances, agents, appendEvent, computers, schedulerAgentPolicies } from "@artoo/db";
import { SchedulerAgentPolicyV1Schema } from "@artoo/domain";
import { and, asc, eq, isNull } from "drizzle-orm";
import { requireAdministrator } from "../auth/request-auth.js";
import type { ServerContext } from "../context.js";
import { buildEvent } from "../events.js";

/**
 * Explicit administrator import from one repeatable-read configuration snapshot.
 * No resource is retargeted, and existing policies (including explicit unpins)
 * are never replaced. Configuration changes after this snapshot need review.
 */
export async function importSchedulerAgentPins(ctx: ServerContext, apply: boolean) {
  return ctx.db.db.transaction(
    async (tx) => {
      await requireAdministrator(ctx, tx);
      if (apply) await lockSchedulerCapacity(ctx, tx);
      const observedAt = ctx.clock.nowIso();
      const targets = await tx
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.organizationId, ctx.organizationId), isNull(agents.deletedAt)))
        .orderBy(asc(agents.id));
      const bindings = await tx
        .select({ agentId: agentInstances.agentId, computerId: agentInstances.computerId })
        .from(agentInstances)
        .innerJoin(
          computers,
          and(
            eq(computers.id, agentInstances.computerId),
            eq(computers.organizationId, ctx.organizationId),
            isNull(computers.deletedAt),
          ),
        )
        .where(and(eq(agentInstances.organizationId, ctx.organizationId), isNull(agentInstances.deletedAt)));
      const existing = new Set(
        (
          await tx
            .select({ agentId: schedulerAgentPolicies.agentId })
            .from(schedulerAgentPolicies)
            .where(eq(schedulerAgentPolicies.organizationId, ctx.organizationId))
        ).map((row) => row.agentId),
      );
      const results: {
        agent_id: string;
        computer_ids: string[];
        status: "preserved" | "missing" | "ambiguous" | "planned" | "imported";
      }[] = [];
      for (const target of targets) {
        const computerIds = [
          ...new Set(bindings.filter((row) => row.agentId === target.id).map((row) => row.computerId)),
        ].sort();
        const row = { agent_id: target.id, computer_ids: computerIds };
        if (existing.has(target.id)) {
          results.push({ ...row, status: "preserved" });
          continue;
        }
        if (computerIds.length !== 1) {
          results.push({ ...row, status: computerIds.length ? "ambiguous" : "missing" });
          continue;
        }
        if (!apply) {
          results.push({ ...row, status: "planned" });
          continue;
        }
        const policy = SchedulerAgentPolicyV1Schema.parse({
          version: 1,
          pinned_computer_id: computerIds[0],
          max_concurrent_runs: 2,
          required_runtimes: [],
          required_labels: [],
        });
        const inserted = await tx
          .insert(schedulerAgentPolicies)
          .values({
            agentId: target.id,
            organizationId: ctx.organizationId,
            policy,
            updatedByUserId: ctx.actorUserId,
            updatedAt: observedAt,
          })
          .onConflictDoNothing()
          .returning();
        if (!inserted.length) {
          results.push({ ...row, status: "preserved" });
          continue;
        }
        await appendEvent(
          tx,
          buildEvent(ctx, {
            type: "scheduler.policy.imported",
            actorType: "user",
            actorId: ctx.actorUserId,
            correlationId: target.id,
            payload: {
              version: 1,
              kind: "agent",
              target_id: target.id,
              policy,
              revision: inserted[0]!.revision,
              observed_at: observedAt,
              execution_authorized: false,
            },
          }),
        );
        results.push({ ...row, status: "imported" });
      }
      return { version: 1 as const, observed_at: observedAt, execution_authorized: false as const, results };
    },
    { isolationLevel: apply && schedulerCapacityEnabled(ctx) ? "read committed" : "repeatable read" },
  );
}
