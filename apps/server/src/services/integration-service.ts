import { integrationQueue } from "@artoo/db";
import type { ArtifactType } from "@artoo/domain";
import { ID_PREFIXES } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, desc, eq } from "drizzle-orm";

import type { ServerContext } from "../context.js";

/**
 * Artifact types that need integration into the shared branch/main (#20). Only
 * mergeable code artifacts are enqueued; reports/logs/screenshots/etc. are not.
 */
const INTEGRATION_ARTIFACT_TYPES = new Set<ArtifactType>(["patch", "pull_request"]);

export function needsIntegration(type: ArtifactType): boolean {
  return INTEGRATION_ARTIFACT_TYPES.has(type);
}

/**
 * Enqueue a produced artifact into `integration_queue` for serialized integration
 * (#20), INSIDE the caller's transaction. No-op for non-integration artifact types.
 * `sequence` is a per-project monotonic counter; `artifact_ref` is the artifact id.
 * The queue serializes artifact integration, NOT lease waiting.
 */
export async function enqueueArtifactForIntegration(
  ctx: ServerContext,
  tx: DrizzleDb,
  params: {
    projectId: string;
    taskId: string;
    runId: string;
    artifactId: string;
    artifactType: ArtifactType;
  },
): Promise<void> {
  if (!needsIntegration(params.artifactType)) {
    return;
  }
  const now = ctx.clock.nowIso();
  const last = (
    await tx
      .select({ sequence: integrationQueue.sequence })
      .from(integrationQueue)
      .where(
        and(
          eq(integrationQueue.organizationId, ctx.organizationId),
          eq(integrationQueue.projectId, params.projectId),
        ),
      )
      .orderBy(desc(integrationQueue.sequence))
      .limit(1)
  )[0];
  const sequence = (last?.sequence ?? 0) + 1;
  await tx.insert(integrationQueue).values({
    id: ctx.idGen.generate(ID_PREFIXES.integrationJob),
    organizationId: ctx.organizationId,
    projectId: params.projectId,
    taskId: params.taskId,
    runId: params.runId,
    status: "queued",
    sequence,
    artifactRef: params.artifactId,
    enqueuedAt: now,
    startedAt: null,
    endedAt: null,
    createdAt: now,
  });
}
