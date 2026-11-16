import {
  agentInstances,
  agents,
  appendEvent,
  computers,
  computerAdmissions,
  logicalAgentConfigurations,
  projects,
  projectSquads,
} from "@artoo/db";
import {
  CreateLogicalAgentV1Schema,
  PutLogicalAgentConfigurationV1Schema,
  LogicalAgentConfigurationRecordV1Schema,
  ProjectSquadV1Schema,
  PutProjectSquadV1Schema,
  ComputerAdmissionV1Schema,
  PutComputerAdmissionV1Schema,
  ID_PREFIXES,
  type LogicalAgentConfigurationV1,
} from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import { requireAdministrator, requireCurrentTeamMember } from "../auth/request-auth.js";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { mapAgent } from "../mappers.js";
import { lockSchedulerConfiguration } from "./scheduler-configuration-fence.js";
import { auditDigestV1 } from "../audit-signature.js";

/** Serializes first inserts and idempotent creates even when scheduler rollout is
 * off. This is a separate resource-edit mutex; it cannot grant execution. */
async function writeGuard(ctx: ServerContext, tx: DrizzleDb) {
  await requireAdministrator(ctx, tx);
  await lockSchedulerConfiguration(ctx, tx);
  const result = await tx.execute(
    sql`SELECT pg_try_advisory_xact_lock(1095914315, hashtext(${ctx.organizationId})) AS acquired`,
  );
  if (result.rows[0]?.acquired !== true)
    throw AppError.conflict("Team configuration is changing; retry the complete operation");
}
const common = (ctx: ServerContext) => ({
  organizationId: ctx.organizationId,
  updatedAt: ctx.clock.nowIso(),
  updatedByUserId: ctx.actorUserId,
});
function revision(actual: number, expected: number) {
  if (actual !== expected)
    throw AppError.conflict("Configuration changed; reload before saving", {
      expected_revision: expected,
      current_revision: actual,
    });
  if (actual >= Number.MAX_SAFE_INTEGER) throw AppError.conflict("Configuration revision is exhausted");
}
async function audit(
  ctx: ServerContext,
  tx: DrizzleDb,
  type: string,
  id: string,
  payload: Record<string, unknown>,
  projectId: string | null = null,
) {
  await appendEvent(
    tx,
    buildEvent(ctx, { type, actorType: "user", actorId: ctx.actorUserId, correlationId: id, projectId, payload }),
  );
}
async function agent(ctx: ServerContext, tx: DrizzleDb, id: string) {
  const [row] = await tx
    .select()
    .from(agents)
    .where(and(eq(agents.id, id), eq(agents.organizationId, ctx.organizationId), isNull(agents.deletedAt)))
    .for("share");
  if (!row) throw AppError.notFound("Agent not found");
  return row;
}
async function target(ctx: ServerContext, tx: DrizzleDb, kind: "project" | "computer", id: string) {
  const rows =
    kind === "project"
      ? await tx
          .select({ id: projects.id })
          .from(projects)
          .where(and(eq(projects.id, id), eq(projects.organizationId, ctx.organizationId)))
          .for("share")
      : await tx
          .select({ id: computers.id })
          .from(computers)
          .where(
            and(eq(computers.id, id), eq(computers.organizationId, ctx.organizationId), isNull(computers.deletedAt)),
          )
          .for("share");
  if (!rows.length) throw AppError.notFound(`${kind} not found`);
}
function configRecord(row: typeof agents.$inferSelect, stored?: typeof logicalAgentConfigurations.$inferSelect) {
  return LogicalAgentConfigurationRecordV1Schema.parse({
    version: 1,
    agent_id: row.id,
    revision: stored?.revision ?? 0,
    configuration: stored?.configuration ?? {
      version: 1,
      display_name: row.displayName,
      kind: row.kind,
      capabilities: row.capabilities,
      role: row.kind,
      description: "",
      instructions: "",
    },
  });
}
export async function getLogicalAgentConfiguration(ctx: ServerContext, id: string) {
  return ctx.db.transaction(async (tx) => {
    await requireCurrentTeamMember(ctx, tx);
    const row = await agent(ctx, tx, id);
    const [stored] = await tx
      .select()
      .from(logicalAgentConfigurations)
      .where(
        and(
          eq(logicalAgentConfigurations.agentId, id),
          eq(logicalAgentConfigurations.organizationId, ctx.organizationId),
        ),
      );
    return configRecord(row, stored);
  });
}
function agentColumns(configuration: LogicalAgentConfigurationV1) {
  return {
    displayName: configuration.display_name,
    kind: configuration.kind,
    capabilities: configuration.capabilities,
  };
}
export async function createLogicalAgent(ctx: ServerContext, raw: unknown) {
  const parsed = CreateLogicalAgentV1Schema.safeParse(raw);
  if (!parsed.success) throw AppError.validation("Invalid version 1 logical Agent configuration");
  const input = parsed.data;
  return ctx.db.transaction(async (tx) => {
    await writeGuard(ctx, tx);
    const [prior] = await tx
      .select()
      .from(logicalAgentConfigurations)
      .where(
        and(
          eq(logicalAgentConfigurations.organizationId, ctx.organizationId),
          eq(logicalAgentConfigurations.createKey, input.request_key),
        ),
      );
    if (prior) {
      if (prior.creationDigest !== auditDigestV1(input.configuration))
        throw AppError.conflict("Agent request key was reused with different configuration");
      const row = await agent(ctx, tx, prior.agentId);
      return { agent: mapAgent(row), configuration: configRecord(row, prior) };
    }
    const [row] = await tx
      .insert(agents)
      .values({
        id: ctx.idGen.generate(ID_PREFIXES.agent),
        organizationId: ctx.organizationId,
        ...agentColumns(input.configuration),
        status: "offline",
        createdAt: ctx.clock.nowIso(),
      })
      .returning();
    const [stored] = await tx
      .insert(logicalAgentConfigurations)
      .values({
        ...common(ctx),
        agentId: row!.id,
        createKey: input.request_key,
        creationDigest: auditDigestV1(input.configuration),
        configuration: input.configuration,
      })
      .returning();
    await audit(ctx, tx, "agent.created", row!.id, { agent_id: row!.id, configuration_revision: stored!.revision });
    return { agent: mapAgent(row!), configuration: configRecord(row!, stored) };
  });
}
export async function putLogicalAgentConfiguration(ctx: ServerContext, id: string, raw: unknown) {
  const parsed = PutLogicalAgentConfigurationV1Schema.safeParse(raw);
  if (!parsed.success) throw AppError.validation("Invalid version 1 Agent edit with expected_revision");
  const input = parsed.data;
  return ctx.db.transaction(async (tx) => {
    await writeGuard(ctx, tx);
    const row = await agent(ctx, tx, id);
    const [prior] = await tx
      .select()
      .from(logicalAgentConfigurations)
      .where(
        and(
          eq(logicalAgentConfigurations.agentId, id),
          eq(logicalAgentConfigurations.organizationId, ctx.organizationId),
        ),
      )
      .for("update");
    revision(prior?.revision ?? 0, input.expected_revision);
    if (isDeepStrictEqual(configRecord(row, prior).configuration, input.configuration)) return configRecord(row, prior);
    const [updated] = await tx
      .update(agents)
      .set(agentColumns(input.configuration))
      .where(eq(agents.id, id))
      .returning();
    const [stored] = await tx
      .insert(logicalAgentConfigurations)
      .values({ ...common(ctx), agentId: id, configuration: input.configuration })
      .onConflictDoUpdate({
        target: logicalAgentConfigurations.agentId,
        set: {
          ...common(ctx),
          configuration: input.configuration,
          revision: sql`${logicalAgentConfigurations.revision}+1`,
        },
      })
      .returning();
    await audit(ctx, tx, "agent.configuration.updated", id, { agent_id: id, configuration_revision: stored!.revision });
    return configRecord(updated!, stored);
  });
}

