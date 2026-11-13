import { agents, agentInstances, contextPacks, eventLog, messages, runs, tasks } from "@artoo/db";
import { ContextPackSchema, AgentHistoryEventSchema, type AgentHistoryQuery, type AgentHistoryEventsQuery,
  type AgentHistoryPage, type AgentHistoryDetail } from "@artoo/domain";
import { and, desc, eq, inArray, lt, or } from "drizzle-orm";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { mapMessage, mapRun } from "../mappers.js";

function scopedRuns(ctx: ServerContext, agentId: string) {
  // Tombstones deliberately remain readable: deleting a resource is not deleting its audit trail.
  return ctx.db.db.select({ run: runs, projectId: tasks.projectId, title: tasks.title }).from(runs)
    .innerJoin(agentInstances, and(eq(agentInstances.id, runs.agentInstanceId),
      eq(agentInstances.organizationId, ctx.organizationId), eq(agentInstances.agentId, agentId)))
    .innerJoin(tasks, and(eq(tasks.id, runs.taskId), eq(tasks.organizationId, ctx.organizationId)))
    .$dynamic();
}

export async function listAgentHistory(ctx: ServerContext, agentId: string, query: AgentHistoryQuery): Promise<AgentHistoryPage> {
  const [agent] = await ctx.db.db.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.organizationId, ctx.organizationId)));
  if (!agent) throw AppError.notFound("Agent not found");
  if (query.instance_id) {
    const [instance] = await ctx.db.db.select({ id: agentInstances.id }).from(agentInstances).where(and(
      eq(agentInstances.id, query.instance_id), eq(agentInstances.agentId, agentId), eq(agentInstances.organizationId, ctx.organizationId)));
    if (!instance) throw AppError.notFound("Agent instance not found");
  }
  const filters = [eq(runs.organizationId, ctx.organizationId),
    query.instance_id ? eq(runs.agentInstanceId, query.instance_id) : undefined,
    query.project_id ? eq(tasks.projectId, query.project_id) : undefined,
    query.status ? eq(runs.status, query.status) : undefined];
  if (query.before_run_id) {
    const [cursor] = await scopedRuns(ctx, agentId).where(and(eq(runs.organizationId, ctx.organizationId), eq(runs.id, query.before_run_id)));
    if (!cursor) throw AppError.validation("Invalid history cursor");
    filters.push(or(lt(runs.createdAt, cursor.run.createdAt), and(eq(runs.createdAt, cursor.run.createdAt), lt(runs.id, cursor.run.id))));
  }
  const rows = await scopedRuns(ctx, agentId).where(and(...filters)).orderBy(desc(runs.createdAt), desc(runs.id)).limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  return { version: 1, agent_id: agentId, agent_name: agent.displayName,
    runs: page.map(row => ({ run: mapRun(row.run), project_id: row.projectId, task_title: row.title })),
    next_before_run_id: rows.length > query.limit ? page.at(-1)!.run.id : null };
}

export async function getAgentHistoryRun(ctx: ServerContext, agentId: string, runId: string, query: AgentHistoryEventsQuery): Promise<AgentHistoryDetail> {
  const [row] = await scopedRuns(ctx, agentId).innerJoin(agents, and(eq(agents.id, agentInstances.agentId), eq(agents.organizationId, ctx.organizationId)))
    .where(and(eq(runs.organizationId, ctx.organizationId), eq(runs.id, runId)));
  if (!row) throw AppError.notFound("Agent execution not found");
  const [pack] = row.run.contextPackId ? await ctx.db.db.select().from(contextPacks).where(and(
    eq(contextPacks.id, row.run.contextPackId), eq(contextPacks.organizationId, ctx.organizationId),
    eq(contextPacks.taskId, row.run.taskId), eq(contextPacks.runId, runId))) : [];
  const parsed = ContextPackSchema.safeParse(pack?.payload);
  const request = parsed.success && parsed.data.task.id === row.run.taskId && parsed.data.project.id === row.projectId ? parsed.data.task : null;
  const rows = await ctx.db.db.select().from(eventLog).where(and(eq(eventLog.organizationId, ctx.organizationId),
    eq(eventLog.runId, runId), eq(eventLog.taskId, row.run.taskId), eq(eventLog.projectId, row.projectId),
    query.before ? lt(eventLog.position, query.before) : undefined)).orderBy(desc(eventLog.position)).limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const messageIds = page.filter(event => event.type === "message.created").flatMap(event => {
    const id = (event.payload as Record<string, unknown>).message_id;
    return typeof id === "string" ? [id] : [];
  });
  const responses = messageIds.length ? await ctx.db.db.select().from(messages).where(and(
    eq(messages.organizationId, ctx.organizationId), eq(messages.runId, runId), eq(messages.taskId, row.run.taskId),
    eq(messages.actorType, "agent"), eq(messages.actorId, row.run.agentInstanceId), inArray(messages.id, messageIds))) : [];
  const responseById = new Map(responses.map(message => [message.id, mapMessage(message).body]));
  return { version: 1, agent_id: agentId, execution: { run: mapRun(row.run), project_id: row.projectId, task_title: row.title }, request,
    events: page.map(event => AgentHistoryEventSchema.parse({ id: event.id, position: event.position, type: event.type,
      actor: { type: event.actorType, id: event.actorId }, sequence: event.sequence, occurred_at: event.occurredAt, payload: event.payload,
      response_text: event.type === "message.created" ? responseById.get((event.payload as { message_id: string }).message_id) ?? null : null })),
    next_before: rows.length > query.limit ? page.at(-1)!.position : null };
}
