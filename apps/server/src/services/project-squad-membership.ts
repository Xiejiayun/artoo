import { agentInstances, agents, projectSquads } from "@artoo/db";
import { and, eq, isNull, or, sql } from "drizzle-orm";

/** Shared trusted selection scope for planning, conversation and execution.
 * An explicit logical Squad can admit an organization-wide instance, but cannot
 * borrow an instance bound to another project. Absent configuration preserves
 * legacy project binding. This is membership, never execution authorization. */
export function projectSquadInstanceMembership(organizationId: string, projectId: string) {
  const configured = sql`SELECT 1 FROM ${projectSquads} WHERE ${projectSquads.organizationId}=${organizationId} AND ${projectSquads.projectId}=${projectId}`;
  return and(
    eq(agentInstances.organizationId, organizationId),
    isNull(agentInstances.deletedAt),
    sql`EXISTS (SELECT 1 FROM ${agents} WHERE ${agents.id}=${agentInstances.agentId} AND ${agents.organizationId}=${organizationId} AND ${agents.deletedAt} IS NULL)`,
    or(
      and(eq(agentInstances.projectId, projectId), sql`NOT EXISTS (${configured})`),
      and(
        or(eq(agentInstances.projectId, projectId), isNull(agentInstances.projectId)),
        sql`EXISTS (${configured} AND ${projectSquads.agentIds} ? ${agentInstances.agentId})`,
      ),
    ),
  );
}
