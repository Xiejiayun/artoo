import { appendEvent, projects, skillInstalls } from "@artoo/db";
import {
  ID_PREFIXES,
  skillContributesCapabilities,
  summarizeSkillPermissions,
  type InstallSkillRequest,
  type SkillInstall,
} from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, asc, eq, isNull, or } from "drizzle-orm";

import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { mapSkillInstall } from "../mappers.js";

async function assertProjectVisible(
  tx: DrizzleDb,
  ctx: ServerContext,
  projectId: string,
): Promise<void> {
  const row = (
    await tx
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.organizationId, ctx.organizationId)))
  )[0];
  if (row === undefined) {
    throw AppError.notFound(`project not found: ${projectId}`, { project_id: projectId });
  }
}

async function loadSkillInstall(tx: DrizzleDb, id: string): Promise<SkillInstall> {
  const row = (await tx.select().from(skillInstalls).where(eq(skillInstalls.id, id)))[0];
  if (row === undefined) {
    throw new Error(`skill install missing after write: ${id}`);
  }
  return mapSkillInstall(row);
}

function stableUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

/**
 * POST /skills/install — persist one validated skill manifest. The route has
 * already parsed the body through InstallSkillRequestSchema, so this service
 * records the derived read-model fields that scheduler/UI consumers need.
 */
export async function installSkill(
  ctx: ServerContext,
  req: InstallSkillRequest,
): Promise<SkillInstall> {
  const now = ctx.clock.nowIso();
  return ctx.db.transaction(async (tx) => {
    if (req.project_id != null) {
      await assertProjectVisible(tx, ctx, req.project_id);
    }

    const id = ctx.idGen.generate(ID_PREFIXES.skillInstall);
    const capabilities = skillContributesCapabilities(req.manifest, true);
    const compatibleRuntimes = stableUnique(req.manifest.compatible_runtimes);
    const permissionSummary = summarizeSkillPermissions(req.manifest);

    await tx.insert(skillInstalls).values({
      id,
      organizationId: ctx.organizationId,
      projectId: req.project_id ?? null,
      skillId: req.manifest.id,
      name: req.manifest.name,
      version: req.manifest.version,
      enabled: req.enabled,
      manifest: req.manifest,
      capabilities,
      compatibleRuntimes,
      permissionSummary,
      installedByType: "user",
      installedById: ctx.actorUserId,
      installedAt: now,
      updatedAt: now,
    });

    await appendEvent(
      tx,
      buildEvent(ctx, {
        type: "skill.installed",
        actorType: "user",
        actorId: ctx.actorUserId,
        correlationId: id,
        projectId: req.project_id ?? null,
        payload: {
          skill_install_id: id,
          skill_id: req.manifest.id,
          version: req.manifest.version,
          enabled: req.enabled,
          capabilities,
          compatible_runtimes: compatibleRuntimes,
        },
      }),
    );

    return loadSkillInstall(tx, id);
  });
}

export interface ListSkillInstallsFilters {
  /** When present, return org-wide installs plus installs scoped to the project. */
  projectId?: string;
  enabled?: boolean;
}

/** GET /skills — list this org's installed skills, optionally by effective project scope. */
export async function listSkillInstalls(
  ctx: ServerContext,
  filters: ListSkillInstallsFilters = {},
): Promise<SkillInstall[]> {
  if (filters.projectId !== undefined && filters.projectId !== "") {
    await assertProjectVisible(ctx.db.db, ctx, filters.projectId);
  }

  const conditions = [eq(skillInstalls.organizationId, ctx.organizationId)];
  if (filters.enabled !== undefined) {
    conditions.push(eq(skillInstalls.enabled, filters.enabled));
  }
  if (filters.projectId !== undefined && filters.projectId !== "") {
    const scopeCondition = or(
      isNull(skillInstalls.projectId),
      eq(skillInstalls.projectId, filters.projectId),
    );
    if (scopeCondition !== undefined) conditions.push(scopeCondition);
  }

  const rows = await ctx.db.db
    .select()
    .from(skillInstalls)
    .where(and(...conditions))
    .orderBy(
      asc(skillInstalls.name),
      asc(skillInstalls.skillId),
      asc(skillInstalls.version),
      asc(skillInstalls.id),
    );
  return rows.map(mapSkillInstall);
}

/** GET /skills/:id. */
export async function getSkillInstall(ctx: ServerContext, id: string): Promise<SkillInstall> {
  const row = (
    await ctx.db.db
      .select()
      .from(skillInstalls)
      .where(and(eq(skillInstalls.id, id), eq(skillInstalls.organizationId, ctx.organizationId)))
  )[0];
  if (row === undefined) {
    throw AppError.notFound(`skill install not found: ${id}`, { skill_install_id: id });
  }
  return mapSkillInstall(row);
}