export async function readProjectSquad(ctx: ServerContext, tx: DrizzleDb, id: string) {
  const [stored] = await tx
    .select()
    .from(projectSquads)
    .where(and(eq(projectSquads.projectId, id), eq(projectSquads.organizationId, ctx.organizationId)));
  const legacy = stored
    ? []
    : await tx
        .select({ agentId: agentInstances.agentId })
        .from(agentInstances)
        .innerJoin(agents, and(eq(agents.id, agentInstances.agentId), isNull(agents.deletedAt)))
        .where(
          and(
            eq(agentInstances.organizationId, ctx.organizationId),
            eq(agents.organizationId, ctx.organizationId),
            eq(agentInstances.projectId, id),
            isNull(agentInstances.deletedAt),
          ),
        )
        .orderBy(asc(agentInstances.agentId));
  return ProjectSquadV1Schema.parse({
    version: 1,
    project_id: id,
    revision: stored?.revision ?? 0,
    agent_ids: stored?.agentIds ?? [...new Set(legacy.map((r) => r.agentId))],
    source: stored ? "configured" : "legacy_instances",
  });
}
export async function getProjectSquad(ctx: ServerContext, id: string) {
  return ctx.db.transaction(async (tx) => {
    await requireCurrentTeamMember(ctx, tx);
    await target(ctx, tx, "project", id);
    return readProjectSquad(ctx, tx, id);
  });
}
export async function putProjectSquad(ctx: ServerContext, id: string, raw: unknown) {
  const parsed = PutProjectSquadV1Schema.safeParse(raw);
  if (!parsed.success) throw AppError.validation("Invalid version 1 Squad edit with expected_revision");
  const input = parsed.data;
  return ctx.db.transaction(async (tx) => {
    await writeGuard(ctx, tx);
    await target(ctx, tx, "project", id);
    const prior = await readProjectSquad(ctx, tx, id);
    revision(prior.revision, input.expected_revision);
    const found = input.agent_ids.length
      ? await tx
          .select({ id: agents.id })
          .from(agents)
          .where(
            and(
              eq(agents.organizationId, ctx.organizationId),
              inArray(agents.id, input.agent_ids),
              isNull(agents.deletedAt),
            ),
          )
          .for("share")
      : [];
    if (found.length !== input.agent_ids.length) throw AppError.notFound("Squad contains an unavailable Agent");
    const agentIds = [...input.agent_ids].sort();
    if (prior.source === "configured" && isDeepStrictEqual([...prior.agent_ids].sort(), agentIds)) return prior;
    await tx
      .insert(projectSquads)
      .values({ ...common(ctx), projectId: id, agentIds })
      .onConflictDoUpdate({
        target: projectSquads.projectId,
        set: { ...common(ctx), agentIds, revision: sql`${projectSquads.revision}+1` },
      });
    const squad = await readProjectSquad(ctx, tx, id);
    await audit(
      ctx,
      tx,
      "project.squad.updated",
      id,
      { version: 1, agent_ids: agentIds, revision: squad.revision },
      id,
    );
    return squad;
  });
}
export async function readComputerAdmission(ctx: ServerContext, tx: DrizzleDb, id: string) {
  const [stored] = await tx
    .select()
    .from(computerAdmissions)
    .where(and(eq(computerAdmissions.computerId, id), eq(computerAdmissions.organizationId, ctx.organizationId)));
  return ComputerAdmissionV1Schema.parse({
    version: 1,
    computer_id: id,
    revision: stored?.revision ?? 0,
    state: stored?.state ?? "accepting",
  });
}
export async function getComputerAdmission(ctx: ServerContext, id: string) {
  return ctx.db.transaction(async (tx) => {
    await requireCurrentTeamMember(ctx, tx);
    await target(ctx, tx, "computer", id);
    return readComputerAdmission(ctx, tx, id);
  });
}
export async function putComputerAdmission(ctx: ServerContext, id: string, raw: unknown) {
  const parsed = PutComputerAdmissionV1Schema.safeParse(raw);
  if (!parsed.success) throw AppError.validation("Invalid version 1 admission edit with expected_revision");
  const input = parsed.data;
  return ctx.db.transaction(async (tx) => {
    await writeGuard(ctx, tx);
    await target(ctx, tx, "computer", id);
    const prior = await readComputerAdmission(ctx, tx, id);
    revision(prior.revision, input.expected_revision);
    if (prior.state === input.state) return prior;
    await tx
      .insert(computerAdmissions)
      .values({ ...common(ctx), computerId: id, state: input.state })
      .onConflictDoUpdate({
        target: computerAdmissions.computerId,
        set: { ...common(ctx), state: input.state, revision: sql`${computerAdmissions.revision}+1` },
      });
    const admission = await readComputerAdmission(ctx, tx, id);
    await audit(ctx, tx, "computer.admission.updated", id, { ...admission, affects: "new_assignments_only" });
    return admission;
  });
}
