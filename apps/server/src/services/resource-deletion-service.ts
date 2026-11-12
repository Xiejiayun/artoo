import { agentInstances, agents, appendEvent, applicationPublications, computers, devices, deviceTokens, discussions, fileLeases, productReleases, runs } from "@artoo/db";
import type { DrizzleDb } from "@artoo/storage";
import { and, asc, eq, inArray, isNull, notInArray } from "drizzle-orm";
import { requireAdministrator } from "../auth/request-auth.js";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { unconfirmedDisconnectRunIds, unsettledStandaloneExecutions } from "./execution-state.js";

export type ResourceKind = "computer" | "agent" | "agent_instance";

async function assertStopped(ctx: ServerContext, tx: DrizzleDb, filter: { computerId?: string; agentInstanceId?: string }) {
  const active = await tx.select({ id: runs.id }).from(runs).where(and(eq(runs.organizationId, ctx.organizationId),
    filter.computerId ? eq(runs.computerId, filter.computerId) : undefined,
    filter.agentInstanceId ? eq(runs.agentInstanceId, filter.agentInstanceId) : undefined,
    notInArray(runs.status, ["completed", "failed", "cancelled"])));
  if (active.length || (await unconfirmedDisconnectRunIds(ctx, tx, filter)).length
    || (await unsettledStandaloneExecutions(ctx, tx, filter)).length) {
    throw AppError.conflict("Stop active work and confirm disconnected processes have exited before deleting this resource");
  }
  const leases = await tx.select({ id: fileLeases.id }).from(fileLeases).innerJoin(runs, eq(runs.id, fileLeases.runId)).where(and(
    eq(fileLeases.organizationId, ctx.organizationId), eq(runs.organizationId, ctx.organizationId), eq(fileLeases.status, "held"),
    filter.computerId ? eq(runs.computerId, filter.computerId) : undefined,
    filter.agentInstanceId ? eq(runs.agentInstanceId, filter.agentInstanceId) : undefined));
  if (leases.length) throw AppError.conflict("Release active file leases before deleting this resource");
  if (filter.agentInstanceId) {
    const planning = await tx.select({ participants: discussions.participants }).from(discussions).where(and(
      eq(discussions.organizationId, ctx.organizationId), inArray(discussions.status, ["running", "stopping"])));
    if (planning.some((row) => (row.participants as { agent_instance_id: string }[]).some((member) => member.agent_instance_id === filter.agentInstanceId))) {
      throw AppError.conflict("Stop active planning before deleting this resource");
    }
  }
  // Publication can outlive the author run; keep its execution host available.
  const releases = await tx.select({ id: productReleases.id }).from(productReleases).innerJoin(runs, eq(runs.id, productReleases.runId)).where(and(
    eq(productReleases.organizationId, ctx.organizationId), eq(productReleases.status, "queued"),
    filter.computerId ? eq(productReleases.computerId, filter.computerId) : undefined,
    filter.agentInstanceId ? eq(runs.agentInstanceId, filter.agentInstanceId) : undefined));
  if (releases.length) throw AppError.conflict("Finish or cancel the pending publication before deleting this resource");
  if (filter.computerId) {
    const applications = await tx.select({ id: applicationPublications.id }).from(applicationPublications).where(and(
      eq(applicationPublications.organizationId, ctx.organizationId), eq(applicationPublications.computerId, filter.computerId), eq(applicationPublications.status, "queued")));
    if (applications.length) throw AppError.conflict("Finish the pending application publication before deleting this computer");
  }
}

/** Tombstones preserve foreign keys and make deletion irreversible by a heartbeat or an enable request. */
export async function deleteResource(ctx: ServerContext, kind: ResourceKind, id: string) {
  await requireAdministrator(ctx);
  return ctx.db.transaction(async (tx) => {
    // Assignment locks instances before computers. Use that same order, including
    // already-deleted children, so a concurrent assignment is rechecked below.
    let children = await tx.select().from(agentInstances).where(and(eq(agentInstances.organizationId, ctx.organizationId),
      kind === "computer" ? eq(agentInstances.computerId, id) : kind === "agent" ? eq(agentInstances.agentId, id) : eq(agentInstances.id, id)))
      .orderBy(asc(agentInstances.id)).for("update");
    const table = kind === "computer" ? computers : kind === "agent" ? agents : agentInstances;
    const [resource] = await tx.select().from(table).where(and(eq(table.id, id), eq(table.organizationId, ctx.organizationId))).for("update");
    if (!resource) throw AppError.notFound(`${kind.replaceAll("_", " ")} not found`);
    if (kind !== "agent_instance") {
      // Registration holds the parent FOR SHARE. Re-read after its lock wait to
      // include any instance that committed while deletion acquired the parent.
      children = await tx.select().from(agentInstances).where(and(eq(agentInstances.organizationId, ctx.organizationId),
        kind === "computer" ? eq(agentInstances.computerId, id) : eq(agentInstances.agentId, id)))
        .orderBy(asc(agentInstances.id)).for("update");
    }
    await requireAdministrator(ctx, tx);
    if (resource.deletedAt !== null) return { deleted: true as const, id, computer_id: kind === "computer" ? id : null, device_ids: [] as string[] };
    if (kind === "computer") await assertStopped(ctx, tx, { computerId: id });
    for (const child of children) await assertStopped(ctx, tx, { agentInstanceId: child.id });
    const now = ctx.clock.nowIso();
    if (children.length) await tx.update(agentInstances).set({ deletedAt: now, status: "disabled" })
      .where(and(eq(agentInstances.organizationId, ctx.organizationId), inArray(agentInstances.id, children.map((item) => item.id)), isNull(agentInstances.deletedAt)));
    const deviceIds: string[] = [];
    if (kind === "computer") {
      await tx.update(computers).set({ deletedAt: now, status: "disabled" }).where(and(eq(computers.id, id), eq(computers.organizationId, ctx.organizationId)));
      const linked = await tx.update(devices).set({ trust: "revoked", revokedAt: now }).where(and(eq(devices.computerId, id), eq(devices.organizationId, ctx.organizationId))).returning({ id: devices.id });
      deviceIds.push(...linked.map((item) => item.id));
      if (deviceIds.length) await tx.update(deviceTokens).set({ status: "revoked", revokedAt: now }).where(and(
        eq(deviceTokens.organizationId, ctx.organizationId), inArray(deviceTokens.deviceId, deviceIds), eq(deviceTokens.status, "active")));
    } else if (kind === "agent") {
      await tx.update(agents).set({ deletedAt: now, status: "offline" }).where(and(eq(agents.id, id), eq(agents.organizationId, ctx.organizationId)));
    }
    await appendEvent(tx, buildEvent(ctx, { type: `${kind}.deleted`, actorType: "user", actorId: ctx.actorUserId, correlationId: id,
      payload: { [`${kind}_id`]: id, agent_instance_ids: children.filter((item) => item.deletedAt === null).map((item) => item.id) } }));
    return { deleted: true as const, id, computer_id: kind === "computer" ? id : null, device_ids: deviceIds };
  });
}
